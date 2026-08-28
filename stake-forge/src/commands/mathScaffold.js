import fs from 'fs-extra';
import path from 'node:path';
import chalk from 'chalk';

import { loadGameSpec } from '../lib/loadSpec.js';
import { getMechanic } from '../lib/mechanics.js';
import { DEFAULT_20_LINES } from '../lib/generators.js';
import { getRecipe, isGenerable } from '../lib/behaviorRecipes.js';
import {
	renderPaytable,
	renderSpecialSymbols,
	renderPaylines,
	renderFreespinTriggers,
	renderAnticipationTriggers,
	renderReelCsv,
	renderNumRows,
	renderBetModes,
} from '../lib/mathGenerators.js';
import {
	replaceAssignment,
	appendToMethod,
	prependToMethod,
	replaceLineInMethod,
	insertMethod,
	appendMethodsToClass,
	appendModuleFunctions,
	replaceOrInsertAssignment,
	replaceOrInsertMethod,
	ensureImport,
} from '../lib/pyPatch.js';

const SKIP = new Set(['library', '__pycache__', '.pytest_cache']);

/**
 * The math-sdk resolves a game's own folder from its `game_id`
 * (Config.construct_paths joins PATH_TO_GAMES with self.game_id), so the
 * directory name and the game_id are the same string, not two independent ones.
 */
export function mathGameId(spec) {
	return spec.game.gameId ?? spec.game.name.replace(/-/g, '_');
}

function copySample(sdkDir, sample, targetId, { force }) {
	const src = path.join(sdkDir, 'games', sample);
	const dest = path.join(sdkDir, 'games', targetId);
	if (!fs.existsSync(src)) {
		throw new Error(
			`Sample game "${sample}" not found at ${src}. Is --math-sdk pointing at a checkout of StakeEngine/math-sdk?`,
		);
	}
	if (fs.existsSync(dest)) {
		if (!force) {
			throw new Error(`games/${targetId} already exists. Re-run with --force to overwrite it.`);
		}
		fs.removeSync(dest);
	}
	fs.copySync(src, dest, { filter: (p) => !SKIP.has(path.basename(p)) });
	return dest;
}

function maxWinAcross(spec) {
	const wins = Object.values(spec.game.betModes)
		.map((m) => m.maxWin)
		.filter((v) => typeof v === 'number');
	return wins.length ? Math.max(...wins) : 5000;
}

