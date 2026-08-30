import fs from 'fs-extra';
import path from 'node:path';
import chalk from 'chalk';

import { loadGameSpec } from '../lib/loadSpec.js';
import { mathGameId } from './mathScaffold.js';
import { staleAgainst } from './packageGame.js';

/**
 * What the maths actually pays, measured against what the spec asked for.
 *
 * `forge verify` proves a game EXECUTES. This proves it pays what you intended,
 * which is a different and later question — and the one that catches a bad
 * paytable before a player does.
 *
 * Everything here is computed from the lookup tables a simulation already
 * writes: one row per round, `simulation id, weight, payout multiplier`. That is
 * the same source the SDK's own rgs_verification uses, so these numbers are the
 * numbers, not an approximation of them.
 */

/** Parse `library/lookup_tables/lookUpTable_<mode>.csv`. */
/**
 * Which simulated rounds reached the free game.
 *
 * lookUpTableSegmented_<mode>.csv is `sim, gametype, weight, payout` — the only
 * place the gametype of a round is recorded outside the books, which are far
 * larger and slower to read. Absent on an older simulation, in which case the
 * feature-variety check simply has nothing to say rather than failing.
 */
export function readFeatureRounds(file) {
	const feature = new Set();
	if (!fs.existsSync(file)) return feature;
	for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
		const parts = line.trim().split(',');
		if (parts.length < 4) continue;
		const sim = Number(parts[0]);
		if (Number.isFinite(sim) && /freegame/.test(parts[1])) feature.add(sim);
	}
	return feature;
}

export function readLookupTable(file, { featureRounds } = {}) {
	const rows = [];
	for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const parts = trimmed.split(',');
		if (parts.length < 3) continue;
		const weight = Number(parts[1]);
		const payout = Number(parts[2]);
		if (!Number.isFinite(weight) || !Number.isFinite(payout)) continue;
		const sim = Number(parts[0]);
		rows.push({ sim, weight, payout, feature: featureRounds ? featureRounds.has(sim) : false });
	}
	return rows;
}

/**
 * Payouts are stored as HUNDREDTHS of the bet.
 *
 * Book.to_json does `int(round(payout_multiplier * 100, 0))`, and the lookup
 * table writes that integer straight out. Treating it as a multiplier reports an
 * RTP a hundred times too high, which is exactly what the first version of this
 * did before the format was checked.
 */
const PAYOUT_SCALE = 100;

/**
 * RTP and hit rates from a weighted payout distribution.
 *
 * Rounds are WEIGHTED — the simulation does not produce each outcome with equal
 * probability, so a plain average over rows would be wrong. RTP is the
 * weight-weighted mean payout, divided by the bet cost, matching the SDK's own
 * calculate_rtp in utils/analysis/distribution_functions.py.
 */
export function summarise(rows, { wincap, cost = 1 } = {}) {
	const totalWeight = rows.reduce((sum, r) => sum + r.weight, 0);
	if (!totalWeight) return null;

	const mean = rows.reduce((sum, r) => sum + r.weight * r.payout, 0) / totalWeight / PAYOUT_SCALE;
	const rtp = mean / cost;
	const winWeight = rows.filter((r) => r.payout > 0).reduce((s, r) => s + r.weight, 0);
	const capRaw = wincap * PAYOUT_SCALE;
	const capWeight = wincap
		? rows.filter((r) => r.payout >= capRaw * 0.999).reduce((s, r) => s + r.weight, 0)
		: 0;

	// Sorted by payout so a percentile is a real percentile of the distribution,
	// not of the row order.
	const sorted = [...rows].sort((a, b) => a.payout - b.payout);
	const percentile = (p) => {
		let seen = 0;
		const target = totalWeight * p;
		for (const row of sorted) {
			seen += row.weight;
			if (seen >= target) return row.payout;
		}
		return sorted[sorted.length - 1]?.payout ?? 0;
	};

	return {
		rounds: rows.length,
		rtp,
		hitRate: winWeight ? totalWeight / winWeight : Infinity,
		winFraction: winWeight / totalWeight,
		maxPayout: Math.max(...rows.map((r) => r.payout)) / PAYOUT_SCALE,
		wincapHitRate: capWeight ? totalWeight / capWeight : null,
		median: percentile(0.5) / PAYOUT_SCALE,
		p99: percentile(0.99) / PAYOUT_SCALE,
		p999: percentile(0.999) / PAYOUT_SCALE,
	};
}

