#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import path from 'node:path';

import { init } from '../src/commands/init.js';
import { scaffoldGame } from '../src/commands/scaffold.js';
import { mathScaffold } from '../src/commands/mathScaffold.js';
import { mathRun } from '../src/commands/mathRun.js';
import { mathSync } from '../src/commands/mathSync.js';
import { mathReport } from '../src/commands/mathReport.js';
import { mathBalance } from '../src/commands/mathBalanceCmd.js';
import { mathValidate } from '../src/commands/mathValidateCmd.js';
import { mechanics } from '../src/commands/mechanics.js';
import { market } from '../src/commands/market.js';
import { brief } from '../src/commands/brief.js';
import { depsLink } from '../src/commands/depsLink.js';
import { mathOptimise } from '../src/commands/mathOptimise.js';
import { soundBuild } from '../src/commands/soundBuild.js';
import { packageGame } from '../src/commands/packageGame.js';
import { importAssets } from '../src/commands/importAssets.js';
import { placeholderArt } from '../src/commands/placeholderArt.js';
import { audit } from '../src/commands/audit.js';
import { verify } from '../src/commands/verify.js';
import { inspire } from '../src/commands/inspire.js';
import { behaviors } from '../src/commands/behaviors.js';
import { preview } from '../src/commands/preview.js';
import { artGuide, artPrompts } from '../src/commands/artPrompts.js';
import { artAccept } from '../src/commands/artAccept.js';
import { artCheck } from '../src/commands/artCheck.js';
import { artImport } from '../src/commands/artImport.js';
import { cutout } from '../src/commands/cutout.js';
import { deliver } from '../src/commands/deliver.js';
import { buildAnimBrief, renderAnimBrief } from '../src/lib/animBrief.js';
import { SpecValidationError } from '../src/lib/loadSpec.js';

const program = new Command();
program
	.name('forge')
	.description('Scaffold Stake Engine games (math-sdk + web-sdk) from one YAML spec + your own art.')
	.version('0.2.0');

/**
 * Wrap a command so a refusal becomes a non-zero exit.
 *
 * ── The bug this shape used to have ─────────────────────────────────────────
 * It used to be `const result = fn(opts); if (result && result.ok === false)`.
 * That is correct for a synchronous command and silently wrong for an
 * asynchronous one: `fn(opts)` returns a PROMISE, `promise.ok` is undefined, and
 * the exit code stays 0 however loudly the command refused.
 *
 * `forge package` is async because it builds the frontend. So it printed
 * "Not ready to upload. 4 problem(s) above." and exited 0 — which the app
 * pipeline rendered as a green PASS on the one step whose entire job is to say
 * whether the bundle can be uploaded. Every check worked; only the exit code
 * was lost.
 *
 * A rejected promise had the same hole: the try/catch here wraps the CALL, not
 * the awaited result, so an async command's error escaped as an unhandled
 * rejection and got Node's generic message instead of `fail()`'s.
 */
