import fs from 'fs-extra';
import path from 'node:path';
import chalk from 'chalk';

import { loadGameSpec } from '../lib/loadSpec.js';
import { renderDesignedReelCsv, multiplierLadder, renderLadder } from '../lib/reelDesign.js';
import { balanceSpec } from '../lib/mathBalance.js';
import { LIFETIMES_SURVIVING_CASCADE } from '../lib/behaviorRecipes.js';
import { BOARD_MECHANICS } from '../lib/boardMechanics.js';
import { GRID_CAP_DEFAULT, GRID_GROWTH_DEFAULT, GLOBAL_MULT_GROWTH_DEFAULT } from '../lib/mechanics.js';
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
	insertBeforeLineInMethod,
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
				// ── How many new expanding wilds may land per spin ──────────────
				// The ladder is mechanic-aware, because a full-reel wild is worth
				// wildly different amounts per evaluator.
				//
				// On lines it adds one wild to each payline crossing that reel —
				// strong, and bounded by the payline count. On ways it multiplies
				// that reel's contribution. On CLUSTER a wild joins every group it
				// touches, so a 7-row column is 7 cells of universal adjacency.
				//
				// Measured on a generated 7x7 cluster game: the lines ladder let
				// four wilds accumulate over a round, covering 28 of 49 cells, and
				// the MEDIAN free-spin round hit the 10,000x cap. Every feature was
				// a max win, and the optimiser could not converge because the
				// cheapest free-spin round paid 282x against a 28.9x target.
				//
				// So a tumbling/cluster board gets at most one, rarely.
				conditionKeys.push(
					mechanic.winType === 'cluster' || mechanic.winType === 'scatter'
						? '"landing_wilds": {0: 200, 1: 5},'
						: '"landing_wilds": {0: 100, 1: 20, 2: 5},',
				);
			}
			if (key === 'colossal_size') {
				// 0 means no block this spin. The ladder never offers an edge the
				// board cannot hold: a 3x3 needs three reels AND three rows on each
				// of them, so a 5x3 fits 2 and 3 while a 5x2 fits only 2.
				const max = Math.min(
					recipe.emitted?.maxColossalSize ?? 3,
					spec.game.reels.count,
					Math.min(...spec.game.reels.rows),
				);
				const weights = ['0: 100'];
				// Weighted so the bigger block is the rarer one — a 3x3 covers 60%
				// of a 5x3 board, and at even weights it stops being an event.
				if (max >= 2) weights.push('2: 22');
				if (max >= 3) weights.push('3: 6');
				conditionKeys.push(`"colossal_size": {${weights.join(', ')}},`);
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
			// A method that overrides an ENGINE method usually needs whatever the
			// engine call it replaces was importing — draw_board's reveal_event,
			// for one — so a patch may bring its own imports.
			for (const imp of patch.imports ?? []) {
				source = ensureImport(source, imp.module, imp.names).source;
			}
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

/**
 * Collector and payer symbols, the Money Train family.
 *
 * ── Why this is the cheapest route to the top of the range ──────────────────
 * Money Train 2 reaches 50,000x and Money Train 4 reaches 150,000x on plain
 * PAYLINES with no exotic evaluator. What carries them is a taxonomy of symbol
 * ROLES inside a hold-and-win round, each a small rule, with the interest coming
 * from the interactions. Two of those roles do most of the work:
 *
 *   collector  sweeps every visible money value into itself and pays the total
 *   payer      ADDS its value to every other money value on screen
 *
 * ── The ordering decision, made explicitly ──────────────────────────────────
 * Collector-then-payer and payer-then-collector give materially different RTPs,
 * and there is no neutral choice: payers must resolve FIRST here, so a collector
 * sweeps the values the payers have already raised. That is the more generous
 * ordering and the one the genre is known for — a collector landing after a
 * screen of payers is the moment the round is built around.
 *
 * It is fixed rather than configurable on purpose. An ordering the spec could
 * flip is an RTP the spec could flip by accident, and this is exactly the kind
 * of rule that must be decided once and written down.
 */
function applyCollectorPayer(gameDir, spec) {
	// Triggered by the SYMBOLS, not by a game-level switch: a symbol carrying
	// special: [prize, collector] is the whole declaration, and requiring a second
	// switch elsewhere would let the two disagree.
	const collectors = spec.symbols.filter((s) => s.special.includes('collector')).map((s) => s.name);
	const payers = spec.symbols.filter((s) => s.special.includes('payer')).map((s) => s.name);
	if (!collectors.length && !payers.length) return [];

	const method = [
		'    def apply_collectors_and_payers(self) -> None:',
		'        """Resolve payer and collector symbols against the prizes on the board.',
		'',
		'        Generated by stake-forge from special: [collector] / [payer].',
		'',
		'        ORDER IS FIXED: payers resolve first, so a collector sweeps values',
		'        the payers have already raised. The reverse ordering gives a',
		'        materially different RTP, so this is decided once here rather than',
		'        left to a spec field somebody could flip by accident.',
		'        """',
		'        prizes = [',
		'            (reel, row)',
		'            for reel in range(self.config.num_reels)',
		'            for row in range(self.config.num_rows[reel])',
		'            if self.board[reel][row].check_attribute("prize")',
		'        ]',
		'        if not prizes:',
		'            return',
		'',
		'        # ── payers first ────────────────────────────────────────────────',
		'        payer_cells = [',
		'            (reel, row)',
		'            for reel, row in prizes',
		'            if self.board[reel][row].check_attribute("payer")',
		'        ]',
		'        for preel, prow in payer_cells:',
		'            value = self.board[preel][prow].get_attribute("prize")',
		'            for reel, row in prizes:',
		'                if (reel, row) == (preel, prow):',
		'                    continue',
		'                current = self.board[reel][row].get_attribute("prize")',
		'                self.board[reel][row].assign_attribute({"prize": current + value})',
		'',
		'        # ── then collectors ─────────────────────────────────────────────',
		'        collector_cells = [',
		'            (reel, row)',
		'            for reel, row in prizes',
		'            if self.board[reel][row].check_attribute("collector")',
		'        ]',
		'        if not collector_cells:',
		'            return',
		'        total = sum(',
		'            self.board[reel][row].get_attribute("prize")',
		'            for reel, row in prizes',
		'            if (reel, row) not in collector_cells',
		'        )',
		'        for creel, crow in collector_cells:',
		'            current = self.board[creel][crow].get_attribute("prize")',
		'            self.board[creel][crow].assign_attribute({"prize": current + total})',
		'        # The swept cells are zeroed, not removed: get_final_board_prize',
		'        # sums the board, so leaving them would pay the same money twice.',
		'        for reel, row in prizes:',
		'            if (reel, row) in collector_cells:',
		'                continue',
		'            self.board[reel][row].assign_attribute({"prize": 0.0})',
	].join('\n');

	const overrideFile = path.join(gameDir, 'game_override.py');
	let override = fs.readFileSync(overrideFile, 'utf8');
	const appended = appendMethodsToClass(
		override,
		'GameStateOverride',
		method,
		'apply_collectors_and_payers',
	);
	if (appended.missingClass) {
		throw new Error('game_override.py has no GameStateOverride class for the collector/payer roles.');
	}
	fs.writeFileSync(overrideFile, appended.source, 'utf8');

	// Immediately before the round is paid: the whole point is that the sweep
	// happens once, on the final board, not per respin.
	const gamestateFile = path.join(gameDir, 'gamestate.py');
	const gamestate = fs.readFileSync(gamestateFile, 'utf8');
	const result = insertBeforeLineInMethod(
		gamestate,
		'run_superspin',
		/^\s*prize_win = self\.get_final_board_prize\(\)/,
		['self.apply_collectors_and_payers()'],
		'roles:collector_payer',
	);
	if (!result.replaced) {
		throw new Error(
			'gamestate.py has no run_superspin() calling get_final_board_prize() to resolve the ' +
				'collector and payer roles before. These roles need a hold-and-win bet mode.',
		);
	}
	fs.writeFileSync(gamestateFile, result.source, 'utf8');

	const parts = [];
	if (payers.length) parts.push(`payer ${payers.join('/')}`);
	if (collectors.length) parts.push(`collector ${collectors.join('/')}`);
	return [`${parts.join(' then ')} resolved on the final hold-and-win board`];
}

/**
 * Apply every board mechanic the spec switches on.
 *
 * One piece of plumbing for all of them: emit the method onto GameStateOverride,
 * add whatever imports it needs, and splice its call in at the right point of
 * the round. Adding a mechanic is then a data entry in boardMechanics.js rather
 * than another bespoke function that gets the splicing subtly differently.
 *
 * Call sites, and why each is where it is:
 *
 *   after-draw     right after draw_board(), so the rewrite is on the board that
 *                  is about to be evaluated
 *   after-cascade  right after tumble_game_board(), so it applies to the symbols
 *                  the refill dropped in — the only place a cascade-scoped
 *                  mechanic can see them
 *
 * Both are spliced into run_spin AND run_freespin where they exist, because a
 * mechanic restricted to the feature says so in its own generated code rather
 * than by being spliced into only one loop. That keeps the two decisions
 * separate: where the hook goes is structural, when it fires is the mechanic's.
 */
function applyBoardMechanics(gameDir, spec, mechanic) {
	const enabled = [];
	for (const definition of Object.values(BOARD_MECHANICS)) {
		const raw = spec.game[definition.specKey];
		if (!raw) continue;
		enabled.push({ definition, config: resolveBoardMechanicConfig(definition, raw, spec) });
	}
	if (!enabled.length) return [];

	const overrideFile = path.join(gameDir, 'game_override.py');
	const gamestateFile = path.join(gameDir, 'gamestate.py');
	let override = fs.readFileSync(overrideFile, 'utf8');
	let gamestate = fs.readFileSync(gamestateFile, 'utf8');
	const applied = [];

	for (const { definition, config } of enabled) {
		const probe = definition.call.replace(/^self\./, '').replace(/\(\)$/, '');
		const appended = appendMethodsToClass(
			override,
			'GameStateOverride',
			definition.method(config),
			probe,
		);
		if (appended.missingClass) {
			throw new Error(
				`game_override.py has no GameStateOverride class to add ${definition.id} to.`,
			);
		}
		override = appended.source;
		for (const imp of definition.imports ?? []) {
			override = imp.plain
				? ensurePlainImport(override, `import ${imp.module}`)
				: ensureImport(override, imp.module, imp.names).source;
		}

		// A method that never gets called is the quietest possible failure, so a
		// splice landing NOWHERE is an error rather than a shrug.
		const afterRe =
			definition.site === 'after-cascade'
				? /^\s*self\.tumble_game_board\(/
				: /^\s*self\.draw_board\(/;
		let sites = 0;
		for (const method of ['run_spin', 'run_freespin']) {
			const result = insertAfterLineInMethod(
				gamestate,
				method,
				afterRe,
				[definition.call],
				`board:${definition.id}:${method}`,
			);
			if (result.replaced) {
				gamestate = result.source;
				sites += 1;
			}
		}
		if (!sites) {
			throw new Error(
				`${definition.id} needs a ${definition.site === 'after-cascade' ? 'tumble_game_board()' : 'draw_board()'} ` +
					`call in gamestate.py to hook onto, and this game has none. That usually means the ` +
					`mechanic does not belong on "${mechanic.id}".`,
			);
		}

		// A mechanic carrying per-round state needs it reset at the START of each
		// spin, or the state leaks from one spin of a free-spin round into the
		// next. The cascade ladder is the case that made this necessary: without
		// the reset it climbs all round instead of per sequence, which is a
		// different mechanic wearing the same name.
		for (const line of definition.init ?? []) {
			for (const method of ['run_spin', 'run_freespin']) {
				const init = insertAfterLineInMethod(
					gamestate,
					method,
					/^\s*self\.(draw_board|update_freespin)\(/,
					[line],
					`board:${definition.id}:init:${method}`,
				);
				if (init.replaced) gamestate = init.source;
			}
		}

		// `roundInit` is the OTHER reset, and the distinction matters. `init` fires
		// once per SPIN and is where a per-sequence counter belongs. `roundInit`
		// fires once per ROUND — after reset_book() opens a base round and after
		// reset_fs_spin() opens a free-spin sequence — and is where state that must
		// SURVIVE from one spin to the next belongs, such as which cells hold a
		// sticky wild and what each is currently worth. Putting sticky state in
		// `init` wipes it every spin and the mechanic silently does nothing.
		for (const line of definition.roundInit ?? []) {
			let placed = 0;
			for (const [method, anchor] of [
				['run_spin', /^\s*self\.reset_book\(/],
				['run_freespin', /^\s*self\.reset_fs_spin\(/],
			]) {
				const init = insertAfterLineInMethod(
					gamestate,
					method,
					anchor,
					[line],
					`board:${definition.id}:roundInit:${method}`,
				);
				if (init.replaced) {
					gamestate = init.source;
					placed += 1;
				}
			}
			if (!placed) {
				throw new Error(
					`${definition.id} needs a reset_book() or reset_fs_spin() call in gamestate.py to ` +
						`reset its per-round state, and this game has neither. Without the reset the ` +
						`state carries from one round into the next, which inflates RTP silently.`,
				);
			}
		}
		applied.push(`${definition.name} (${sites} site${sites === 1 ? '' : 's'})`);
	}

	fs.writeFileSync(overrideFile, override, 'utf8');
	fs.writeFileSync(gamestateFile, gamestate, 'utf8');
	return applied;
}

/**
 * Fill in the defaults a board mechanic needs, from the spec.
 *
 * Every mechanic here needs to know the game's wild and its payable symbols, and
 * making each entry re-derive that would be five copies of the same lookup.
 */
function resolveBoardMechanicConfig(definition, raw, spec) {
	const options = raw === true ? {} : raw;
	const wild = spec.symbols.find((s) => s.special.includes('wild'))?.name ?? 'W';
	const scatters = spec.symbols.filter((s) => s.special.includes('scatter')).map((s) => s.name);
	const prizes = spec.symbols.filter((s) => s.special.includes('prize')).map((s) => s.name);
	const payable = spec.symbols
		.filter((s) => s.paytable && !s.special.includes('scatter') && !s.special.includes('wild'))
		.map((s) => s.name);
	const lows = spec.symbols.filter((s) => s.role === 'low').map((s) => s.name);
	const highs = spec.symbols.filter((s) => s.role === 'high').map((s) => s.name);

	// Never overwrite a scatter or a prize: a scatter count is what triggers the
	// feature and force_special_board() places them deliberately, so a mechanic
	// quietly eating one changes the trigger rate. A prize carries a value.
	const base = { wild, protected: [...scatters, ...prizes], inBaseGame: options.inBaseGame ?? false };

	switch (definition.id) {
		case 'random_wild': {
			const weights = options.weights ?? { 0: 60, 1: 30, 2: 10 };
			return {
				...base,
				weights: Object.keys(weights),
				weightValues: Object.values(weights),
				max: Math.max(...Object.keys(weights).map(Number)),
			};
		}
		case 'mystery_symbol': {
			// The cover has to be a symbol the game declares, or the strips cannot
			// carry it and it never lands.
			const pool = options.revealsAs ?? payable;
			return {
				...base,
				cover: options.symbol ?? 'M',
				pool,
				// Weighted toward the cheap end by default: a mystery that reveals as
				// the top symbol as often as the bottom one is a different, far richer
				// game than the name suggests.
				poolWeights: options.weights ?? pool.map((_, i) => Math.max(1, pool.length - i)),
			};
		}
		case 'symbol_upgrade': {
			const map = options.map ?? Object.fromEntries(lows.map((l, i) => [l, highs[i % Math.max(highs.length, 1)] ?? l]));
			return { ...base, map, chance: options.chance ?? 0.05 };
		}
		case 'symbol_transform':
			return {
				...base,
				from: options.from ?? lows,
				to: options.to ?? highs[highs.length - 1] ?? payable[0],
				chance: options.chance ?? 0.05,
			};
		case 'wild_spawner':
			return { ...base, count: options.count ?? 3, afterCascades: options.afterCascades ?? 4 };
		case 'sticky_multiplier_wild':
			return {
				...base,
				// Starts at 2, not 1. apply_added_symbol_mult() ignores any symbol
				// multiplier that is not GREATER than 1, so a ladder starting at 1
				// would pay nothing on the spin a wild lands and the mechanic would
				// look broken for exactly one spin per wild.
				start: options.start ?? 2,
				step: options.step ?? 1,
				cap: options.cap ?? 25,
				// Free spins only by default. Sticky wilds in the base game are a much
				// bigger RTP commitment than they look, because the base game is where
				// almost every spin happens.
				freeSpinsOnly: options.inBaseGame ? false : true,
			};
		case 'progressive_cascade_multiplier':
			// Gonzo's own ladder as the default: 1, 2, 3, 5. Held at the top rung
			// rather than running off the end, so a long sequence is rewarded
			// without being unbounded.
			return { ...base, ladder: options.ladder ?? [1, 2, 3, 5] };
		default:
			return base;
	}
}

/**
 * Free spins that RESET when a qualifying symbol lands.
 *
 * ── Where this comes from ───────────────────────────────────────────────────
 * Scroll Keeper (Paperclip Gaming) — a title Stake reports passing a million
 * bets in its first week on the Engine — resets its free spins to 3 every time a
 * new wild lands. The round only ends after three consecutive spins with no new
 * wild, so a rich board extends itself.
 *
 * That is the hold-and-win respin-reset rule applied to a FREE-SPIN round rather
 * than to a separate bet mode, and it is a different feel from a fixed count:
 * the player is watching a countdown that keeps being pushed back rather than
 * ticking down.
 *
 * ── Why it needs a bound the sample's version does not ──────────────────────
 * Nothing in the SDK stops `tot_fs` growing forever, and this rule grows it on
 * an event that a wild-dense free-game strip produces often. The generated code
 * therefore counts resets and stops honouring them past a ceiling — without it
 * the round is a branching process with no guarantee of termination, which is
 * the same failure that hung a simulation over the retrigger rule.
 */
function applyFreeSpinReset(gameDir, spec) {
	const reset = spec.freeSpins?.resetOnSymbol;
	if (!reset) return [];

	const symbol = reset.symbol;
	const to = reset.spins ?? 3;
	const maxResets = reset.maxResets ?? 20;

	const method = [
		'    def check_freespin_reset(self) -> None:',
		`        """Reset the free-spin counter when a ${symbol} lands.`,
		'',
		'        Generated by stake-forge from freeSpins.resetOnSymbol. The reset',
		'        COUNT is bounded: tot_fs growing on a board event that a wild-dense',
		'        strip produces often is a branching process, and an unbounded one',
		'        does not reliably terminate.',
		'        """',
		'        landed = sum(',
		`            1 for reel in self.board for sym in reel if sym.name == "${symbol}"`,
		'        )',
		'        if landed <= self.fs_reset_seen_symbols:',
		'            self.fs_reset_seen_symbols = landed',
		'            return',
		'        self.fs_reset_seen_symbols = landed',
		`        if self.fs_reset_count >= ${maxResets}:`,
		'            return',
		'        self.fs_reset_count += 1',
		'        # max(), never a plain assignment: a bare tot_fs = fs + N SHORTENS a',
		'        # round that had more than N spins left. Measured before this fix:',
		'        # rounds awarded 12 spins finishing in 4, because an early wild',
		'        # truncated them. A reset must extend a feature or leave it alone.',
		`        self.tot_fs = max(self.tot_fs, self.fs + ${to})`,
	].join('\n');

	const overrideFile = path.join(gameDir, 'game_override.py');
	let override = fs.readFileSync(overrideFile, 'utf8');
	const appended = appendMethodsToClass(override, 'GameStateOverride', method, 'check_freespin_reset');
	if (appended.missingClass) {
		throw new Error('game_override.py has no GameStateOverride class to add the reset to.');
	}
	fs.writeFileSync(overrideFile, appended.source, 'utf8');

	// The counters have to be reset per ROUND, not per spin, or a long session
	// would carry one round's reset budget into the next.
	const gamestateFile = path.join(gameDir, 'gamestate.py');
	let gamestate = fs.readFileSync(gamestateFile, 'utf8');
	const reset0 = prependToMethod(
		gamestate,
		'run_freespin',
		['self.fs_reset_count = 0', 'self.fs_reset_seen_symbols = 0'],
		'freespin_reset:init',
	);
	if (!reset0.replaced) throw new Error('gamestate.py has no run_freespin to bound the reset in.');
	gamestate = reset0.source;

	// After the board is evaluated, so a reset reflects the board just played.
	const call = insertAfterLineInMethod(
		gamestate,
		'run_freespin',
		/^\s*self\.win_manager\.update_gametype_wins\(/,
		['self.check_freespin_reset()'],
		'freespin_reset:check',
	);
	if (!call.replaced) {
		throw new Error(
			'gamestate.py run_freespin has no win_manager.update_gametype_wins() to check the reset after.',
		);
	}
	fs.writeFileSync(gamestateFile, call.source, 'utf8');

	return [`free spins reset to ${to} on a new ${symbol}, up to ${maxResets} times`];
}

/**
 * Global-multiplier growth, from the spec.
 *
 * ── What the engine gives you, and what it does not ─────────────────────────
 * executables.py:104 is the whole implementation:
 *
 *     self.global_multiplier += 1
 *
 * No cap, no alternative. That is fine as a default and wrong as the only
 * option. Samurai Dogs Unleashed (Twist Gaming), which Stake reports inside the
 * Engine platform's top 50 by total bets, DOUBLES on a winning spin and caps at
 * 64x in the base game and 256x in free spins.
 *
 * Rather than patch the SDK, the game gets its own override of the method —
 * which is exactly what game_override.py exists for, and what every sample uses
 * it for. The base implementation stays untouched, so a game that does not ask
 * for this behaves as before.
 */
function applyGlobalMultiplierGrowth(gameDir, spec) {
	const growth = spec.game.globalMultiplier;
	if (!growth) return [];

	const mode = growth.growth ?? GLOBAL_MULT_GROWTH_DEFAULT;
	const baseCap = growth.cap ?? null;
	const freeCap = growth.freegameCap ?? baseCap;
	// Nothing to override: the default rule with no ceiling is what the engine
	// already does, and generating a method that reimplements it identically is
	// a diff for nothing.
	if (mode === 'increment' && baseCap === null) return [];

	const step =
		mode === 'double'
			? '        self.global_multiplier = max(1, self.global_multiplier) * 2'
			: '        self.global_multiplier += 1';

	const capLines =
		baseCap === null
			? []
			: [
					'        # Separate ceilings per game type: a feature sharing the base',
					'        # game\'s cap has nothing extra to offer.',
					`        ceiling = ${freeCap} if self.gametype == self.config.freegame_type else ${baseCap}`,
					'        self.global_multiplier = min(self.global_multiplier, ceiling)',
				];

	const method = [
		'    def update_global_mult(self) -> None:',
		`        """${mode === 'double' ? 'Double' : 'Increment'} the round multiplier${baseCap === null ? '' : `, capped at ${baseCap}x / ${freeCap}x`}.`,
		'',
		'        Overrides src/executables/executables.py, which increments by 1 with no',
		'        ceiling. Generated by stake-forge from game.globalMultiplier.',
		'        """',
		step,
		...capLines,
		'        update_global_mult_event(self)',
	].join('\n');

	const file = path.join(gameDir, 'game_override.py');
	let source = fs.readFileSync(file, 'utf8');
	// GameStateOverride is the class every sample's game_override.py declares, and
	// the right home for a method that replaces one of the engine's own.
	const result = appendMethodsToClass(source, 'GameStateOverride', method, 'update_global_mult');
	if (result.missingClass) {
		throw new Error('game_override.py has no class to override update_global_mult on.');
	}
	source = ensureImport(result.source, 'src.events.events', ['update_global_mult_event']).source;
	fs.writeFileSync(file, source, 'utf8');

	return [
		`global multiplier ${mode === 'double' ? 'doubles' : 'increments'}` +
			(baseCap === null ? ' (uncapped)' : `, capped ${baseCap}x base / ${freeCap}x free`),
	];
}

/**
 * Grid-position multipliers, from the spec.
 *
 * ── What the shipped sample actually does ───────────────────────────────────
 * games/0_0_cluster already implements these, so every cluster game the tool
 * generates has had them all along — 1,066 updateGrid events with a live cell in
 * a 500-round run, top value 110. Two things were never controllable:
 *
 *   the cap     hardcoded `self.maximum_board_mult = 512`
 *   the growth  `+= 1` per hit, despite the sample's own docstring saying
 *               "double the grid value". The docstring is wrong about the code
 *               beneath it; 110 is not a power of two.
 *
 * Incrementing and doubling are completely different volatility shapes — nine
 * hits on one cell is 9x one way and 256x the other — and doubling is the
 * pattern the mechanic is known for. So both are offered, the default stays
 * what the sample does, and the scaffolder says which it generated.
 */
function applyGridMultipliers(gameDir, spec, mechanic) {
	const grid = spec.game.gridMultipliers;
	if (!grid || mechanic.winType !== 'cluster') return [];

	const applied = [];
	const cap = grid.cap ?? GRID_CAP_DEFAULT;
	const growth = grid.growth ?? GRID_GROWTH_DEFAULT;

	// ── the cap ──────────────────────────────────────────────────────────────
	const configPath = path.join(gameDir, 'game_config.py');
	let config = fs.readFileSync(configPath, 'utf8');
	const capLine = /^(\s*)self\.maximum_board_mult\s*=.*$/m;
	if (capLine.test(config)) {
		config = config.replace(capLine, `$1self.maximum_board_mult = ${cap}`);
		fs.writeFileSync(configPath, config, 'utf8');
		applied.push(`cap ${cap}`);
	}

	// ── the growth rule ──────────────────────────────────────────────────────
	// Only when it differs from what the sample does. Rewriting the line to what
	// it already says would be a diff for nothing.
	if (growth === 'double') {
		const execPath = path.join(gameDir, 'game_executables.py');
		let source = fs.readFileSync(execPath, 'utf8');
		const incrementLine =
			/^(\s*)self\.position_multipliers\[pos\["reel"\]\]\[pos\["row"\]\] \+= 1$/m;
		if (!incrementLine.test(source)) {
			throw new Error(
				'game_executables.py has no `position_multipliers[...] += 1` to convert to doubling — ' +
					'the cluster sample changed shape. Read update_grid_mults() and re-derive the patch.',
			);
		}
		source = source.replace(
			incrementLine,
			'$1# stake-forge:grid:double — the sample increments; this doubles.\n' +
				'$1self.position_multipliers[pos["reel"]][pos["row"]] *= 2',
		);
		fs.writeFileSync(execPath, source, 'utf8');
		applied.push('growth doubling');
	} else {
		applied.push('growth incrementing (as the sample does)');
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
				colossalSymbol: symbol.name,
				size: spec.game.colossal?.size,
				gameTypes: spec.game.colossal?.gameTypes ?? mechanic.gameTypes,
				winType: mechanic.winType,
				paysBothWays: Boolean(spec.game.paysBothWays),
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

	// ── board lifetimes ─────────────────────────────────────────────────────
	// Every board-writing recipe declares how long its writes survive. On a
	// tumbling mechanic the cascade redraws the board from the strips, so any
	// lifetime that outlives one evaluation has to be restored after each refill
	// or the mechanic silently vanishes mid-round — which is exactly how the
	// expanding-wild bug presented, and what BOARD_LIFETIMES exists to stop
	// recurring for every board-writing mechanic after it.
	if (mechanic.tumbles) {
		const restored = applyBoardLifetimes(gameDir, results);
		for (const r of restored) results.push(r);
	}

	return results;
}

/**
 * Restore persistent board writes after every cascade refill.
 *
 * tumble_game_board() draws replacement symbols straight off the reel strips, so
 * anything a mechanic stamped onto the board is gone the moment a cascade runs.
 * The fix is mechanical once each recipe states its lifetime: splice its own
 * restore call in after every tumble, in both the base-game and free-spin
 * cascade loops.
 *
 * Deliberately narrow. This restores what a recipe already knows how to write;
 * it does NOT invent gravity semantics for a symbol that should be fallen
 * around rather than overwritten. Sticky symbols on a cascading board need the
 * refill to stack ABOVE the held cell, and that is a different piece of work in
 * tumble.py rather than a splice here.
 */
function applyBoardLifetimes(gameDir, recipeResults) {
	const file = path.join(gameDir, 'gamestate.py');
	if (!fs.existsSync(file)) return [];
	let source = fs.readFileSync(file, 'utf8');
	const applied = [];

	for (const result of recipeResults) {
		const { recipe } = result;
		if (!recipe?.reapplyCall) continue;
		if (!LIFETIMES_SURVIVING_CASCADE.includes(recipe.boardLifetime)) continue;

		// Both loops: the base game cascades too, and a mechanic that survives the
		// round has to survive both.
		let landed = 0;
		for (const method of ['run_spin', 'run_freespin']) {
			const patched = insertAfterLineInMethod(
				source,
				method,
				/^\s*self\.tumble_game_board\(/,
				[recipe.reapplyCall],
				`lifetime:${recipe.id}:${method}`,
			);
			if (patched.replaced) {
				source = patched.source;
				landed += 1;
			}
		}
		if (landed) {
			applied.push({
				tag: recipe.id,
				action: 'lifetime-restored',
				recipe,
				lifetime: recipe.boardLifetime,
				sites: landed,
			});
		}
	}

	if (applied.length) fs.writeFileSync(file, source, 'utf8');
	return applied;
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
	const gridEdits = applyGridMultipliers(gameDir, spec, mechanic);
	const globalMultEdits = applyGlobalMultiplierGrowth(gameDir, spec);
	const resetEdits = applyFreeSpinReset(gameDir, spec);
	const boardEdits = applyBoardMechanics(gameDir, spec, mechanic);
	const roleEdits = applyCollectorPayer(gameDir, spec);
	for (const r of recipeResults) {
		if (r.action === 'generated') {
			console.log(
				chalk.green('✓'),
				// A recipe built from primitives has no sample to name, and printing
				// "generated from null" reads like a bug in the tool rather than a
				// true statement about where the code came from.
				r.recipe.referenceSample.math
					? `behavior "${r.tag}" on ${r.symbol}: generated from ${r.recipe.referenceSample.math}`
					: `behavior "${r.tag}" on ${r.symbol}: generated from engine primitives (no sample exists)`,
			);
		} else if (r.action === 'builtin') {
			console.log(chalk.cyan('·'), `behavior "${r.tag}": built-in (tier 2), config only`);
		} else if (r.action === 'lifetime-restored') {
			// Worth saying out loud: without this the mechanic works on the first
			// board of a round and silently vanishes on the first cascade, which
			// is a bug that looks like a maths problem.
			console.log(
				chalk.green('✓'),
				`board lifetime "${r.lifetime}" for "${r.tag}": ${r.recipe.reapplyCall} restored after ` +
					`every cascade refill (${r.sites} loop${r.sites === 1 ? '' : 's'})`,
			);
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
	if (gridEdits.length) {
		console.log(chalk.green('✓'), `grid multipliers: ${gridEdits.join(', ')}`);
	}
	if (globalMultEdits.length) {
		console.log(chalk.green('✓'), globalMultEdits.join(', '));
	}
	if (resetEdits.length) {
		console.log(chalk.green('✓'), resetEdits.join(', '));
	}
	for (const edit of boardEdits) {
		console.log(chalk.green('✓'), `board mechanic: ${edit}`);
	}
	for (const edit of roleEdits) {
		console.log(chalk.green('✓'), `symbol roles: ${edit}`);
	}

	console.log(chalk.bold.cyan('\nNext:'));
	console.log(`  forge verify --spec ${path.basename(specPath)} --math-sdk ${mathSdkDir}`);
	console.log(`  cd ${mathSdkDir} && python games/${gameId}/run.py   # real simulation\n`);

	return { gameDir, gameId, recipeResults };
}
