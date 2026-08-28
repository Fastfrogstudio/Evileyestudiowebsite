#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import path from 'node:path';

import { init } from '../src/commands/init.js';
import { scaffoldGame } from '../src/commands/scaffold.js';
import { mathScaffold } from '../src/commands/mathScaffold.js';
import { importAssets } from '../src/commands/importAssets.js';
import { audit } from '../src/commands/audit.js';
import { verify } from '../src/commands/verify.js';
import { inspire } from '../src/commands/inspire.js';
import { behaviors } from '../src/commands/behaviors.js';
import { SpecValidationError } from '../src/lib/loadSpec.js';

const program = new Command();
program
	.name('forge')
	.description('Scaffold Stake Engine games (math-sdk + web-sdk) from one YAML spec + your own art.')
	.version('0.2.0');

const run = (fn) => (opts) => {
	try {
		const result = fn(opts);
		if (result && result.ok === false) process.exit(1);
	} catch (err) {
		fail(err);
	}
};

program
	.command('init')
	.description('Write example game-spec.yaml / assets-manifest.yaml / inspiration.yaml into the current directory')
	.action(run(() => init({ cwd: process.cwd() })));

program
	.command('inspire')
	.description('Turn a plain-language feature checklist into a draft game-spec.yaml + a build report')
	.requiredOption('--in <path>', 'path to inspiration.yaml')
	.option('--out <path>', 'where to write the draft spec', 'game-spec.draft.yaml')
	.option('--report <path>', 'where to write the markdown report', 'inspiration-report.md')
	.option('--force', 'overwrite --out if it exists', false)
	.action(
		run((opts) =>
			inspire({
				inputPath: path.resolve(opts.in),
				outPath: path.resolve(opts.out),
				reportPath: path.resolve(opts.report),
				force: opts.force,
			}),
		),
	);

program
	.command('behaviors')
	.description('List the behavior recipe registry — what is built, what needs custom code, and from which sample')
	.option('--json', 'machine-readable output', false)
	.action(run((opts) => behaviors({ json: opts.json })));

program
	.command('audit')
	.description('Cross-check assets-manifest.yaml against the animation states the spec implies')
	.requiredOption('--spec <path>', 'path to game-spec.yaml')
	.requiredOption('--manifest <path>', 'path to assets-manifest.yaml')
	.option('--json', 'machine-readable output', false)
	.action(
		run((opts) =>
			audit({ specPath: path.resolve(opts.spec), manifestPath: path.resolve(opts.manifest), json: opts.json }),
		),
	);

program
	.command('scaffold')
	.description('Create apps/<name> in the web-sdk checkout from a game-spec.yaml')
	.requiredOption('--spec <path>', 'path to game-spec.yaml')
	.requiredOption('--sdk <path>', 'path to a checkout of StakeEngine/web-sdk')
	.option('--force', 'overwrite apps/<name> if it already exists', false)
	.action(
		run((opts) => scaffoldGame({ specPath: path.resolve(opts.spec), sdkDir: path.resolve(opts.sdk), force: opts.force })),
	);

program
	.command('math:scaffold')
	.description('Create games/<game_id> in the math-sdk checkout from the SAME game-spec.yaml')
	.requiredOption('--spec <path>', 'path to game-spec.yaml')
	.requiredOption('--math-sdk <path>', 'path to a checkout of StakeEngine/math-sdk')
	.option('--force', 'overwrite games/<game_id> if it already exists', false)
	.action(
		run((opts) =>
			mathScaffold({ specPath: path.resolve(opts.spec), mathSdkDir: path.resolve(opts.mathSdk), force: opts.force }),
		),
	);

program
	.command('assets:import')
	.description('Copy your art/spine files into apps/<game> and wire them into assets.ts + constants.ts')
	.requiredOption('--manifest <path>', 'path to assets-manifest.yaml')
	.requiredOption('--sdk <path>', 'path to a checkout of StakeEngine/web-sdk')
	.requiredOption('--game <name>', 'the game.name you used in game-spec.yaml (matches apps/<name>)')
	.option('--spec <path>', 'path to game-spec.yaml, so states are wired per symbol role/behavior')
	.action(
		run((opts) =>
			importAssets({
				manifestPath: path.resolve(opts.manifest),
				sdkDir: path.resolve(opts.sdk),
				gameName: opts.game,
				specPath: opts.spec ? path.resolve(opts.spec) : null,
			}),
		),
	);

program
	.command('verify')
	.description('Actually RUN the generated output: py_compile + GameConfig() + run_spin(), and tsc against a baseline')
	.requiredOption('--spec <path>', 'path to game-spec.yaml')
	.option('--math-sdk <path>', 'path to a checkout of StakeEngine/math-sdk')
	.option('--sdk <path>', 'path to a checkout of StakeEngine/web-sdk')
	.option('--python <path>', 'python interpreter to use (default: <math-sdk>/.venv/bin/python, else python3)')
	.option('--skip-spin', 'skip the run_spin() level (fastest useful check is GameConfig())', false)
	.action(
		run((opts) => {
			if (!opts.mathSdk && !opts.sdk) {
				throw new Error('give at least one of --math-sdk or --sdk — there is nothing to verify otherwise');
			}
			return verify({
				specPath: path.resolve(opts.spec),
				mathSdkDir: opts.mathSdk ? path.resolve(opts.mathSdk) : null,
				webSdkDir: opts.sdk ? path.resolve(opts.sdk) : null,
				python: opts.python,
				skipSpin: opts.skipSpin,
			});
		}),
	);

function fail(err) {
	if (err instanceof SpecValidationError) {
		console.error(chalk.red(`\n${err.message}\n`));
	} else {
		console.error(chalk.red(`\nError: ${err.message}\n`));
		if (process.env.DEBUG) console.error(err.stack);
	}
	process.exit(1);
}

program.parse();
