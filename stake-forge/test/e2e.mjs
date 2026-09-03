#!/usr/bin/env node
/**
 * End-to-end verification against real SDK checkouts.
 *
 * This is the test that actually matters, and it cannot be faked: it scaffolds
 * real games from real specs into real clones of StakeEngine/math-sdk and
 * StakeEngine/web-sdk, then runs Python and tsc against the result.
 *
 *   node test/e2e.mjs --math-sdk ../math-sdk --sdk ../web-sdk
 *
 * Either path may be omitted to check only one side.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { defaultPaytable } from '../src/lib/taxonomy.js';
import { MECHANICS as MECHANIC_PROFILES } from '../src/lib/mechanics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FORGE = path.join(__dirname, '..', 'bin', 'forge.js');
const TEMPLATE = path.join(__dirname, '..', 'templates', 'game-spec.example.yaml');

function arg(name) {
	const i = process.argv.indexOf(`--${name}`);
	return i === -1 ? null : path.resolve(process.argv[i + 1]);
}

const mathSdk = arg('math-sdk');
const webSdk = arg('sdk');
if (!mathSdk && !webSdk) {
	console.error('Usage: node test/e2e.mjs [--math-sdk <path>] [--sdk <path>]');
	process.exit(2);
}

const MECHANICS = {
	lines: { count: 5, rows: [3, 3, 3, 3, 3], paylines: true, expanding: true },
	ways: { count: 5, rows: [3, 3, 3, 3, 3], paylines: false, expanding: true },
	// expanding is refused on tumbling mechanics — see behaviorRecipes.js.
	cluster: { count: 7, rows: [7, 7, 7, 7, 7, 7, 7], paylines: false, expanding: false },
	scatter: {
		count: 6,
		rows: [5, 5, 5, 5, 5, 5],
		paylines: false,
		expanding: false,
		requiredSymbols: [
			{ name: 'M', role: 'low', order: 6, label: 'Multiplier', special: ['multiplier'], paytable: { 5: 2, 4: 1, 3: 0.5 } },
		],
	},
};

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-e2e-'));
const results = [];
/** Specs kept alive so the typecheck pass can re-use them after pnpm install. */
const specPaths = {};

function run(args, label) {
	const r = spawnSync(process.execPath, [FORGE, ...args], { encoding: 'utf8', timeout: 900000 });
	const output = `${r.stdout || ''}${r.stderr || ''}`;
	results.push({ label, ok: r.status === 0, output });
	console.log(`${r.status === 0 ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${label}`);
	if (r.status !== 0) console.log(output.split('\n').map((l) => `    ${l}`).join('\n'));
	return { ok: r.status === 0, output };
}

for (const [mechanic, cfg] of Object.entries(MECHANICS)) {
	console.log(`\n\x1b[1m── ${mechanic} ──\x1b[0m`);

	const spec = YAML.parse(fs.readFileSync(TEMPLATE, 'utf8'));
	spec.game.name = `e2e-${mechanic}`;
	spec.game.gameId = `0_0_e2e_${mechanic}`;
	spec.game.mechanic = mechanic;
	spec.game.reels = { count: cfg.count, rows: cfg.rows };
	if (!cfg.paylines) delete spec.paylines;
	if (!cfg.expanding) {
		for (const s of spec.symbols) delete s.behaviors;
	}
	if (cfg.requiredSymbols) {
		// apps/scatter's components reference a symbol literally named 'M'.
		spec.symbols.push(...cfg.requiredSymbols);
	}

	// Paytables are MECHANIC-SHAPED. The template is lines-shaped (kinds 3/4/5);
	// cluster pays by cluster SIZE from 5 and scatter from 8, both as ranges. A
	// lines-shaped table on those is silently broken — their evaluators guard the
	// lookup, so every group above the table's top entry pays ZERO with no error.
	const boardCells = cfg.rows.reduce((sum, r) => sum + r, 0);
	const ranks = { H1: 0, H2: 1, H3: 2, H4: 3, L1: 4, L2: 5, L3: 6, L4: 7, L5: 8, W: 0, M: 6 };
	for (const symbol of spec.symbols) {
		if (!symbol.paytable) continue;
		symbol.paytable = defaultPaytable({
			mechanic: MECHANIC_PROFILES[mechanic],
			rank: ranks[symbol.name] ?? 6,
			boardCells,
		});
	}
	const specPath = path.join(workDir, `spec-${mechanic}.yaml`);
	fs.writeFileSync(specPath, YAML.stringify(spec), 'utf8');

	if (mathSdk) {
		run(['math:scaffold', '--spec', specPath, '--math-sdk', mathSdk, '--force'], `${mechanic}: math:scaffold`);
		run(['verify', '--spec', specPath, '--math-sdk', mathSdk], `${mechanic}: math verify (py_compile + GameConfig() + run_spin)`);
	}
	if (webSdk) {
		run(['scaffold', '--spec', specPath, '--sdk', webSdk, '--force'], `${mechanic}: scaffold`);
		specPaths[mechanic] = specPath;
	}
}

