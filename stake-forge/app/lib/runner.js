/**
 * Pipeline step execution with streamed output.
 *
 * Every step shells out to the same `forge` CLI the terminal uses rather than
 * calling the command modules in-process. That is deliberate: it means the app
 * and the CLI can never diverge in behaviour, a step that fails in the UI fails
 * identically in a terminal, and the command line shown in the log is one you
 * can paste and re-run.
 */

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FORGE = path.join(__dirname, '..', '..', 'bin', 'forge.js');

/**
 * The pipeline, in the order it should be run.
 *
 * `needs` drives the UI: a step whose requirements are unmet is shown as
 * blocked with the reason, rather than failing halfway through.
 */
export const STEPS = {
	'art:placeholder': {
		id: 'art:placeholder',
		title: 'Generate placeholder art',
		blurb: 'Stand-in symbol tiles so the game renders before your art exists.',
		needs: [],
		args: ({ dir }) => [
			'art:placeholder',
			'--spec', path.join(dir, 'game-spec.yaml'),
			'--out', path.join(dir, 'assets-source'),
			'--manifest', path.join(dir, 'assets-manifest.yaml'),
		],
	},
	audit: {
		id: 'audit',
		title: 'Audit assets',
		blurb: 'Check the manifest against the states each symbol’s role and behaviors need.',
		needs: ['manifest'],
		args: ({ dir }) => [
			'audit',
			'--spec', path.join(dir, 'game-spec.yaml'),
			'--manifest', path.join(dir, 'assets-manifest.yaml'),
		],
	},
	'math:scaffold': {
		id: 'math:scaffold',
		title: 'Scaffold math',
		blurb: 'Clone a math-sdk sample and patch it from the spec.',
		needs: ['mathSdk'],
		args: ({ dir, config }) => [
			'math:scaffold',
			'--spec', path.join(dir, 'game-spec.yaml'),
			'--math-sdk', config.mathSdk,
			'--force',
		],
	},
	scaffold: {
		id: 'scaffold',
		title: 'Scaffold web app',
		blurb: 'Clone a web-sdk sample app and generate config, constants and any behavior code.',
		needs: ['webSdk'],
		args: ({ dir, config }) => [
			'scaffold',
			'--spec', path.join(dir, 'game-spec.yaml'),
			'--sdk', config.webSdk,
			'--force',
		],
	},
	'assets:import': {
		id: 'assets:import',
		title: 'Import art',
		blurb: 'Copy your files into the app and wire them into assets.ts and SYMBOL_INFO_MAP.',
		needs: ['webSdk', 'manifest', 'scaffolded'],
		args: ({ dir, config, spec }) => [
			'assets:import',
			'--manifest', path.join(dir, 'assets-manifest.yaml'),
			'--sdk', config.webSdk,
			'--game', spec.game.name,
			'--spec', path.join(dir, 'game-spec.yaml'),
		],
	},
	'math:run': {
		id: 'math:run',
		title: 'Simulate',
		blurb: 'Run the real maths — produces books, lookup tables and the authoritative frontend config.',
		needs: ['mathSdk', 'mathScaffolded'],
		args: ({ dir, config }) => {
			const args = [
				'math:run',
				'--spec', path.join(dir, 'game-spec.yaml'),
				'--math-sdk', config.mathSdk,
				'--sims', String(config.sims ?? 1000),
			];
			if (config.python) args.push('--python', config.python);
			return args;
		},
	},
	'math:optimise': {
		id: 'math:optimise',
		title: 'Hit the target RTP',
		blurb: 'Reweight the simulated rounds until the game pays what the spec asked for. The slow step.',
		needs: ['mathSdk', 'simulated'],
		args: ({ dir, config }) => {
			const args = [
				'math:optimise',
				'--spec', path.join(dir, 'game-spec.yaml'),
				'--math-sdk', config.mathSdk,
			];
			if (config.python) args.push('--python', config.python);
			return args;
		},
	},
	'math:sync': {
		id: 'math:sync',
		title: 'Sync maths into the app',
		blurb: 'Replace the placeholder config and story data with what the simulation produced.',
		needs: ['mathSdk', 'webSdk', 'scaffolded', 'simulated'],
		args: ({ dir, config }) => [
			'math:sync',
			'--spec', path.join(dir, 'game-spec.yaml'),
			'--math-sdk', config.mathSdk,
			'--sdk', config.webSdk,
		],
	},
	'math:report': {
		id: 'math:report',
		title: 'Report what it pays',
		blurb: 'Measured RTP, hit rate and spread from the simulated rounds, against your targets.',
		needs: ['mathSdk', 'simulated'],
		args: ({ dir, config }) => [
			'math:report',
			'--spec', path.join(dir, 'game-spec.yaml'),
			'--math-sdk', config.mathSdk,
		],
	},
	verify: {
		id: 'verify',
		title: 'Verify',
		blurb: 'Run the generated output for real: py_compile, GameConfig(), a live spin, and tsc.',
		needs: ['mathSdk'],
		args: ({ dir, config }) => {
			const args = ['verify', '--spec', path.join(dir, 'game-spec.yaml')];
			if (config.mathSdk) args.push('--math-sdk', config.mathSdk);
			if (config.webSdk) args.push('--sdk', config.webSdk);
			if (config.python) args.push('--python', config.python);
			return args;
		},
	},
};