/** Patch game_config.py from the spec. Every edit reports whether it landed. */
function patchGameConfig(gameDir, spec, mechanic, { recipes }) {
	const configPath = path.join(gameDir, 'game_config.py');
	let source = fs.readFileSync(configPath, 'utf8');
	const applied = [];
	const skipped = [];

	const conditionKeys = [];

	// `mult_values` is needed whenever ANY symbol carries special: [multiplier] —
	// not only when a behavior recipe asks for it. That flag is what puts
	// assign_mult_property into special_symbol_functions, and every sample's own
	// game_override.py reads the condition unguarded, so a game without it dies
	// with KeyError: 'mult_values' on the first simulated round.
	//
	// The SHAPE has to match that sample's reader: 0_0_ways reads it flat,
	// everything else indexes it by gametype. See mechanics.js.
	const hasMultiplierSymbol = spec.symbols.some((s) => s.special.includes('multiplier'));
	if (hasMultiplierSymbol) {
		conditionKeys.push(
			mechanic.multValuesShape === 'flat'
				? '"mult_values": {1: 20, 2: 50, 3: 80, 5: 40, 10: 10},'
				: '"mult_values": {self.basegame_type: {1: 1}, self.freegame_type: {2: 100, 3: 50, 5: 20, 10: 5}},',
		);
	}

	for (const recipe of recipes) {
		for (const key of recipe.emitted?.requiredConditions ?? []) {
			if (key === 'landing_wilds') {
				conditionKeys.push('"landing_wilds": {0: 100, 1: 20, 2: 5},');
			}
		}
	}

	const edits = [
		['self.game_id', `"${mathGameId(spec)}"`],
		// provider_name and game_name are only set on the Config BASE class, so no
		// sample game overrides them — which means a scaffolded game inherited
		// "sample_provider" / "sample_lines" and, worse, carried them into
		// config_fe_*.json, so a synced frontend config claimed to be the sample.
		['self.provider_name', `"${spec.game.providerName ?? 'your_studio'}"`],
		['self.game_name', `"${spec.game.name.replace(/-/g, '_')}"`],
		['self.provider_number', String(spec.game.providerNumber ?? 0)],
		['self.working_name', `"${spec.game.workingName ?? spec.game.name}"`],
		['self.wincap', Number(maxWinAcross(spec)).toFixed(1)],
		['self.win_type', `"${mechanic.winType}"`],
		['self.rtp', String(spec.game.rtp)],
		['self.num_reels', String(spec.game.reels.count)],
		['self.num_rows', renderNumRows(spec)],
		['self.paytable', renderPaytable(spec)],
		['self.special_symbols', renderSpecialSymbols(spec)],
		['self.bet_modes', renderBetModes(spec, { conditionKeys: [...new Set(conditionKeys)] })],
	];

	if (mechanic.supportsPaylines) {
		edits.push(['self.paylines', renderPaylines(spec, DEFAULT_20_LINES)]);
	}

	const triggers = renderFreespinTriggers(spec);
	if (triggers) {
		edits.push(['self.freespin_triggers', triggers]);
		edits.push(['self.anticipation_triggers', renderAnticipationTriggers(spec)]);
	}

	const inserted = [];
	for (const [target, value] of edits) {
		const result = replaceOrInsertAssignment(source, '__init__', target, value);
		if (result.action === 'replaced') {
			source = result.source;
			applied.push(target);
		} else if (result.action === 'inserted') {
			source = result.source;
			applied.push(target);
			inserted.push(target);
		} else {
			skipped.push(target);
		}
	}

	fs.writeFileSync(configPath, source, 'utf8');
	return { applied, skipped, inserted };
}

/**
 * Reel strips. GameConfig.read_reels_csv() runs during __init__, so a game with
 * no reel files cannot even be constructed — these must exist before any
 * verification step can run. The sample's own strips are removed first because
 * they carry the SAMPLE's symbol names, and Config.validate_reel_symbols()
 * rejects any symbol not declared in this spec.
 */
function writeReels(gameDir, spec) {
	const reelsDir = path.join(gameDir, 'reels');
	fs.ensureDirSync(reelsDir);
	for (const file of fs.readdirSync(reelsDir)) {
		if (file.endsWith('.csv')) fs.removeSync(path.join(reelsDir, file));
	}

	const written = [];
	for (const strip of ['BR0', 'FR0', 'FRWCAP', 'WCAP', 'SSR', 'SSWCAP']) {
		fs.writeFileSync(path.join(reelsDir, `${strip}.csv`), renderReelCsv(spec, { seed: strip }), 'utf8');
		written.push(`${strip}.csv`);
	}
	return written;
}