// Typecheck AFTER every app exists. A scaffolded app is a new pnpm workspace
// package, so its node_modules only appear once `pnpm install` is re-run at the
// web-sdk root — doing it once here mirrors the real flow and avoids paying for
// four installs.
if (webSdk) {
	console.log(`\n\x1b[1m── pnpm install (link the new workspace packages) ──\x1b[0m`);
	const install = spawnSync('pnpm', ['install', '--ignore-scripts'], {
		cwd: webSdk,
		encoding: 'utf8',
		timeout: 900000,
	});
	const installed = install.status === 0;
	results.push({ label: 'pnpm install', ok: installed, output: `${install.stdout}${install.stderr}` });
	console.log(`${installed ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} pnpm install`);
	if (!installed) console.log(`    ${install.stderr || install.error?.message}`);

	console.log(`\n\x1b[1m── typecheck ──\x1b[0m`);
	for (const [mechanic, specPath] of Object.entries(specPaths)) {
		run(['verify', '--spec', specPath, '--sdk', webSdk], `${mechanic}: tsc --noEmit (vs sample baseline)`);
	}
}

// The combination the boardLifetime work unblocked, asserted positively: an
// expanding wild on a CASCADING board must now generate, construct a
// GameConfig, and run a spin. Without this the gate test below would pass
// simply by everything being refused.
if (mathSdk) {
	console.log(`\n\x1b[1m── board lifetimes ──\x1b[0m`);
	const spec = YAML.parse(fs.readFileSync(TEMPLATE, 'utf8'));
	spec.game.name = 'e2e-lifetime';
	spec.game.gameId = '0_0_e2e_lifetime';
	spec.game.mechanic = 'cluster';
	spec.game.volatility = 'high';
	spec.game.reels = { count: MECHANICS.cluster.count, rows: MECHANICS.cluster.rows };
	delete spec.paylines;
	if (MECHANICS.cluster.requiredSymbols) spec.symbols.push(...MECHANICS.cluster.requiredSymbols);
	const cells = MECHANICS.cluster.rows.reduce((a, b) => a + b, 0);
	const ranksL = { H1: 0, H2: 1, H3: 2, H4: 3, L1: 4, L2: 5, L3: 6, W: 0 };
	for (const symbol of spec.symbols) {
		if (!symbol.paytable) continue;
		symbol.paytable = defaultPaytable({
			mechanic: MECHANIC_PROFILES.cluster,
			rank: ranksL[symbol.name] ?? 6,
			boardCells: cells,
		});
	}
	const wild = spec.symbols.find((sym) => (sym.special ?? []).includes('wild'));
	if (wild) wild.behaviors = ['expanding'];
	const specPath = path.join(workDir, 'spec-lifetime.yaml');
	fs.writeFileSync(specPath, YAML.stringify(spec), 'utf8');

	run(
		['math:scaffold', '--spec', specPath, '--math-sdk', mathSdk, '--force'],
		'cluster + expanding wild: math:scaffold (boardLifetime restores it after each cascade)',
	);
	run(
		['verify', '--spec', specPath, '--math-sdk', mathSdk],
		'cluster + expanding wild: math verify (py_compile + GameConfig() + run_spin)',
	);

	// ...and the restore call must actually be in BOTH cascade loops, not just
	// generated somewhere. A splice that lands in one loop leaves the base game
	// silently wiping the wilds.
	const gamestate = path.join(mathSdk, 'games', '0_0_e2e_lifetime', 'gamestate.py');
	const sites = fs.existsSync(gamestate)
		? (fs.readFileSync(gamestate, 'utf8').match(/lifetime:expanding:/g) ?? []).length
		: 0;
	results.push({ label: 'lifetime restore in both loops', ok: sites === 2, output: `found ${sites} restore sites` });
	console.log(
		`${sites === 2 ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} cluster + expanding wild: restore spliced into both cascade loops (${sites}/2)`,
	);
}

