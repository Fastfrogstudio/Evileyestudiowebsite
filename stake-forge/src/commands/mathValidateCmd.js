import fs from 'fs-extra';
import path from 'node:path';
import chalk from 'chalk';

import { loadGameSpec } from '../lib/loadSpec.js';
import { mathGameId } from './mathScaffold.js';
import { readLookupTable, readFeatureRounds, summarise } from './mathReport.js';
import { validateMode, RULE_PROVENANCE } from '../lib/mathValidate.js';
import { staleAgainst } from './packageGame.js';

/**
 * `forge math:validate` — is this game shippable?
 *
 * math:report tells you what the game pays. This tells you whether that is
 * good enough, rule by rule, with the measured number beside each verdict.
 * Exits non-zero on a failure so it can gate a pipeline.
 */
export function mathValidate({ specPath, mathSdkDir, json = false }) {
	const spec = loadGameSpec(specPath);
	const gameId = mathGameId(spec);
	const tablesDir = path.join(mathSdkDir, 'games', gameId, 'library', 'lookup_tables');
	const publishDir = path.join(mathSdkDir, 'games', gameId, 'library', 'publish_files');

	if (!fs.existsSync(tablesDir)) {
		throw new Error(
			`No simulation output for games/${gameId}. Run "forge math:run" and "forge math:optimise" first.`,
		);
	}

	// The base mode is the reference every other mode is held to, so it is read
	// first regardless of the order the spec declares them in.
	const entries = Object.entries(spec.game.betModes);
	const ordered = [
		...entries.filter(([, m]) => !m.buyBonus && !m.superspin),
		...entries.filter(([, m]) => m.buyBonus || m.superspin),
	];

	const results = [];
	let baseRtp = null;
	for (const [name, mode] of ordered) {
		const raw = path.join(tablesDir, `lookUpTable_${name}.csv`);
		if (!fs.existsSync(raw)) continue;

		// publish_files starts as a byte-for-byte copy, so its existence proves
		// nothing — the files have to be compared.
		const optimisedFile = path.join(publishDir, `lookUpTable_${name}_0.csv`);
		const differs =
			fs.existsSync(optimisedFile) &&
			fs.readFileSync(optimisedFile, 'utf8') !== fs.readFileSync(raw, 'utf8');
		// Differing is necessary but not sufficient — see mathReport. A table
		// optimised against a superseded simulation still differs from the raw
		// one, and validating from it would pass a game on numbers that describe
		// rounds the books no longer contain.
		const stale = differs ? staleAgainst(raw, optimisedFile) : null;
		const optimised = differs && !stale;

		// The gametype of each round lives only in the segmented table, and the
		// feature-variety check needs it to know which rounds are the FEATURE.
		const featureRounds = readFeatureRounds(
			path.join(tablesDir, `lookUpTableSegmented_${name}.csv`),
		);
		const rows = readLookupTable(optimised ? optimisedFile : raw, { featureRounds });
		// The buy-cost check needs the RAW rounds, always. After optimisation the
		// weighted mean payout IS rtp x cost by construction, so measuring it there
		// makes the check pass trivially on every game — which it did, until four
		// games in a row reported "1x the cost set in the spec".
		const rawRows = readLookupTable(raw);
		const summary = summarise(rows, { wincap: mode.maxWin, cost: mode.cost ?? 1 });
		if (!summary) continue;

		const result = validateMode({ name, mode, rows, rawRows, summary, spec, baseRtp, optimised });
		if (stale) {
			// A hard failure, not a note. Every other rule in this gate is about
			// whether the game is good enough; this one is about whether the
			// numbers describe the game at all.
			result.checks.unshift({
				id: 'tables-match-books',
				ok: false,
				statement: 'the optimised weights describe the simulation they ship with',
				detail:
					`they do not — ${stale}. The optimiser ran against a superseded simulation, so ` +
					`every number below is measured from the RAW rounds instead. Re-run ` +
					`"forge math:optimise".`,
			});
			result.ok = false;
			result.failed += 1;
		}
		if (baseRtp === null && optimised) baseRtp = summary.rtp;
		results.push({ ...result, optimised, stale });
	}

	if (!results.length) throw new Error(`No lookup tables found in ${tablesDir}.`);

	const ok = results.every((r) => r.ok);

	if (json) {
		console.log(JSON.stringify({ game: spec.game.name, ok, modes: results }, null, 2));
		return { ok, modes: results };
	}

	console.log(chalk.bold(`\nIs this shippable? — ${spec.game.name}\n`));

	for (const mode of results) {
		console.log(
			chalk.bold(mode.name.padEnd(10)),
			mode.optimised
				? chalk.green('optimised')
				: mode.stale
					? chalk.red('STALE — optimised against a different simulation')
					: chalk.yellow('raw — optimiser has not run'),
		);
		for (const check of mode.checks) {
			// Three states, not two: a hard rule passes or fails, and an advisory or
			// not-yet-judgeable rule is neither. Rendering "cannot be judged before
			// the optimiser runs" as a failure would be a lie in the other direction.
			const mark = check.ok
				? chalk.green('  ✓')
				: check.ok === false
					? chalk.red('  ✗')
					: check.advisory
						? chalk.yellow('  !')
						: chalk.dim('  –');
			console.log(`${mark} ${check.statement}${check.advisory ? chalk.dim(' (advisory)') : ''}`);
			console.log(chalk.dim(`     ${check.detail}`));
		}
		console.log('');
	}

	if (ok) {
		// An advisory that fired is not a failure, but "All rules pass" on its own
		// reads as if nothing was raised — and feature-variety firing is exactly the
		// kind of thing someone would want to see before shipping.
		const raised = results.flatMap((r) => r.checks.filter((c) => c.advisory && c.ok === null));
		console.log(
			raised.length
				? chalk.green.bold('All rules pass') +
						chalk.yellow.bold(
							`, with ${raised.length} advisory finding(s): ${[...new Set(raised.map((c) => c.id))].join(', ')}.`,
						)
				: chalk.green.bold('All rules pass.'),
		);
	} else {
		const failed = results.flatMap((m) => m.checks.filter((c) => c.ok === false).map((c) => c.id));
		console.log(chalk.red.bold(`${failed.length} rule(s) failed: ${[...new Set(failed)].join(', ')}`));
	}

	// Said every time, not buried in a doc: four of these rules are our reading of
	// Stake's approval criteria, gathered from research rather than handed to us.
	// A gate that overstates its own authority is worse than no gate.
	console.log('');
	console.log(chalk.dim('Where each rule comes from:'));
	for (const [id, source] of Object.entries(RULE_PROVENANCE)) {
		console.log(chalk.dim(`  ${id.padEnd(18)} ${source}`));
	}

	if (!ok) process.exitCode = 1;
	return { ok, modes: results };
}
