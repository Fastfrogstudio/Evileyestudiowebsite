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
import { renderPaytable, renderSpecialSymbols, renderFreespinTriggers, renderReelCsv, renderNumRows } from '../src/lib/mathGenerators.js';
import { MECHANICS } from '../src/lib/mechanics.js';
import { assertNoExtractedMaterial, matchLine } from '../src/lib/inspirationRules.js';
import { loadGameSpec, SpecValidationError } from '../src/lib/loadSpec.js';

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

test('placeholder reels never stack scatters within a reel window', () => {
	// force_special_board() loops until the board holds EXACTLY the requested
	// number of scatters; two visible in one reel make that unreachable.
	const spec = specFor('lines');
	const csv = renderReelCsv(spec, { seed: 'BR0', length: 300 });
	const rows = csv.trim().split('\n').map((r) => r.split(','));
	const window = Math.max(...spec.game.reels.rows) + 2;
	for (let reel = 0; reel < spec.game.reels.count; reel += 1) {
		const positions = rows.map((r) => r[reel]).map((s, i) => (s === 'S' ? i : -1)).filter((i) => i >= 0);
		for (let i = 1; i < positions.length; i += 1) {
			assert.ok(positions[i] - positions[i - 1] >= window, `scatters too close on reel ${reel}`);
		}
	}
});

test('placeholder reels only contain symbols from the spec', () => {
	// Config.validate_reel_symbols() rejects anything else.
	const spec = specFor('lines');
	const names = new Set(spec.symbols.map((s) => s.name));
	for (const cell of renderReelCsv(spec, { seed: 'BR0', length: 200 }).trim().split(/[\n,]/)) {
		assert.ok(names.has(cell), `unknown symbol "${cell}" on a reel`);
	}
});

test('reel generation is deterministic per game and strip', () => {
	const spec = specFor('lines');
	assert.equal(renderReelCsv(spec, { seed: 'BR0' }), renderReelCsv(spec, { seed: 'BR0' }));
	assert.notEqual(renderReelCsv(spec, { seed: 'BR0' }), renderReelCsv(spec, { seed: 'FR0' }));
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