// ── colossal ────────────────────────────────────────────────────────────────
//
// Built from engine primitives with no sample to adapt, so the e2e bar is the
// one the plan sets for tier B: it runs, it emits its event, and the invariants
// hold on real boards rather than in a unit test's imagination.
{
	console.log(`\n\x1b[1m── colossal ──\x1b[0m`);
	const spec = YAML.parse(fs.readFileSync(TEMPLATE, 'utf8'));
	spec.game.name = 'e2e-colossal';
	spec.game.gameId = '0_0_e2e_colossal';
	spec.game.mechanic = 'lines';
	spec.game.colossal = { size: 3, gameTypes: ['basegame', 'freegame'] };
	const high = spec.symbols.find((sym) => sym.role === 'high');
	high.behaviors = ['colossal'];
	// The template ships an expanding wild, and the two recipes both want to own
	// the board reveal. Assert the refusal, then drop it and test colossal alone.
	const conflicted = path.join(workDir, 'spec-colossal-conflict.yaml');
	fs.writeFileSync(conflicted, YAML.stringify(spec), 'utf8');
	const clash = spawnSync(process.execPath, [FORGE, 'audit', '--spec', conflicted, '--manifest', conflicted], { encoding: 'utf8' });
	const refused = /conflicts with "expanding"/.test(`${clash.stdout}${clash.stderr}`);
	results.push({ label: 'colossal: expanding conflict refused', ok: refused, output: `${clash.stdout}${clash.stderr}` });
	console.log(
		`${refused ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} colossal: refused alongside an expanding wild (both own the reveal)`,
	);
	for (const sym of spec.symbols) {
		if (sym.behaviors) sym.behaviors = sym.behaviors.filter((b) => b !== 'expanding');
	}
	const specPath = path.join(workDir, 'spec-colossal.yaml');
	fs.writeFileSync(specPath, YAML.stringify(spec), 'utf8');

	run(
		['math:scaffold', '--spec', specPath, '--math-sdk', mathSdk, '--force'],
		'colossal: math:scaffold (built from primitives, no sample)',
	);
	const verify = run(
		['verify', '--spec', specPath, '--math-sdk', mathSdk],
		'colossal: math verify (py_compile + GameConfig() + run_spin)',
	);

	// run_spin must actually emit the event, not merely avoid crashing.
	const emitted = /colossalSymbol×\d+/.test(verify?.output ?? '');
	results.push({ label: 'colossal: event emitted', ok: emitted, output: verify?.output ?? '' });
	console.log(
		`${emitted ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} colossal: run_spin emits colossalSymbol`,
	);

	// The two properties that make the mechanic safe rather than merely working:
	// the block never covers a scatter (so it cannot rewrite the trigger count
	// draw_board already settled), and on a lines board it is anchored to reel 0
	// (so it can actually pay).
	const exe = path.join(mathSdk, 'games', '0_0_e2e_colossal', 'game_executables.py');
	const source = fs.existsSync(exe) ? fs.readFileSync(exe, 'utf8') : '';
	const safe =
		/covered & blocked/.test(source) &&
		/check_attribute\("locked"\)/.test(source) &&
		/COLOSSAL_ANCHOR_LEFT = True/.test(source) &&
		/get_special_symbols_on_board\(\)/.test(source);
	results.push({ label: 'colossal: invariants generated', ok: safe, output: source.slice(0, 400) });
	console.log(
		`${safe ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} colossal: scatter-safe, lock-aware, reel-0 anchored, record recomputed`,
	);
}

// The expanding recipe must be REFUSED where it is not verified, not silently
// generated — assert the refusal as loudly as the successes.
//
// cluster came OFF this list when the boardLifetime work made the combination
// real: every board-writing recipe now declares how long its writes survive and
// the scaffolder restores them after each cascade refill. Proven by running it
// end to end (96.50% RTP, 10,000x cap at 1-in-20,000,000).
//
// scatter stays, for a different reason than it was originally added for.
// It is not that the cascade wipes the wild — it is that scatter-pays counts
// instances anywhere with no positional requirement, so a substituting wild has
// no gap to bridge. It would generate, run, and do nothing.
console.log(`\n\x1b[1m── recipe gating ──\x1b[0m`);
for (const mechanic of ['scatter']) {
	const spec = YAML.parse(fs.readFileSync(TEMPLATE, 'utf8'));
	spec.game.name = `e2e-gate-${mechanic}`;
	spec.game.gameId = `0_0_e2e_gate_${mechanic}`;
	spec.game.mechanic = mechanic;
	spec.game.reels = { count: MECHANICS[mechanic].count, rows: MECHANICS[mechanic].rows };
	delete spec.paylines;
	if (MECHANICS[mechanic].requiredSymbols) spec.symbols.push(...MECHANICS[mechanic].requiredSymbols);
	const specPath = path.join(workDir, `gate-${mechanic}.yaml`);
	fs.writeFileSync(specPath, YAML.stringify(spec), 'utf8');

	// audit loads the spec first, so the refusal surfaces before any manifest work.
	const r = spawnSync(process.execPath, [FORGE, 'audit', '--spec', specPath, '--manifest', specPath], { encoding: 'utf8' });
	const refused = /only verified on mechanic/.test(`${r.stdout}${r.stderr}`);
	results.push({ label: `${mechanic}: expanding refused`, ok: refused, output: `${r.stdout}${r.stderr}` });
	console.log(`${refused ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${mechanic}: expanding behavior refused on a tumbling board`);
}

fs.rmSync(workDir, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n${'─'.repeat(60)}`);
console.log(`${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length ? 1 : 0);
