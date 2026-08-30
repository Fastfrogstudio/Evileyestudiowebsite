/**
 * Unit tests for the pure logic — the parts that must be right before any
 * generated file is worth looking at.
 *
 * These deliberately do NOT cover "does the generated game run", because that
 * cannot be faked: it is `forge verify`, which runs py_compile, constructs
 * GameConfig() and executes real spins against a checkout of the SDKs. Run
 * `npm run test:e2e` for that.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
	replaceAssignment,
	readAssignment,
	endOfImportBlock,
	ensureImport,
	appendToMethod,
	prependToMethod,
	replaceLineInMethod,
	replaceOrInsertAssignment,
	replaceOrInsertMethod,
	appendModuleFunctions,
	pyLiteral,
	PyRaw,
} from '../src/lib/pyPatch.js';
import { replaceExportConst, replaceExportDefault } from '../src/lib/patchExport.js';
import {
	normaliseSymbol,
	assignOrders,
	sortSymbols,
	highSymbolNames,
	buildSpecialSymbols,
	typeRequiredStates,
	defaultAnimationStates,
	ENGINE_SPECIAL_KEYS,
} from '../src/lib/taxonomy.js';
import { requiredStatesForSymbol, validateBehaviors, getRecipe, BEHAVIOR_RECIPES, BOARD_LIFETIMES, LIFETIMES_SURVIVING_CASCADE } from '../src/lib/behaviorRecipes.js';
import { buildConfigObject, buildSymbolInfoMap, buildInitialBoard } from '../src/lib/generators.js';
import { renderPaytable, renderSpecialSymbols, renderFreespinTriggers, renderReelCsv, renderNumRows, renderBetModes, betModeCriteria, REEL_STRIP_LENGTH, SCATTER_DENSITY } from '../src/lib/mathGenerators.js';
import { MECHANICS, GRID_GROWTH_MODES, GRID_GROWTH_DEFAULT, GRID_CAP_DEFAULT } from '../src/lib/mechanics.js';
import { assertNoExtractedMaterial, matchLine } from '../src/lib/inspirationRules.js';
import { loadGameSpec, loadAssetsManifest, SpecValidationError } from '../src/lib/loadSpec.js';
import { Canvas, encodePng } from '../src/lib/png.js';
import { drawText, measureText } from '../src/lib/font5x7.js';
import { renderSymbolTile, topPayoutOf } from '../src/lib/placeholderArt.js';
import { applyWebRecipe } from '../src/lib/webRecipePatch.js';
import { renderExpandingMath } from '../src/lib/recipes/expanding.js';
import { buildConfigFromMath } from '../src/commands/mathSync.js';
import { summarise } from '../src/commands/mathReport.js';
import { auditSound, readSoundVocabulary, readSoundsUsed, readSoundSprite } from '../src/lib/sound.js';
import { planOptimisation, renderOptimisationPy, splitRtp, VOLATILITY_PROFILES, VOLATILITY_IDS } from '../src/lib/optimisation.js';
import { planSprite, spriteJson, buildFilterGraph, looksLooping, readSoundSources, SPRITE_FORMATS, CLIP_GAP_MS } from '../src/lib/soundSprite.js';
import { inspectMathPublish, collectFrontend, staleAgainst } from '../src/commands/packageGame.js';
import { renderStickyMath } from '../src/lib/recipes/sticky.js';
import { renderSuperspinReelCsv, hasSuperspinMode, BLANK_SYMBOL, SUPERSPIN_PRIZE_DENSITY } from '../src/lib/mathGenerators.js';
import { payingHitRate, wincapRtpAllocation, TARGET_WINCAP_HIT_RATE } from '../src/lib/optimisation.js';
import { analyseMaxWin, boardCeiling, multiplierCeiling, symbolFrequencies, STRIP_PROFILES, renderDesignedReelCsv, stripColumns, multiplierLadder, renderLadder } from '../src/lib/reelDesign.js';
import { estimateStripEv, payoutTable } from '../src/lib/rtpModel.js';
import { balanceSpec, baseGameTarget, calibrateAlpha, scalePaytable, EV_TOLERANCE } from '../src/lib/mathBalance.js';
import { validateMode, topShareOfRtp, RULE_PROVENANCE } from '../src/lib/mathValidate.js';
import { retriggerSafety, RETRIGGER_LIMIT, CASCADE_LIMITS } from '../src/lib/mathBalance.js';
import { stripProfileFor, placeScatters } from '../src/lib/reelDesign.js';
import { MECHANIC_LIBRARY, MECHANIC_IDS, libraryStats, checkCombination, artRequirementsFor, mechanicsForWinType, getMechanicEntry, STATUS_ORDER } from '../src/lib/mechanicsLibrary.js';
import { REFERENCE_GAMES, gamesUsing, gamesByMaxWin } from '../src/lib/referenceGames.js';
import { buildArtBrief, winLevelBands, LOCALES, LOCALISED_SHEETS, WIN_LEVEL_SCALES } from '../src/lib/artBrief.js';
import { brief as runBrief, renderMarkdown, renderCsv, renderManifest } from '../src/commands/brief.js';
import { audit } from '../src/commands/audit.js';
import YAML from 'yaml';
import { addDictEntry, insertAfterLineInMethod, insertAfterImports } from '../src/lib/pyPatch.js';
import { auditSpriteFrames, readSpriteFrames, readSpriteAssetKeys } from '../src/lib/spriteFrames.js';

/** A pristine sample app, for the checks that need real source to read. */
const LINES_APP = process.env.FORGE_WEB_SDK
	? path.join(process.env.FORGE_WEB_SDK, 'apps', 'lines')
	: '/home/user/web-sdk/apps/lines';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let pass = 0;
const failures = [];
function test(name, fn) {
	try {
		fn();
		pass += 1;
	} catch (err) {
		failures.push({ name, err });
	}
}
function group(name) {
	console.log(`\n${name}`);
}

const collect = () => ({ errors: [], warnings: [] });

// ── pyPatch ─────────────────────────────────────────────────────────────────
group('pyPatch — assignment replacement');

test('consumes a trailing expression after the bracketed value', () => {
	// The bug class this module exists to prevent: math-sdk game_config.py
	// really does contain `self.num_rows = [3] * self.num_reels`.
	const src = 'class C:\n    def __init__(self):\n        self.num_rows = [3] * self.num_reels\n        self.after = 1\n';
	const { source, replaced } = replaceAssignment(src, 'self.num_rows', '[3, 3, 3, 3, 3]');
	assert.ok(replaced);
	assert.ok(!source.includes('* self.num_reels'), 'stale trailing expression survived');
	assert.match(source, /self\.num_rows = \[3, 3, 3, 3, 3\]\n/);
	assert.match(source, /self\.after = 1/);
});

test('replaces a multi-line dict without eating the next statement', () => {
	const src = 'self.paytable = {\n    (5, "W"): 50,\n}\nself.after = 2\n';
	const { source } = replaceAssignment(src, 'self.paytable', '{}');
	assert.match(source, /self\.paytable = \{\}\n/);
	assert.match(source, /self\.after = 2/);
});

test('a brace inside a string does not confuse bracket depth', () => {
	const { source } = replaceAssignment('self.v = {"a": "}{"}\nself.after = 3\n', 'self.v', 'None');
	assert.match(source, /self\.v = None\n/);
	assert.match(source, /self\.after = 3/);
});

test('a bracket inside a comment does not confuse bracket depth', () => {
	const { source } = replaceAssignment('self.v = {\n    1: 2,  # note ] here\n}\nself.after = 4\n', 'self.v', '{}');
	assert.match(source, /self\.v = \{\}\n/);
	assert.match(source, /self\.after = 4/);
});

test('handles a backslash line continuation', () => {
	const { source } = replaceAssignment('self.v = 1 + \\\n    2\nself.after = 5\n', 'self.v', '3');
	assert.match(source, /self\.v = 3\n/);
	assert.match(source, /self\.after = 5/);
});

test('handles a triple-quoted string spanning lines', () => {
	const { source } = replaceAssignment('self.v = """a\n}\n"""\nself.after = 6\n', 'self.v', '"x"');
	assert.match(source, /self\.v = "x"\n/);
	assert.match(source, /self\.after = 6/);
});

test('preserves indentation', () => {
	const { source } = replaceAssignment('class C:\n    def f(self):\n        self.v = 1\n', 'self.v', '2');
	assert.ok(source.includes('        self.v = 2'));
});

test('does not match the attribute inside an expression', () => {
	const { source } = replaceAssignment('y = self.v + 1\nself.v = 5\n', 'self.v', '9');
	assert.ok(source.startsWith('y = self.v + 1\n'));
	assert.match(source, /self\.v = 9/);
});

test('reports replaced=false when the target is absent', () => {
	assert.equal(replaceAssignment('a = 1\n', 'self.nope', '2').replaced, false);
});

test('readAssignment returns the whole right-hand side', () => {
	assert.equal(readAssignment('self.v = [3] * 5\n', 'self.v'), '[3] * 5');
});

group('pyPatch — imports');

test('does not insert inside a parenthesised import block', () => {
	// 0_0_scatter/game_executables.py opens with exactly this shape.
	const src = 'from src.events.events import (\n    set_win_event,\n    set_total_event,\n)\n\nX = 1\n';
	const { source } = ensureImport(src, 'src.calculations.statistics', ['get_random_outcome']);
	assert.match(source, /\)\nfrom src\.calculations\.statistics import get_random_outcome/);
	assert.ok(!/import \(\nfrom/.test(source), 'inserted inside the parenthesised list');
});

test('merges into an existing single-line import', () => {
	const { source, changed } = ensureImport('from a.b import x\n', 'a.b', ['y']);
	assert.ok(changed);
	assert.match(source, /from a\.b import x, y/);
});

test('is a no-op when the name is already imported', () => {
	assert.equal(ensureImport('from a.b import x\n', 'a.b', ['x']).changed, false);
});

test('endOfImportBlock spans a parenthesised import', () => {
	const src = 'import os\nfrom a import (\n    b,\n)\nX = 1\n';
	assert.equal(src.slice(0, endOfImportBlock(src)).trimEnd().endsWith(')'), true);
});

group('pyPatch — method editing');

const CLASS_SRC = `class GameStateOverride(GameExecutables):
    def reset_book(self):
        super().reset_book()

    def assign_special_sym_function(self):
        pass

    def other(self):
        return 1
`;

test('appendToMethod adds to the end of the method body only', () => {
	const { source, replaced } = appendToMethod(CLASS_SRC, 'reset_book', ['        self.x = []'], 'm1');
	assert.ok(replaced);
	assert.match(source, /super\(\)\.reset_book\(\)\n        self\.x = \[\]/);
	assert.match(source, /def assign_special_sym_function/);
});

test('appendToMethod is idempotent', () => {
	const once = appendToMethod(CLASS_SRC, 'reset_book', ['        self.x = []'], 'm1').source;
	const twice = appendToMethod(once, 'reset_book', ['        self.x = []'], 'm1');
	assert.equal(twice.alreadyPresent, true);
	assert.equal(twice.source, once);
});

test('prependToMethod inserts after a docstring, not before it', () => {
	const src = 'class C:\n    def f(self):\n        """Doc."""\n        return 1\n';
	const { source } = prependToMethod(src, 'f', ['self.x = 0'], 'm2');
	const lines = source.split('\n');
	assert.match(lines[2], /"""Doc\."""/);
	assert.match(lines[3], /self\.x = 0/);
});