const run = (fn) => async (opts) => {
	try {
		const result = await fn(opts);
		if (result && result.ok === false) process.exitCode = 1;
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
	.command('art:placeholder')
	.description('Generate stand-in symbol tiles so you can see the game before your art exists')
	.requiredOption('--spec <path>', 'path to game-spec.yaml')
	.option('--out <dir>', 'where to write the tiles', 'assets-source')
	.option('--manifest <path>', 'manifest to update', 'assets-manifest.yaml')
	.option('--size <px>', 'tile size in pixels', (v) => Number(v), 256)
	.option('--force', 'replace existing spineSymbols entries too', false)
	.action(
		run((opts) =>
			placeholderArt({
				specPath: path.resolve(opts.spec),
				outDir: path.resolve(opts.out),
				manifestPath: path.resolve(opts.manifest),
				force: opts.force,
				size: opts.size,
			}),
		),
	);

program
	.command('audit')
	.description('Cross-check assets-manifest.yaml against the animation states the spec implies')
	.requiredOption('--spec <path>', 'path to game-spec.yaml')
	.requiredOption('--manifest <path>', 'path to assets-manifest.yaml')
	.option('--sdk <path>', 'path to a checkout of StakeEngine/web-sdk, to also check sound')
	.option('--json', 'machine-readable output', false)
	.action(
		run((opts) =>
			audit({
				specPath: path.resolve(opts.spec),
				manifestPath: path.resolve(opts.manifest),
				sdkDir: opts.sdk ? path.resolve(opts.sdk) : null,
				json: opts.json,
			}),
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
	.command('math:run')
	.description('Run the real simulation — produces books, lookup tables and the authoritative frontend config')
	.requiredOption('--spec <path>', 'path to game-spec.yaml')
	.requiredOption('--math-sdk <path>', 'path to a checkout of StakeEngine/math-sdk')
	.option('--sims <n>', 'rounds to simulate per bet mode', (v) => Number(v), 1000)
	.option('--python <path>', 'python interpreter to use')
	.option('--compress', 'write compressed books (needed for a real upload)', false)
	.option('--batch <n>', 'rounds held in memory before writing out (default: sized to ~1.25GB)', (v) => Number(v))
	.action(
		run(async (opts) =>
			mathRun({
				specPath: path.resolve(opts.spec),
				mathSdkDir: path.resolve(opts.mathSdk),
				sims: opts.sims,
				batch: opts.batch,
				python: opts.python,
				compress: opts.compress,
			}),
		),
	);

program
	.command('math:sync')
	.description('Replace the placeholder config and story data with the real maths')
	.requiredOption('--spec <path>', 'path to game-spec.yaml')
	.requiredOption('--math-sdk <path>', 'path to a checkout of StakeEngine/math-sdk')
	.requiredOption('--sdk <path>', 'path to a checkout of StakeEngine/web-sdk')
	.option('--dry-run', 'print what would be written and stop', false)
	.action(
		run((opts) =>
			mathSync({
				specPath: path.resolve(opts.spec),
				mathSdkDir: path.resolve(opts.mathSdk),
				sdkDir: path.resolve(opts.sdk),
				dryRun: opts.dryRun,
			}),
		),
	);

program
	.command('brief')
	.description('What to draw — the complete asset specification for a spec, before any art exists')
	.requiredOption('--spec <path>', 'path to game-spec.yaml')
	.option('--format <fmt>', 'md | csv | json | manifest', 'md')
	.option('--out <path>', 'write to a file instead of stdout')
	.action(
		run((opts) =>
			brief({
				specPath: path.resolve(opts.spec),
				format: opts.format,
				out: opts.out ? path.resolve(opts.out) : undefined,
			}),
		),
	);

program
	.command('deps:link')
	.description('Re-link the web-sdk pnpm workspace, so a freshly scaffolded app can type-check')
	.requiredOption('--sdk <path>', 'path to a checkout of StakeEngine/web-sdk')
	.option('--with-scripts', 'run postinstall scripts too (slower; fetches browsers)', false)
	.action(
		run((opts) => depsLink({ sdkDir: path.resolve(opts.sdk), ignoreScripts: !opts.withScripts })),
	);

program
	.command('art:guide')
	.description('Write art-guide.yaml — the look, once, for every asset in this game')
	.option('--out <path>', 'where to write it', 'art-guide.yaml')
	.option('--force', 'overwrite an existing guide', false)
	.action(run((opts) => artGuide({ out: path.resolve(opts.out), force: opts.force })));

program
	.command('deliver')
	.description('One checklist: every file this game needs and exactly what to call it')
	.requiredOption('--spec <path>', 'path to game-spec.yaml')
	.option('--guide <path>', 'path to art-guide.yaml', 'art-guide.yaml')
	.option('--sdk <path>', 'a web-sdk checkout, to read the reference assets from')
	.option('--out <path>', 'write the checklist as markdown')
	.option('--json', 'machine-readable output', false)
	.action(
		run((opts) =>
			deliver({
				specPath: path.resolve(opts.spec),
				guidePath: path.resolve(opts.guide),
				sdkDir: opts.sdk ? path.resolve(opts.sdk) : null,
				out: opts.out ? path.resolve(opts.out) : null,
				json: opts.json,
			}),
		),
	);

program
	.command('anim:brief')
	.description('What the animation team needs: skeleton names, animation names, canvas sizes')
	.requiredOption('--spec <path>', 'path to game-spec.yaml')
	.option('--sdk <path>', 'a web-sdk checkout, to read the reference skeletons from')
	.option('--out <path>', 'write the brief as markdown')
	.option('--json', 'machine-readable output', false)
	.action(
		run(async (opts) => {
			const { loadGameSpec } = await import('../src/lib/loadSpec.js');
			const { getMechanic } = await import('../src/lib/mechanics.js');
			const spec = loadGameSpec(path.resolve(opts.spec));
			const referenceAppDir = opts.sdk
				? path.join(path.resolve(opts.sdk), 'apps', getMechanic(spec.game.mechanic).webApp)
				: null;
			const brief = buildAnimBrief({ spec, referenceAppDir });
			if (opts.json) {
				console.log(JSON.stringify(brief, null, 2));
				return { ok: true };
			}
			const markdown = renderAnimBrief(brief);
			if (opts.out) {
				const fsx = await import('fs-extra');
				fsx.default.outputFileSync(path.resolve(opts.out), markdown, 'utf8');
				console.log(
					chalk.green('✓'),
					`wrote ${opts.out} — ${brief.totals.skeletons} skeletons, ` +
						`${brief.totals.animations} named animations, ${brief.totals.parts} parts`,
				);
			} else {
				console.log(markdown);
			}
			return { ok: true };
		}),
	);

program
	.command('art:cutout')
	.description('Knock the white background out of generated art, and trim it to the subject')
	.requiredOption('--from <path>', 'a PNG, or a folder of them')
	.option('--out <dir>', 'where to write (default: beside the input)')
	.option('--size <WxH>', 'also centre the subject on a canvas this size, e.g. 200x200')
	.option('--threshold <n>', 'brightness at or above which a neutral pixel is background', Number)
	.option('--saturation <n>', 'max channel spread for a pixel to count as neutral', Number)
	.option('--feather <n>', 'pixels over which the edge fades in', Number)
	.option('--dry-run', 'report what would happen and write nothing', false)
	.action(
		run((opts) => {
			let size = null;
			if (opts.size) {
				const match = /^(\d+)x(\d+)$/i.exec(String(opts.size).trim());
				if (!match) throw new Error(`--size must look like 200x200 (got "${opts.size}")`);
				size = { width: Number(match[1]), height: Number(match[2]) };
			}
			return cutout({
				input: path.resolve(opts.from),
				out: opts.out ? path.resolve(opts.out) : null,
				size,
				threshold: opts.threshold,
				saturation: opts.saturation,
				feather: opts.feather,
				dryRun: opts.dryRun,
			});
		}),
	);

program
	.command('art:import')
	.description('Bring in art made elsewhere: match it to slots, resize, and check alpha')
	.requiredOption('--spec <path>', 'path to game-spec.yaml')
	.requiredOption('--from <dir>', 'folder of delivered PNGs')
	.option('--guide <path>', 'path to art-guide.yaml', 'art-guide.yaml')
	.option('--sdk <path>', 'a web-sdk checkout, to read the reference layer lists from')
	.option('--game <dir>', 'the game folder assets-source/ lives in', '.')
	.option('--dry-run', 'report what would happen and write nothing', false)
	.action(
		run((opts) =>
			artImport({
				specPath: path.resolve(opts.spec),
				guidePath: path.resolve(opts.guide),
				sdkDir: opts.sdk ? path.resolve(opts.sdk) : null,
				fromDir: path.resolve(opts.from),
				gameDir: path.resolve(opts.game),
				dryRun: opts.dryRun,
			}),
		),
	);

program
	.command('art:check')
	.description('One request to the image provider, reported in full — run this before a batch')
	.option('--endpoint <url>', 'override the configured endpoint')
	.option('--key <key>', 'override the configured API key')
	.option('--model <id>', 'override the configured model')
	.option('--out <path>', 'where to write the returned image', 'art-check.png')
	.option('--prompt <text>', 'use your own prompt instead of the default coin')
	.action(
		run(async (opts) => {
			// Falls back to the app's config so the CLI and the app cannot disagree
			// about which endpoint is being tested.
			const { loadConfig } = await import('../app/lib/config.js');
			const config = loadConfig();
			return artCheck({
				endpoint: opts.endpoint ?? config.imageEndpoint,
				apiKey: opts.key ?? config.imageApiKey,
				model: opts.model ?? config.imageModel,
				out: path.resolve(opts.out),
				prompt: opts.prompt,
			});
		}),
	);

program
	.command('art:prompts')
	.description('One prompt per asset part, at the exact size this game needs')
	.requiredOption('--spec <path>', 'path to game-spec.yaml')
	.option('--guide <path>', 'path to art-guide.yaml', 'art-guide.yaml')
	.option('--sdk <path>', 'a web-sdk checkout, to read the reference layer lists from')
	.option('--out <path>', 'write the manifest as JSON')
	.option('--only <kinds>', 'comma-separated: symbol, backdrop, layer, or an asset key')
	.option('--json', 'machine-readable output', false)
	.action(
		run((opts) =>
			artPrompts({
				specPath: path.resolve(opts.spec),
				guidePath: path.resolve(opts.guide),
				sdkDir: opts.sdk ? path.resolve(opts.sdk) : null,
				out: opts.out ? path.resolve(opts.out) : null,
				only: opts.only,
				json: opts.json,
			}),
		),
	);

program
	.command('art:accept')
	.description('Promote a generated candidate into the game and make it a style anchor')
	.requiredOption('--manifest <path>', 'the art-prompts manifest')
	.requiredOption('--id <id>', 'the job id, e.g. symbol.W')
	.requiredOption('--file <path>', 'the generated image to accept')
	.option('--guide <path>', 'art-guide.yaml, to register it as a style reference', 'art-guide.yaml')
	.option('--game <dir>', 'the game folder assets-source/ lives in', '.')
	.option('--force', 'accept even if the size does not match the brief', false)
	.action(
		run((opts) =>
			artAccept({
				manifestPath: path.resolve(opts.manifest),
				id: opts.id,
				file: path.resolve(opts.file),
				guidePath: path.resolve(opts.guide),
				gameDir: path.resolve(opts.game),
				force: opts.force,
			}),
		),
	);

program
	.command('preview')
	.description('Look at the game — real books through the real renderer, in your browser')
	.requiredOption('--sdk <path>', 'path to a checkout of StakeEngine/web-sdk')
	.option('--spec <path>', 'path to game-spec.yaml (to name the app)')
	.option('--name <name>', 'app name under apps/, if you would rather not pass --spec')
	.option('--port <n>', 'port to serve on', '6006')
	.option('--host <host>', 'host to bind', 'localhost')
	.option('--open', 'open a browser automatically', false)
	.action(
		run(async (opts) => {
			// --spec is the normal path because it is the same argument every other
			// command takes; --name is the escape hatch for an app scaffolded before
			// the spec moved, or one of the SDK's own samples.
			let name = opts.name;
			if (!name) {
				if (!opts.spec) {
					throw new Error('Pass --spec <game-spec.yaml> or --name <app> so I know what to open.');
				}
				const { loadGameSpec } = await import('../src/lib/loadSpec.js');
				name = loadGameSpec(path.resolve(opts.spec)).game.name;
			}
			return preview({
				sdkDir: path.resolve(opts.sdk),
				name,
				port: Number(opts.port),
				host: opts.host,
				open: opts.open,
			});
		}),
	);

program
	.command('market')
	.description('Where the market is crowded and where it is thin — crossed with what we can build')
	.option('--rare-below <share>', 'treat a mechanic as thin below this share of the corpus', (v) => Number(v), 0.1)
	.option('--pairs', 'also list mechanic pairings no recorded game uses', false)
	.option('--json', 'machine-readable output', false)
	.action(run((opts) => market({ json: opts.json, rareBelow: opts.rareBelow, pairs: opts.pairs })));

program
	.command('mechanics')
	.description('Browse the researched mechanics library — what works where, who shipped it, what art it needs')
	.option('--id <id>', 'show one mechanic in full')
	.option('--win-type <type>', 'lines | ways | cluster | scatter')
	.option('--volatility <tier>', 'low | medium | high | extreme')
	.option('--search <text>', 'free-text search')
	.option('--games [query]', 'the reference game index, optionally filtered')
	.option('--max-win <n>', 'with --games: only games reaching at least this multiple')
	.option('--combine <ids>', 'comma-separated ids — check the combination for conflicts')
	.option('--art <ids>', 'comma-separated ids — what the art team must produce')
	.option('--doc', 'regenerate docs/mechanics-library.md from the library', false)
	.option('--json', 'machine-readable output', false)
	.action(
		run((opts) =>
			mechanics({
				id: opts.id,
				winType: opts.winType,
				volatility: opts.volatility,
				search: opts.search,
				games: opts.games,
				maxWin: opts.maxWin,
				combine: opts.combine,
				art: opts.art,
				json: opts.json,
				doc: opts.doc,
			}),
		),
	);

program
	.command('math:balance')
	.description('Pre-flight: is this paytable payable at this RTP, on this board? Runs in a second, no simulation')
	.requiredOption('--spec <path>', 'path to game-spec.yaml')
	.option('--volatility <profile>', 'low | medium | high — overrides game.volatility in the spec')
	.option('--apply', 'rescale the paytable in the spec so it lands on target', false)
	.option('--json', 'machine-readable output', false)
	.action(
		run((opts) =>
			mathBalance({
				specPath: path.resolve(opts.spec),
				volatility: opts.volatility,
				apply: opts.apply,
				json: opts.json,
			}),
		),
	);

program
	.command('math:optimise')
	.description('Reweight the simulated rounds until the game actually pays its target RTP')
	.requiredOption('--spec <path>', 'path to game-spec.yaml')
	.requiredOption('--math-sdk <path>', 'path to a checkout of StakeEngine/math-sdk')
	.option('--volatility <profile>', 'low | medium | high — overrides game.volatility in the spec')
	.option('--threads <n>', 'threads for the Rust optimiser', (v) => Number(v), 4)
	.option('--force', 'regenerate game_optimization.py, discarding any hand-tuning', false)
	.option('--setup-only', 'write game_optimization.py and stop, without running the optimiser', false)
	.option('--python <path>', 'python interpreter to use')
	.action(
		run((opts) =>
			mathOptimise({
				specPath: path.resolve(opts.spec),
				mathSdkDir: path.resolve(opts.mathSdk),
				volatility: opts.volatility,
				threads: opts.threads,
				force: opts.force,
				setupOnly: opts.setupOnly,
				python: opts.python,
			}),
		),
	);

program
	.command('math:report')
	.description('What the maths actually pays — measured RTP and hit rates against your targets')
	.requiredOption('--spec <path>', 'path to game-spec.yaml')
	.requiredOption('--math-sdk <path>', 'path to a checkout of StakeEngine/math-sdk')
	.option('--json', 'machine-readable output', false)
	.action(
		run((opts) =>
			mathReport({
				specPath: path.resolve(opts.spec),
				mathSdkDir: path.resolve(opts.mathSdk),
				json: opts.json,
			}),
		),
	);

program
	.command('math:validate')
	.description('Is this game shippable? Every rule measured, with the number it was judged on')
	.requiredOption('--spec <path>', 'path to game-spec.yaml')
	.requiredOption('--math-sdk <path>', 'path to a checkout of StakeEngine/math-sdk')
	.option('--json', 'machine-readable output', false)
	.action(
		run((opts) =>
			mathValidate({
				specPath: path.resolve(opts.spec),
				mathSdkDir: path.resolve(opts.mathSdk),
				json: opts.json,
			}),
		),
	);

program
	.command('sound:build')
	.description('Build the audio sprite (sounds.json + 4 formats) from a folder of individual sound files')
	.requiredOption('--sdk <path>', 'path to a checkout of StakeEngine/web-sdk')
	.requiredOption('--source <path>', 'folder of audio files, each named after the sound it is')
	.option('--spec <path>', 'path to game-spec.yaml, to know which app to build into')
	.option('--game <name>', 'the game.name you used (matches apps/<name>) — alternative to --spec')
	.option('--dry-run', 'show the planned layout without writing anything', false)
	.action(
		run((opts) =>
			soundBuild({
				specPath: opts.spec ? path.resolve(opts.spec) : null,
				sdkDir: path.resolve(opts.sdk),
				sourceDir: path.resolve(opts.source),
				gameName: opts.game,
				dryRun: opts.dryRun,
			}),
		),
	);

program
	.command('package')
	.description('Build and assemble everything Stake Engine wants uploaded, in one folder')
	.requiredOption('--spec <path>', 'path to game-spec.yaml')
	.requiredOption('--sdk <path>', 'path to a checkout of StakeEngine/web-sdk')
	.requiredOption('--math-sdk <path>', 'path to a checkout of StakeEngine/math-sdk')
	.option('--out <path>', 'where to write the upload folder (default: <spec folder>/upload)')
	.option('--skip-build', 'package what is already built, without rebuilding the frontend', false)
	.action(
		run((opts) =>
			packageGame({
				specPath: path.resolve(opts.spec),
				sdkDir: path.resolve(opts.sdk),
				mathSdkDir: path.resolve(opts.mathSdk),
				outDir: opts.out ? path.resolve(opts.out) : null,
				skipBuild: opts.skipBuild,
			}),
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