/** Add `import random` and friends that have no `from X import Y` form. */
function ensurePlainImport(source, statement) {
	if (new RegExp(`^${statement.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').test(source)) {
		return source;
	}
	return `${statement}\n${source}`;
}

/** Append a recipe's top-level functions to a module, creating it if absent. */
function applyModuleFunctions(gameDir, specs) {
	for (const spec of specs) {
		const file = path.join(gameDir, spec.file);
		const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
		const result = appendModuleFunctions(existing, spec.source, spec.probe);
		if (result.action === 'already-present') continue;
		fs.writeFileSync(file, result.source, 'utf8');
	}
}

/** Append a recipe's methods to an existing class, keeping the file's own methods. */
function applyClassMethods(gameDir, specs) {
	for (const spec of specs) {
		const file = path.join(gameDir, spec.file);
		if (!fs.existsSync(file)) {
			throw new Error(`${spec.file} not found in the sample game — cannot append recipe methods.`);
		}
		let source = fs.readFileSync(file, 'utf8');

		const result = appendMethodsToClass(source, spec.className, spec.source, spec.probe);
		if (result.missingClass) {
			throw new Error(`${spec.file} has no class ${spec.className} to extend.`);
		}
		if (!result.changed) continue; // already applied
		source = result.source;

		for (const imp of spec.imports ?? []) {
			source = imp.module
				? ensureImport(source, imp.module, imp.names).source
				: ensurePlainImport(source, imp.statement);
		}
		for (const constant of spec.constants ?? []) {
			const name = constant.split('=')[0].trim();
			if (!new RegExp(`^${name}\\s*=`, 'm').test(source)) {
				// Place module constants after the imports, before the class.
				source = source.replace(/\n(class\s)/, `\n\n${constant}\n\n$1`);
			}
		}

		fs.writeFileSync(file, source, 'utf8');
	}
}

/** Splice a recipe's steps into gamestate.py's run loop. */
function applyGamestatePatches(gameDir, patches, imports) {
	const file = path.join(gameDir, 'gamestate.py');
	let source = fs.readFileSync(file, 'utf8');

	for (const patch of patches) {
		let result;
		if (patch.mode === 'prepend') {
			result = prependToMethod(source, patch.method, patch.body, patch.id);
		} else if (patch.mode === 'replace-line') {
			result = replaceLineInMethod(source, patch.method, patch.lineRe, patch.body, patch.id);
		} else {
			throw new Error(`unknown gamestate patch mode "${patch.mode}"`);
		}

		if (!result.replaced) {
			throw new Error(
				`gamestate.py: could not apply "${patch.id}" — no ${patch.method}() ` +
					`${patch.mode === 'replace-line' ? `containing a line matching ${patch.lineRe}` : ''}. ` +
					`The sample game's structure does not match what the recipe expects; ` +
					`refusing to write half-applied logic.`,
			);
		}
		source = result.source;
	}

	for (const imp of imports ?? []) {
		source = ensureImport(source, imp.module, imp.names).source;
	}

	fs.writeFileSync(file, source, 'utf8');
}

/** Patches into game_override.py that a recipe does not own outright. */
function applyOverridePatches(gameDir, patches) {
	const overridePath = path.join(gameDir, 'game_override.py');
	let source = fs.readFileSync(overridePath, 'utf8');

	for (const patch of patches) {
		if (patch.anchor === 'reset_book') {
			const result = appendToMethod(source, 'reset_book', patch.pythonBody.split('\n'), patch.id);
			if (!result.replaced) {
				throw new Error(
					`game_override.py has no reset_book() to extend — the sample game's ` +
						`GameStateOverride does not match what recipe "${patch.id}" expects.`,
				);
			}
			source = result.source;
			continue;
		}

		if (patch.functionName) {
			const mapping = `{"${patch.symbol}": [self.${patch.functionName}]}`;
			// 0_0_cluster's assign_special_sym_function() is just `pass`, with no
			// assignment to replace — so insert one rather than failing.
			const result = replaceOrInsertAssignment(
				source,
				'assign_special_sym_function',
				'self.special_symbol_functions',
				mapping,
			);
			if (result.action === 'failed') {
				throw new Error(
					'game_override.py has neither a self.special_symbol_functions assignment nor an ' +
						'assign_special_sym_function() method to put one in.',
				);
			}
			source = result.source;
			source = patch.ownMethod
				? replaceOrInsertMethod(source, 'GameStateOverride', patch.pythonMethod, patch.functionName)
						.source
				: insertMethod(source, 'GameStateOverride', patch.pythonMethod, patch.functionName).source;
			source = ensureImport(source, 'src.calculations.statistics', ['get_random_outcome']).source;
		}
	}

	fs.writeFileSync(overridePath, source, 'utf8');
}