/**
 * `verify` runs LAST, after the maths has been synced in.
 *
 * It is the only step that type-checks and executes the generated output, and
 * math:sync rewrites config.ts — so running it before the sync would certify a
 * state the game is no longer in. Ending on it means the thing that passed is
 * the thing you have.
 */
export const STEP_ORDER = [
	'art:placeholder',
	'audit',
	'math:scaffold',
	'scaffold',
	'assets:import',
	'math:run',
	'math:optimise',
	'math:sync',
	'math:report',
	'verify',
];

/**
 * Run a step, calling `onLine` for each line of output as it arrives.
 * Resolves with the exit code — never rejects on a non-zero exit, because a
 * failing audit or verify is a normal, informative outcome rather than an error.
 */
export function runStep({ step, dir, config, spec, onLine }) {
	const definition = STEPS[step];
	if (!definition) throw new Error(`Unknown step "${step}"`);

	const args = definition.args({ dir, config, spec });
	// Show the exact command, so anything seen here can be reproduced in a shell.
	onLine({ stream: 'meta', text: `$ forge ${args.join(' ')}` });

	return new Promise((resolve) => {
		const child = spawn(process.execPath, [FORGE, ...args], {
			cwd: dir,
			// FORCE_COLOR off: the UI renders its own styling, and escape codes in
			// the log are noise rather than colour once they reach HTML.
			env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
		});

		const pump = (stream) => {
			let buffer = '';
			return (chunk) => {
				buffer += chunk.toString();
				const lines = buffer.split('\n');
				buffer = lines.pop() ?? '';
				for (const text of lines) onLine({ stream, text });
			};
		};

		child.stdout.on('data', pump('out'));
		child.stderr.on('data', pump('err'));

		child.on('error', (err) => {
			onLine({ stream: 'err', text: `failed to start: ${err.message}` });
			resolve(1);
		});
		child.on('close', (code) => {
			onLine({ stream: 'meta', text: `exit ${code}` });
			resolve(code ?? 0);
		});
	});
}

/** Run `audit --json` and return the parsed report for the UI to render. */
export function auditJson({ dir }) {
	return new Promise((resolve) => {
		const child = spawn(
			process.execPath,
			[
				FORGE, 'audit',
				'--spec', path.join(dir, 'game-spec.yaml'),
				'--manifest', path.join(dir, 'assets-manifest.yaml'),
				'--json',
			],
			{ cwd: dir, env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' } },
		);

		let out = '';
		let err = '';
		child.stdout.on('data', (c) => (out += c));
		child.stderr.on('data', (c) => (err += c));
		child.on('error', () => resolve({ ok: false, error: 'could not run audit' }));
		child.on('close', () => {
			try {
				resolve({ ok: true, report: JSON.parse(out) });
			} catch {
				resolve({ ok: false, error: (err || out || 'audit produced no JSON').trim() });
			}
		});
	});
}
