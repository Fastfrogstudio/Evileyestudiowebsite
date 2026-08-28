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

function run(args, label) {
	const r = spawnSync(process.execPath, [FORGE, ...args], { encoding: 'utf8', timeout: 900000 });
	const output = `${r.stdout || ''}${r.stderr || ''}`;
	results.push({ label, ok: r.status === 0, output });
	console.log(`${r.status === 0 ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${label}`);
	if (r.status !== 0) console.log(output.split('\n').map((l) => `    ${l}`).join('\n'));
	return r.status === 0;
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
	const specPath = path.join(workDir, `spec-${mechanic}.yaml`);
	fs.writeFileSync(specPath, YAML.stringify(spec), 'utf8');

	if (mathSdk) {
		run(['math:scaffold', '--spec', specPath, '--math-sdk', mathSdk, '--force'], `${mechanic}: math:scaffold`);
		run(['verify', '--spec', specPath, '--math-sdk', mathSdk], `${mechanic}: math verify (py_compile + GameConfig() + run_spin)`);
	}
	if (webSdk) {
		run(['scaffold', '--spec', specPath, '--sdk', webSdk, '--force'], `${mechanic}: scaffold`);
		run(['verify', '--spec', specPath, '--sdk', webSdk], `${mechanic}: tsc --noEmit (vs sample baseline)`);
	}
}

// The expanding recipe must be REFUSED on tumbling mechanics, not silently
// generated — assert the refusal as loudly as the successes.
console.log(`\n\x1b[1m── recipe gating ──\x1b[0m`);
for (const mechanic of ['cluster', 'scatter']) {
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