/** Apply the math half of every generable behavior recipe. */
function applyRecipes(gameDir, spec) {
	const results = [];
	const mechanic = spec._mechanic ?? getMechanic(spec.game.mechanic);

	for (const symbol of spec.symbols) {
		for (const tag of symbol.behaviors) {
			const recipe = getRecipe(tag);
			if (!recipe) continue;

			if (recipe.tier === 2) {
				results.push({ tag, symbol: symbol.name, action: 'builtin', recipe });
				continue;
			}
			if (!isGenerable(recipe) || !recipe.emitMath) {
				results.push({ tag, symbol: symbol.name, action: 'not-generated', recipe });
				continue;
			}

			const emitted = recipe.emitMath({
				wildSymbol: symbol.name,
				gameName: spec.game.name,
				gameTypes: mechanic.gameTypes,
			});

			for (const file of emitted.files ?? []) {
				const dest = path.join(gameDir, file.path);
				if (file.mode === 'create' && fs.existsSync(dest)) continue;
				fs.writeFileSync(dest, file.contents, 'utf8');
			}
			applyModuleFunctions(gameDir, emitted.moduleFunctions ?? []);
			applyClassMethods(gameDir, emitted.classMethods ?? []);
			applyOverridePatches(gameDir, emitted.overridePatches ?? []);
			applyGamestatePatches(gameDir, emitted.gamestatePatches ?? [], emitted.gamestateImports);

			results.push({ tag, symbol: symbol.name, action: 'generated', recipe, emitted });
		}
	}

	return results;
}

export function mathScaffold({ specPath, mathSdkDir, force }) {
	const spec = loadGameSpec(specPath);
	const mechanic = spec._mechanic;
	const gameId = mathGameId(spec);

	console.log(
		chalk.bold(
			`\nScaffolding math for "${spec.game.name}" (${mechanic.id}) into ${mathSdkDir}/games/${gameId}\n`,
		),
	);
	for (const warning of spec._warnings) console.log(chalk.yellow('  !'), warning);
	if (spec._warnings.length) console.log('');

	const gameDir = copySample(mathSdkDir, mechanic.mathSample, gameId, { force });
	console.log(chalk.green('✓'), `copied games/${mechanic.mathSample} -> games/${gameId}`);

	const recipeResults = applyRecipes(gameDir, spec);
	for (const r of recipeResults) {
		if (r.action === 'generated') {
			console.log(
				chalk.green('✓'),
				`behavior "${r.tag}" on ${r.symbol}: generated from ${r.recipe.referenceSample.math}`,
			);
		} else if (r.action === 'builtin') {
			console.log(chalk.cyan('·'), `behavior "${r.tag}": built-in (tier 2), config only`);
		} else {
			console.log(
				chalk.yellow('  !'),
				`behavior "${r.tag}" on ${r.symbol} is status "${r.recipe.status}" — NOT generated.\n` +
					`      ${r.recipe.referenceSample.math ? `Copy the pattern from ${r.recipe.referenceSample.math}` : 'No sample exists in either SDK'}.`,
			);
		}
	}

	const { applied, skipped, inserted } = patchGameConfig(gameDir, spec, mechanic, {
		recipes: recipeResults,
	});
	console.log(chalk.green('✓'), `patched game_config.py (${applied.length} assignments)`);
	if (inserted.length) {
		console.log(
			chalk.cyan('  ·'),
			`added (absent from games/${mechanic.mathSample}): ${inserted.join(', ')}`,
		);
	}
	if (skipped.length) {
		console.log(
			chalk.yellow('  !'),
			`could not find these in game_config.py, patch by hand: ${skipped.join(', ')}`,
		);
	}

	const reels = writeReels(gameDir, spec);
	console.log(
		chalk.green('✓'),
		`wrote ${reels.length} PLACEHOLDER reel strips (${reels.join(', ')}) — not real math`,
	);

	console.log(chalk.bold.cyan('\nNext:'));
	console.log(`  forge verify --spec ${path.basename(specPath)} --math-sdk ${mathSdkDir}`);
	console.log(`  cd ${mathSdkDir} && python games/${gameId}/run.py   # real simulation\n`);

	return { gameDir, gameId, recipeResults };
}
