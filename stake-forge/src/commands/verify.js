import path from 'node:path';
import chalk from 'chalk';

import { loadGameSpec } from '../lib/loadSpec.js';
import { buildSpecialSymbols, sortSymbols } from '../lib/taxonomy.js';
import { getRecipe } from '../lib/behaviorRecipes.js';
import { mathGameId } from './mathScaffold.js';
import {
	resolvePython,
	resolveTsc,
	pyCompile,
	instantiateGameConfig,
	runSpin,
	tscDiff,
} from '../lib/verify.js';

/**
 * Prove the generated game actually works, rather than merely looking right.
 *
 * Math side runs three escalating levels (py_compile -> GameConfig() ->
 * run_spin()); the TypeScript side runs baseline-differential tsc. See
 * src/lib/verify.js for why each level exists.
 */
export function verify({ specPath, mathSdkDir, webSdkDir, python: pythonOverride, skipSpin }) {
	const spec = loadGameSpec(specPath);
	const mechanic = spec._mechanic;
	const results = [];

	console.log(chalk.bold(`\nVerifying "${spec.game.name}" (${mechanic.id})\n`));

	// ── math ────────────────────────────────────────────────────────────────
	if (mathSdkDir) {
		const gameId = mathGameId(spec);
		const gameDir = path.join(mathSdkDir, 'games', gameId);
		const python = resolvePython(mathSdkDir, pythonOverride);
		console.log(chalk.dim(`  python: ${python}`));
		console.log(chalk.dim(`  game:   games/${gameId}\n`));

		results.push(pyCompile({ gameDir, python }));

		const expect = {
			gameId,
			winType: mechanic.winType,
			numReels: spec.game.reels.count,
			numRows: spec.game.reels.rows,
			payingSymbols: sortSymbols(spec.symbols)
				.filter((s) => s.paytable)
				.map((s) => s.name)
				.sort(),
			specialSymbols: buildSpecialSymbols(spec.symbols),
			betModes: Object.keys(spec.game.betModes),
			numPaylines: mechanic.supportsPaylines
				? spec.paylines === 'default_20'
					? 20
					: Object.keys(spec.paylines).length
				: 0,
		};
		results.push(instantiateGameConfig({ mathSdkDir, gameDir, python, expect }));

		if (!skipSpin) {
			// A behavior recipe's own events are the proof its runtime path is
			// reachable — importable is not the same as executed.
			const expectEvents = [];
			for (const symbol of spec.symbols) {
				for (const tag of symbol.behaviors) {
					const recipe = getRecipe(tag);
					if (recipe?.status === 'verified') {
						expectEvents.push(...(recipe.webHooks?.bookEvents ?? []));
					}
				}
			}
			const criteria = spec.freeSpins ? 'freegame' : 'basegame';
			results.push(
				runSpin({
					mathSdkDir,
					gameDir,
					python,
					betmode: Object.keys(spec.game.betModes)[0],
					criteria,
					expectEvents: [...new Set(expectEvents)],
				}),
			);
		}
	}

	// ── web ─────────────────────────────────────────────────────────────────
	if (webSdkDir) {
		const tsc = resolveTsc(webSdkDir);
		if (!tsc) {
			results.push({
				name: 'tsc --noEmit',
				ok: false,
				detail:
					'no typescript found under the web-sdk checkout. Run `pnpm install` in it first — ' +
					'the pinned tsc is used deliberately, since a newer one reports different errors.',
			});
		} else {
			results.push(
				tscDiff({
					webSdkDir,
					appName: spec.game.name,
					baselineApp: mechanic.webApp,
					tsc,
				}),
			);
		}
	}

	// ── report ──────────────────────────────────────────────────────────────
	console.log('');
	for (const r of results) {
		const tag = r.ok ? chalk.green('✓ PASS') : chalk.red('✗ FAIL');
		console.log(`${tag}  ${chalk.bold(r.name)}`);
		console.log(`        ${r.ok ? chalk.dim(r.detail) : chalk.red(r.detail)}`);
		if (!r.ok && r.traceback) {
			console.log(chalk.dim(r.traceback.split('\n').map((l) => `        ${l}`).join('\n')));
		}
	}

	const failed = results.filter((r) => !r.ok);
	console.log(
		`\n${results.length - failed.length}/${results.length} checks passed\n`,
	);
	return { ok: failed.length === 0, results };
}
