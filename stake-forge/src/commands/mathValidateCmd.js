import fs from 'fs-extra';
import path from 'node:path';
import chalk from 'chalk';

import { loadGameSpec } from '../lib/loadSpec.js';
import { mathGameId } from './mathScaffold.js';
import { readLookupTable, summarise } from './mathReport.js';
import { validateMode, RULE_PROVENANCE } from '../lib/mathValidate.js';

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
		const optimised =
			fs.existsSync(optimisedFile) &&
			fs.readFileSync(optimisedFile, 'utf8') !== fs.readFileSync(raw, 'utf8');

		const rows = readLookupTable(optimised ? optimisedFile : raw);
		const summary = summarise(rows, { wincap: mode.maxWin, cost: mode.cost ?? 1 });
		if (!summary) continue;

		const result = validateMode({ name, mode, rows, summary, spec, baseRtp, optimised });
		if (baseRtp === null && optimised) baseRtp = summary.rtp;
		results.push({ ...result, optimised });
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
			mode.optimised ? chalk.green('optimised') : chalk.yellow('raw — optimiser has not run'),
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
		console.log(chalk.green.bold('All rules pass.'));
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
