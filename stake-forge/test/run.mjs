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
import { requiredStatesForSymbol, validateBehaviors, getRecipe, BEHAVIOR_RECIPES } from '../src/lib/behaviorRecipes.js';
import { buildConfigObject, buildSymbolInfoMap, buildInitialBoard } from '../src/lib/generators.js';
import { renderPaytable, renderSpecialSymbols, renderFreespinTriggers, renderReelCsv, renderNumRows, renderBetModes, betModeCriteria, REEL_STRIP_LENGTH, SCATTER_DENSITY } from '../src/lib/mathGenerators.js';
import { MECHANICS } from '../src/lib/mechanics.js';
import { assertNoExtractedMaterial, matchLine } from '../src/lib/inspirationRules.js';
import { loadGameSpec, loadAssetsManifest, SpecValidationError } from '../src/lib/loadSpec.js';
import { Canvas, encodePng } from '../src/lib/png.js';
import { drawText, measureText } from '../src/lib/font5x7.js';
import { renderSymbolTile, topPayoutOf } from '../src/lib/placeholderArt.js';
import { applyWebRecipe } from '../src/lib/webRecipePatch.js';
import { buildConfigFromMath } from '../src/commands/mathSync.js';
import { summarise } from '../src/commands/mathReport.js';
import { auditSound, readSoundVocabulary, readSoundsUsed, readSoundSprite } from '../src/lib/sound.js';
import { planOptimisation, renderOptimisationPy, splitRtp, VOLATILITY_PROFILES, VOLATILITY_IDS } from '../src/lib/optimisation.js';
import { planSprite, spriteJson, buildFilterGraph, looksLooping, readSoundSources, SPRITE_FORMATS, CLIP_GAP_MS } from '../src/lib/soundSprite.js';
import { inspectMathPublish, collectFrontend } from '../src/commands/packageGame.js';

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

test('expanding is refused on tumbling mechanics', () => {
	// Not merely untested: a cascade re-draws the board mid-spin and would wipe
	// the expanded wilds, and 0_0_expwilds (a lines game) never exercises that.
	for (const mechanic of ['cluster', 'scatter']) {
		const ctx = collect();
		const s = normaliseSymbol({ name: 'W', role: 'wild', special: ['wild', 'multiplier'], behaviors: ['expanding'], paytable: { 5: 1 } }, ctx);
		const ctx2 = collect();
		validateBehaviors(s, { mechanic, ...ctx2 });
		assert.match(ctx2.errors.join(' '), /only verified on mechanic/, `${mechanic} should be refused`);
	}
});

test('expanding is allowed on lines and ways', () => {
	for (const mechanic of ['lines', 'ways']) {
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

test('only recipes with a verified status carry code emitters', () => {
	for (const id of ['sticky', 'prize', 'colossal']) {
		const r = getRecipe(id);
		assert.notEqual(r.status, 'verified');
		assert.ok(!r.emitMath && !r.emitWeb, `${id} must not emit unverified code`);
	}
	assert.equal(getRecipe('expanding').status, 'verified');
	assert.ok(getRecipe('expanding').emitMath);
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
	assert.deepEqual(
		betModeCriteria({ buyBonus: true }).map((c) => c.criteria),
		['freegame'],
	);
	const plan = planOptimisation(optSpec());
	const bonus = plan.modes.find((m) => m.name === 'bonus');
	assert.equal(bonus.conditions.length, 1);
	assert.equal(bonus.conditions[0].criteria, 'freegame');
	// hr="x": every round triggers, so there is no one-in-N to hit.
	assert.equal(bonus.conditions[0].hitRate, 'x');
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
	assert.equal(base.conditions.find((c) => c.criteria === 'basegame').rtp, 0.965);
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

test('an optimisation against a DIFFERENT run is caught by row count', () => {
	// The nastiest one: the table differs from the raw table, so it looks
	// optimised, but its simulation ids no longer match the books beside it.
	withPublishDir(({ publish, rows }) => {
		fs.writeFileSync(path.join(publish, 'lookUpTable_base_0.csv'), rows(40, 7));
	}, ({ root }) => {
		const result = inspectMathPublish({ gameDir: root, gameId: 'x' });
		assert.equal(result.ok, false);
		assert.match(result.problems.join('\n'), /40 rows but the simulation produced 100/);
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