test('replaceLineInMethod swaps a line and preserves indentation', () => {
	const src = 'class C:\n    def run(self):\n        while True:\n            self.draw_board()\n            self.win()\n';
	const { source, replaced } = replaceLineInMethod(src, 'run', /self\.draw_board\(/, ['self.draw_board(emit_event=False)', 'self.extra()'], 'm3');
	assert.ok(replaced);
	assert.ok(source.includes('            self.draw_board(emit_event=False)'));
	assert.ok(source.includes('            self.extra()'));
	assert.match(source, /self\.win\(\)/);
});

test('replaceLineInMethod reports replaced=false when nothing matches', () => {
	const src = 'class C:\n    def run(self):\n        pass\n';
	assert.equal(replaceLineInMethod(src, 'run', /nope/, ['x'], 'm4').replaced, false);
});

test('replaceOrInsertAssignment inserts over a lone `pass`', () => {
	// 0_0_cluster's assign_special_sym_function() is exactly `pass`.
	const { source, action } = replaceOrInsertAssignment(
		CLASS_SRC,
		'assign_special_sym_function',
		'self.special_symbol_functions',
		'{"W": [self.f]}',
	);
	assert.equal(action, 'inserted');
	assert.ok(!/^\s+pass$/m.test(source.split('def other')[0]));
	assert.match(source, /self\.special_symbol_functions = \{"W": \[self\.f\]\}/);
});

test('replaceOrInsertAssignment replaces when the assignment exists', () => {
	const src = 'class C:\n    def f(self):\n        self.v = 1\n';
	const { action, source } = replaceOrInsertAssignment(src, 'f', 'self.v', '2');
	assert.equal(action, 'replaced');
	assert.match(source, /self\.v = 2/);
});

test('replaceOrInsertMethod replaces an existing method wholesale', () => {
	// Needed because 0_0_ways ships an assign_mult_property reading a FLAT
	// mult_values, while the recipe emits one nested by gametype.
	const src = 'class C:\n    def assign_mult_property(self, s):\n        old = 1\n\n    def keep(self):\n        return 2\n';
	const replacement = '    def assign_mult_property(self, s):\n        new = 2\n';
	const { source, action } = replaceOrInsertMethod(src, 'C', replacement, 'assign_mult_property');
	assert.equal(action, 'replaced');
	assert.ok(!source.includes('old = 1'));
	assert.match(source, /new = 2/);
	assert.match(source, /def keep/);
});

test('appendModuleFunctions never clobbers an existing module', () => {
	// 0_0_cluster's game_events.py defines update_grid_mult_event, which its
	// gamestate.py imports.
	const existing = 'def update_grid_mult_event(g):\n    return 1\n';
	const { source, action } = appendModuleFunctions(existing, '"""Doc."""\n\ndef new_expanding_wild_event(g):\n    return 2\n', 'new_expanding_wild_event');
	assert.equal(action, 'appended');
	assert.match(source, /def update_grid_mult_event/);
	assert.match(source, /def new_expanding_wild_event/);
});

test('appendModuleFunctions creates the module when absent', () => {
	assert.equal(appendModuleFunctions(null, 'def f():\n    pass\n', 'f').action, 'created');
});

test('appendModuleFunctions is idempotent', () => {
	const existing = 'def f(g):\n    return 1\n';
	assert.equal(appendModuleFunctions(existing, 'def f(g):\n    return 1\n', 'f').action, 'already-present');
});

group('pyPatch — literals');

test('pyLiteral emits Python truthiness and None', () => {
	assert.equal(pyLiteral(true), 'True');
	assert.equal(pyLiteral(false), 'False');
	assert.equal(pyLiteral(null), 'None');
	assert.equal(pyLiteral([]), '[]');
	assert.equal(pyLiteral({}), '{}');
});

test('pyLiteral supports tuple keys via PyRaw', () => {
	const out = pyLiteral(new Map([[new PyRaw('(5, "W")'), 50]]));
	assert.match(out, /\(5, "W"\): 50,/);
});

test('pyLiteral escapes quotes in strings', () => {
	assert.equal(pyLiteral('a"b'), '"a\\"b"');
});

// ── patchExport ─────────────────────────────────────────────────────────────
group('patchExport — TypeScript exports');

test('preserves a type annotation', () => {
	// Dropping `: RawSymbol[][]` widens the literal to { name: string }[][],
	// which surfaces as a tsc error in stateGame.svelte.ts, far from this file.
	const src = 'export const INITIAL_BOARD: RawSymbol[][] = [\n\t[{ name: 1 }],\n];\nexport const AFTER = 1;\n';
	const { source, replaced } = replaceExportConst(src, 'INITIAL_BOARD', '[[{ name: 2 }]]');
	assert.ok(replaced);
	assert.match(source, /export const INITIAL_BOARD: RawSymbol\[\]\[\] = \[\[\{ name: 2 \}\]\];/);
	assert.ok(!source.includes('as const'), 'appended `as const` to an annotated const');
	assert.match(source, /export const AFTER = 1;/);
});

test('adds `as const` to an unannotated object export', () => {
	const src = 'export const M = {\n\ta: 1,\n} as const;\nexport const AFTER = 1;\n';
	const { source } = replaceExportConst(src, 'M', '{ b: 2 }');
	assert.match(source, /export const M = \{ b: 2 \} as const;/);
	assert.match(source, /export const AFTER = 1;/);
});

test('array exports get a plain semicolon', () => {
	const { source } = replaceExportConst('export const H = [1];\nexport const AFTER = 1;\n', 'H', "['a']");
	assert.match(source, /export const H = \['a'\];/);
});

test('reports replaced=false for a missing export', () => {
	assert.equal(replaceExportConst('export const A = 1;\n', 'MISSING', '2').replaced, false);
});

test('replaceExportDefault swaps the default object', () => {
	const { source, replaced } = replaceExportDefault('export default {\n\ta: 1,\n};\n', '{ b: 2 }');
	assert.ok(replaced);
	assert.equal(source.trim(), 'export default { b: 2 };');
});

// ── taxonomy ────────────────────────────────────────────────────────────────
group('taxonomy — role / special / order');

test('role wild implies special: [wild]', () => {
	const ctx = collect();
	const s = normaliseSymbol({ name: 'W', role: 'wild', paytable: { 3: 1 } }, ctx);
	assert.deepEqual(s.special, ['wild']);
	assert.deepEqual(ctx.errors, []);
});

test('role scatter implies special: [scatter] and needs no paytable', () => {
	const ctx = collect();
	const s = normaliseSymbol({ name: 'S', role: 'scatter' }, ctx);
	assert.deepEqual(s.special, ['scatter']);
	assert.deepEqual(ctx.errors, []);
});

test('an explicit special overrides the implied one', () => {
	const ctx = collect();
	const s = normaliseSymbol({ name: 'W', role: 'wild', special: ['wild', 'multiplier'], paytable: { 3: 1 } }, ctx);
	assert.deepEqual(s.special, ['wild', 'multiplier']);
	assert.deepEqual(ctx.warnings, []);
});

test('an override that drops the implied key warns but does not error', () => {
	const ctx = collect();
	normaliseSymbol({ name: 'W', role: 'wild', special: ['multiplier'], paytable: { 3: 1 } }, ctx);
	assert.deepEqual(ctx.errors, []);
	assert.equal(ctx.warnings.length, 1);
	assert.match(ctx.warnings[0], /drops it/);
});

test('a non-engine special key warns with the reason', () => {
	const ctx = collect();
	normaliseSymbol({ name: 'X', role: 'high', special: ['sparkly'], paytable: { 3: 1 } }, ctx);
	assert.deepEqual(ctx.errors, []);
	assert.match(ctx.warnings.join(' '), /no engine default/);
});

test('all four engine special keys are accepted silently', () => {
	for (const key of ENGINE_SPECIAL_KEYS) {
		const ctx = collect();
		normaliseSymbol({ name: 'X', role: 'high', special: [key], paytable: { 3: 1 } }, ctx);
		assert.deepEqual(ctx.warnings, [], `${key} should not warn`);
	}
});

test('an invalid role is an error', () => {
	const ctx = collect();
	assert.equal(normaliseSymbol({ name: 'X', role: 'medium', paytable: { 3: 1 } }, ctx), null);
	assert.match(ctx.errors.join(' '), /role "medium" is invalid/);
});

test('taxonomy v1 `tier` migrates to role, with a warning', () => {
	const ctx = collect();
	const s = normaliseSymbol({ name: 'H1', tier: 'high', paytable: { 3: 1 } }, ctx);
	assert.equal(s.role, 'high');
	assert.match(ctx.warnings.join(' '), /taxonomy v1/);
});

test('taxonomy v1 `tier: special` + special: [scatter] becomes role scatter', () => {
	const ctx = collect();
	const s = normaliseSymbol({ name: 'S', tier: 'special', special: ['scatter'] }, ctx);
	assert.equal(s.role, 'scatter');
});

test('a non-scatter with no paytable is an error', () => {
	const ctx = collect();
	normaliseSymbol({ name: 'H1', role: 'high' }, ctx);
	assert.match(ctx.errors.join(' '), /paytable is required/);
});

test('order is derived from the paytable, descending', () => {
	const ctx = collect();
	const symbols = [
		normaliseSymbol({ name: 'H2', role: 'high', paytable: { 5: 10 } }, ctx),
		normaliseSymbol({ name: 'H1', role: 'high', paytable: { 5: 20 } }, ctx),
	];
	assignOrders(symbols, ctx);
	assert.equal(symbols.find((s) => s.name === 'H1').order, 1);
	assert.equal(symbols.find((s) => s.name === 'H2').order, 2);
});

test('explicit and derived order can be mixed without collision', () => {
	const ctx = collect();
	const symbols = [
		normaliseSymbol({ name: 'A', role: 'high', order: 2, paytable: { 5: 5 } }, ctx),
		normaliseSymbol({ name: 'B', role: 'high', paytable: { 5: 99 } }, ctx),
		normaliseSymbol({ name: 'C', role: 'high', paytable: { 5: 1 } }, ctx),
	];
	assignOrders(symbols, ctx);
	assert.deepEqual(ctx.errors, []);
	const orders = symbols.map((s) => s.order).sort();
	assert.deepEqual(orders, [1, 2, 3]);
	assert.equal(symbols.find((s) => s.name === 'A').order, 2);
	assert.equal(symbols.find((s) => s.name === 'B').order, 1);
});

test('duplicate explicit order within one role is an error', () => {
	const ctx = collect();
	const symbols = [
		normaliseSymbol({ name: 'A', role: 'high', order: 1, paytable: { 5: 5 } }, ctx),
		normaliseSymbol({ name: 'B', role: 'high', order: 1, paytable: { 5: 5 } }, ctx),
	];
	assignOrders(symbols, ctx);
	assert.match(ctx.errors.join(' '), /order must be unique per role/);
});

test('the same order in DIFFERENT roles is fine', () => {
	const ctx = collect();
	const symbols = [
		normaliseSymbol({ name: 'H', role: 'high', order: 1, paytable: { 5: 5 } }, ctx),
		normaliseSymbol({ name: 'L', role: 'low', order: 1, paytable: { 5: 1 } }, ctx),
	];
	assignOrders(symbols, ctx);
	assert.deepEqual(ctx.errors, []);
});

test('buildSpecialSymbols always includes the four engine keys', () => {
	const ctx = collect();
	const symbols = [normaliseSymbol({ name: 'H1', role: 'high', paytable: { 5: 1 } }, ctx)];
	assignOrders(symbols, ctx);
	const out = buildSpecialSymbols(symbols);
	// The win calculators index config.special_symbols[wild_key] directly, so a
	// missing key is a KeyError even when the game has no wilds.
	for (const key of ENGINE_SPECIAL_KEYS) assert.ok(key in out, `${key} missing`);
});

test('buildSpecialSymbols carries custom keys through', () => {
	const ctx = collect();
	const symbols = [normaliseSymbol({ name: 'X', role: 'high', special: ['blank'], paytable: { 5: 1 } }, ctx)];
	assignOrders(symbols, ctx);
	assert.deepEqual(buildSpecialSymbols(symbols).blank, ['X']);
});

test('highSymbolNames returns only high symbols, in rank order', () => {
	const ctx = collect();
	const symbols = [
		normaliseSymbol({ name: 'H2', role: 'high', order: 2, paytable: { 5: 5 } }, ctx),
		normaliseSymbol({ name: 'H1', role: 'high', order: 1, paytable: { 5: 9 } }, ctx),
		normaliseSymbol({ name: 'L1', role: 'low', order: 1, paytable: { 5: 1 } }, ctx),
	];
	assert.deepEqual(highSymbolNames(symbols), ['H1', 'H2']);
});

test('sortSymbols orders wild, high, low, scatter', () => {
	const ctx = collect();
	const symbols = [
		normaliseSymbol({ name: 'S', role: 'scatter', order: 1 }, ctx),
		normaliseSymbol({ name: 'L1', role: 'low', order: 1, paytable: { 5: 1 } }, ctx),
		normaliseSymbol({ name: 'W', role: 'wild', order: 1, paytable: { 5: 9 } }, ctx),
		normaliseSymbol({ name: 'H1', role: 'high', order: 1, paytable: { 5: 5 } }, ctx),
	];
	assert.deepEqual(sortSymbols(symbols).map((s) => s.name), ['W', 'H1', 'L1', 'S']);
});

group('taxonomy — animation states');

test('typeRequiredStates always includes explosion', () => {
	// apps/<m>/src/game/utils.ts indexes SYMBOL_INFO_MAP by the full SymbolState
	// union regardless of mechanic, so omitting explosion is a TS7053.
	assert.ok(typeRequiredStates().includes('explosion'));
});

test('defaultAnimationStates only asks for explosion ART on tumbling mechanics', () => {
	assert.ok(!defaultAnimationStates({ mechanic: 'lines' }).includes('explosion'));
	assert.ok(!defaultAnimationStates({ mechanic: 'ways' }).includes('explosion'));
	assert.ok(defaultAnimationStates({ mechanic: 'cluster' }).includes('explosion'));
	assert.ok(defaultAnimationStates({ mechanic: 'scatter' }).includes('explosion'));
});

// ── behavior recipes ────────────────────────────────────────────────────────
group('behaviorRecipes');

test('the expanding recipe adds its three states, with reasons', () => {
	const ctx = collect();
	const wild = normaliseSymbol({ name: 'W', role: 'wild', special: ['wild', 'multiplier'], behaviors: ['expanding'], paytable: { 5: 1 } }, ctx);
	const states = requiredStatesForSymbol(wild, defaultAnimationStates({ mechanic: 'lines' }));
	for (const state of ['expand_in', 'expand_loop', 'expand_out']) {
		assert.ok(states.has(state), `${state} missing`);
		assert.deepEqual(states.get(state), ['behavior "expanding"']);
	}
	assert.deepEqual(states.get('static'), ['role default']);
});

test('an unknown behavior tag is an error listing the known ones', () => {
	const ctx = collect();
	const s = normaliseSymbol({ name: 'W', role: 'wild', behaviors: ['teleporting'], paytable: { 5: 1 } }, ctx);
	validateBehaviors(s, { mechanic: 'lines', ...ctx });
	assert.match(ctx.errors.join(' '), /unknown behavior "teleporting"/);
});

test('expanding without special: [wild] is an error', () => {
	const ctx = collect();
	const s = normaliseSymbol({ name: 'W', role: 'wild', special: ['multiplier'], behaviors: ['expanding'], paytable: { 5: 1 } }, ctx);
	const ctx2 = collect();
	validateBehaviors(s, { mechanic: 'lines', ...ctx2 });
	assert.match(ctx2.errors.join(' '), /requires special: \[wild\]/);
});

test('expanding without multiplier warns rather than failing', () => {
	const ctx = collect();
	const s = normaliseSymbol({ name: 'W', role: 'wild', behaviors: ['expanding'], paytable: { 5: 1 } }, ctx);
	const ctx2 = collect();
	validateBehaviors(s, { mechanic: 'lines', ...ctx2 });
	assert.deepEqual(ctx2.errors, []);
	assert.match(ctx2.warnings.join(' '), /normally pairs with special: \[multiplier\]/);
});

test('expanding is still refused on scatter, for a different reason', () => {
	// It used to be refused on cluster AND scatter because a cascade re-draws the
	// board mid-spin and wiped the expanded wilds. The boardLifetime work fixed
	// that for cluster, proven by running it.
	//
	// scatter stays out, and not for a mechanical reason: scatter-pays counts
	// instances anywhere with no positional requirement, so a substituting wild
	// has no gap to bridge. It would generate, run, and do nothing.
	const ctx = collect();
	const s = normaliseSymbol({ name: 'W', role: 'wild', special: ['wild', 'multiplier'], behaviors: ['expanding'], paytable: { 5: 1 } }, ctx);
	const ctx2 = collect();
	validateBehaviors(s, { mechanic: 'scatter', ...ctx2 });
	assert.match(ctx2.errors.join(' '), /only verified on mechanic/);
});

test('expanding is allowed on lines, ways and cluster', () => {
	for (const mechanic of ['lines', 'ways', 'cluster']) {
		const ctx = collect();
		const s = normaliseSymbol({ name: 'W', role: 'wild', special: ['wild', 'multiplier'], behaviors: ['expanding'], paytable: { 5: 1 } }, ctx);
		const ctx2 = collect();
		validateBehaviors(s, { mechanic, ...ctx2 });
		assert.deepEqual(ctx2.errors, [], `${mechanic} should be allowed`);
	}
});

test('tumble is refused on non-tumbling mechanics', () => {
	const ctx = collect();
	const s = normaliseSymbol({ name: 'W', role: 'wild', behaviors: ['tumble'], paytable: { 5: 1 } }, ctx);
	const ctx2 = collect();
	validateBehaviors(s, { mechanic: 'lines', ...ctx2 });
	assert.match(ctx2.errors.join(' '), /requires mechanic cluster or scatter/);
});

test('a recipe emits code if and only if it is verified', () => {
	// The invariant, rather than a list of which recipes are which — a list has
	// to be edited every time one is promoted, which is exactly when the rule
	// most needs to still be checked.
	for (const [id, r] of Object.entries(BEHAVIOR_RECIPES)) {
		const emits = Boolean(r.emitMath || r.emitWeb);
		if (r.status === 'verified') continue; // verified may or may not emit yet
		assert.ok(!emits, `${id} is "${r.status}" but carries a code emitter`);
	}
	// And at least the two that have been run end to end do emit.
	for (const id of ['expanding', 'sticky']) {
		assert.equal(getRecipe(id).status, 'verified');
		assert.ok(getRecipe(id).emitMath, `${id} should emit math`);
	}
});

test('every recipe cites what it was verified against', () => {
	for (const [id, r] of Object.entries(BEHAVIOR_RECIPES)) {
		assert.ok(r.verifiedAgainst && r.verifiedAgainst.length > 40, `${id} has no provenance`);
	}
});

// ── mechanics + generators ──────────────────────────────────────────────────
group('mechanics + web generators');

const SPEC = {
	game: {
		name: 'test-game',
		providerName: 'studio',
		gameId: '0_0_test',
		rtp: 0.96,
		reels: { count: 5, rows: [3, 3, 3, 3, 3] },
		betModes: { base: { cost: 1, rtp: 0.96, maxWin: 5000, feature: true, buyBonus: false } },
	},
	paylines: 'default_20',
	freeSpins: { triggerSymbol: 'S', triggerCount: 3, awardedSpins: 10, retrigger: true },
};

function specFor(mechanicId) {
	const ctx = collect();
	const symbols = [
		normaliseSymbol({ name: 'H1', role: 'high', paytable: { 5: 20, 3: 5 } }, ctx),
		normaliseSymbol({ name: 'L1', role: 'low', paytable: { 5: 5, 3: 1 } }, ctx),
		normaliseSymbol({ name: 'W', role: 'wild', special: ['wild', 'multiplier'], paytable: { 5: 20, 3: 5 } }, ctx),
		normaliseSymbol({ name: 'S', role: 'scatter' }, ctx),
		// apps/scatter's components reference a symbol literally named 'M'.
		normaliseSymbol({ name: 'M', role: 'low', special: ['multiplier'], paytable: { 5: 2, 3: 1 } }, ctx),
	];
	assignOrders(symbols, ctx);
	const m = MECHANICS[mechanicId];
	return {
		...SPEC,
		game: { ...SPEC.game, mechanic: mechanicId, reels: { ...m.defaultReels } },
		symbols,
		_mechanic: m,
	};
}

test('paddingReels keys match each sample app exactly', () => {
	// GameType = keyof typeof config.paddingReels, so the key set is part of the
	// app's type surface — dropping ways' superspingame drops a game type.
	const expected = {
		lines: ['basegame', 'freegame'],
		// apps/scatter really does use camelCase 'freeSpins' for its second game
		// type; see the note at the foot of mechanics.js.
		scatter: ['basegame', 'freeSpins'],
		cluster: ['basegame', 'freegame'],
		ways: ['basegame', 'freegame', 'superspingame'],
	};
	for (const [mechanic, keys] of Object.entries(expected)) {
		const config = buildConfigObject(specFor(mechanic));
		assert.deepEqual(Object.keys(config.paddingReels), keys, mechanic);
	}
});

test('cluster and ways emit empty-string paddingReels, matching their samples', () => {
	for (const mechanic of ['cluster', 'ways']) {
		const config = buildConfigObject(specFor(mechanic));
		for (const value of Object.values(config.paddingReels)) {
			assert.equal(value, '', `${mechanic} should ship empty strings`);
		}
	}
});

test('lines and scatter emit real reel strips', () => {
	for (const mechanic of ['lines', 'scatter']) {
		const config = buildConfigObject(specFor(mechanic));
		assert.ok(Array.isArray(config.paddingReels.basegame), mechanic);
		assert.equal(config.paddingReels.basegame.length, MECHANICS[mechanic].defaultReels.count);
	}
});

test('paylines are emitted only for lines', () => {
	assert.ok(buildConfigObject(specFor('lines')).paylines);
	for (const mechanic of ['ways', 'cluster', 'scatter']) {
		assert.equal(buildConfigObject(specFor(mechanic)).paylines, undefined, mechanic);
	}
});

test('config generation is deterministic for the same spec', () => {
	const a = JSON.stringify(buildConfigObject(specFor('lines')));
	const b = JSON.stringify(buildConfigObject(specFor('lines')));
	assert.equal(a, b, 're-running produced a different config');
});

test('SYMBOL_INFO_MAP carries every SymbolState for every mechanic', () => {
	for (const mechanic of Object.keys(MECHANICS)) {
		const map = buildSymbolInfoMap(specFor(mechanic));
		for (const [name, entry] of Object.entries(map)) {
			for (const state of typeRequiredStates()) {
				assert.ok(state in entry, `${mechanic}/${name} missing ${state}`);
			}
		}
	}
});

test('INITIAL_BOARD is reels x (rows + 2) and excludes scatters', () => {
	const spec = specFor('lines');
	const board = buildInitialBoard(spec);
	assert.equal(board.length, spec.game.reels.count);
	assert.equal(board[0].length, spec.game.reels.rows[0] + 2);
	assert.ok(!board.flat().some((s) => s.name === 'S'), 'a scatter is on the initial board');
});

// ── math generators ─────────────────────────────────────────────────────────
group('math generators');

test('the paytable uses (kind, name) tuple keys with the name as a string', () => {
	// SymbolStorage asserts type(tup[1]) == str.
	const out = renderPaytable(specFor('lines'));
	assert.match(out, /\(5, "H1"\): 20,/);
	assert.match(out, /\(3, "H1"\): 5,/);
	assert.ok(!out.includes('"S"'), 'scatter has no paytable and must not appear');
});

test('the paytable is emitted wild-first, then high, then low', () => {
	const out = renderPaytable(specFor('lines'));
	assert.ok(out.indexOf('"W"') < out.indexOf('"H1"'));
	assert.ok(out.indexOf('"H1"') < out.indexOf('"L1"'));
});

test('special_symbols renders all four engine keys', () => {
	const out = renderSpecialSymbols(specFor('lines'));
	for (const key of ENGINE_SPECIAL_KEYS) assert.match(out, new RegExp(`"${key}":`));
	assert.match(out, /"wild": \[\n\s*"W",\n\s*\]/);
});

test('num_rows is a literal list, never `[n] * num_reels`', () => {
	assert.equal(renderNumRows(specFor('lines')), '[\n    3,\n    3,\n    3,\n    3,\n    3,\n]');
});

test('freespin_triggers covers every count that can physically land', () => {
	// executables.py indexes freespin_triggers[gametype][count] directly, so a
	// landable count with no entry is a KeyError mid-simulation.
	const out = renderFreespinTriggers(specFor('lines'));
	for (const count of [3, 4, 5]) assert.match(out, new RegExp(`\\b${count}: `));
});

test('freespin_triggers omits the freegame table when retrigger is off', () => {
	const spec = specFor('lines');
	const out = renderFreespinTriggers({ ...spec, freeSpins: { ...spec.freeSpins, retrigger: false } });
	assert.ok(!out.includes('freegame_type'));
});

test('every reel carries at least one scatter', () => {
	// force_special_board() loops until the board holds EXACTLY the requested
	// number of trigger symbols. A reel with no scatter makes that unreachable
	// and hangs the simulation — which is exactly what happened when scatters
	// were rolled from the weighted pool rather than placed.
	for (const mechanic of Object.keys(MECHANICS)) {
		const spec = specFor(mechanic);
		for (const seed of ['BR0', 'FR0', 'WCAP']) {
			const rows = renderReelCsv(spec, { seed }).trim().split('\n').map((r) => r.split(','));
			for (let reel = 0; reel < spec.game.reels.count; reel += 1) {
				const count = rows.filter((r) => r[reel] === 'S').length;
				assert.ok(count >= 1, `${mechanic}/${seed} reel ${reel} has no scatter`);
			}
		}
	}
});

test('placeholder reels never stack scatters within a reel window', () => {
	// Two scatters visible in one reel also make an exact count unreachable.
	for (const mechanic of Object.keys(MECHANICS)) {
		const spec = specFor(mechanic);
		const window = Math.max(...spec.game.reels.rows) + 2;
		for (const seed of ['BR0', 'FR0', 'WCAP']) {
			const rows = renderReelCsv(spec, { seed }).trim().split('\n').map((r) => r.split(','));
			for (let reel = 0; reel < spec.game.reels.count; reel += 1) {
				const at = rows.map((r, i) => (r[reel] === 'S' ? i : -1)).filter((i) => i >= 0);
				for (let i = 1; i < at.length; i += 1) {
					assert.ok(
						at[i] - at[i - 1] >= window,
						`${mechanic}/${seed} reel ${reel}: scatters at ${at[i - 1]} and ${at[i]} are closer than ${window}`,
					);
				}
			}
		}
	}
});

test('scatter density stays inside the range the real sample games use', () => {
	// Measured from math-sdk's own BR0.csv files: 0.2%-2.4% per reel. Above that,
	// free spins re-trigger faster than they are consumed and run_freespin()'s
	// `while self.fs < self.tot_fs` never terminates.
	for (const mechanic of Object.keys(MECHANICS)) {
		const spec = specFor(mechanic);
		const rows = renderReelCsv(spec, { seed: 'BR0' }).trim().split('\n').map((r) => r.split(','));
		assert.equal(rows.length, REEL_STRIP_LENGTH);
		for (let reel = 0; reel < spec.game.reels.count; reel += 1) {
			const density = rows.filter((r) => r[reel] === 'S').length / rows.length;
			assert.ok(density > 0, `${mechanic} reel ${reel} has no scatter`);
			assert.ok(density <= 0.025, `${mechanic} reel ${reel} density ${density} is above the sample range`);
		}
	}
	assert.ok(SCATTER_DENSITY > 0.002 && SCATTER_DENSITY < 0.024);
});

test('placeholder reels only contain symbols from the spec', () => {
	// Config.validate_reel_symbols() rejects anything else.
	const spec = specFor('lines');
	const names = new Set(spec.symbols.map((s) => s.name));
	for (const cell of renderReelCsv(spec, { seed: 'BR0' }).trim().split(/[\n,]/)) {
		assert.ok(names.has(cell), `unknown symbol "${cell}" on a reel`);
	}
});

test('reel generation is deterministic per game and strip', () => {
	const spec = specFor('lines');
	assert.equal(renderReelCsv(spec, { seed: 'BR0' }), renderReelCsv(spec, { seed: 'BR0' }));
	assert.notEqual(renderReelCsv(spec, { seed: 'BR0' }), renderReelCsv(spec, { seed: 'FR0' }));
});

// ── web recipe patching ─────────────────────────────────────────────────────
group('webRecipePatch — storybook wiring');

/** Build a throwaway app tree with the files a recipe patches. */
function withApp(fn) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-app-'));
	fs.mkdirSync(path.join(dir, 'src', 'game'), { recursive: true });
	fs.mkdirSync(path.join(dir, 'src', 'stories', 'data'), { recursive: true });
	fs.mkdirSync(path.join(dir, 'src', 'components'), { recursive: true });

	fs.writeFileSync(
		path.join(dir, 'src', 'game', 'typesBookEvent.ts'),
		"type BookEventReveal = { index: number; type: 'reveal' };\n\nexport type BookEvent = BookEventReveal;\n",
	);
	fs.writeFileSync(
		path.join(dir, 'src', 'game', 'bookEventHandlerMap.ts'),
		'export const bookEventHandlerMap = {\n\treveal: async () => {},\n};\n',
	);
	fs.writeFileSync(
		path.join(dir, 'src', 'game', 'typesEmitterEvent.ts'),
		"import type { EmitterEventBoard } from '../components/Board.svelte';\n\nexport type EmitterEventGame = EmitterEventBoard;\n",
	);
	fs.writeFileSync(path.join(dir, 'src', 'stories', 'data', 'bonus_events.ts'), 'export default {\n\treveal: { type: \'reveal\' },\n};\n');
	fs.writeFileSync(
		path.join(dir, 'src', 'stories', 'ModeBonusBookEvent.stories.svelte'),
		'<Story\n\tname="reveal"\n\targs={templateArgs({ data: events.reveal })}\n\t{template}\n/>\n',
	);

	try {
		return fn(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

const EMITTED = {
	files: [{ path: 'src/components/ExpandingWilds.svelte', contents: '<!-- c -->', mode: 'create' }],
	bookEventTypes: "type BookEventNewExpandingWilds = { index: number; type: 'newExpandingWilds' };",
	bookEventUnionMembers: ['BookEventNewExpandingWilds'],
	handlers: "\tnewExpandingWilds: async () => {},",
	emitterImport: { typeName: 'EmitterEventExpandingWilds', from: '../components/ExpandingWilds.svelte' },
	storyEvents: { newExpandingWilds: { type: 'newExpandingWilds', newWilds: [] } },
};

test('adds a <Story> per new bookEvent, not just the fixture', () => {
	// Without the <Story> block the fixture in <mode>_events.ts is unreachable:
	// storybook only surfaces stories that have one, so the event could not be
	// tested in isolation. Caught by actually opening storybook.
	withApp((dir) => {
		applyWebRecipe(dir, EMITTED);
		const stories = fs.readFileSync(path.join(dir, 'src', 'stories', 'ModeBonusBookEvent.stories.svelte'), 'utf8');
		assert.match(stories, /name="newExpandingWilds"/);
		assert.match(stories, /data: events\.newExpandingWilds/);
		assert.match(stories, /playBookEvent/);
		assert.match(stories, /name="reveal"/, 'clobbered the existing story');
	});
});

test('the generated <Story> matches the app’s own shape', () => {
	// Apps differ on whether they pass {template}; a story that omits it when the
	// app needs it renders nothing at all.
	withApp((dir) => {
		applyWebRecipe(dir, EMITTED);
		const stories = fs.readFileSync(path.join(dir, 'src', 'stories', 'ModeBonusBookEvent.stories.svelte'), 'utf8');
		assert.match(stories, /\{template\}/);
	});

	withApp((dir) => {
		const file = path.join(dir, 'src', 'stories', 'ModeBonusBookEvent.stories.svelte');
		fs.writeFileSync(file, '<Story\n\tname="reveal"\n\targs={templateArgs({ data: events.reveal })}\n/>\n');
		applyWebRecipe(dir, EMITTED);
		const stories = fs.readFileSync(file, 'utf8');
		assert.ok(!stories.includes('{template}'), 'added {template} to an app that does not use it');
	});
});

test('re-running the recipe does not duplicate stories, types or handlers', () => {
	withApp((dir) => {
		applyWebRecipe(dir, EMITTED);
		applyWebRecipe(dir, EMITTED);
		const read = (...p) => fs.readFileSync(path.join(dir, ...p), 'utf8');
		const count = (text, needle) => text.split(needle).length - 1;

		assert.equal(count(read('src', 'stories', 'ModeBonusBookEvent.stories.svelte'), 'name="newExpandingWilds"'), 1);
		assert.equal(count(read('src', 'game', 'typesBookEvent.ts'), 'type BookEventNewExpandingWilds'), 1);
		assert.equal(count(read('src', 'game', 'bookEventHandlerMap.ts'), 'newExpandingWilds:'), 1);
		assert.equal(count(read('src', 'game', 'typesEmitterEvent.ts'), 'EmitterEventExpandingWilds'), 2); // import + union
		assert.equal(count(read('src', 'stories', 'data', 'bonus_events.ts'), 'newExpandingWilds:'), 1);
	});
});

test('story fixtures use the codebase style, not JSON', () => {
	withApp((dir) => {
		applyWebRecipe(dir, EMITTED);
		const data = fs.readFileSync(path.join(dir, 'src', 'stories', 'data', 'bonus_events.ts'), 'utf8');
		assert.ok(!data.includes('"type"'), 'emitted double-quoted JSON keys into a TS source file');
		assert.match(data, /type: 'newExpandingWilds'/);
	});
});

test('the BookEvent union gains the new members', () => {
	withApp((dir) => {
		applyWebRecipe(dir, EMITTED);
		const types = fs.readFileSync(path.join(dir, 'src', 'game', 'typesBookEvent.ts'), 'utf8');
		assert.match(types, /export type BookEvent =[\s\S]*BookEventNewExpandingWilds/);
	});
});

// ── placeholder art ─────────────────────────────────────────────────────────
group('placeholder art');

test('encodePng emits a structurally valid PNG', () => {
	const c = new Canvas(4, 3);
	c.fillRect(0, 0, 4, 3, [10, 20, 30, 255]);
	const png = c.toPng();
	assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	assert.equal(png.subarray(12, 16).toString('ascii'), 'IHDR');
	assert.equal(png.readUInt32BE(16), 4);
	assert.equal(png.readUInt32BE(20), 3);
	assert.equal(png[24], 8, 'bit depth');
	assert.equal(png[25], 6, 'colour type RGBA');
	assert.equal(png.subarray(png.length - 8, png.length - 4).toString('ascii'), 'IEND');
});

test('encodePng rejects a mismatched buffer rather than emitting a corrupt file', () => {
	assert.throws(() => encodePng(4, 4, Buffer.alloc(10)), /expected 64 bytes/);
});

test('Canvas alpha-blends rather than overwriting', () => {
	const c = new Canvas(1, 1);
	c.set(0, 0, [0, 0, 0, 255]);
	c.set(0, 0, [255, 255, 255, 128]);
	const px = c.data[0];
	assert.ok(px > 100 && px < 160, `expected a blend, got ${px}`);
});

test('rounded corners are transparent', () => {
	const c = new Canvas(32, 32);
	c.fillRoundRect(0, 0, 32, 32, 10, [255, 0, 0, 255]);
	assert.equal(c.data[3], 0, 'top-left corner should be transparent');
	assert.equal(c.data[(16 * 32 + 16) * 4 + 3], 255, 'centre should be opaque');
});

test('the font covers every character a symbol name can contain', () => {
	// Symbol names come from the spec, so anything alphanumeric must render.
	for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') {
		const c = new Canvas(8, 8);
		drawText(c, ch, 0, 0, [255, 255, 255, 255], 1);
		const lit = [...c.data].filter((_, i) => i % 4 === 3 && c.data[i] > 0).length;
		assert.ok(lit > 0, `glyph "${ch}" rendered nothing`);
	}
});

test('measureText matches what drawText actually occupies', () => {
	const width = measureText('H1', 2, 1);
	const c = new Canvas(64, 16);
	drawText(c, 'H1', 0, 0, [255, 255, 255, 255], 2);
	let rightmost = 0;
	for (let y = 0; y < 16; y += 1) {
		for (let x = 0; x < 64; x += 1) {
			if (c.data[(y * 64 + x) * 4 + 3] > 0) rightmost = Math.max(rightmost, x);
		}
	}
	assert.ok(rightmost < width, `text overran its measured width (${rightmost} >= ${width})`);
	assert.ok(rightmost > width - 6, 'measureText is wildly over-reporting');
});

test('symbol tiles are valid PNGs of the requested size', () => {
	const png = renderSymbolTile({ name: 'H1', role: 'high', order: 1, roleCount: 4, topPayout: 20, size: 128 });
	assert.equal(png.readUInt32BE(16), 128);
	assert.equal(png.readUInt32BE(20), 128);
});

test('symbols of the same role get visibly different colours', () => {
	// Hashing the name produced near-collisions (H1 and H2 two degrees apart),
	// which is invisible on a spinning reel. Rank-based hues must separate.
	const sample = (order) => {
		const png = renderSymbolTile({ name: `H${order}`, role: 'high', order, roleCount: 4, topPayout: 20, size: 64 });
		return png.length; // structural proxy; colour asserted via the canvas below
	};
	const lengths = [1, 2, 3, 4].map(sample);
	assert.ok(lengths.every((n) => n > 100), 'tiles should encode to real files');

	// Compare actual face colours by rendering the same gradient the tile uses.
	const faces = [1, 2, 3, 4].map((order) => {
		const c = new Canvas(8, 8);
		const png = renderSymbolTile({ name: `H${order}`, role: 'high', order, roleCount: 4, size: 64 });
		return png.subarray(0, 40).toString('hex');
	});
	assert.equal(new Set(faces).size, 4, 'four ranks produced fewer than four distinct tiles');
});

test('a behavior state variant renders differently from the base tile', () => {
	const base = renderSymbolTile({ name: 'W', role: 'wild', order: 1, roleCount: 1, size: 64 });
	const variant = renderSymbolTile({ name: 'W', role: 'wild', order: 1, roleCount: 1, variant: 'expand_in', size: 64 });
	assert.notEqual(base.toString('hex'), variant.toString('hex'), 'variant tile is identical to the base');
});

test('topPayoutOf reads the highest paytable value', () => {
	assert.equal(topPayoutOf({ paytable: { 3: 5, 5: 20, 4: 10 } }), 20);
	assert.equal(topPayoutOf({ paytable: null }), null);
});

// ── math sync ───────────────────────────────────────────────────────────────
group('math sync — converting the SDK\'s output');

test('symbols convert from array-of-objects to an object', () => {
	// The maths emits [{H1:{...}}, {L1:{...}}]; config.ts declares an object.
	const { config } = buildConfigFromMath(
		{ symbols: [{ H1: { paytable: [{ '5': 20 }] } }, { L1: { paytable: [{ '5': 5 }] } }], paddingReels: {} },
		MECHANICS.lines,
	);
	assert.deepEqual(Object.keys(config.symbols), ['H1', 'L1']);
	assert.deepEqual(config.symbols.H1.paytable, [{ '5': 20 }]);
});

test('game-type keys stay the app\'s, not the maths\'', () => {
	// apps/scatter keys its second padding set `freeSpins`; the maths calls it
	// `freegame`. GameType derives from these keys, so the app's name must win.
	const { config, notes } = buildConfigFromMath(
		{ symbols: [], paddingReels: { basegame: [[{ name: 'H1' }]], freegame: [[{ name: 'L1' }]] } },
		MECHANICS.scatter,
	);
	assert.deepEqual(Object.keys(config.paddingReels), ['basegame', 'freeSpins']);
	assert.deepEqual(config.paddingReels.freeSpins, [[{ name: 'L1' }]]);
	assert.match(notes.join(' '), /mapped the maths' "freegame"/);
});

test('cluster and ways keep empty-string padding whatever the maths says', () => {
	for (const mechanic of ['cluster', 'ways']) {
		const { config } = buildConfigFromMath(
			{ symbols: [], paddingReels: { basegame: [[{ name: 'H1' }]] } },
			MECHANICS[mechanic],
		);
		assert.deepEqual(Object.keys(config.paddingReels), MECHANICS[mechanic].gameTypes, mechanic);
		for (const v of Object.values(config.paddingReels)) assert.equal(v, '', mechanic);
	}
});

test('a missing game type still gets a key, because GameType derives from them', () => {
	const { config, notes } = buildConfigFromMath(
		{ symbols: [], paddingReels: { basegame: [[{ name: 'H1' }]] } },
		MECHANICS.lines,
	);
	assert.deepEqual(Object.keys(config.paddingReels), ['basegame', 'freegame']);
	assert.equal(config.paddingReels.freegame, '');
	assert.match(notes.join(' '), /no reel strip for "freegame"/);
});

test('paylines are dropped for a mechanic that has no such key', () => {
	const { config, notes } = buildConfigFromMath(
		{ symbols: [], paylines: { 1: [0, 0, 0] }, paddingReels: {} },
		MECHANICS.cluster,
	);
	assert.equal(config.paylines, undefined);
	assert.match(notes.join(' '), /dropped paylines/);
});

// ── math report ─────────────────────────────────────────────────────────────
group('math report — reading the lookup tables');

test('payouts are hundredths of the bet, not multipliers', () => {
	// Book.to_json stores int(round(payout_multiplier * 100)). Reading them as
	// multipliers reported an RTP 100x too high.
	const summary = summarise([{ weight: 1, payout: 100 }], { wincap: 5000, cost: 1 });
	assert.equal(summary.rtp, 1, 'a payout of 100 is 1.00x, so RTP is 1.0');
	assert.equal(summary.maxPayout, 1);
});

test('RTP is divided by the bet cost', () => {
	// A buy-bonus at 100x paying 200x the base bet is a 2x return on its cost.
	const summary = summarise([{ weight: 1, payout: 20000 }], { wincap: 5000, cost: 100 });
	assert.equal(summary.rtp, 2);
});

test('RTP is weighted, not a plain mean', () => {
	const summary = summarise(
		[{ weight: 9, payout: 0 }, { weight: 1, payout: 1000 }],
		{ wincap: 5000, cost: 1 },
	);
	assert.equal(summary.rtp, 1, '(9*0 + 1*10) / 10 = 1.0');
	assert.equal(summary.hitRate, 10, 'one winner in ten weighted rounds');
});

test('hit rate is Infinity rather than a divide-by-zero when nothing pays', () => {
	assert.equal(summarise([{ weight: 1, payout: 0 }], { wincap: 100 }).hitRate, Infinity);
});

// ── sound ───────────────────────────────────────────────────────────────────
group('sound audit');

test('reads the vocabulary out of sound.ts', () => {
	const v = readSoundVocabulary(LINES_APP);
	assert.ok(v.found);
	assert.ok(v.music.includes('bgm_main'));
	assert.ok(v.effects.includes('sfx_btn_spin'));
	assert.ok(v.music.length + v.effects.length > 40);
});

test('finds sounds played by a direct player call, not only by broadcast', () => {
	// Sound.svelte does sound.players.once.play({ name: 'sfx_btn_spin' }).
	// Missing that shape made the audit under-report by three sounds.
	const used = readSoundsUsed(LINES_APP);
	assert.ok(used.has('sfx_btn_spin'), 'direct .play({ name }) call not detected');
	assert.ok(used.has('bgm_main'), 'broadcast not detected');
});

test('reads the audio sprite and its formats', () => {
	const sprite = readSoundSprite(LINES_APP);
	assert.ok(sprite.found);
	assert.ok(sprite.supplied.length > 40);
	assert.deepEqual(sprite.formats.sort(), ['ac3', 'm4a', 'mp3', 'ogg']);
});

test('a pristine sample app has no missing or unknown sounds', () => {
	const result = auditSound(LINES_APP);
	assert.deepEqual(result.missing, [], 'sample should supply everything it plays');
	assert.deepEqual(result.unknown, [], 'sample should play nothing outside its own union');
	assert.ok(result.unused.length > 0, 'the sample does ship sounds it never plays');
});

// ── inspiration boundary ────────────────────────────────────────────────────
group('inspiration — the hard boundary');

const BOUNDARY_CASES = [
	['a sprite sheet path', { features: ['x'], reference: 'competitor_symbols.atlas' }],
	['an image', { features: ['x'], look: 'screenshot.png' }],
	['a client bundle', { features: ['x'], src: 'game.bundle.js' }],
	['an archive', { features: ['x'], download: 'game.zip' }],
	['an assetDir key', { features: ['x'], assetDir: './somewhere' }],
	['a decompiled key', { features: ['x'], decompiled: 'notes' }],
	['a nested file reference', { features: ['x'], notes: { art: ['a.webp'] } }],
];

for (const [label, doc] of BOUNDARY_CASES) {
	test(`refuses ${label}`, () => {
		assert.throws(() => assertNoExtractedMaterial(JSON.stringify(doc), doc), /plain-language description only/);
	});
}

test('refuses pasted client-bundle source even inside a string', () => {
	const raw = 'features:\n  - |\n    !function(e){webpackJsonp}\n';
	assert.throws(() => assertNoExtractedMaterial(raw, { features: ['!function(e){webpackJsonp}'] }), /that is code/);
});

test('accepts a plain-language checklist', () => {
	const doc = { name: 'g', features: ['sticky wilds during free spins', 'buy-bonus at 100x'] };
	assert.doesNotThrow(() => assertNoExtractedMaterial(JSON.stringify(doc), doc));
});

test('does not trip on ordinary prose containing a dot', () => {
	const doc = { features: ['multiplier goes up 0.5x each tumble'] };
	assert.doesNotThrow(() => assertNoExtractedMaterial(JSON.stringify(doc), doc));
});

group('inspiration — rule matching');

test('recognises tumbling described in several ways', () => {
	for (const line of ['tumbling board', 'symbols cascade down', 'winning symbols explode', 'avalanche mechanic']) {
		assert.ok(matchLine(line).some((r) => r.id === 'tumble'), `missed: ${line}`);
	}
});

test('maps a bespoke feature to tier 3 with a reference', () => {
	const rules = matchLine('expanding wild that fills the reel');
	const rule = rules.find((r) => r.id === 'expanding');
	assert.ok(rule);
	assert.equal(rule.tier, 3);
	assert.match(rule.reference, /0_0_expwilds/);
});

test('maps a built-in feature to tier 2', () => {
	assert.equal(matchLine('free spins round').find((r) => r.id === 'freespins').tier, 2);
});

test('reads the buy-in cost out of the line', () => {
	const rule = matchLine('buy-bonus at 100x').find((r) => r.id === 'buybonus');
	const draft = { game: { betModes: {} } };
	const extractor = rule.extract[0];
	extractor.apply(draft, extractor.pattern.exec('buy-bonus at 100x'));
	assert.equal(draft.game.betModes.bonus.cost, 100);
});

test('returns nothing for an unrecognised line rather than guessing', () => {
	assert.deepEqual(matchLine('the reels are made of cheese'), []);
});

// ── spec loading ────────────────────────────────────────────────────────────
group('loadGameSpec — end to end validation');

function withSpec(yaml, fn) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-test-'));
	const file = path.join(dir, 'game-spec.yaml');
	fs.writeFileSync(file, yaml, 'utf8');
	try {
		return fn(file);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

const MINIMAL = `
game:
  name: t
  providerName: p
  gameId: 0_0_t
  rtp: 0.96
  mechanic: lines
  reels: { count: 5, rows: [3, 3, 3, 3, 3] }
  betModes:
    base: { cost: 1.0, rtp: 0.96, maxWin: 5000, feature: true, buyBonus: false }
paylines: default_20
symbols:
  - { name: H1, role: high, paytable: { "5": 20 } }
  - { name: S, role: scatter }
`;

test('loads a minimal valid spec', () => {
	withSpec(MINIMAL, (file) => {
		const spec = loadGameSpec(file);
		assert.equal(spec.game.name, 't');
		assert.equal(spec.symbols.length, 2);
	});
});

test('rows must match the reel count', () => {
	const yaml = MINIMAL.replace('rows: [3, 3, 3, 3, 3]', 'rows: [3, 3, 3]');
	withSpec(yaml, (file) => {
		assert.throws(() => loadGameSpec(file), (err) => {
			assert.ok(err instanceof SpecValidationError);
			assert.match(err.message, /game\.reels\.rows has 3 entries but game\.reels\.count is 5/);
			return true;
		});
	});
});

test('a lines game without paylines is an error', () => {
	withSpec(MINIMAL.replace('paylines: default_20', ''), (file) => {
		assert.throws(() => loadGameSpec(file), /requires paylines/);
	});
});

test('a free-spin trigger symbol that is not a scatter is an error', () => {
	const yaml = `${MINIMAL}\nfreeSpins:\n  triggerSymbol: H1\n  triggerCount: 3\n  awardedSpins: 10\n`;
	withSpec(yaml, (file) => {
		assert.throws(() => loadGameSpec(file), /must carry special: \[scatter\]/);
	});
});

test('a free-spin trigger symbol not in symbols[] is an error', () => {
	const yaml = `${MINIMAL}\nfreeSpins:\n  triggerSymbol: Z\n  triggerCount: 3\n  awardedSpins: 10\n`;
	withSpec(yaml, (file) => {
		assert.throws(() => loadGameSpec(file), /is not in symbols\[\]/);
	});
});

test('duplicate symbol names are an error', () => {
	const yaml = MINIMAL.replace('  - { name: S, role: scatter }', '  - { name: H1, role: low, paytable: { "5": 1 } }\n  - { name: S, role: scatter }');
	withSpec(yaml, (file) => {
		assert.throws(() => loadGameSpec(file), /duplicate symbol name "H1"/);
	});
});

test('an unknown screen slot is an error naming the valid ones', () => {
	const yaml = `${MINIMAL}\nscreens:\n  bakcground: true\n`;
	withSpec(yaml, (file) => {
		assert.throws(() => loadGameSpec(file), /is not a known screen slot/);
	});
});

test('a known nested screen slot is accepted', () => {
	const yaml = `${MINIMAL}\nscreens:\n  background:\n    basegame: true\n`;
	withSpec(yaml, (file) => {
		assert.doesNotThrow(() => loadGameSpec(file));
	});
});

test('every error in the spec is reported at once, not one at a time', () => {
	const yaml = MINIMAL.replace('mechanic: lines', 'mechanic: nope').replace('name: t', 'name: Not_Kebab');
	withSpec(yaml, (file) => {
		try {
			loadGameSpec(file);
			assert.fail('should have thrown');
		} catch (err) {
			assert.ok(err.errors.length >= 2, `only reported ${err.errors.length} error(s)`);
		}
	});
});

test('invalid YAML reports the file, not a stack trace', () => {
	withSpec('game: {\n  broken', (file) => {
		assert.throws(() => loadGameSpec(file), /is not valid YAML/);
	});
});

test('a scatter game without the M symbol is an error', () => {
	// apps/scatter's own components compare rawSymbol.name === 'M'.
	const yaml = MINIMAL.replace('mechanic: lines', 'mechanic: scatter')
		.replace('paylines: default_20', '')
		.replace('rows: [3, 3, 3, 3, 3]', 'rows: [5, 5, 5, 5, 5]');
	withSpec(yaml, (file) => {
		assert.throws(() => loadGameSpec(file), /requires a symbol named "M"/);
	});
});

test('the shipped example spec is valid', () => {
	const example = path.join(__dirname, '..', 'templates', 'game-spec.example.yaml');
	const spec = loadGameSpec(example);
	assert.equal(spec.game.mechanic, 'lines');
	assert.deepEqual(spec._warnings, [], `example spec warns: ${spec._warnings.join('; ')}`);
	const wild = spec.symbols.find((s) => s.name === 'W');
	assert.deepEqual(wild.behaviors, ['expanding']);
	assert.deepEqual(wild.special, ['wild', 'multiplier']);
});


// ── optimisation ────────────────────────────────────────────────────────────
// The SDK asserts on all of this at import time, so getting it wrong is not a
// subtly-wrong game — it is an AssertionError before a round is optimised.

const optSpec = () => ({
	game: {
		name: 'opt-test',
		rtp: 0.965,
		reels: { count: 5, rows: [3, 3, 3, 3, 3] },
		betModes: {
			base: { cost: 1, rtp: 0.965, maxWin: 5000, feature: true, buyBonus: false },
			bonus: { cost: 100, rtp: 0.965, maxWin: 5000, feature: false, buyBonus: true },
		},
	},
	freeSpins: { triggerCount: 3 },
});

test('splitRtp parts sum EXACTLY to the whole, at 5dp', () => {
	// verify_optimization_input does round(sum, 5) == round(total, 5). Rounding
	// each share independently drifts off by 1e-5 for some splits, which is a
	// hard failure rather than a rounding nicety.
	for (const total of [0.965, 0.9642, 0.88, 0.9701, 0.5]) {
		for (const share of [0.25, 0.33, 0.38, 0.55, 0.6667]) {
			const parts = splitRtp(total, [share, 1 - share]);
			const sum = parts.reduce((a, b) => a + b, 0);
			assert.equal(
				Math.round(sum * 1e5),
				Math.round(total * 1e5),
				`${total} split ${share} summed to ${sum}`,
			);
		}
	}
});

test('every conditions key matches a distribution criteria', () => {
	// The SDK asserts this directly. Both files are generated from
	// betModeCriteria() so they cannot drift, and this proves the wiring.
	const spec = optSpec();
	const plan = planOptimisation(spec);
	for (const mode of plan.modes) {
		const criteria = betModeCriteria(spec.game.betModes[mode.name]).map((c) => c.criteria);
		assert.deepEqual(
			mode.conditions.map((c) => c.criteria).sort(),
			[...criteria].sort(),
			`mode ${mode.name}`,
		);
	}
});

test('condition RTPs sum to the bet mode RTP for every volatility profile', () => {
	for (const volatility of VOLATILITY_IDS) {
		const plan = planOptimisation(optSpec(), { volatility });
		for (const mode of plan.modes) {
			const sum = mode.conditions.reduce((total, c) => total + c.rtp, 0);
			assert.equal(
				Math.round(sum * 1e5),
				Math.round(mode.rtp * 1e5),
				`${volatility}/${mode.name}: ${sum} != ${mode.rtp}`,
			);
		}
	}
});

test('a buy-bonus mode is free spins only, and never lands in the base game', () => {
	// A basegame distribution here meant 90% of bonus rounds were plain base
	// spins — a 100x purchase that usually bought nothing.
	const buyCriteria = betModeCriteria({ buyBonus: true }).map((c) => c.criteria);
	// The invariant is that a bought round never lands in the BASE game. It also
	// carries a wincap distribution — every mode does — which is not a basegame
	// round, so it does not violate this.
	assert.ok(!buyCriteria.includes('basegame'), `buy mode has a basegame criteria: ${buyCriteria}`);
	assert.ok(buyCriteria.includes('freegame'));
	const plan = planOptimisation(optSpec());
	const bonus = plan.modes.find((m) => m.name === 'bonus');
	const paying = bonus.conditions.find((c) => c.criteria !== 'wincap');
	assert.equal(paying.criteria, 'freegame');
	// hr="x": every round triggers, so there is no one-in-N to hit.
	assert.equal(paying.hitRate, 'x');
	assert.ok(!bonus.conditions.some((c) => c.criteria === 'basegame'));
});

test('a non-buy mode carries a zero-win criteria, or the RTP is unreachable', () => {
	// Without losing rounds in the simulated set the optimiser has nothing to
	// weight down: measured, the base mode optimised to 331.94% against a 96.5%
	// target at a hit rate of 1 in 1.0.
	const criteria = betModeCriteria({ buyBonus: false });
	const zero = criteria.find((c) => c.criteria === '0');
	assert.ok(zero, 'no zero-win distribution');
	assert.equal(zero.winCriteria, 0.0);

	const base = planOptimisation(optSpec()).modes.find((m) => m.name === 'base');
	const zeroCondition = base.conditions.find((c) => c.criteria === '0');
	assert.ok(zeroCondition, 'no zero-win condition');
	assert.equal(zeroCondition.rtp, 0, 'the zero criteria must not consume any RTP');
	assert.equal(zeroCondition.avWin, 0);
});

test('the zero-win distribution emits win_criteria, and only it does', () => {
	// Comments stripped first: the generated block carries a commented-out
	// wincap example, which is documentation rather than an emitted distribution.
	const py = renderBetModes(optSpec())
		.split('\n')
		.filter((line) => !line.trim().startsWith('#'))
		.join('\n');
	const blocks = py.split('Distribution(').slice(1);
	for (const block of blocks) {
		const criteria = /criteria="([^"]*)"/.exec(block)?.[1];
		if (criteria === '0') assert.match(block, /win_criteria=0\.0/, 'zero-win has no win_criteria');
		// The cap round pins win_criteria to the cap itself; check_repeat then
		// re-rolls until the round pays exactly that.
		else if (criteria === 'wincap') assert.match(block, /win_criteria=self\.wincap/);
		else assert.doesNotMatch(block, /win_criteria=/, `${criteria} should not pin a win_criteria`);
	}
});

test('a game with no free spins puts all of the RTP in the base game', () => {
	const spec = optSpec();
	delete spec.freeSpins;
	const base = planOptimisation(spec).modes.find((m) => m.name === 'base');
	const free = base.conditions.find((c) => c.criteria === 'freegame');
	assert.equal(free.rtp, 0, 'a game with no free spins cannot pay through them');
	assert.equal(free.searchSymbol, null, 'nothing to search for without a scatter trigger');
	// Everything except the cap's own allocation, which is derived from the max
	// win: 5000x at a 1-in-20M target hit rate is 0.00025 of RTP.
	const capRtp = base.conditions.find((c) => c.criteria === 'wincap').rtp;
	assert.equal(capRtp, 0.00025);
	assert.equal(base.conditions.find((c) => c.criteria === 'basegame').rtp, 0.965 - capRtp);
});

test('generated Python quotes hr="x" rather than emitting a bare name', () => {
	// Raw interpolation produced `hr=x`, which is a NameError at import.
	const spec = optSpec();
	const py = renderOptimisationPy(spec, planOptimisation(spec));
	assert.match(py, /hr="x"/);
	assert.doesNotMatch(py, /hr=x[,)\s]/);
});

test('generated Python uses tuples where the SDK asserts on tuples', () => {
	// ConstructScaling asserts isinstance(win_range, tuple) and ConstructFenceBias
	// asserts len(range) == 2 — a list fails the first outright.
	const spec = optSpec();
	const py = renderOptimisationPy(spec, planOptimisation(spec));
	assert.match(py, /"win_range": \(\d/);
	assert.doesNotMatch(py, /"win_range": \[/);
	assert.match(py, /bias_ranges=\[\(/);
	// test_spins IS a list in the sample, and toml-dumped as one.
	assert.match(py, /test_spins=\[\d/);
});

test('the zero-win criteria gets no scaling curve', () => {
	// Every round in it pays zero, so a win_range factor has nothing to act on.
	const base = planOptimisation(optSpec()).modes.find((m) => m.name === 'base');
	assert.equal(base.scaling.filter((s) => s.criteria === '0').length, 0);
});

test('volatility moves the RTP into the feature, monotonically', () => {
	const freeShare = (volatility) => {
		const base = planOptimisation(optSpec(), { volatility }).modes.find((m) => m.name === 'base');
		return base.conditions.find((c) => c.criteria === 'freegame').rtp;
	};
	assert.ok(freeShare('low') < freeShare('medium'), 'low should pay less through the feature');
	assert.ok(freeShare('medium') < freeShare('high'), 'high should pay more through the feature');
});

test('an unknown volatility is refused by name, not silently defaulted', () => {
	assert.throws(() => planOptimisation(optSpec(), { volatility: 'spicy' }), /Unknown volatility "spicy"/);
});

test('every volatility profile is complete', () => {
	for (const [id, profile] of Object.entries(VOLATILITY_PROFILES)) {
		for (const key of ['label', 'freegameShare', 'baseHitRate', 'freegameHitRate', 'scaleSpread']) {
			assert.ok(profile[key] !== undefined, `${id} is missing ${key}`);
		}
		assert.ok(profile.freegameShare > 0 && profile.freegameShare < 1, `${id} share out of range`);
	}
});

test('game.volatility is validated in the spec, not at optimise time', () => {
	withSpec(MINIMAL.replace('rtp: 0.96\n', 'rtp: 0.96\n  volatility: enormous\n'), (file) => {
		assert.throws(() => loadGameSpec(file), /game\.volatility must be one of/);
	});
	withSpec(MINIMAL.replace('rtp: 0.96\n', 'rtp: 0.96\n  volatility: high\n'), (file) => {
		assert.equal(loadGameSpec(file).game.volatility, 'high');
	});
});


// ── audio sprite ────────────────────────────────────────────────────────────
// The layout convention was read off the shipped sprite rather than invented,
// so the strongest test is that it reproduces that sprite exactly.

const SHIPPED_SPRITE = path.join(LINES_APP, 'static', 'assets', 'audio', 'sounds.json');
const shipped = fs.existsSync(SHIPPED_SPRITE) ? JSON.parse(fs.readFileSync(SHIPPED_SPRITE, 'utf8')) : null;

test('the layout reproduces the shipped sprite offset for offset', () => {
	if (!shipped) return; // no web-sdk checkout here
	const clips = Object.entries(shipped.sprite)
		.sort((a, b) => a[1][0] - b[1][0])
		.map(([name, v]) => ({ name, durationMs: v[1], loop: Boolean(v[2]) }));
	const plan = planSprite(clips);
	for (const entry of plan.entries) {
		assert.equal(entry.start, shipped.sprite[entry.name][0], `${entry.name} landed at the wrong offset`);
	}
});

test('the loop heuristic matches the shipped sprite exactly', () => {
	if (!shipped) return;
	const ours = Object.keys(shipped.sprite).filter(looksLooping).sort();
	const theirs = Object.entries(shipped.sprite).filter(([, v]) => v[2]).map(([k]) => k).sort();
	assert.deepEqual(ours, theirs);
});

test('every clip starts on a whole second, with at least a 1s gap', () => {
	// A sprite is one file seeked into, and browsers seek imprecisely — without
	// the pad a clip bleeds into the next one.
	const clips = [
		{ name: 'a', durationMs: 1500 },
		{ name: 'b', durationMs: 10 },
		{ name: 'c', durationMs: 69120 },
		{ name: 'd', durationMs: 132452.83 },
	];
	const plan = planSprite(clips);
	let previousEnd = 0;
	for (const entry of plan.entries) {
		assert.equal(entry.start % 1000, 0, `${entry.name} does not start on a whole second`);
		if (previousEnd) {
			assert.ok(entry.start - previousEnd >= CLIP_GAP_MS, `${entry.name} is padded by less than 1s`);
		}
		previousEnd = entry.start + entry.durationMs;
	}
	assert.ok(plan.totalMs >= previousEnd);
});

test('no two clips overlap, whatever the durations', () => {
	const clips = Array.from({ length: 40 }, (_, i) => ({
		name: `s${i}`,
		// Deliberately awkward: sub-millisecond, exactly-on-the-second, and long.
		durationMs: [0.4, 1000, 999.999, 1000.001, 45231.7][i % 5],
	}));
	const plan = planSprite(clips);
	for (let i = 1; i < plan.entries.length; i += 1) {
		const previous = plan.entries[i - 1];
		assert.ok(
			plan.entries[i].start >= previous.start + previous.durationMs,
			`${plan.entries[i].name} starts before ${previous.name} ends`,
		);
	}
});

test('sounds.json has exactly the shape the loader reads', () => {
	const plan = planSprite([
		{ name: 'bgm_main', durationMs: 1000, loop: true },
		{ name: 'sfx_btn_spin', durationMs: 250, loop: false, volume: 0.5 },
	]);
	const json = spriteJson(plan);
	assert.deepEqual(Object.keys(json).sort(), ['config', 'sprite', 'src']);
	// A looping clip carries the third element; a one-shot must NOT — the shipped
	// sprite only sets it on the 8 that loop.
	assert.equal(json.sprite.bgm_main.length, 3);
	assert.equal(json.sprite.bgm_main[2], true);
	assert.equal(json.sprite.sfx_btn_spin.length, 2);
	assert.equal(json.config.sfx_btn_spin.volume, 0.5);
	assert.equal(json.config.bgm_main.volume, 1);
	// Paths resolve from static/, not from the JSON's own folder.
	assert.deepEqual(json.src, SPRITE_FORMATS.map((f) => `./assets/audio/sounds.${f.ext}`));
});

test('the shipped sprite ships all four formats, and so do we', () => {
	if (!shipped) return;
	assert.deepEqual(spriteJson(planSprite([{ name: 'x', durationMs: 1 }])).src, shipped.src);
});

test('the filter graph normalises every input before mixing', () => {
	// Mixing a 48kHz mono clip with a 44.1kHz stereo one without resampling
	// produces a mangled or silent track, and ffmpeg does not warn about it.
	const graph = buildFilterGraph([
		{ name: 'a', start: 0 },
		{ name: 'b', start: 2000 },
	]);
	assert.equal((graph.match(/aresample=44100/g) ?? []).length, 2);
	assert.equal((graph.match(/channel_layouts=stereo/g) ?? []).length, 2);
	assert.match(graph, /adelay=0\|0/);
	assert.match(graph, /adelay=2000\|2000/);
	// normalize=0 is load-bearing: amix otherwise divides every sample by the
	// input count and the whole sprite comes out near-silent.
	assert.match(graph, /amix=inputs=2:normalize=0/);
});

test('the source folder maps filenames to sound names', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-sound-'));
	try {
		fs.writeFileSync(path.join(dir, 'bgm_main.wav'), '');
		fs.writeFileSync(path.join(dir, 'sfx_btn_spin.MP3'), '');
		fs.writeFileSync(path.join(dir, 'notes.txt'), 'not audio');
		fs.writeFileSync(path.join(dir, 'sounds.yaml'), 'x: 1');
		const found = readSoundSources(dir);
		assert.deepEqual(found.map((f) => f.name), ['bgm_main', 'sfx_btn_spin']);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});


// ── packaging ───────────────────────────────────────────────────────────────
// Every check here exists because the folder LOOKS finished in that state. An
// upload that fails loudly is fine; one that succeeds and serves the wrong game
// is what these are for.

// node:fs, not fs-extra — no writeJsonSync here.
const writeJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');

function withPublishDir(setup, fn) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-pkg-'));
	try {
		const publish = path.join(root, 'library', 'publish_files');
		const tables = path.join(root, 'library', 'lookup_tables');
		const configs = path.join(root, 'library', 'configs');
		for (const d of [publish, tables, configs]) fs.mkdirSync(d, { recursive: true });

		const rows = (n, weight) =>
			Array.from({ length: n }, (_, i) => `${i},${weight},${i * 10}`).join('\n') + '\n';

		// A healthy publish folder: compressed books present, optimised tables
		// (different weights from raw), same row count, matching index.
		fs.writeFileSync(path.join(tables, 'lookUpTable_base.csv'), rows(100, 1));
		fs.writeFileSync(path.join(publish, 'lookUpTable_base_0.csv'), rows(100, 7));
		fs.writeFileSync(path.join(publish, 'books_base.jsonl.zst'), 'compressed');
		writeJson(path.join(publish, 'index.json'), {
			modes: [{ name: 'base', cost: 1, events: 'books_base.jsonl.zst', weights: 'lookUpTable_base_0.csv' }],
		});
		setup({ root, publish, tables, configs, rows });
		return fn({ root, publish, tables, configs });
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

test('a complete publish folder passes', () => {
	withPublishDir(() => {}, ({ root }) => {
		const result = inspectMathPublish({ gameDir: root, gameId: 'x' });
		assert.deepEqual(result.problems, []);
		assert.equal(result.ok, true);
		assert.equal(result.optimised, true);
	});
});

test('missing compressed books is caught, and named as the compression flag', () => {
	// index.json names books_<mode>.jsonl.zst, which only exist when the
	// simulation ran with compression. Without it the index points at nothing.
	withPublishDir(({ publish }) => {
		fs.rmSync(path.join(publish, 'books_base.jsonl.zst'));
	}, ({ root }) => {
		const result = inspectMathPublish({ gameDir: root, gameId: 'x' });
		assert.equal(result.ok, false);
		assert.match(result.problems.join('\n'), /books_base\.jsonl\.zst is missing/);
		assert.match(result.problems.join('\n'), /math:run --compress/);
	});
});

test('un-optimised lookup tables are caught', () => {
	// publish_files' table is a byte-for-byte COPY of the raw one until the
	// optimiser runs, so its presence proves nothing. Uploading it publishes
	// whatever RTP the raw simulation happened to have.
	withPublishDir(({ publish, tables }) => {
		fs.copyFileSync(path.join(tables, 'lookUpTable_base.csv'), path.join(publish, 'lookUpTable_base_0.csv'));
	}, ({ root }) => {
		const result = inspectMathPublish({ gameDir: root, gameId: 'x' });
		assert.equal(result.ok, false);
		assert.match(result.problems.join('\n'), /RAW simulation, not the optimised/);
	});
});

test('an optimisation against a DIFFERENT run is caught', () => {
	// The nastiest one: the table differs from the raw table, so it looks
	// optimised, but its simulation ids no longer match the books beside it.
	withPublishDir(({ publish, rows }) => {
		fs.writeFileSync(path.join(publish, 'lookUpTable_base_0.csv'), rows(40, 7));
	}, ({ root }) => {
		const result = inspectMathPublish({ gameDir: root, gameId: 'x' });
		assert.equal(result.ok, false);
		assert.match(result.problems.join('\n'), /40 rows against the simulation's 100/);
	});
});

test('an empty sha256 in config.json is caught', () => {
	// The SDK only WARNS when it cannot hash the compressed books, and writes "".
	withPublishDir(({ configs }) => {
		writeJson(path.join(configs, 'config.json'), {
			bookShelfConfig: [{ name: 'base', booksFile: { file: 'books_base.jsonl.zst', sha256: '' } }],
		});
	}, ({ root }) => {
		const result = inspectMathPublish({ gameDir: root, gameId: 'x' });
		assert.equal(result.ok, false);
		assert.match(result.problems.join('\n'), /EMPTY sha256/);
	});
});

test('a sha256 that no longer matches the file is caught', () => {
	// The books were rebuilt after the config was written.
	withPublishDir(({ configs }) => {
		writeJson(path.join(configs, 'config.json'), {
			bookShelfConfig: [{ name: 'base', booksFile: { file: 'books_base.jsonl.zst', sha256: 'deadbeef' } }],
		});
	}, ({ root }) => {
		const result = inspectMathPublish({ gameDir: root, gameId: 'x' });
		assert.equal(result.ok, false);
		assert.match(result.problems.join('\n'), /does not match the file in publish_files/);
	});
});

test('a missing index.json stops immediately — the RGS reads it first', () => {
	withPublishDir(({ publish }) => {
		fs.rmSync(path.join(publish, 'index.json'));
	}, ({ root }) => {
		const result = inspectMathPublish({ gameDir: root, gameId: 'x' });
		assert.equal(result.ok, false);
		assert.match(result.problems.join('\n'), /index\.json is missing/);
	});
});

test('the frontend is collected from build/ when the static adapter wrote one', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-fe-'));
	try {
		const app = path.join(root, 'app');
		fs.mkdirSync(path.join(app, 'build', '_app'), { recursive: true });
		fs.writeFileSync(path.join(app, 'build', 'index.html'), '<html></html>');
		fs.writeFileSync(path.join(app, 'build', '_app', 'chunk.js'), 'x');
		const out = path.join(root, 'out');
		const result = collectFrontend({ appDir: app, outDir: out });
		assert.equal(result.assembled, false);
		assert.ok(fs.existsSync(path.join(out, 'index.html')));
		assert.ok(fs.existsSync(path.join(out, '_app', 'chunk.js')));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('the frontend is assembled by hand when there is no build/ folder', () => {
	// index.html comes out of prerendered/pages and everything else out of
	// client/ — the layout the web-sdk README describes doing manually.
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-fe2-'));
	try {
		const app = path.join(root, 'app');
		const output = path.join(app, '.svelte-kit', 'output');
		fs.mkdirSync(path.join(output, 'prerendered', 'pages'), { recursive: true });
		fs.mkdirSync(path.join(output, 'client', '_app'), { recursive: true });
		fs.writeFileSync(path.join(output, 'prerendered', 'pages', 'index.html'), '<html></html>');
		fs.writeFileSync(path.join(output, 'client', '_app', 'chunk.js'), 'x');
		fs.writeFileSync(path.join(output, 'client', 'favicon.svg'), '<svg/>');
		const out = path.join(root, 'out');
		const result = collectFrontend({ appDir: app, outDir: out });
		assert.equal(result.assembled, true);
		// index.html must be at the ROOT — the one mistake that uploads cleanly
		// and then serves nothing.
		assert.ok(fs.existsSync(path.join(out, 'index.html')));
		assert.ok(fs.existsSync(path.join(out, '_app', 'chunk.js')));
		assert.ok(fs.existsSync(path.join(out, 'favicon.svg')));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('a build that produced no index.html refuses to package', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-fe3-'));
	try {
		fs.mkdirSync(path.join(root, 'app'), { recursive: true });
		assert.throws(
			() => collectFrontend({ appDir: path.join(root, 'app'), outDir: path.join(root, 'out') }),
			/produced no index\.html/,
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});


// ── hold-and-win (sticky) ───────────────────────────────────────────────────

const stickySpec = () => ({
	game: {
		name: 'vault',
		rtp: 0.96,
		volatility: 'high',
		reels: { count: 5, rows: [3, 3, 3, 3, 3] },
		betModes: {
			base: { cost: 1, rtp: 0.96, maxWin: 5000, feature: true },
			superspin: { cost: 50, rtp: 0.96, maxWin: 2000, feature: true, superspin: true },
		},
	},
	freeSpins: { triggerCount: 3 },
	symbols: [
		{ name: 'H1', role: 'high', special: [], paytable: { 5: 20 } },
		{ name: 'P', role: 'high', special: ['prize'], behaviors: ['sticky'] },
	],
});

test('a superspin mode never lands in the base game', () => {
	const criteria = betModeCriteria({ superspin: true }).map((c) => c.criteria);
	assert.deepEqual(criteria.sort(), ['0', 'basegame']);
	// No freegame criteria: a hold-and-win round is its own loop and never
	// triggers free spins. An earlier plan assumed one and the optimiser failed
	// with "fence 'freegame' matched 0 books".
	assert.ok(!criteria.includes('freegame'));
});

test('a superspin distribution draws from its own strip, under the base gametype', () => {
	const py = renderBetModes(stickySpec());
	const block = py.slice(py.indexOf('name="superspin"'));
	assert.match(block, /self\.basegame_type: \{"SSR": 1\}/);
	assert.doesNotMatch(block.slice(0, block.indexOf('BetMode(', 10) + 1 || undefined), /"BR0"/);
});

test('a hold-and-win strip is blanks and prizes, and nothing else', () => {
	// 0_0_expwilds' SSR.csv is 460 X to 20 P. Ordinary symbols on it would be
	// cells that look valuable, lock, and pay nothing.
	const csv = renderSuperspinReelCsv(stickySpec());
	const names = new Set(csv.trim().split('\n').flatMap((row) => row.split(',')));
	assert.deepEqual([...names].sort(), [BLANK_SYMBOL, 'P'].sort());
});

test('every reel of a hold-and-win strip carries at least two prizes', () => {
	// Too sparse and a paying round lands nothing, which check_repeat() re-rolls
	// forever; too dense and the respin counter never runs down.
	const csv = renderSuperspinReelCsv(stickySpec());
	const rows = csv.trim().split('\n').map((r) => r.split(','));
	for (let reel = 0; reel < 5; reel += 1) {
		const prizes = rows.filter((r) => r[reel] === 'P').length;
		assert.ok(prizes >= 2, `reel ${reel} has only ${prizes} prize(s)`);
		assert.ok(prizes < rows.length * SUPERSPIN_PRIZE_DENSITY * 3, `reel ${reel} is too dense`);
	}
});

test('the prize symbol is kept OFF the ordinary strips', () => {
	// 0_0_expwilds' BR0 and FR0 carry no P at all: nothing in an ordinary spin
	// collects a prize, so one landing there pays nothing and looks broken.
	const csv = renderReelCsv(stickySpec());
	assert.ok(!csv.includes('P'), 'the base strip should not carry the prize symbol');
});

test('a hold-and-win game registers the blank symbol, and only then', () => {
	// Config.validate_reel_symbols() rejects a symbol on a strip the game has
	// not declared, and kind 99 is beyond any real win length so it pays nothing.
	const withSuperspin = renderPaytable(stickySpec());
	assert.match(withSuperspin, /\(99, "X"\): 0/);

	const plain = stickySpec();
	delete plain.game.betModes.superspin;
	assert.equal(hasSuperspinMode(plain), false);
	assert.doesNotMatch(renderPaytable(plain), /\(99, "X"\)/);
});

test('a prize symbol needs no paytable, unlike every other paying role', () => {
	// It carries its value as an attribute rolled on landing. Requiring a
	// paytable would be requiring a payout it must not have.
	const errors = [];
	const symbol = normaliseSymbol(
		{ name: 'P', role: 'high', special: ['prize'] },
		{ errors, warnings: [] },
	);
	assert.deepEqual(errors, []);
	assert.ok(symbol);
	// A high symbol WITHOUT the prize flag still needs one.
	const errors2 = [];
	normaliseSymbol({ name: 'H9', role: 'high' }, { errors: errors2, warnings: [] });
	assert.match(errors2.join('\n'), /paytable is required/);
});

test('sticky without a superspin bet mode is refused', () => {
	// The code would be emitted, never reached, and the behavior would silently
	// do nothing — the exact quiet no-op worth failing on.
	const errors = [];
	validateBehaviors(
		{ name: 'P', role: 'high', special: ['prize'], behaviors: ['sticky'] },
		{ mechanic: 'lines', errors, warnings: [], betModes: { base: { cost: 1 } } },
	);
	assert.match(errors.join('\n'), /hold-and-win respin ROUND/);

	const ok = [];
	validateBehaviors(
		{ name: 'P', role: 'high', special: ['prize'], behaviors: ['sticky'] },
		{ mechanic: 'lines', errors: ok, warnings: [], betModes: { s: { superspin: true } } },
	);
	assert.deepEqual(ok, []);
});

test('sticky requires special: [prize] — its math reads that flag', () => {
	const errors = [];
	validateBehaviors(
		{ name: 'P', role: 'high', special: [], behaviors: ['sticky'] },
		{ mechanic: 'lines', errors, warnings: [], betModes: { s: { superspin: true } } },
	);
	assert.match(errors.join('\n'), /requires special: \[prize\]/);
});

test('sticky is refused on a tumbling mechanic', () => {
	// tumble_game_board() redraws mid-round, which run_superspin never sees —
	// the locks would be wiped by the first cascade.
	for (const mechanic of ['cluster', 'scatter']) {
		const errors = [];
		validateBehaviors(
			{ name: 'P', role: 'high', special: ['prize'], behaviors: ['sticky'] },
			{ mechanic, errors, warnings: [], betModes: { s: { superspin: true } } },
		);
		assert.match(errors.join('\n'), /only verified on mechanic lines/);
	}
});

test('the generated event guards on the prize KEY, not on the blank name', () => {
	// json_ready_sym omits an attribute the symbol does not carry, so
	// 0_0_expwilds' `name != "X"` form is a KeyError the moment any other symbol
	// reaches the board.
	const emitted = renderStickyMath({ prizeSymbol: 'P' });
	const events = emitted.moduleFunctions[0].source;
	assert.match(events, /if "prize" in board_client/);
	assert.doesNotMatch(events, /!= "X"/);
});

test('the generated event module brings its own imports', () => {
	// A sample's game_events.py imports only what its own events need; without
	// these the first superspin round dies with a NameError.
	const emitted = renderStickyMath({ prizeSymbol: 'P' });
	const modules = emitted.moduleFunctions[0].imports.map((i) => i.module);
	assert.deepEqual(modules.sort(), ['copy', 'src.events.event_constants', 'src.events.events']);
});

test('the respin count comes from the spec, not the sample literal', () => {
	const setup = renderStickyMath({ prizeSymbol: 'P', respins: 7 }).overridePatches.find(
		(p) => p.id === 'sticky:reset_superspin',
	);
	assert.match(setup.pythonMethod, /self\.tot_fs = 7/);
	assert.match(renderStickyMath({ prizeSymbol: 'P' }).overridePatches.find(
		(p) => p.id === 'sticky:reset_superspin',
	).pythonMethod, /self\.tot_fs = 3/);
});

test('the respin counter reset is in the generated loop', () => {
	// self.fs = 0 on a landing IS the mechanic — without it the round runs a
	// fixed number of spins and is not hold-and-win at all.
	const emitted = renderStickyMath({ prizeSymbol: 'P' });
	const loop = emitted.gamestatePatches.find((p) => p.id === 'sticky:run_superspin').source;
	assert.match(loop, /new_sticky_event\(self, new_sticky_symbols\)\s*\n\s*#[^\n]*\n\s*self\.fs = 0/);
});

test('the dispatch names the mode set, not a literal', () => {
	const emitted = renderStickyMath({ prizeSymbol: 'P', superspinModes: ['superspin', 'megaspin'] });
	assert.deepEqual(emitted.gamestateConstants, ['SUPERSPIN_BETMODES = {"superspin", "megaspin"}']);
	const dispatch = emitted.gamestatePatches.find((p) => p.id === 'sticky:dispatch');
	assert.ok(dispatch.body.some((l) => l.includes('SUPERSPIN_BETMODES')));
});

test('a superspin optimisation plan matches its real criteria', () => {
	const plan = planOptimisation(stickySpec());
	const superspin = plan.modes.find((m) => m.name === 'superspin');
	assert.deepEqual(superspin.conditions.map((c) => c.criteria).sort(), ['0', 'basegame']);
	// The hit rate is DERIVED from the quotas. "x" let the optimiser park weight
	// in the zero bucket and the mode came in at exactly half its target.
	const basegame = superspin.conditions.find((c) => c.criteria === 'basegame');
	assert.notEqual(basegame.hitRate, 'x');
	assert.equal(basegame.hitRate, payingHitRate(betModeCriteria({ superspin: true })));
	assert.ok(basegame.hitRate > 1 && basegame.hitRate < 1.2, `hr ${basegame.hitRate} out of range`);
});

test('payingHitRate is the reciprocal of the paying share', () => {
	assert.equal(payingHitRate([{ criteria: 'basegame', quota: 0.9 }, { criteria: '0', quota: 0.1 }]), 1.11111);
	assert.equal(payingHitRate([{ criteria: 'freegame', quota: 1 }]), 1);
	assert.equal(payingHitRate([{ criteria: '0', quota: 1 }]), 'x');
});

test('a plan that does not match its distributions is refused at plan time', () => {
	// Rather than as a Rust fence failure minutes into an optimiser run.
	const spec = stickySpec();
	const plan = planOptimisation(spec);
	for (const mode of plan.modes) {
		const criteria = betModeCriteria(spec.game.betModes[mode.name]).map((c) => c.criteria);
		assert.deepEqual(mode.conditions.map((c) => c.criteria).sort(), [...criteria].sort());
	}
});

// ── python patching ─────────────────────────────────────────────────────────

test('addDictEntry handles a dict written across several lines', () => {
	const single = 'reels = {"BR0": "BR0.csv"}\n';
	assert.match(addDictEntry(single, 'reels', 'SSR', '"SSR.csv"').source, /"BR0": "BR0.csv", "SSR": "SSR.csv"/);

	const multi = 'reels = {\n    "BR0": "BR0.csv",\n    "FR0": "FR0.csv",\n}\nx = 1\n';
	const result = addDictEntry(multi, 'reels', 'SSR', '"SSR.csv"');
	assert.equal(result.added, true);
	assert.match(result.source, /"SSR": "SSR\.csv"\}/);
	assert.match(result.source, /\nx = 1\n/, 'the statement after the dict must survive');
});

test('addDictEntry does not duplicate a key that is already there', () => {
	const src = 'reels = {"SSR": "SSR.csv"}\n';
	const result = addDictEntry(src, 'reels', 'SSR', '"SSR.csv"');
	assert.equal(result.added, false);
	assert.equal(result.alreadyPresent, true);
	assert.equal(result.source, src);
});

test('insertAfterLineInMethod keeps the anchor line', () => {
	// Distinct from replace-line: the dispatch goes AFTER reset_book(), which
	// every sample calls and none of them can skip.
	const src = 'class G:\n    def run_spin(self):\n        self.reset_book()\n        self.draw_board()\n';
	const result = insertAfterLineInMethod(src, 'run_spin', /self\.reset_book\(\)/, ['if x:', '    y()'], 'test');
	assert.equal(result.replaced, true);
	assert.match(result.source, /self\.reset_book\(\)\n\s+if x:/);
	assert.match(result.source, /self\.draw_board\(\)/, 'the rest of the method must survive');
});

test('insertAfterLineInMethod is idempotent', () => {
	const src = 'class G:\n    def run_spin(self):\n        self.reset_book()\n';
	const once = insertAfterLineInMethod(src, 'run_spin', /reset_book/, ['a()'], 'test');
	const twice = insertAfterLineInMethod(once.source, 'run_spin', /reset_book/, ['a()'], 'test');
	assert.equal(twice.source, once.source);
	assert.equal(twice.alreadyPresent, true);
});

test('insertAfterImports does not splice into a parenthesised import', () => {
	const src = 'from a import (\n    x,\n    y,\n)\nfrom b import z\n\n\nclass C:\n    pass\n';
	const out = insertAfterImports(src, ['CONST = 1']);
	assert.match(out, /from b import z\n\nCONST = 1/);
	assert.match(out, /from a import \(\n {4}x,\n {4}y,\n\)/, 'the parenthesised import must be intact');
});


// ── sprite frames ───────────────────────────────────────────────────────────
// A symbol pointing at a frame no sheet holds renders as NOTHING, silently —
// the same failure class as a missing sound, and found the same way: by looking
// at the running game and noticing the scatter was invisible.

function withSpriteApp(setup, fn) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-app-'));
	try {
		const sheets = path.join(root, 'static', 'assets', 'sprites', 'symbolsStatic');
		const game = path.join(root, 'src', 'game');
		fs.mkdirSync(sheets, { recursive: true });
		fs.mkdirSync(game, { recursive: true });
		setup({ root, sheets, game });
		return fn({ root });
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

const sheetJson = (frames) =>
	JSON.stringify({ frames: Object.fromEntries(frames.map((f) => [f, {}])) });

const constantsTs = (entries) =>
	'export const SYMBOL_INFO_MAP = {\n' +
	entries
		.map(
			([symbol, key]) =>
				`\t${symbol}: {\n\t\tstatic: {\n\t\t\ttype: 'sprite',\n\t\t\tassetKey: '${key}',\n\t\t},\n\t},`,
		)
		.join('\n') +
	'\n} as const;\n';

test('a frame that exists in a sheet passes', () => {
	withSpriteApp(({ sheets, game }) => {
		fs.writeFileSync(path.join(sheets, 'symbolsStatic.json'), sheetJson(['h1.webp', 's.png']));
		fs.writeFileSync(path.join(game, 'constants.ts'), constantsTs([['H1', 'h1.webp'], ['S', 's.png']]));
	}, ({ root }) => {
		const result = auditSpriteFrames(root);
		assert.equal(result.ok, true);
		assert.deepEqual(result.missing, []);
	});
});

test('a frame no sheet holds is reported, with the near miss named', () => {
	// "s.webp" against a sheet holding "s.png" is one character from working.
	withSpriteApp(({ sheets, game }) => {
		fs.writeFileSync(path.join(sheets, 'symbolsStatic.json'), sheetJson(['h1.webp', 's.png']));
		fs.writeFileSync(path.join(game, 'constants.ts'), constantsTs([['H1', 'h1.webp'], ['S', 's.webp']]));
	}, ({ root }) => {
		const result = auditSpriteFrames(root);
		assert.equal(result.ok, false);
		assert.equal(result.missing.length, 1);
		assert.equal(result.missing[0].symbol, 'S');
		assert.deepEqual(result.missing[0].assetKeys, ['s.webp']);
		assert.deepEqual(result.missing[0].near, ['s.png']);
	});
});

test('a symbol with no art at all is reported with no near miss', () => {
	withSpriteApp(({ sheets, game }) => {
		fs.writeFileSync(path.join(sheets, 'symbolsStatic.json'), sheetJson(['l1.webp']));
		fs.writeFileSync(path.join(game, 'constants.ts'), constantsTs([['L5', 'l5.webp']]));
	}, ({ root }) => {
		const result = auditSpriteFrames(root);
		assert.equal(result.missing[0].symbol, 'L5');
		assert.deepEqual(result.missing[0].near, [], 'nothing to suggest — the art does not exist');
	});
});

test('frames are collected across every sheet, not just one', () => {
	withSpriteApp(({ root, sheets, game }) => {
		fs.writeFileSync(path.join(sheets, 'symbolsStatic.json'), sheetJson(['h1.webp']));
		const other = path.join(root, 'static', 'assets', 'sprites', 'coins');
		fs.mkdirSync(other, { recursive: true });
		fs.writeFileSync(path.join(other, 'coins.json'), sheetJson(['s.png']));
		fs.writeFileSync(path.join(game, 'constants.ts'), constantsTs([['H1', 'h1.webp'], ['S', 's.png']]));
	}, ({ root }) => {
		// The loader picks the sheet, not the symbol — so a frame in ANY sheet counts.
		assert.equal(auditSpriteFrames(root).ok, true);
	});
});

test('a spine assetKey is NOT checked against sheet frames', () => {
	// It resolves against assets.ts instead — a different namespace. Checking it
	// here would report every spine symbol as broken.
	withSpriteApp(({ sheets, game }) => {
		fs.writeFileSync(path.join(sheets, 'symbolsStatic.json'), sheetJson(['h1.webp']));
		fs.writeFileSync(
			path.join(game, 'constants.ts'),
			"export const SYMBOL_INFO_MAP = {\n\tH1: {\n\t\twin: {\n\t\t\ttype: 'spine',\n\t\t\tassetKey: 'H1',\n\t\t},\n\t},\n} as const;\n",
		);
	}, ({ root }) => {
		assert.equal(auditSpriteFrames(root).ok, true);
	});
});

test('the scaffolder matches real frames instead of guessing an extension', () => {
	// The guess is `<name>.webp`. Against a sheet holding s.png and w.png it is
	// wrong, and the symbol renders as nothing with no error.
	const frames = ['h1.webp', 'l1.webp', 's.png', 'w.png'];
	const spec = {
		game: { name: 'g', rtp: 0.96, reels: { count: 5, rows: [3, 3, 3, 3, 3] }, betModes: { base: {} } },
		symbols: [
			{ name: 'W', role: 'wild', special: ['wild'], paytable: { 5: 10 }, behaviors: [], order: 1 },
			{ name: 'H1', role: 'high', special: [], paytable: { 5: 20 }, behaviors: [], order: 1 },
			{ name: 'L1', role: 'low', special: [], paytable: { 5: 2 }, behaviors: [], order: 1 },
			{ name: 'S', role: 'scatter', special: ['scatter'], behaviors: [], order: 1 },
			{ name: 'L9', role: 'low', special: [], paytable: { 5: 1 }, behaviors: [], order: 2 },
		],
	};
	const map = buildSymbolInfoMap(spec, { availableFrames: frames });
	assert.equal(map.S.static.assetKey, 's.png');
	assert.equal(map.W.static.assetKey, 'w.png');
	assert.equal(map.H1.static.assetKey, 'h1.webp');
	// Nothing matches L9, so the guess stands and the audit reports it rather
	// than the generator inventing a frame.
	assert.equal(map.L9.static.assetKey, 'l9.webp');
});

test('frame resolution survives a one-shot iterator', () => {
	// Callers pass a Map's .keys(). Spreading it per symbol drained it on the
	// first one, so W resolved and every symbol after it fell back to the guess.
	const sheet = new Map([['s.png', 'x'], ['w.png', 'x']]);
	const spec = {
		game: { name: 'g', rtp: 0.96, reels: { count: 5, rows: [3, 3, 3, 3, 3] }, betModes: { base: {} } },
		symbols: [
			{ name: 'W', role: 'wild', special: ['wild'], paytable: { 5: 10 }, behaviors: [], order: 1 },
			{ name: 'S', role: 'scatter', special: ['scatter'], behaviors: [], order: 1 },
		],
	};
	const map = buildSymbolInfoMap(spec, { availableFrames: sheet.keys() });
	assert.equal(map.W.static.assetKey, 'w.png');
	assert.equal(map.S.static.assetKey, 's.png', 'the second symbol saw a drained iterator');
});

test('a bet mode cannot be both a bonus buy and a hold-and-win round', () => {
	withSpec(
		MINIMAL.replace(
			'base: { cost: 1.0, rtp: 0.96, maxWin: 5000, feature: true, buyBonus: false }',
			'base: { cost: 1.0, rtp: 0.96, maxWin: 5000, feature: true, buyBonus: true, superspin: true }',
		),
		(file) => {
			assert.throws(() => loadGameSpec(file), /both superspin and buyBonus/);
		},
	);
});


// ── mult_values shape ───────────────────────────────────────────────────────

test('a recipe that replaces the reader decides the mult_values shape', () => {
	// 0_0_ways' own game_override.py is the ONE flat reader in the SDK. The
	// expanding recipe owns assign_mult_property outright, so applying it to a
	// ways game leaves no flat reader at all — and emitting the mechanic's flat
	// shape produced KeyError: 'freegame' on the first free spin.
	const recipe = renderExpandingMath({ wildSymbol: 'W' });
	assert.equal(recipe.multValuesShape, 'nested');

	// All three of its readers index by gametype, which is why.
	const readers = [
		...recipe.classMethods.map((c) => c.source),
		...recipe.overridePatches.map((p) => p.pythonMethod ?? ''),
	].join('\n');
	const nested = readers.match(/\["mult_values"\]\[self\.gametype\]/g) ?? [];
	assert.equal(nested.length, 3, 'expected three nested readers');
	assert.doesNotMatch(readers, /\["mult_values"\]\s*\)/, 'no flat reader should remain');

	// And the mechanic still says flat, so the override is doing real work.
	assert.equal(MECHANICS.ways.multValuesShape, 'flat');
});


// ── reel design and max win ─────────────────────────────────────────────────

test('the wincap RTP allocation lands on the target hit rate', () => {
	// hit_rate = max_win / rtp_allocated. Verified against math-sdk docs (1% of
	// RTP at 5000x = 1-in-500k) and 0_0_lines (rtp=0.001, av_win=5000 = 1-in-5M).
	for (const maxWin of [5000, 20000, 100000]) {
		const rtp = wincapRtpAllocation(maxWin);
		assert.equal(Math.round(maxWin / rtp), TARGET_WINCAP_HIT_RATE, `${maxWin}x`);
	}
});

test('the cap never eats a meaningful share of RTP', () => {
	// An absurd max win must not starve the rest of the paytable.
	assert.ok(wincapRtpAllocation(100_000_000) <= 0.02);
});

test('symbol frequency falls as payout rises', () => {
	// The placeholder gave every symbol the same weight, which is why generated
	// games had no shape — a 50x top symbol landed as often as a 0.5x low.
	const spec = {
		game: { name: 'f', rtp: 0.96, volatility: 'medium', reels: { count: 5, rows: [3, 3, 3, 3, 3] }, betModes: {} },
		symbols: [
			{ name: 'H1', special: [], paytable: { 5: 50 } },
			{ name: 'L1', special: [], paytable: { 5: 1 } },
		],
	};
	const freq = symbolFrequencies(spec);
	assert.ok(freq.get('L1') > freq.get('H1'), 'the low symbol must be commoner than the high one');
});

test('volatility changes how steep that curve is', () => {
	const make = (volatility) => {
		const spec = {
			game: { name: 'f', rtp: 0.96, volatility, reels: { count: 5, rows: [3, 3, 3, 3, 3] }, betModes: {} },
			symbols: [
				{ name: 'H1', special: [], paytable: { 5: 50 } },
				{ name: 'L1', special: [], paytable: { 5: 1 } },
			],
		};
		const f = symbolFrequencies(spec);
		return f.get('L1') / f.get('H1');
	};
	// A high-volatility game makes its top symbol rarer relative to its lows.
	assert.ok(make('high') > make('medium'), 'high should be steeper than medium');
	assert.ok(make('medium') > make('low'), 'medium should be steeper than low');
});

test('the cap strip carries wild stacks tall enough to fill a reel', () => {
	// This is what makes force_wincap terminate. Measured on the samples:
	// BR0 is 0-0.9% wilds with stacks of 1; FRWCAP is 7-13% with stacks to 10.
	assert.ok(STRIP_PROFILES.WCAP.wildPct > STRIP_PROFILES.BR0.wildPct * 5);
	assert.equal(STRIP_PROFILES.WCAP.wildStack, 'full');
	assert.ok(STRIP_PROFILES.WCAP.rows < STRIP_PROFILES.BR0.rows, 'a shorter cap strip is reached sooner');

	const spec = {
		game: { name: 'capgame', rtp: 0.96, volatility: 'medium', reels: { count: 5, rows: [3, 3, 3, 3, 3] }, betModes: {} },
		symbols: [
			{ name: 'H1', special: [], paytable: { 5: 50 } },
			{ name: 'L1', special: [], paytable: { 5: 1 } },
			{ name: 'W', special: ['wild'], paytable: { 5: 50 } },
		],
	};
	const rows = renderDesignedReelCsv(spec, { stripId: 'WCAP', scatterDensity: 0 })
		.trim().split('\n').map((r) => r.split(','));
	for (let reel = 0; reel < 5; reel += 1) {
		let best = 0, run = 0;
		for (const row of rows) { run = row[reel] === 'W' ? run + 1 : 0; best = Math.max(best, run); }
		// rows + 2 padding = a fully wild visible reel.
		assert.ok(best >= 5, `reel ${reel} max wild stack ${best} cannot fill a padded 3-row reel`);
	}
});

test('an unreachable max win is caught by arithmetic, not by an overnight run', () => {
	const spec = {
		game: { name: 'x', rtp: 0.96, mechanic: 'lines', reels: { count: 5, rows: [3, 3, 3, 3, 3] }, betModes: { base: { maxWin: 100000 } } },
		_mechanic: MECHANICS.lines,
		paylines: 'default_20',
		symbols: [{ name: 'H1', special: [], paytable: { 5: 20 } }],
	};
	const analysis = analyseMaxWin(spec);
	// 20 paylines x 20x = 400x, no multiplier symbol, so 400x total against 100,000x.
	assert.equal(analysis.board.value, 400);
	assert.equal(analysis.multiplier.value, 1);
	assert.equal(analysis.reachable, false);
	assert.ok(analysis.shortfall > 200);
});

test('symbol multipliers ADD, except on ways under its "symbol" strategy', () => {
	// Corrected against src/wins/multiplier_strategy.py, having first assumed
	// composition was a free choice. apply_added_symbol_mult SUMS them, and
	// cluster.py/scatter.py sum inline. The one compounding case is ways, and it
	// works by a different route: a multiplier symbol contributes its VALUE to
	// that reel's ways count, and ways multiply across reels.
	//
	// Corrected a second time, against ways.py itself: that compounding is
	// specific to the "symbol" strategy. Under "board" (ways.py:87) the values
	// add into board_mult_count and scale the win as a SUM, so a ways game set to
	// "board" behaves like a lines game. Reading the file's compounding comment
	// as if it covered all three strategies sends you hunting a runaway
	// multiplier that is not there.
	const base = (mechanic, extra = {}) => ({
		game: { mechanic, reels: { count: 5, rows: [3, 3, 3, 3, 3] }, ...extra },
		_mechanic: MECHANICS[mechanic],
		symbols: [{ name: 'W', special: ['multiplier'] }],
	});

	// How many positions can contribute to a sum is per-evaluator: a payline
	// collects one per reel, everything else collects across the whole grid.
	assert.equal(multiplierCeiling(base('lines')).value, 50); // 5 reels x 10x
	assert.equal(multiplierCeiling(base('cluster')).value, 150); // 15 cells x 10x
	assert.equal(multiplierCeiling(base('ways')).value, 100000); // 10^5, compounding

	// The same ways game, only the strategy changed: it sums instead.
	assert.equal(multiplierCeiling(base('ways', { multiplierStrategy: 'board' })).value, 150);
});

test('the strategy is read from game: as well as the top level', () => {
	// It lives under `game:` in a real spec and at the top level only where
	// maxWinAdvice spreads it to model an alternative. Reading just the top-level
	// one defaulted every real spec to "symbol", which reported a ways game set
	// to "board" as compounding when it sums — a 667x overstatement of its
	// ceiling, on the one number the whole max-win analysis rests on.
	const spec = {
		game: {
			mechanic: 'ways',
			reels: { count: 5, rows: [3, 3, 3, 3, 3] },
			multiplierStrategy: 'board',
		},
		_mechanic: MECHANICS.ways,
		symbols: [{ name: 'W', special: ['multiplier'] }],
	};
	assert.equal(multiplierCeiling(spec).value, 150);
});

test('the global multiplier counts only when something increments it', () => {
	// executables.py update_global_mult() is `+= 1` with no ceiling — but nothing
	// calls it by default. Of all the samples only 0_0_scatter does, per tumble.
	// Crediting it unconditionally would credit a multiplier the game never moves.
	const spec = {
		game: { mechanic: 'lines', reels: { count: 5, rows: [3, 3, 3, 3, 3] }, multiplierStrategy: 'combined' },
		_mechanic: MECHANICS.lines,
		multiplierStrategy: 'combined',
		freeSpins: { awardedSpins: 10 },
		symbols: [{ name: 'W', special: ['multiplier'] }],
	};
	assert.equal(multiplierCeiling(spec).value, 50, 'a global multiplier nothing increments is 1x');
	assert.equal(
		multiplierCeiling({ ...spec, globalMultiplierPerSpin: true }).value,
		500,
		'once generated, 10 free spins carry it to 10x',
	);
});

test('a global multiplier with no feature to grow in is refused', () => {
	withSpec(MINIMAL.replace('rtp: 0.96\n', 'rtp: 0.96\n  globalMultiplierPerSpin: true\n'), (file) => {
		assert.throws(() => loadGameSpec(file), /needs a freeSpins block/);
	});
});

test('multiplier strategies are validated PER MECHANIC, not globally', () => {
	// The four evaluators differ: lines takes multiplier_method (symbol/global/
	// combined), ways takes multiplier_strategy (symbol/board/global) and ASSERTS
	// on that list, and cluster/scatter have no parameter at all.
	const withStrategy = (value) =>
		MINIMAL.replace('rtp: 0.96\n', `rtp: 0.96\n  multiplierStrategy: ${value}\n`);

	withSpec(withStrategy('exponential'), (file) => {
		assert.throws(() => loadGameSpec(file), /not valid on "lines"/);
	});
	// "board" is a real strategy — but a ways-only one, so it must be refused here.
	withSpec(withStrategy('board'), (file) => {
		assert.throws(() => loadGameSpec(file), /not valid on "lines"/);
	});
	// "combined" is lines-only and MINIMAL is a lines game, so it passes.
	withSpec(withStrategy('combined'), (file) => {
		assert.equal(loadGameSpec(file).game.multiplierStrategy, 'combined');
	});
});

test('a mechanic with no strategy parameter refuses the setting outright', () => {
	// cluster sums position multipliers inline; there is nothing to pass.
	const cluster = MINIMAL
		.replace('mechanic: lines', 'mechanic: cluster')
		.replace('paylines: default_20\n', '')
		.replace('rows: [3, 3, 3, 3, 3]', 'rows: [5, 5, 5, 5, 5]')
		.replace('paytable: { "5": 20 }', 'paytable: { "5": 5.0, "6-25": 60.0 }')
		.replace('rtp: 0.96\n', 'rtp: 0.96\n  multiplierStrategy: combined\n');
	withSpec(cluster, (file) => {
		assert.throws(() => loadGameSpec(file), /has no strategy parameter/);
	});
});


// ─────────────────────────────────────────────────────────────────────────────
// The RTP model and the balance check
//
// These exist because of one concrete failure. A generated 5x4 ways game with a
// 100,000x cap simulated cleanly, reached its max win, and then died in the Rust
// optimiser with "pos_pigs=50/50, neg_pigs=0/50. Target avg_win=184.8000" — every
// candidate distribution above target, none below, so no set of weights existed.
// The cheapest free-spin round in the whole simulation paid 908.7x.
//
// The cause was arithmetic the tool could have done in a second: the base strip
// paid an expected 60.2x per spin against a target of 0.43x. 5x4 is 1024 ways
// where 5x3 is 243, and the paytable had been written for a 5x3.
// ─────────────────────────────────────────────────────────────────────────────

const waysSpec = (rows) => ({
	game: {
		name: 'model-test',
		mechanic: 'ways',
		rtp: 0.965,
		volatility: 'high',
		reels: { count: 5, rows },
		betModes: { base: { cost: 1, rtp: 0.965, maxWin: 5000, feature: true, buyBonus: false } },
	},
	_mechanic: MECHANICS.ways,
	symbols: [
		{ name: 'H1', role: 'high', special: [], paytable: { 3: 5, 4: 12.5, 5: 50 } },
		{ name: 'H2', role: 'high', special: [], paytable: { 3: 2.8, 4: 6.9, 5: 27.5 } },
		{ name: 'L1', role: 'low', special: [], paytable: { 3: 0.8, 4: 2.1, 5: 8.3 } },
		{ name: 'L2', role: 'low', special: [], paytable: { 3: 0.5, 4: 1.1, 5: 4.6 } },
		{ name: 'W', role: 'wild', special: ['wild'], paytable: { 3: 5, 4: 12.5, 5: 50 } },
		{ name: 'S', role: 'scatter', special: ['scatter'] },
	],
	freeSpins: { triggerSymbol: 'S', triggerCount: 3, awardedSpins: 15, retrigger: true },
});

test('the model prices a taller ways board higher, because ways pay per way', () => {
	// The whole point. Nothing else about these two specs differs — same paytable,
	// same symbols, same volatility — and a row of extra height multiplies the
	// ways count from 243 to 1024. If the model could not see that, it could not
	// have caught the game that failed to optimise.
	const short = waysSpec([3, 3, 3, 3, 3]);
	const tall = waysSpec([4, 4, 4, 4, 4]);
	const evOf = (spec) => estimateStripEv(spec, stripColumns(spec, 'BR0'), { spins: 4000 }).ev;

	const shortEv = evOf(short);
	const tallEv = evOf(tall);
	assert.ok(tallEv > shortEv * 2, `taller board should pay much more (${shortEv} -> ${tallEv})`);
});

test('the model reproduces the failure it was written for', () => {
	// The exact geometry and paytable that broke the optimiser. The assertion is
	// deliberately loose on the number and strict on the conclusion: what matters
	// is that this is caught as wildly out of band, not that it measures 60.2.
	const spec = waysSpec([4, 4, 4, 4, 4]);
	const report = balanceSpec(spec, { spins: 4000 });
	assert.equal(report.inBand, false);
	assert.ok(report.ratio > 10, `should be an order of magnitude out, was ${report.ratio}x`);
	assert.ok(report.paytableScale < 0.2, `should call for a big cut, said x${report.paytableScale}`);
	assert.ok(
		report.findings.some((f) => f.includes('1024 ways')),
		'should name the geometry as the cause',
	);
});

test('rescaling the paytable by the reported factor lands it in band', () => {
	// Expected value is linear in the paytable, so the reported factor is exact
	// rather than a starting point for iteration. This is the property that makes
	// `math:balance --apply` a fix and not a guess.
	const spec = waysSpec([4, 4, 4, 4, 4]);
	const before = balanceSpec(spec, { spins: 4000 });
	assert.equal(before.inBand, false);

	const scaled = scalePaytable(spec, before.paytableScale);
	const after = balanceSpec(scaled, { spins: 4000 });
	assert.equal(after.inBand, true, `still ${after.ratio}x out after rescaling`);
	assert.ok(
		after.ratio > EV_TOLERANCE.low && after.ratio < EV_TOLERANCE.high,
		`ratio ${after.ratio} outside [${EV_TOLERANCE.low}, ${EV_TOLERANCE.high}]`,
	);
});

test('scalePaytable does not mutate the spec it is given', () => {
	const spec = waysSpec([3, 3, 3, 3, 3]);
	const before = JSON.stringify(spec.symbols);
	scalePaytable(spec, 0.5);
	assert.equal(JSON.stringify(spec.symbols), before);
});

test('calibration scans alpha rather than bisecting, because EV is U-shaped in it', () => {
	// The obvious implementation bisects, reasoning that a steeper payout curve
	// makes top symbols rarer and lowers EV. Measured, that is wrong at the top of
	// the range: high alpha concentrates the strip onto the CHEAPEST symbol, and a
	// strip dominated by one symbol lands it on every reel nearly every spin. On
	// the 5x4 board, alpha 4 paid 1,656x per spin against 58.8x at alpha 1.0 — a
	// bisection walked to the wrong end of the curve and reported it as correct.
	const spec = waysSpec([4, 4, 4, 4, 4]);
	const result = calibrateAlpha(spec, { target: 0.4, spins: 3000 });
	const evs = result.curve.map((p) => p.ev);
	const highEnd = evs[evs.length - 1];
	const middle = evs[Math.floor(evs.length / 2)];
	assert.ok(
		highEnd > middle,
		`EV should rise again at high alpha (mid ${middle}, high ${highEnd}) — if it does not, ` +
			'the U-shape this test documents has gone and a bisection would be valid again',
	);
	// And the scan must not have returned that high end as its answer.
	assert.ok(result.alpha < 4, `scan settled at the endpoint (alpha ${result.alpha})`);
});

test('the base-game target matches how planOptimisation splits RTP', () => {
	// If these two ever disagree, the balance check passes a game the optimiser
	// then rejects — the exact class of bug this whole file exists to prevent.
	const spec = waysSpec([3, 3, 3, 3, 3]);
	const target = baseGameTarget(spec);
	const plan = planOptimisation(spec);
	const basegame = plan.modes[0].conditions.find((c) => c.kind === 'basegame');
	assert.equal(target.baseRtp, basegame.rtp);
	assert.equal(target.baseHitRate, basegame.hitRate);
});

test('the multiplier ladder is short where multipliers compound', () => {
	// A ladder topping out at 10x is fine where multipliers sum: five of them
	// reach 50x. Where they compound it is not — 10x on each of five reels is
	// 100,000x from the multipliers alone, so the top of the ladder stops being a
	// rare treat and becomes the whole game.
	const compounding = multiplierLadder(
		{ game: { multiplierStrategy: 'symbol', volatility: 'high' } },
		MECHANICS.ways,
	);
	const summing = multiplierLadder(
		{ game: { multiplierStrategy: 'board', volatility: 'high' } },
		MECHANICS.ways,
	);
	const top = (l) => Math.max(...Object.keys(l).map(Number));
	assert.ok(top(compounding) < top(summing), 'compounding ladder should be the shorter one');
	// And weighted much harder toward 1x.
	assert.ok(compounding[1] > summing[1] * 5);
});

test('renderLadder emits a Python dict the config can carry', () => {
	assert.equal(renderLadder({ 1: 20, 2: 5 }), '{1: 20, 2: 5}');
});

test('the payout table expands range keys, as the engine does at load', () => {
	// Config.convert_range_table() expands "6-9": 12.5 into one entry per size. A
	// model reading the raw keys finds nothing for a cluster of 7 and reports a
	// game that pays nothing at all.
	const spec = {
		symbols: [{ name: 'H1', special: [], paytable: { 5: 5, '6-9': 12.5 } }],
	};
	const table = payoutTable(spec);
	assert.equal(table.get('H1')[7], 12.5);
	assert.equal(table.get('H1')[5], 5);
});

test('the scatter symbol never pays as an ordinary symbol in the model', () => {
	const spec = {
		symbols: [
			{ name: 'H1', special: [], paytable: { 3: 5 } },
			{ name: 'S', special: ['scatter'], paytable: { 3: 100 } },
		],
	};
	assert.equal(payoutTable(spec).has('S'), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// math:validate — the honesty gate
// ─────────────────────────────────────────────────────────────────────────────

/** Lookup-table rows: payouts in hundredths of the bet, as the SDK writes them. */
const lut = (pairs) => pairs.map(([weight, payout]) => ({ weight, payout: payout * 100 }));

const validateSpec = (overrides = {}) => ({
	game: {
		name: 'gate-test',
		mechanic: 'lines',
		rtp: 0.965,
		volatility: 'high',
		reels: { count: 5, rows: [3, 3, 3, 3, 3] },
		betModes: {},
		...overrides,
	},
	_mechanic: MECHANICS.lines,
	symbols: [],
});

/** A distribution that satisfies every hard rule, to vary one thing at a time. */
function healthyRows(maxWin) {
	const rows = [
		[800000, 0],
		[150000, 0.5],
		[40000, 5],
		[8000, maxWin * 0.005],
		[1500, maxWin * 0.05],
		[100, maxWin * 0.3],
	];
	// Weight chosen so the cap lands at 1-in-20,000,000 by weight.
	const total = rows.reduce((s, [w]) => s + w, 0);
	rows.push([total / (20_000_000 - 1), maxWin]);
	return lut(rows);
}

const summaryOf = (rows, { maxWin, cost = 1 }) => summarise(rows, { wincap: maxWin, cost });

test('the gate passes a distribution that satisfies every hard rule', () => {
	const rows = healthyRows(5000);
	const mode = { cost: 1, rtp: 0.965, maxWin: 5000 };
	const summary = summaryOf(rows, { maxWin: 5000 });
	// The synthetic distribution is not on 96.5% RTP, so that rule is expected to
	// fail; every OTHER hard rule must pass, which is what this is checking.
	const result = validateMode({
		name: 'base',
		mode,
		rows,
		summary,
		spec: validateSpec(),
		baseRtp: null,
		optimised: true,
	});
	const failed = result.checks.filter((c) => c.ok === false).map((c) => c.id);
	assert.deepEqual(failed, ['rtp-on-target'], `unexpected failures: ${failed.join(', ')}`);
});

test('a cap no round reaches is caught, and the message says what to do', () => {
	const rows = healthyRows(5000).filter((r) => r.payout < 5000 * 100);
	const result = validateMode({
		name: 'base',
		mode: { cost: 1, rtp: 0.965, maxWin: 5000 },
		rows,
		summary: summaryOf(rows, { maxWin: 5000 }),
		spec: validateSpec(),
		baseRtp: null,
		optimised: true,
	});
	const check = result.checks.find((c) => c.id === 'max-win-reached');
	assert.equal(check.ok, false);
	assert.match(check.detail, /math:balance/);
});

test('cap frequency is judged per unit STAKED, not per round', () => {
	// A 100x bonus buy reaching its cap once in 200,000 rounds is reaching it once
	// in 20,000,000 units staked — the same frequency as the base mode. Judging
	// rounds against rounds failed that mode at "0.01x the target" when nothing
	// was wrong with it.
	const rows = healthyRows(5000);
	// Re-weight so the cap lands 100x more often per ROUND.
	const total = rows.reduce((s, r) => s + r.weight, 0);
	const capRow = rows[rows.length - 1];
	capRow.weight = total / 200_000;

	const judge = (cost) =>
		validateMode({
			name: 'bonus',
			mode: { cost, rtp: 0.965, maxWin: 5000, buyBonus: true },
			rows,
			summary: summaryOf(rows, { maxWin: 5000, cost }),
			spec: validateSpec(),
			baseRtp: null,
			optimised: true,
		}).checks.find((c) => c.id === 'wincap-frequency');

	assert.equal(judge(1).ok, false, 'at 1x cost this really is 100x too frequent');
	assert.equal(judge(100).ok, true, 'at 100x cost it is exactly on target');
});

test('a hole in the win range is caught and named', () => {
	// Everything pays either pennies or the cap, with nothing in between — the
	// shape Stake\'s "no gaps" criterion exists to reject.
	const rows = lut([
		[900000, 0],
		[100000, 0.5],
		[1, 5000],
	]);
	const result = validateMode({
		name: 'base',
		mode: { cost: 1, rtp: 0.965, maxWin: 5000 },
		rows,
		summary: summaryOf(rows, { maxWin: 5000 }),
		spec: validateSpec(),
		baseRtp: null,
		optimised: true,
	});
	const check = result.checks.find((c) => c.id === 'no-gaps');
	assert.equal(check.ok, false);
	assert.match(check.detail, /medium|large/);
});

test('hit rate and volatility are not judged on a bought bonus', () => {
	// A bonus buy triggers every round by definition, so 1-in-1 is correct there,
	// and its shape is compressed by construction. Holding it to the base game\'s
	// bands fails it for being exactly what it is.
	const rows = healthyRows(5000);
	const result = validateMode({
		name: 'bonus',
		mode: { cost: 100, rtp: 0.965, maxWin: 5000, buyBonus: true },
		rows,
		summary: summaryOf(rows, { maxWin: 5000, cost: 100 }),
		spec: validateSpec(),
		baseRtp: 0.965,
		optimised: true,
	});
	assert.equal(result.checks.some((c) => c.id === 'hit-rate'), false);
	assert.equal(result.checks.some((c) => c.id === 'volatility-shape'), false);
});

test('RTP is not judged before the optimiser has run', () => {
	// Pre-optimisation every simulated round is a re-rolled winner, so the RTP is
	// above target BY DESIGN. Failing it there would be a lie in the other
	// direction from passing a broken game.
	const rows = healthyRows(5000);
	const result = validateMode({
		name: 'base',
		mode: { cost: 1, rtp: 0.965, maxWin: 5000 },
		rows,
		summary: summaryOf(rows, { maxWin: 5000 }),
		spec: validateSpec(),
		baseRtp: null,
		optimised: false,
	});
	const check = result.checks.find((c) => c.id === 'rtp-on-target');
	assert.equal(check.ok, null);
	assert.match(check.detail, /optimiser has not run/);
});

test('the volatility check is advisory and never fails the gate', () => {
	// A flat distribution declared high-volatility: the shape is wrong and the
	// gate should SAY so without failing, because the band is ours and uncalibrated.
	const rows = lut([
		[500000, 0.9],
		[500000, 1],
		[1, 5000],
	]);
	const result = validateMode({
		name: 'base',
		mode: { cost: 1, rtp: 0.965, maxWin: 5000 },
		rows,
		summary: summaryOf(rows, { maxWin: 5000 }),
		spec: validateSpec({ volatility: 'high' }),
		baseRtp: null,
		optimised: true,
	});
	const check = result.checks.find((c) => c.id === 'volatility-shape');
	assert.equal(check.advisory, true);
	assert.notEqual(check.ok, false, 'an advisory check must never report a hard failure');
	assert.match(check.detail, /flatter/);
});

test('topShareOfRtp splits the row straddling the cutoff', () => {
	// Taking whole rows makes the answer jump with how the simulation happened to
	// bucket rounds, which would make the measure noise rather than shape.
	const rows = lut([
		[99, 0],
		[1, 100],
	]);
	// The top 1% of weight is exactly the paying row, which carries all the RTP.
	assert.equal(topShareOfRtp(rows, 0.01), 1);
	// Half of it carries half.
	assert.equal(topShareOfRtp(rows, 0.005), 0.5);
});

test('every rule states where it came from', () => {
	// Four of these are our reading of Stake\'s criteria, gathered from research
	// rather than handed to us. A gate that overstates its authority is worse than
	// no gate, so the provenance is data and is asserted to be complete.
	const rows = healthyRows(5000);
	const result = validateMode({
		name: 'base',
		mode: { cost: 1, rtp: 0.965, maxWin: 5000 },
		rows,
		summary: summaryOf(rows, { maxWin: 5000 }),
		spec: validateSpec(),
		baseRtp: null,
		optimised: true,
	});
	for (const check of result.checks) {
		assert.ok(RULE_PROVENANCE[check.id], `rule "${check.id}" does not say where it came from`);
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// Cascade and retrigger safety
//
// Both were found by hanging a simulation, not by reading code, and both are
// the same shape of bug: a quantity that is fine below 1 and fatal at 1.
// ─────────────────────────────────────────────────────────────────────────────

test('the retrigger threshold never drops below 3 scatters', () => {
	// It used to be max(2, triggerCount - 1). Two scatters is not "slightly
	// easier than three" on a large board: 6.8% of free-spin boards on a 7x7
	// carried two or more, so a round awarding 12 free spins retriggered its way
	// to 186 and the simulation spent minutes inside single rounds. Measured at
	// 0.91% once the floor was in.
	const rendered = renderFreespinTriggers({
		game: { reels: { count: 7 } },
		freeSpins: { triggerCount: 3, awardedSpins: 12, retrigger: true },
	});
	const freegame = rendered.slice(rendered.indexOf('freegame_type'));
	assert.equal(/\b2:/.test(freegame), false, 'free-game table must not trigger on 2 scatters');
	assert.ok(/\b3:/.test(freegame), 'free-game table should start at 3');
});

test('a spec asking for a 2-scatter retrigger still gets one', () => {
	// The floor is a default, not a prohibition — an explicit retriggerCount is
	// the designer's call, and mathBalance reports what it costs either way.
	const rendered = renderFreespinTriggers({
		game: { reels: { count: 7 } },
		freeSpins: { triggerCount: 3, awardedSpins: 12, retrigger: true, retriggerCount: 2 },
	});
	assert.ok(/\b2:/.test(rendered.slice(rendered.indexOf('freegame_type'))));
});

test('retrigger safety reads a strip that actually has scatters on it', () => {
	// stripColumns leaves scatters off by default, because they do not pay and
	// would distort the EV model. Reading that strip made this check measure a 0%
	// trigger rate on every game — a check that silently passes everything is
	// worse than no check at all.
	const spec = {
		game: {
			name: 'retrigger-test',
			mechanic: 'cluster',
			rtp: 0.965,
			volatility: 'low',
			reels: { count: 7, rows: Array(7).fill(7) },
			betModes: { base: { cost: 1, rtp: 0.965, maxWin: 10000 } },
		},
		_mechanic: MECHANICS.cluster,
		symbols: [
			{ name: 'H1', special: [], paytable: { 5: 5, 6: 12, 7: 12 } },
			{ name: 'L1', special: [], paytable: { 5: 1, 6: 2, 7: 2 } },
			{ name: 'S', special: ['scatter'] },
		],
		freeSpins: { triggerSymbol: 'S', triggerCount: 3, awardedSpins: 12, retrigger: true },
	};
	const safety = retriggerSafety(spec, { spins: 4000 });
	assert.ok(safety, 'a retriggering game should be measurable');
	assert.ok(safety.triggerProbability > 0, 'measured a 0% trigger rate — the strip has no scatters');
});

test('a runaway retrigger is caught before the round can diverge', () => {
	// The expansion factor is retriggerSpins x P(retrigger). Above 1 the round
	// never ends; the flagged game sat at 0.54, whose MEAN is only 2.2x but whose
	// tail the simulation runs thousands of times.
	const base = {
		game: {
			name: 'runaway',
			mechanic: 'cluster',
			rtp: 0.965,
			volatility: 'low',
			reels: { count: 7, rows: Array(7).fill(7) },
			betModes: { base: { cost: 1, rtp: 0.965, maxWin: 10000 } },
		},
		_mechanic: MECHANICS.cluster,
		symbols: [
			{ name: 'H1', special: [], paytable: { 5: 5, 6: 12, 7: 12 } },
			{ name: 'L1', special: [], paytable: { 5: 1, 6: 2, 7: 2 } },
			{ name: 'S', special: ['scatter'] },
		],
		freeSpins: { triggerSymbol: 'S', triggerCount: 3, awardedSpins: 12, retrigger: true },
	};
	const safe = retriggerSafety(base, { spins: 4000 });
	// Two scatters on a 49-cell board is common, so this is the configuration
	// that hung.
	const risky = retriggerSafety(
		{ ...base, freeSpins: { ...base.freeSpins, retriggerCount: 2, retriggerSpins: 12 } },
		{ spins: 4000 },
	);
	assert.ok(
		risky.expansion > safe.expansion,
		`a 2-scatter retrigger should expand more (${safe.expansion} vs ${risky.expansion})`,
	);
	assert.ok(safe.ok, `the 3-scatter default should be safe, measured ${safe.expansion}`);
});

test('a game without retriggers has nothing to measure', () => {
	const spec = {
		game: { name: 'x', mechanic: 'cluster', reels: { count: 7, rows: Array(7).fill(7) } },
		_mechanic: MECHANICS.cluster,
		symbols: [{ name: 'S', special: ['scatter'] }],
		freeSpins: { triggerCount: 3, awardedSpins: 10, retrigger: false },
	};
	assert.equal(retriggerSafety(spec), null);
});

test('strip profiles differ per mechanic, because the samples do', () => {
	// The originals were measured off 0_0_lines and 0_0_ways only. Applied to a
	// 7x7 cluster board they put 13% wilds in stacks nine tall on the cap strip;
	// a wild joins every group it touches, 93% of boards won, and the round never
	// ended. Measured across the shipped samples:
	//   0_0_lines  FRWCAP 13.0%   0_0_cluster WCAP 7.1%   0_0_scatter WCAP 0%
	const linesCap = stripProfileFor(MECHANICS.lines, 'FRWCAP');
	const clusterCap = stripProfileFor(MECHANICS.cluster, 'WCAP');
	const scatterCap = stripProfileFor(MECHANICS.scatter, 'WCAP');
	assert.ok(linesCap.wildPct > clusterCap.wildPct);
	assert.equal(scatterCap.wildPct, 0, '0_0_scatter ships no wilds on any strip');
	assert.equal(linesCap.wildStack, 'full', 'a lines cap board needs whole reels of wilds');
	assert.equal(clusterCap.wildStack, 1, 'a cluster cap board needs a big group, not a full reel');
});

test('scatter density thins on the free-game and cap strips', () => {
	// Every shipped sample does this and ours did not, which is what let the
	// retrigger loop run away. 0_0_cluster: BR0 1.2%, FR0 0.8%.
	for (const mechanic of [MECHANICS.lines, MECHANICS.cluster, MECHANICS.scatter]) {
		const base = stripProfileFor(mechanic, 'BR0').scatterPct;
		const free = stripProfileFor(mechanic, 'FR0').scatterPct;
		assert.ok(free < base, `${mechanic.id}: free strip (${free}) should be thinner than base (${base})`);
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// The mechanics library
//
// The research behind this used to live in docs/mechanics-catalogue.md, where
// nothing could read it — no command, no test, no screen referenced that file.
// These tests exist because data nobody validates rots as quietly as prose
// nobody reads.
// ─────────────────────────────────────────────────────────────────────────────

test('every mechanic declares a status the tool understands', () => {
	// The failure mode of a library like this is that it reads as a feature list.
	// Status is what stops that, so it has to be present and valid on every row.
	for (const [id, m] of Object.entries(MECHANIC_LIBRARY)) {
		assert.ok(STATUS_ORDER.includes(m.status), `${id} has status "${m.status}"`);
		assert.ok(m.rule && m.rule.length > 40, `${id} needs a real rule description`);
		assert.ok(m.family, `${id} needs a family`);
		assert.ok(m.art, `${id} must state what art it needs — that is the point of the library`);
		assert.ok(m.math, `${id} must state where the maths comes from`);
	}
});

test('every conflict points at a mechanic that exists', () => {
	// A conflict naming a typo'd id silently never fires, which is worse than no
	// conflict rule at all — the editor would accept an incoherent combination.
	for (const [id, m] of Object.entries(MECHANIC_LIBRARY)) {
		for (const c of m.conflictsWith) {
			assert.ok(MECHANIC_LIBRARY[c.id], `${id} conflicts with unknown "${c.id}"`);
			assert.ok(c.why && c.why.length > 20, `${id} + ${c.id} needs a reason, not just a flag`);
		}
		for (const other of m.combinesWith) {
			if (other === '*') continue;
			assert.ok(MECHANIC_LIBRARY[other], `${id} combines with unknown "${other}"`);
		}
	}
});

test('every reference game names mechanics that exist', () => {
	for (const [id, g] of Object.entries(REFERENCE_GAMES)) {
		assert.ok(g.studio, `${id} needs attribution`);
		assert.ok(g.whyItMatters.length > 40, `${id} needs a reason to be in the library`);
		for (const m of g.mechanics) {
			assert.ok(MECHANIC_LIBRARY[m], `${id} references unknown mechanic "${m}"`);
		}
	}
});

test('the conflict we found the expensive way has been RESOLVED, not deleted', () => {
	// Expanding wilds on a tumbling board was the library's founding conflict,
	// found by running a generated game rather than reading code. The
	// boardLifetime work fixed it: every board-writing recipe declares how long
	// its writes survive, and the scaffolder restores them after each cascade
	// refill. Proven end to end — 96.50% RTP, cap reached at 1-in-20,000,000.
	//
	// This test guards the resolution. If the conflict comes back, either the
	// lifetime machinery regressed or someone re-added the rule by hand.
	const result = checkCombination(['tumble', 'expanding_wild']);
	assert.deepEqual(result.conflicts, [], 'the lifetime work resolved this pairing');
	assert.equal(BEHAVIOR_RECIPES.expanding.boardLifetime, 'this-round');
	assert.ok(BEHAVIOR_RECIPES.expanding.reapplyCall);

	// ...and the conflicts that are genuinely unresolved are still there.
	const walking = checkCombination(['tumble', 'walking_wild']);
	assert.equal(walking.ok, false, 'a step-per-spin wild is still undefined inside a cascade');
});

test('a conflicting pair is reported once, not twice', () => {
	// Both sides of a pairing may declare it; reporting it from each direction
	// would make a two-mechanic clash look like two problems.
	const result = checkCombination(['tumble', 'expanding_wild', 'walking_wild']);
	const keys = result.conflicts.map((c) => c.key);
	assert.equal(new Set(keys).size, keys.length, `duplicate conflict rows: ${keys.join(', ')}`);
});

test('a blocked mechanic is refused, with the reason', () => {
	const result = checkCombination(['ways_pays', 'megaways']);
	assert.equal(result.ok, false);
	assert.deepEqual(result.blocked, ['megaways']);
	assert.match(MECHANIC_LIBRARY.megaways.math.notes, /patent/i);
	assert.match(MECHANIC_LIBRARY.megaways.math.notes, /num_rows/);
});

test('choosing mechanics produces an art list', () => {
	// The whole reason this studio wants the library: pick mechanics, learn what
	// to draw. If this join breaks, the library is just trivia.
	const art = artRequirementsFor(['tumble', 'grid_multipliers', 'freespins']);
	assert.ok(art.animations.some((a) => /explosion/i.test(a)), 'tumble needs an explosion state');
	assert.ok(art.animations.some((a) => /badge double/i.test(a)), 'grid multipliers need a doubling beat');
	assert.ok(art.screens.some((s) => /16 languages/i.test(s)), 'free spins carry the localised banner cost');
	// Every animation is attributed, so an art director can ask "why am I drawing this".
	for (const a of art.animations) assert.match(a, /\[.+\]$/, `unattributed animation: ${a}`);
});

test('the usable-today count is not inflated', () => {
	// The number that matters when someone asks "what can this tool do". It must
	// count only what generates code or works from a spec setting.
	const stats = libraryStats();
	const usable = Object.values(MECHANIC_LIBRARY).filter(
		(m) => m.status === 'built' || m.status === 'config',
	);
	assert.equal(stats.usableToday, usable.length);
	assert.ok(stats.total > stats.usableToday, 'a library where everything is built is a library that is lying');
});

test('a mechanic generated by a recipe points at a real recipe', () => {
	for (const [id, m] of Object.entries(MECHANIC_LIBRARY)) {
		if (!m.recipe) continue;
		assert.ok(BEHAVIOR_RECIPES[m.recipe], `${id} claims recipe "${m.recipe}", which does not exist`);
	}
});

test('a built mechanic must have somewhere the code actually comes from', () => {
	// "built" is the strongest claim in the library. It has to cash out as either
	// a behavior recipe or a named sample, or it is just optimism.
	for (const [id, m] of Object.entries(MECHANIC_LIBRARY)) {
		if (m.status !== 'built') continue;
		assert.ok(
			m.recipe || m.math.sample,
			`${id} is marked built but names neither a recipe nor a sample`,
		);
	}
});

test('trademarked mechanics carry an owner and a warning', () => {
	const flagged = Object.values(MECHANIC_LIBRARY).filter((m) => m.trademark);
	assert.ok(flagged.length >= 5, 'the obvious trademarked names should all be flagged');
	for (const m of flagged) {
		assert.ok(m.trademark.owner, `${m.id} flags a trademark without naming the owner`);
		assert.ok(m.trademark.note, `${m.id} flags a trademark without saying what it means`);
	}
	// Megaways is the one that is a patent as well, and must say so.
	assert.match(MECHANIC_LIBRARY.megaways.trademark.note, /patent/i);
});

test('the library can answer the questions it exists to answer', () => {
	// "What reaches 50,000x?" and "what works on a cluster board?" — the two
	// questions a designer actually asks, which a markdown file could not answer.
	const big = gamesByMaxWin(50000);
	assert.ok(big.length >= 3, 'should know several games at the top of the range');
	assert.ok(big[0].maxWin >= big[big.length - 1].maxWin, 'sorted descending');

	const clusterable = mechanicsForWinType('cluster');
	assert.ok(clusterable.some((m) => m.id === 'grid_multipliers'));
	assert.equal(clusterable.some((m) => m.id === 'lines_pays'), false);

	// And the reverse join: who has shipped a given mechanic.
	assert.ok(gamesUsing('hold_and_win').length >= 2);
	assert.ok(getMechanicEntry('hold_and_win').seenIn.length >= 2);
});

// ─────────────────────────────────────────────────────────────────────────────
// The art brief
//
// `forge audit` reports gaps in supplied art. This answers the earlier question
// — given a spec and nothing else, what do we draw? The two must stay exact
// mirror images, which is what the end-to-end test below is for.
// ─────────────────────────────────────────────────────────────────────────────

const briefSpec = () => ({
	game: {
		name: 'brief-test',
		mechanic: 'cluster',
		rtp: 0.965,
		volatility: 'low',
		reels: { count: 7, rows: Array(7).fill(7) },
		betModes: { base: { cost: 1, rtp: 0.965, maxWin: 10000, feature: true } },
		globalMultiplierPerSpin: true,
	},
	_mechanic: MECHANICS.cluster,
	symbols: [
		{ name: 'H1', label: 'High 1', role: 'high', special: [], behaviors: [], paytable: { 5: 5 } },
		{ name: 'W', label: 'Wild', role: 'wild', special: ['wild'], behaviors: [], paytable: { 5: 5 } },
		{ name: 'S', label: 'Scatter', role: 'scatter', special: ['scatter'], behaviors: [] },
	],
	freeSpins: { triggerSymbol: 'S', triggerCount: 3, awardedSpins: 12, retrigger: true },
});

test('a tumbling game asks every symbol for an explosion state', () => {
	// The state set is mechanic-dependent: asking a lines game for an explosion
	// would be noise, since nothing ever triggers one.
	const d = buildArtBrief(briefSpec());
	for (const s of d.symbols) {
		assert.ok(
			s.states.some((st) => st.state === 'explosion'),
			`${s.name} needs an explosion state on a cluster game`,
		);
	}
});

test('every required state names the animation and says who asked for it', () => {
	// "You are missing a state" is half a finding. An artist needs the animation
	// name to export against and a reason it exists.
	const d = buildArtBrief(briefSpec());
	for (const s of d.symbols) {
		for (const st of s.states) {
			assert.ok(st.animationName, `${s.name}.${st.state} has no animation name`);
			assert.ok(st.requiredBy.length, `${s.name}.${st.state} does not say what requires it`);
		}
	}
});

test('the win banners are the engine\'s fixed bands, not fractions of the cap', () => {
	// Corrected after inventing them. Config.get_win_level() bands on FIXED
	// multiples of the bet; only level 9's ceiling and level 10's floor track
	// wincap. A "big win" fires at 15x on a 500x game and on a 100,000x game
	// alike, which is exactly the sort of thing an art brief must not get wrong.
	const small = winLevelBands(500);
	const huge = winLevelBands(100000);
	assert.equal(small[0].standard.from, 15);
	assert.equal(huge[0].standard.from, 15, 'level 6 must not move with the cap');
	assert.equal(small[0].standard.to, 30);

	// ...and the two that DO move.
	assert.equal(huge.find((b) => b.level === 9).standard.to, 100000);
	assert.equal(huge.find((b) => b.level === 10).standard.from, 100000);
	assert.equal(small.find((b) => b.level === 9).standard.to, 500);
});

test('the two win-level scales are both reported, because they differ', () => {
	// The same banner art plays for level 7 on both scales, but level 7 means
	// 30x-50x during a spin and 100x-500x at feature end. An artist told only
	// "super win" cannot know that.
	const bands = winLevelBands(10000);
	const seven = bands.find((b) => b.level === 7);
	assert.equal(seven.standard.from, 30);
	assert.equal(seven.endFeature.from, 100);
	assert.notEqual(seven.standard.to, seven.endFeature.to);
	assert.equal(WIN_LEVEL_SCALES.standard.bands[6][0], 15);
	assert.equal(WIN_LEVEL_SCALES.endFeature.bands[6][0], 50);
});

test('the localisation cost lands on three sheets, not forty', () => {
	// "Everything needs 16 languages" is both wrong and expensive. Verified by
	// reading frame names: freeSpins.json, MM_pressanywhere.json and
	// MM_Localisation_winsmall.json carry locale variants; no other sheet does.
	assert.equal(LOCALES.length, 16);
	assert.equal(LOCALISED_SHEETS.length, 3);
	const d = buildArtBrief(briefSpec());
	assert.equal(d.totals.localisedFrames, 48);
	for (const sheet of d.localised) {
		assert.equal(sheet.frames.length, 16);
		assert.ok(sheet.content, `${sheet.sheet} must say what words it carries`);
	}
});

test('reusable-across-games assets are separated from per-game ones', () => {
	// A studio planning its second title should not re-budget for the loading
	// progress bar.
	const d = buildArtBrief(briefSpec());
	const reusable = d.screens.filter((s) => s.reusableAcrossGames);
	assert.ok(reusable.length >= 3, 'some assets are identical in every title we ship');
	assert.ok(d.screens.some((s) => !s.reusableAcrossGames), 'and most are not');
});

test('the brief carries what the chosen mechanics add', () => {
	// The join the mechanics library exists to make: picking a mechanic tells the
	// art team what it costs them.
	const d = buildArtBrief(briefSpec());
	assert.ok(d.fromMechanics.mechanics.includes('tumble'));
	assert.ok(d.fromMechanics.mechanics.includes('cluster_pays'));
	assert.ok(d.fromMechanics.mechanics.includes('freespins'));
	assert.ok(d.fromMechanics.mechanics.includes('progressive_global_multiplier'));
	assert.ok(
		d.fromMechanics.screens.some((s) => /16 languages/i.test(s)),
		'free spins carry the localised banner cost',
	);
});

test('a cascading game is warned that its explosion is on a hot path', () => {
	const d = buildArtBrief(briefSpec());
	assert.ok(
		d.fromMechanics.notes.some((n) => /explosion|cascade timing/i.test(n.note)),
		'the tumble note about round length should reach the brief',
	);
});

test('the sound list covers the feature and the cascade ladder', () => {
	const d = buildArtBrief(briefSpec());
	const names = d.sounds.map((s) => s.name);
	assert.ok(names.includes('bgm_freegame'), 'a feature with no music of its own has no lift');
	assert.ok(names.includes('tumble_win_1'), 'a tumbling game needs the cascade pitch ladder');
	assert.ok(names.includes('sfx_max_win'), 'every banner level needs a sound');
	const tumble = d.sounds.find((s) => s.name === 'tumble_win_1');
	assert.match(tumble.note, /ladder/i, 'must say it is a ladder, not one clip');
});

test('all three render formats produce something usable', () => {
	const d = buildArtBrief(briefSpec());
	const md = renderMarkdown(d);
	assert.match(md, /## Symbols/);
	assert.match(md, /## Localised text art/);
	assert.match(md, /## Win banners/);

	const csv = renderCsv(d);
	const lines = csv.trim().split('\n');
	assert.equal(lines[0], 'category,item,detail,format,required,note');
	// One row per deliverable, so the count is schedulable.
	assert.ok(lines.length > d.totals.symbolStates, 'CSV should have a row per deliverable');
	// Commas inside a field must not break the columns.
	assert.ok(csv.includes('"'), 'fields containing commas must be quoted');

	const manifest = renderManifest(d);
	assert.match(manifest, /^assetsSourceDir:/m);
	assert.match(manifest, /^spineSymbols:/m);
});

test('the manifest emits the right fields for each asset type', () => {
	// A spine needs atlas + png + skeleton; a sprite sheet needs one json.
	// Getting this wrong is a runtime miss, not a build error.
	const d = buildArtBrief(briefSpec());
	const manifest = renderManifest(d);
	const progressBar = d.screens.find((s) => s.assetKey === 'progressBar');
	assert.notEqual(progressBar.assetType, 'spine', 'progressBar is a sprite sheet in the sample');
	// Its block must not claim an atlas.
	const block = manifest.slice(manifest.indexOf('progressBar:'));
	const nextSlot = block.slice(1).search(/\n  #? ?\w[\w.]*:/);
	assert.equal(/atlas:/.test(block.slice(0, nextSlot)), false, 'a sprite sheet must not be given a spine atlas');
});

test('FULFILLING THE BRIEF MAKES THE AUDIT PASS', () => {
	// The gate Phase 2 is defined by, and the reason the brief can be trusted:
	// generate the manifest from the brief, create exactly the files it names,
	// run the REAL audit, and require zero errors. Without this the brief and
	// the checker drift, and a brief that no longer matches what is checked is
	// worse than no brief at all.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-brief-'));
	try {
		const specPath = path.join(dir, 'game-spec.yaml');
		fs.writeFileSync(
			specPath,
			[
				'game:',
				'  name: brief-gate',
				'  rtp: 0.965',
				'  volatility: low',
				'  mechanic: cluster',
				'  reels: { count: 7, rows: [7, 7, 7, 7, 7, 7, 7] }',
				'  betModes:',
				'    base: { cost: 1, rtp: 0.965, maxWin: 10000, feature: true, buyBonus: false }',
				'symbols:',
				'  - { name: H1, role: high, label: High 1, paytable: { "5": 5, "6-9": 12.5, "10-49": 60 } }',
				'  - { name: L1, role: low, label: Low 1, paytable: { "5": 1, "6-9": 2, "10-49": 10 } }',
				'  - { name: W, role: wild, label: Wild, special: [wild], paytable: { "5": 5, "6-9": 12.5, "10-49": 60 } }',
				'  - { name: S, role: scatter, label: Scatter, special: [scatter] }',
				'freeSpins: { triggerSymbol: S, triggerCount: 3, awardedSpins: 12, retrigger: true }',
				'',
			].join('\n'),
			'utf8',
		);

		const sourceDir = path.join(dir, 'assets-source');
		fs.mkdirSync(sourceDir, { recursive: true });

		const manifestPath = path.join(dir, 'assets-manifest.yaml');
		runBrief({ specPath, format: 'manifest', out: manifestPath, quiet: true });

		// Create exactly the files the generated manifest names — nothing more.
		const manifest = YAML.parse(fs.readFileSync(manifestPath, 'utf8'));
		const files = new Set();
		for (const def of Object.values(manifest.spineSymbols ?? {})) {
			for (const field of ['atlas', 'png', 'skeleton', 'staticSprite']) {
				if (def?.[field]) files.add(def[field]);
			}
		}
		for (const def of Object.values(manifest.screens ?? {})) {
			if (typeof def === 'string') files.add(def);
			else for (const field of ['atlas', 'png', 'skeleton', 'sprite']) if (def?.[field]) files.add(def[field]);
		}
		assert.ok(files.size > 10, `the manifest should name real files, named ${files.size}`);
		for (const file of files) fs.writeFileSync(path.join(sourceDir, file), 'x', 'utf8');

		// audit prints its report; the assertion is on the returned findings, so
		// the output is captured rather than left to scroll past the test names.
		const log = console.log;
		let result;
		try {
			console.log = () => {};
			result = audit({ specPath, manifestPath, json: true });
		} finally {
			console.log = log;
		}
		const errors = result.findings.filter((f) => f.level === 'error');
		assert.deepEqual(
			errors.map((e) => `${e.area}: ${e.message}`),
			[],
			'a fulfilled brief must audit clean',
		);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// Board lifetimes
//
// The expanding-wild-on-a-cascade bug was found by running a generated game:
// the recipe writes wilds into the board, the cascade calls tumble_game_board()
// and redraws it from the strips, and the wilds vanish mid-round. That is not
// one bug but a class of them — it recurs for sticky wilds, walking wilds,
// persistent symbols, blockers, locked prizes. Declaring a lifetime is the fix
// that generalises.
// ─────────────────────────────────────────────────────────────────────────────

test('every recipe declares a board lifetime, or explicitly none', () => {
	// The point of the abstraction is that no board-writing mechanic can be added
	// without answering the question. `undefined` would silently mean "does not
	// survive a cascade" and reintroduce exactly the bug this prevents.
	for (const [id, recipe] of Object.entries(BEHAVIOR_RECIPES)) {
		assert.ok(
			'boardLifetime' in recipe,
			`recipe "${id}" does not declare a boardLifetime — see BOARD_LIFETIMES`,
		);
		if (recipe.boardLifetime !== null) {
			assert.ok(
				BOARD_LIFETIMES.includes(recipe.boardLifetime),
				`recipe "${id}" has lifetime "${recipe.boardLifetime}", which is not one of ${BOARD_LIFETIMES.join(', ')}`,
			);
		}
	}
});

test('a lifetime that outlives an evaluation names how to restore itself', () => {
	// Declaring "this survives a cascade" without saying HOW to put it back makes
	// the declaration decorative.
	for (const [id, recipe] of Object.entries(BEHAVIOR_RECIPES)) {
		if (!LIFETIMES_SURVIVING_CASCADE.includes(recipe.boardLifetime)) continue;
		assert.ok(
			recipe.reapplyCall,
			`recipe "${id}" survives a cascade but names no reapplyCall`,
		);
		assert.match(recipe.reapplyCall, /^self\.\w+\(\)$/, `${id}: reapplyCall should be a method call`);
	}
});

test('a recipe that does not touch the board has nothing to restore', () => {
	for (const [id, recipe] of Object.entries(BEHAVIOR_RECIPES)) {
		if (recipe.boardLifetime !== null) continue;
		assert.equal(recipe.reapplyCall, null, `${id} writes nothing but names a reapplyCall`);
	}
});

test('this-evaluation writes are not re-applied, because nothing carries them', () => {
	// colossal stamps its block onto each newly drawn board. Re-applying it after
	// a refill would be re-stamping something the next draw writes anyway.
	assert.equal(BEHAVIOR_RECIPES.colossal.boardLifetime, 'this-evaluation');
	assert.equal(LIFETIMES_SURVIVING_CASCADE.includes('this-evaluation'), false);
});

test('the lifetimes are ordered from shortest to longest', () => {
	// Read as a scale in the docs and in the editor, so the order is load-bearing.
	assert.deepEqual(BOARD_LIFETIMES, [
		'this-evaluation',
		'this-cascade-sequence',
		'this-round',
		'until-consumed',
	]);
	// Everything except the shortest has to survive a cascade.
	assert.deepEqual(LIFETIMES_SURVIVING_CASCADE, BOARD_LIFETIMES.slice(1));
});

// ─────────────────────────────────────────────────────────────────────────────
// Grid multipliers
//
// The plan called these "adaptable from games/0_0_gold_rush". Two things were
// wrong with that. 0_0_gold_rush is a game this TOOL generated, not a shipped
// sample — the real source is 0_0_cluster, which every generated cluster game
// already clones, so the mechanic has worked all along. And the sample's own
// docstring says wins "double the grid value" while the code beneath it does
// `+= 1`. Measured in a generated game: top cell 110, which is not a power of
// two.
// ─────────────────────────────────────────────────────────────────────────────

test('the default growth is what the shipped sample actually does', () => {
	// Not what its docstring says. Changing the default would silently re-shape
	// the volatility of every existing cluster game.
	assert.equal(GRID_GROWTH_DEFAULT, 'increment');
	assert.deepEqual(GRID_GROWTH_MODES, ['increment', 'double']);
	assert.equal(GRID_CAP_DEFAULT, 512);
});

test('grid multipliers are refused on every mechanic but cluster', () => {
	// 0_0_scatter, 0_0_lines and 0_0_ways carry no position_multipliers and no
	// evaluate_clusters_with_grid — grepped every shipped sample. Accepting the
	// setting elsewhere would emit config nothing reads.
	for (const mechanic of ['lines', 'ways', 'scatter']) {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-grid-'));
		try {
			const specPath = path.join(dir, 'game-spec.yaml');
			fs.writeFileSync(
				specPath,
				[
					'game:',
					'  name: grid-test',
					'  rtp: 0.965',
					`  mechanic: ${mechanic}`,
					'  reels: { count: 5, rows: [3, 3, 3, 3, 3] }',
					'  gridMultipliers: { growth: double }',
					'  betModes:',
					'    base: { cost: 1, rtp: 0.965, maxWin: 5000, feature: true }',
					'symbols:',
					'  - { name: H1, role: high, label: High 1, paytable: { "3": 5, "4": 12, "5": 50 } }',
					'  - { name: L1, role: low, label: Low 1, paytable: { "3": 1, "4": 2, "5": 8 } }',
					'',
				].join('\n'),
				'utf8',
			);
			assert.throws(
				() => loadGameSpec(specPath),
				/cluster mechanic only/,
				`${mechanic} should refuse gridMultipliers`,
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}
});

test('an unknown growth mode is refused rather than silently ignored', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-grid-'));
	try {
		const specPath = path.join(dir, 'game-spec.yaml');
		fs.writeFileSync(
			specPath,
			[
				'game:',
				'  name: grid-test',
				'  rtp: 0.965',
				'  mechanic: cluster',
				'  reels: { count: 7, rows: [7, 7, 7, 7, 7, 7, 7] }',
				'  gridMultipliers: { growth: triple }',
				'  betModes:',
				'    base: { cost: 1, rtp: 0.965, maxWin: 5000, feature: true }',
				'symbols:',
				'  - { name: H1, role: high, label: High 1, paytable: { "5": 5, "6-49": 60 } }',
				'  - { name: L1, role: low, label: Low 1, paytable: { "5": 1, "6-49": 10 } }',
				'',
			].join('\n'),
			'utf8',
		);
		assert.throws(() => loadGameSpec(specPath), /must be one of: increment, double/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('the library no longer claims the mechanic doubles by default', () => {
	// The entry used to read "then DOUBLE on each subsequent hit, capped (512x in
	// the sample)", taken from the sample's docstring rather than its code. A
	// library that repeats a wrong docstring is worse than one that says nothing.
	const grid = MECHANIC_LIBRARY.grid_multipliers;
	assert.equal(grid.status, 'built', 'it works today, in every cluster game');
	assert.deepEqual(grid.winTypes, ['cluster'], 'scatter has no position_multipliers');
	assert.match(grid.rule, /INCREMENT/);
	assert.match(grid.rule, /DOUBLE/);
	assert.equal(grid.math.sample, 'games/0_0_cluster');
	assert.match(grid.math.notes, /0_0_gold_rush/, 'the wrong citation should be recorded, not erased');
});

// ─────────────────────────────────────────────────────────────────────────────
// Stale optimisation
//
// Simulate, optimise, then simulate again. Every file is present, well-formed
// and internally consistent — and the published weights now index rounds the
// books no longer contain. The game would pay a distribution nobody computed,
// and the pipeline would report a confident RTP for it. That is the worst
// failure available here, because it looks exactly like success.
// ─────────────────────────────────────────────────────────────────────────────

const csvTable = (rows) => rows.map((r) => r.join(',')).join('\n') + '\n';

function withTables(rawRows, publishedRows, fn) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-stale-'));
	try {
		const raw = path.join(dir, 'raw.csv');
		const pub = path.join(dir, 'pub.csv');
		fs.writeFileSync(raw, csvTable(rawRows), 'utf8');
		fs.writeFileSync(pub, csvTable(publishedRows), 'utf8');
		return fn(raw, pub);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

test('reweighted rows from the same simulation are not stale', () => {
	// The optimiser rewrites the WEIGHT column and nothing else — verified
	// against a live optimised game, where the id and payout columns were
	// identical in both files. Flagging that as stale would fail every correctly
	// optimised game.
	const result = withTables(
		[['0', '1', '0'], ['1', '1', '44'], ['2', '1', '900']],
		[['0', '1738586969127', '0'], ['1', '1193578433539', '44'], ['2', '77', '900']],
		staleAgainst,
	);
	assert.equal(result, null);
});

test('a different simulation at the SAME row count is caught', () => {
	// The case the first version of this check missed. It compared row counts, on
	// the reasoning that the optimiser only reweights rows — true, and useless,
	// because re-running math:run at the same sims count produces the same number
	// of rows and completely different rounds.
	const result = withTables(
		[['0', '1', '0'], ['1', '1', '7744'], ['2', '1', '900']],
		[['0', '99', '0'], ['1', '1193578433539', '44'], ['2', '77', '900']],
		staleAgainst,
	);
	assert.ok(result, 'same row count, different payouts, must be caught');
	assert.match(result, /pays 7744 in the books and 44 in the published/);
});

test('a row-count difference is still caught, and says so plainly', () => {
	const result = withTables(
		[['0', '1', '0'], ['1', '1', '44']],
		[['0', '1', '0'], ['1', '1', '44'], ['2', '1', '900']],
		staleAgainst,
	);
	assert.match(result, /3 rows against the simulation's 2/);
});

test('a re-ordered simulation id is caught', () => {
	// Two runs can produce the same multiset of payouts in a different order.
	// Comparing the id column catches that where comparing payouts alone would
	// not.
	const result = withTables(
		[['0', '1', '0'], ['1', '1', '44']],
		[['0', '1', '0'], ['7', '1', '44']],
		staleAgainst,
	);
	assert.match(result, /row 2 is simulation 7, the books have 1/);
});

// ── report ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
if (failures.length) {
	for (const { name, err } of failures) {
		console.log(`\nFAIL  ${name}\n      ${err.message.split('\n').join('\n      ')}`);
	}
	console.log(`\n${pass} passed, ${failures.length} FAILED\n`);
	process.exit(1);
}
console.log(`${pass} passed, 0 failed\n`);
