import fs from 'fs-extra';
import path from 'node:path';
import chalk from 'chalk';

import { loadGameSpec } from '../lib/loadSpec.js';
import { renderDesignedReelCsv, multiplierLadder, renderLadder } from '../lib/reelDesign.js';
import { balanceSpec } from '../lib/mathBalance.js';
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
	renderSuperspinReelCsv,
	hasSuperspinMode,
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
	insertAfterLineInMethod,
	insertAfterLine,
	insertAfterImports,
	addDictEntry,
	ensureImport,
} from '../lib/pyPatch.js';

/**
 * Files not carried over from the sample game.
 *
 * game_optimization.py is on this list because it targets the SAMPLE's bet
 * modes by name. Copied into a game with different modes it is not merely
 * stale, it is wrong — the optimiser dies with `KeyError: 'bonus'` looking for
 * a mode that does not exist. Leaving it absent means `forge math:optimise`
 * writes a fresh one from the spec, and its refusal to overwrite an existing
 * file then means what it says: that file is yours, not the sample's.
 */
const SKIP = new Set(['library', '__pycache__', '.pytest_cache', 'game_optimization.py']);

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
	// The SHAPE has to match WHOEVER READS IT — which is not always the mechanic.
	//
	// 0_0_ways' own game_override.py reads mult_values FLAT; every other sample
	// indexes it by gametype. But a recipe can REPLACE that reader: `expanding`
	// owns assign_mult_property (ownMethod: true) and reads nested, and its
	// executables read nested too. Applied to a ways game, the sample's only flat
	// reader is gone and all three remaining readers are the recipe's — so
	// emitting the mechanic's flat shape produced KeyError: 'freegame' on the
	// first free spin. Verified by grepping every reader in the generated game.
	//
	// So: a recipe that declares a shape wins over the mechanic's.
	const hasMultiplierSymbol = spec.symbols.some((s) => s.special.includes('multiplier'));
	// Computed unconditionally: the wincap condition emits its own mult_values and
	// needs the same shape even when no ordinary condition does.
	const recipeShape = recipes.map((r) => r.emitted?.multValuesShape).find((v) => v !== undefined);
	const shape = recipeShape ?? mechanic.multValuesShape;
	if (hasMultiplierSymbol) {
		// The ladder is chosen from the mechanic and the volatility, not fixed —
		// a compounding mechanic needs a far shorter one. See multiplierLadder.
		const ladder = renderLadder(multiplierLadder(spec, mechanic));
		conditionKeys.push(
			shape === 'flat'
				? `"mult_values": ${ladder},`
				: `"mult_values": {self.basegame_type: {1: 1}, self.freegame_type: ${ladder}},`,
		);
	}

	for (const recipe of recipes) {
		for (const key of recipe.emitted?.requiredConditions ?? []) {
			if (key === 'landing_wilds') {
				conditionKeys.push('"landing_wilds": {0: 100, 1: 20, 2: 5},');
			}
			if (key === 'prize_values') {
				// Weighted prize ladder for a hold-and-win round, shaped after
				// 0_0_expwilds' superspin distribution: small values common, the top
				// of the ladder rare. Values are multiples of the bet.
				conditionKeys.push(
					'"prize_values": {1: 700, 2: 200, 3: 50, 5: 30, 10: 20, 25: 10, 50: 5, 100: 5, 500: 2, 1000: 1},',
				);
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
		['self.bet_modes', renderBetModes(spec, { conditionKeys: [...new Set(conditionKeys)], multValuesShape: shape })],
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
function writeReels(gameDir, spec, { alpha } = {}) {
	const reelsDir = path.join(gameDir, 'reels');
	fs.ensureDirSync(reelsDir);
	for (const file of fs.readdirSync(reelsDir)) {
		if (file.endsWith('.csv')) fs.removeSync(path.join(reelsDir, file));
	}

	// The superspin strips are blanks and prizes, not ordinary symbols — see
	// renderSuperspinReelCsv. They are only written for a game that actually has
	// a hold-and-win mode, because they need a prize symbol to put on them.
	const superspin = hasSuperspinMode(spec);
	const strips = superspin
		? ['BR0', 'FR0', 'FRWCAP', 'WCAP', 'SSR', 'SSWCAP']
		: ['BR0', 'FR0', 'FRWCAP', 'WCAP'];

	const written = [];
	for (const strip of strips) {
		// Designed strips, not uniform noise: frequency falls as payout rises, and
		// the cap strips carry wild stacks tall enough to fill a whole reel. That
		// last part is what makes force_wincap terminate — see reelDesign.js.
		const contents = strip.startsWith('SS')
			? renderSuperspinReelCsv(spec, { seed: strip })
			: renderDesignedReelCsv(spec, { stripId: strip, alpha });
		fs.writeFileSync(path.join(reelsDir, `${strip}.csv`), contents, 'utf8');
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

		// The appended functions may need imports the sample's own game_events.py
		// never had. Missing these is a NameError on the first round that emits
		// the event — late, and only under the one bet mode that reaches it.
		let source = result.source;
		for (const imp of spec.imports ?? []) {
			source = ensureImport(source, imp.module, imp.names).source;
		}
		fs.writeFileSync(file, source, 'utf8');
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
function applyGamestatePatches(gameDir, patches, imports, constants) {
	const file = path.join(gameDir, 'gamestate.py');
	let source = fs.readFileSync(file, 'utf8');

	for (const patch of patches) {
		let result;
		if (patch.mode === 'prepend') {
			result = prependToMethod(source, patch.method, patch.body, patch.id);
		} else if (patch.mode === 'replace-line') {
			result = replaceLineInMethod(source, patch.method, patch.lineRe, patch.body, patch.id);
		} else if (patch.mode === 'wrap-after') {
			result = insertAfterLineInMethod(source, patch.method, patch.afterRe, patch.body, patch.id);
		} else if (patch.mode === 'add-method') {
			// A whole new method on the class, rather than a splice into one that
			// already exists. run_superspin has no counterpart in any sample the
			// scaffolder clones, so there is nothing to splice into.
			const appended = appendMethodsToClass(source, patch.className, patch.source, patch.probe);
			// changed:false with the class present means the method is already
			// there — idempotent, not a failure. A missing class IS a failure.
			result = { source: appended.source, replaced: !appended.missingClass };
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

	for (const constant of constants ?? []) {
		const name = constant.split(/\s*=/)[0];
		if (!new RegExp(`^${name}\\s*=`, 'm').test(source)) {
			source = insertAfterImports(source, [constant]);
		}
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

		if (patch.anchor === 'method') {
			// A standalone method on GameStateOverride, with no special-symbol
			// mapping attached. reset_superspin is called by the game loop
			// directly rather than dispatched by symbol.
			source = replaceOrInsertMethod(source, 'GameStateOverride', patch.pythonMethod, patch.probe).source;
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


/**
 * Patches into game_config.py that a recipe needs beyond what the spec drives.
 *
 * Kept separate from the spec-driven config generation because these are
 * conditional on a behavior being present: a game with no sticky recipe should
 * not carry a superspin reel strip it never draws from.
 */
function applyConfigPatches(gameDir, patches) {
	if (!patches.length) return;
	const file = path.join(gameDir, 'game_config.py');
	let source = fs.readFileSync(file, 'utf8');

	for (const patch of patches) {
		if (patch.mode === 'dict-entry') {
			const result = addDictEntry(source, patch.assignment, patch.key, patch.value);
			if (!result.added && !result.alreadyPresent) {
				throw new Error(
					`game_config.py: could not apply "${patch.id}" — no ${patch.assignment} = {...} ` +
						`assignment to add "${patch.key}" to. Refusing to write half-applied logic.`,
				);
			}
			source = result.source;
			continue;
		}
		if (patch.mode === 'after-line') {
			const result = insertAfterLine(source, patch.lineRe, patch.body, patch.id);
			if (!result.replaced) {
				throw new Error(
					`game_config.py: could not apply "${patch.id}" — no line matching ${patch.lineRe}. ` +
						`Refusing to write half-applied logic.`,
				);
			}
			source = result.source;
			continue;
		}
		throw new Error(`unknown config patch mode "${patch.mode}"`);
	}

	fs.writeFileSync(file, source, 'utf8');
}


/** Register "WCAP" -> FRWCAP.csv in game_config.py's reels dict if it is absent. */
function ensureCapReelKey(gameDir) {
	const file = path.join(gameDir, 'game_config.py');
	const source = fs.readFileSync(file, 'utf8');
	const result = addDictEntry(source, 'reels', 'WCAP', '"FRWCAP.csv"');
	if (result.added) fs.writeFileSync(file, result.source, 'utf8');
	return result.added;
}

/**
 * Wire the spec's multiplier strategy into the generated game.
 *
 * Two separate things, because they live in different files and only one of
 * them exists by default:
 *
 *   multiplierStrategy   The evaluators take `multiplier_method` and default it
 *                        to "symbol" (lines.py:33). No sample overrides it, so
 *                        symbol multipliers always sum. Passing "combined" is
 *                        what applies the global multiplier on top.
 *
 *   globalMultiplierPerSpin  NOTHING calls update_global_mult() by default — of
 *                        all the samples only 0_0_scatter does, once per tumble.
 *                        Without generating the call the global multiplier sits
 *                        at 1 forever and "combined" buys nothing, which is the
 *                        kind of silently-inert setting worth refusing to ship.
 */
function applyMultiplierStrategy(gameDir, spec) {
	const strategy = spec.game.multiplierStrategy ?? 'symbol';
	const applied = [];

	const mechanic = spec._mechanic ?? getMechanic(spec.game.mechanic);
	const param = mechanic.multiplierParam;

	if (strategy !== 'symbol' && param) {
		const file = path.join(gameDir, 'game_executables.py');
		if (fs.existsSync(file)) {
			const source = fs.readFileSync(file, 'utf8');
			// Argument ORDER differs between evaluators — lines takes
			// (self.board, self.config, ...) and ways takes (self.config, self.board, ...)
			// — so match either, and never double-apply.
			// Argument ORDER differs between evaluators — lines takes
			// (self.board, self.config, ...) and ways takes (self.config, self.board)
			// — and the ways call has no trailing comma at all, so match both the
			// "more args follow" and the "call ends here" shapes. The lookahead
			// stops a second run double-applying it.
			const patched = source.replace(
				new RegExp(
					`(\\.\\w+\\(\\s*self\\.(?:board|config),\\s*self\\.(?:board|config))(\\s*[,)])(?![^)]*${param})`,
					'g',
				),
				(match, head, tail) =>
					tail.trim() === ')'
						? `${head}, ${param}="${strategy}")`
						: `${head}, ${param}="${strategy}",`,
			);
			if (patched !== source) {
				fs.writeFileSync(file, patched, 'utf8');
				applied.push(`${param}="${strategy}"`);
			}
		}
	}

	if (spec.game.globalMultiplierPerSpin) {
		const file = path.join(gameDir, 'gamestate.py');
		const source = fs.readFileSync(file, 'utf8');
		// INSIDE the spin loop, not at the top of run_freespin. Prepending it to
		// the method fires it once per ROUND, so a 15-spin feature reached 2x
		// rather than 15x — the setting is called globalMultiplierPerSpin and it
		// was per round. update_freespin() is the first statement of every
		// iteration of `while self.fs < self.tot_fs`, in every sample, so
		// inserting after it is one increment per spin by construction.
		const result = insertAfterLineInMethod(
			source,
			'run_freespin',
			/^\s*self\.update_freespin\(\)/,
			['self.update_global_mult()'],
			'multiplier:global_per_spin',
		);
		if (!result.replaced) {
			throw new Error(
				'gamestate.py has no run_freespin() with an update_freespin() call to increment the ' +
					'global multiplier after — globalMultiplierPerSpin needs a free-spin round with a ' +
					'per-spin loop.',
			);
		}
		fs.writeFileSync(file, result.source, 'utf8');
		applied.push('update_global_mult() per free spin');
	}

	return applied;
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
				// The same symbol, named for what the recipe does with it. A recipe
				// reads whichever it means, so a prize recipe never has to pretend
				// its symbol is a wild.
				prizeSymbol: symbol.name,
				gameName: spec.game.name,
				gameTypes: mechanic.gameTypes,
				respins: spec.holdAndWin?.respins,
				superspinModes: Object.entries(spec.game.betModes)
					.filter(([, mode]) => mode.superspin)
					.map(([name]) => name),
			});

			for (const file of emitted.files ?? []) {
				const dest = path.join(gameDir, file.path);
				if (file.mode === 'create' && fs.existsSync(dest)) continue;
				fs.writeFileSync(dest, file.contents, 'utf8');
			}
			applyModuleFunctions(gameDir, emitted.moduleFunctions ?? []);
			applyClassMethods(gameDir, emitted.classMethods ?? []);
			applyOverridePatches(gameDir, emitted.overridePatches ?? []);
			applyGamestatePatches(
				gameDir,
				emitted.gamestatePatches ?? [],
				emitted.gamestateImports,
				emitted.gamestateConstants,
			);
			applyConfigPatches(gameDir, emitted.configPatches ?? []);

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

	// The cap strip's registered KEY differs per sample — 0_0_lines registers
	// "WCAP": "FRWCAP.csv" while 0_0_ways registers "FRWCAP": "FRWCAP.csv" for the
	// same file. The wincap distribution has to name one of them, so rather than
	// depend on which sample this game was cloned from, guarantee the canonical
	// key exists. Without it the simulation dies with KeyError on the first round.
	ensureCapReelKey(gameDir);

	const recipeResults = applyRecipes(gameDir, spec);
	const multiplierEdits = applyMultiplierStrategy(gameDir, spec);
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

	// Calibrate the strip frequencies against the target RTP before writing them.
	// The volatility profile's own alpha only sets the SHAPE of the payout curve;
	// it knows nothing about the board geometry or the size of the symbol set, and
	// on a 5x4 ways board that gap was a factor of 140. balanceSpec measures what
	// the strip actually pays and picks the alpha that lands closest.
	const balance = balanceSpec(spec);
	const reels = writeReels(gameDir, spec, { alpha: balance.calibrated.alpha });
	console.log(
		chalk.green('✓'),
		`wrote ${reels.length} designed reel strips (${reels.join(', ')})`,
	);
	console.log(
		chalk.cyan('  ·'),
		`calibrated to alpha ${balance.calibrated.alpha}: base game models ` +
			`${balance.calibrated.ev.toFixed(3)}x per spin against a ${balance.target.baseEv} target ` +
			`(${balance.ratio.toFixed(2)}x)`,
	);
	if (!balance.inBand) {
		// Loud, because the alternative is finding out an hour later when the Rust
		// optimiser fails to converge and says nothing about paytables.
		console.log(
			chalk.yellow('  !'),
			`this paytable is ${balance.ratio.toFixed(1)}x off what the board can pay at ` +
				`${(spec.game.rtp * 100).toFixed(1)}% RTP — the optimiser will not converge.`,
		);
		for (const finding of balance.findings) console.log(chalk.yellow('    ·'), finding);
		console.log(
			chalk.yellow('    ·'),
			`Fix before simulating: forge math:balance --spec ${path.basename(specPath)} --apply`,
		);
	}
	if (multiplierEdits.length) {
		console.log(chalk.green('✓'), `multipliers: ${multiplierEdits.join(', ')}`);
	}

	console.log(chalk.bold.cyan('\nNext:'));
	console.log(`  forge verify --spec ${path.basename(specPath)} --math-sdk ${mathSdkDir}`);
	console.log(`  cd ${mathSdkDir} && python games/${gameId}/run.py   # real simulation\n`);

	return { gameDir, gameId, recipeResults };
}
