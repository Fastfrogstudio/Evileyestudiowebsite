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
	'art:import': {
		id: 'art:import',
		title: 'Import your art',
		blurb:
			'Match the delivery folder to this game’s slots, resample, check transparency, ' +
			'validate the rigs, and point assets-manifest.yaml at your art instead of the ' +
			'placeholders.',
		needs: ['artGuide'],
		// After art:placeholder, never before. The placeholder step fills every
		// symbol with a stand-in and preserves only spineSymbols, so running it
		// second would overwrite real flat art with tiles — silently, since a tile
		// is a valid PNG. This way placeholders fill the gaps and delivered art
		// wins wherever it exists.
		//
		// Advisory: an incomplete delivery is the NORMAL state for most of a
		// game's life — art arrives symbol by symbol — and a partial one must not
		// stop the pipeline from reaching the maths.
		advisory: true,
		args: ({ dir }) => [
			'art:import',
			'--spec', path.join(dir, 'game-spec.yaml'),
			'--guide', path.join(dir, 'art-guide.yaml'),
			'--from', path.join(dir, 'delivered'),
			'--game', dir,
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
	'math:balance': {
		id: 'math:balance',
		title: 'Balance the maths',
		blurb:
			'Before anything is simulated: is this paytable payable at this RTP, on this board? ' +
			'Runs in a second and catches what would otherwise cost an hour of simulation and a ' +
			'failed optimiser run.',
		needs: [],
		// Advisory: it exits non-zero when the paytable is out of band, and that is
		// worth seeing loudly, but a spec being iterated on is out of band most of
		// the time and stopping the build over it would mean never reaching the
		// maths. math:validate, at the far end, is the one that blocks.
		advisory: true,
		args: ({ dir }) => ['math:balance', '--spec', path.join(dir, 'game-spec.yaml')],
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
	'deps:link': {
		id: 'deps:link',
		title: 'Link the new app',
		blurb:
			'pnpm install at the web-sdk root. A scaffolded app is a new workspace package, and until ' +
			'the workspace is re-linked every import in it fails to resolve.',
		needs: ['webSdk', 'scaffolded'],
		// Its own command rather than a hidden part of `scaffold`, because it is a
		// workspace-level operation that takes a minute and a user re-scaffolding
		// one game of five should not pay for it every time.
		args: ({ config }) => ['deps:link', '--sdk', config.webSdk],
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
	'sound:build': {
		id: 'sound:build',
		title: 'Build the audio sprite',
		blurb: 'Mix your sound files into the one sprite the web-sdk actually loads, in all four formats.',
		needs: ['webSdk', 'scaffolded', 'sounds'],
		// The sprite is still WRITTEN when sounds are missing — the command exits
		// non-zero to say the game will be partly silent, which is true and worth
		// saying, but a half-supplied audio folder is a normal state to be in
		// mid-project and nothing downstream depends on it. Stopping a whole build
		// over it would mean never getting to the maths.
		advisory: true,
		args: ({ dir, config, spec }) => [
			'sound:build',
			'--sdk', config.webSdk,
			'--game', spec.game.name,
			'--source', path.join(dir, 'sounds-source'),
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
				// ALWAYS compressed in the pipeline, though the CLI keeps it optional.
				//
				// index.json names books_<mode>.jsonl.zst, and math:run WIPES
				// publish_files on every run — so a pipeline that simulated without
				// compression produced an upload folder whose index named two books
				// files that were not in it. Found by running the whole pipeline end
				// to end; every individual step passed.
				//
				// The CLI flag stays opt-in because iterating on maths does not need
				// the compressed output and it is not free. The pipeline's whole
				// purpose is to end at something uploadable, so it pays.
				'--compress',
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
	'math:validate': {
		id: 'math:validate',
		title: 'Is it shippable?',
		blurb:
			'Every rule measured against the optimised tables, with the number it was judged on: max ' +
			'win reached, RTP on target, cap frequency, hit rate, no gaps, every mode within 0.5pp.',
		needs: ['mathSdk', 'simulated'],
		args: ({ dir, config }) => [
			'math:validate',
			'--spec', path.join(dir, 'game-spec.yaml'),
			'--math-sdk', config.mathSdk,
		],
	},
	package: {
		id: 'package',
		title: 'Package for upload',
		blurb: 'Build the frontend and assemble both halves — frontend files and RGS math — in one folder.',
		needs: ['webSdk', 'mathSdk', 'scaffolded', 'simulated'],
		args: ({ dir, config }) => [
			'package',
			'--spec', path.join(dir, 'game-spec.yaml'),
			'--sdk', config.webSdk,
			'--math-sdk', config.mathSdk,
			'--out', path.join(dir, 'upload'),
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
 * Order matters in two places, and both are about certifying the right thing.
 *
 * `verify` runs after math:sync: it is the only step that type-checks and
 * executes the generated output, and math:sync rewrites config.ts, so running
 * it earlier would certify a state the game is no longer in.
 *
 * `package` runs after verify: it produces the folder you actually upload, and
 * it should only ever be built from output that has just been proven to compile,
 * construct a GameConfig, spin, and type-check.
 */
export const STEP_ORDER = [
	'art:placeholder',
	'art:import',
	'audit',
	// Before math:scaffold, because it is the cheap check that makes the expensive
	// ones worth running: a paytable that cannot pay its RTP on this board will
	// simulate for an hour and then fail in the optimiser with a message about pig
	// counts. This says the same thing in a second, with the fix.
	'math:balance',
	'math:scaffold',
	'scaffold',
	// Immediately after scaffold, because `verify` type-checks the app and every
	// import in a freshly scaffolded workspace package fails to resolve until the
	// workspace is re-linked. Without this step the pipeline has a step that
	// reliably fails the first time for a reason no step fixes.
	'deps:link',
	'assets:import',
	'sound:build',
	'math:run',
	'math:optimise',
	'math:sync',
	'math:report',
	// After math:report, because report says what it pays and this says whether
	// that is good enough — and before verify, so a game that cannot ship on its
	// maths is not packaged.
	'math:validate',
	'verify',
	'package',
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