export function mathReport({ specPath, mathSdkDir, json }) {
	const spec = loadGameSpec(specPath);
	const gameId = mathGameId(spec);
	const tablesDir = path.join(mathSdkDir, 'games', gameId, 'library', 'lookup_tables');

	if (!fs.existsSync(tablesDir)) {
		throw new Error(
			`No simulation output for games/${gameId}. Run "forge math:run" first — ` +
				`there is nothing to measure until rounds have been simulated.`,
		);
	}

	const publishDir = path.join(mathSdkDir, 'games', gameId, 'library', 'publish_files');

	const modes = [];
	for (const [name, mode] of Object.entries(spec.game.betModes)) {
		const raw = path.join(tablesDir, `lookUpTable_${name}.csv`);
		if (!fs.existsSync(raw)) continue;

		// The optimiser writes its reweighted table to publish_files. Until it has
		// run, that file is a byte-for-byte copy of the raw one — so its presence
		// is not evidence of anything, and it has to be compared.
		const optimised = path.join(publishDir, `lookUpTable_${name}_0.csv`);
		const differs =
			fs.existsSync(optimised) && fs.readFileSync(optimised, 'utf8') !== fs.readFileSync(raw, 'utf8');
		// ...and differing is not enough either. Simulate, optimise, then simulate
		// again: the published table still differs from the raw one, so it looks
		// optimised, but its weights describe rounds the books no longer contain.
		// Reporting from it would put a confident RTP on a game nobody computed —
		// the worst failure available here, because it looks like success.
		const stale = differs ? staleAgainst(raw, optimised) : null;
		const isOptimised = differs && !stale;

		const summary = summarise(readLookupTable(isOptimised ? optimised : raw), {
			wincap: mode.maxWin,
			cost: mode.cost ?? 1,
		});
		if (!summary) continue;

		const targetRtp = mode.rtp ?? spec.game.rtp;
		modes.push({
			name,
			optimised: isOptimised,
			stale,
			target: { rtp: targetRtp, maxWin: mode.maxWin, cost: mode.cost },
			measured: summary,
			// A tolerance rather than an exact match, because a finite simulation
			// never lands exactly on target. 2 percentage points is loose enough
			// that a short run does not cry wolf and tight enough to catch a
			// paytable that is simply wrong.
			rtpDelta: summary.rtp - targetRtp,
			// Comparing a pre-optimisation RTP to a target is meaningless — see the
			// note printed below — so it is not judged at all until the optimiser
			// has actually reweighted the distribution.
			withinTolerance: isOptimised ? Math.abs(summary.rtp - targetRtp) <= 0.02 : null,
			reachedCap: summary.maxPayout >= mode.maxWin * 0.999,
		});
	}

	if (!modes.length) {
		throw new Error(`No lookup tables found in ${tablesDir}.`);
	}

	if (json) {
		console.log(JSON.stringify({ game: spec.game.name, modes }, null, 2));
		return { ok: modes.every((m) => m.withinTolerance), modes };
	}

	const anyOptimised = modes.some((m) => m.optimised);

	console.log(chalk.bold(`\nWhat the maths pays — ${spec.game.name}\n`));

	if (!anyOptimised) {
		// This is the difference between a useful report and a misleading one.
		console.log(
			chalk.yellow('  These are PRE-OPTIMISATION numbers.\n') +
				chalk.dim(
					'  The generated distributions re-roll any round that pays nothing, so every\n' +
						'  simulated round is a winner and the RTP below is far above target BY DESIGN.\n' +
						'  The optimiser is what reweights the distribution to hit your target — until\n' +
						'  it has run, the figures below describe the shape of your paytable, not the\n' +
						'  RTP a player would see.\n',
				),
		);
	}

	for (const mode of modes) {
		const pct = (v) => `${(v * 100).toFixed(2)}%`;
		const ok = mode.withinTolerance;
		console.log(
			chalk.bold(mode.name.padEnd(10)),
			chalk.dim(`${mode.measured.rounds} rounds`),
			mode.optimised ? chalk.green('optimised') : mode.stale ? chalk.red('STALE') : chalk.yellow('raw'),
		);
		if (mode.stale) {
			console.log(
				chalk.red(
					`  The optimised table was built against a DIFFERENT simulation than the books
` +
						`  beside it (${mode.stale}). The numbers below are the RAW simulation, because
` +
						`  reporting from the stale table would describe a game that does not exist.
` +
						`  Re-run "forge math:optimise".`,
				),
			);
		}
		console.log(
			`  RTP        ${chalk.bold(pct(mode.measured.rtp))}` +
				chalk.dim(`  target ${pct(mode.target.rtp)}  `) +
				(ok === null
					? chalk.dim('(not comparable before optimisation)')
					: ok
						? chalk.green(`(${mode.rtpDelta >= 0 ? '+' : ''}${(mode.rtpDelta * 100).toFixed(2)}pp)`)
						: chalk.red(`(${mode.rtpDelta >= 0 ? '+' : ''}${(mode.rtpDelta * 100).toFixed(2)}pp — off target)`)),
		);
		console.log(
			`  Hit rate   ${chalk.bold(`1 in ${mode.measured.hitRate.toFixed(1)}`)}` +
				chalk.dim(`  ${pct(mode.measured.winFraction)} of rounds pay`),
		);
		console.log(
			`  Max paid   ${chalk.bold(`${mode.measured.maxPayout.toFixed(0)}x`)}` +
				chalk.dim(`  cap ${mode.target.maxWin}x  `) +
				(mode.reachedCap
					? chalk.green(`reached, 1 in ${mode.measured.wincapHitRate?.toFixed(0)}`)
					: chalk.yellow('never reached in this run')),
		);
		console.log(
			chalk.dim(
				`  Spread     median ${mode.measured.median.toFixed(2)}x · ` +
					`p99 ${mode.measured.p99.toFixed(1)}x · p99.9 ${mode.measured.p999.toFixed(1)}x`,
			),
		);
		console.log('');
	}

	const off = modes.filter((m) => m.withinTolerance === false);
	if (!anyOptimised) {
		console.log(
			chalk.dim(
				'Run the optimiser to get numbers worth judging:\n' +
					'  cd <math-sdk>/optimization_program && cargo build --release\n' +
					'  then `forge math:optimise`\n',
			),
		);
	} else if (off.length) {
		console.log(
			chalk.yellow(
				`${off.length} mode(s) more than 2pp from target. On a short run that is usually\n` +
					`sampling noise — re-run with more sims before changing the paytable. If it\n` +
					`persists, the paytable or reel weights are wrong, and the optimiser is what\n` +
					`closes the gap.\n`,
			),
		);
	} else {
		console.log(chalk.green('All modes within 2pp of target.\n'));
	}

	const unreached = modes.filter((m) => !m.reachedCap);
	if (unreached.length) {
		console.log(
			chalk.dim(
				`Max win was never hit in: ${unreached.map((m) => m.name).join(', ')}. Expected with\n` +
					`placeholder reels — a real strip needs to be able to reach it, or the cap is\n` +
					`decorative.\n`,
			),
		);
	}

	return { ok: off.length === 0, optimised: anyOptimised, modes };
}
