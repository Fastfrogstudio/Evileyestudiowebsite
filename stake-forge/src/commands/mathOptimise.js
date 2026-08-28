import fs from 'fs-extra';
import path from 'node:path';
import chalk from 'chalk';
import { spawn } from 'node:child_process';

import { loadGameSpec } from '../lib/loadSpec.js';
import { resolvePython } from '../lib/verify.js';
import { mathGameId } from './mathScaffold.js';
import { planOptimisation, renderOptimisationPy, VOLATILITY_PROFILES } from '../lib/optimisation.js';

/**
 * Hit the target RTP.
 *
 * `math:run` simulates rounds; this reweights them until the distribution
 * actually pays what the spec asked for. Two things happen here:
 *
 *   1. `game_optimization.py` is generated from the spec's volatility profile.
 *      It is generated ONCE and then left alone — see the --force note below.
 *   2. The Rust optimiser is run over every bet mode, and the reweighted lookup
 *      tables land in library/publish_files/.
 *
 * Afterwards `forge math:report` reads the optimised tables instead of the raw
 * ones, and its numbers become numbers worth judging.
 */

/**
 * Write game_optimization.py.
 *
 * REFUSES to overwrite an existing one without --force. The generated targets
 * are a starting point that a maths person is expected to tune by hand, and
 * silently replacing a tuned file with the generated defaults would throw away
 * exactly the work this step exists to enable.
 */
export function writeOptimisationSetup({ spec, gameDir, volatility, force }) {
	const file = path.join(gameDir, 'game_optimization.py');
	const plan = planOptimisation(spec, { volatility });

	if (fs.existsSync(file) && !force) {
		return { file, plan, written: false };
	}

	fs.writeFileSync(file, renderOptimisationPy(spec, plan), 'utf8');
	return { file, plan, written: true };
}

/**
 * Which bet modes an existing game_optimization.py targets.
 *
 * Read with a regex rather than by importing it: this runs before Python is
 * involved, and the whole point is to catch a mismatch without executing
 * anything.
 */
export function readSetupModes(file) {
	if (!fs.existsSync(file)) return [];
	const source = fs.readFileSync(file, 'utf8');
	const block = /opt_params\s*=\s*\{([\s\S]*)/.exec(source);
	if (!block) return [];
	return [...block[1].matchAll(/^\s{12}["']([^"']+)["']\s*:\s*\{/gm)].map((m) => m[1]);
}

/** Is the Rust optimiser buildable and present? */
function checkCargo(mathSdkDir) {
	const optimisationPath = path.join(mathSdkDir, 'optimization_program');
	if (!fs.existsSync(path.join(optimisationPath, 'Cargo.toml'))) {
		return { ok: false, why: `no Cargo.toml in ${optimisationPath} — is --math-sdk a full checkout?` };
	}
	return { ok: true, optimisationPath };
}

export async function mathOptimise({
	specPath,
	mathSdkDir,
	volatility,
	force,
	threads = 4,
	setupOnly,
	python: pythonOverride,
	onLine,
}) {
	const spec = loadGameSpec(specPath);
	const gameId = mathGameId(spec);
	const gameDir = path.join(mathSdkDir, 'games', gameId);
	const log = onLine ?? ((...parts) => console.log(...parts));

	if (!fs.existsSync(gameDir)) {
		throw new Error(`games/${gameId} does not exist — run "forge math:scaffold" first.`);
	}

	const tables = path.join(gameDir, 'library', 'lookup_tables');
	if (!setupOnly && !fs.existsSync(tables)) {
		throw new Error(
			`No simulated rounds for games/${gameId}. The optimiser reweights rounds that already ` +
				`exist — run "forge math:run" first.`,
		);
	}

	const { file, plan, written } = writeOptimisationSetup({ spec, gameDir, volatility, force });

	// A setup naming modes this game does not have cannot work: the optimiser
	// looks each one up by name and dies with a bare KeyError. Say so here, where
	// the fix is obvious, rather than after the Rust binary has started.
	if (!written) {
		const declared = readSetupModes(file);
		const actual = new Set(plan.modes.map((m) => m.name));
		const strangers = declared.filter((m) => !actual.has(m));
		if (strangers.length) {
			throw new Error(
				`${path.relative(mathSdkDir, file)} targets bet mode(s) this game does not have: ` +
					`${strangers.join(', ')}. It is the sample game's setup, or was written for a different ` +
					`spec. Re-run with --force to regenerate it from this one.`,
			);
		}
	}

	log(chalk.bold(`\nOptimising "${spec.game.name}"\n`));
	log(`  volatility  ${chalk.bold(plan.volatility)} — ${chalk.dim(plan.profile.label)}`);
	for (const mode of plan.modes) {
		const split = mode.conditions.map((c) => `${c.criteria} ${(c.rtp * 100).toFixed(2)}%`).join(' · ');
		log(`  ${mode.name.padEnd(10)} target ${(mode.rtp * 100).toFixed(2)}%  ${chalk.dim(split)}`);
	}
	log('');

	if (written) {
		log(chalk.green('✓'), `wrote ${path.relative(mathSdkDir, file)}`);
	} else {
		log(
			chalk.yellow('·'),
			`${path.relative(mathSdkDir, file)} already exists — kept as-is`,
			chalk.dim('(--force to regenerate from the spec)'),
		);
	}

	if (setupOnly) {
		log(chalk.dim('\n  --setup-only: not running the optimiser.\n'));
		return { ok: true, file, plan, optimised: false };
	}

	const cargo = checkCargo(mathSdkDir);
	if (!cargo.ok) {
		log(chalk.red(`\n✗ ${cargo.why}`));
		return { ok: false, error: cargo.why };
	}

	const python = resolvePython(mathSdkDir, pythonOverride);
	const modes = plan.modes.map((m) => m.name);

	log(chalk.dim(`\n  Running the Rust optimiser over ${modes.length} mode(s). This is the slow step —`));
	log(chalk.dim('  the first run also has to compile it, which takes a few minutes.\n'));

	const script = `
import sys, json, time, traceback
sys.path.insert(0, ${JSON.stringify(mathSdkDir)})
sys.path.insert(0, ${JSON.stringify(gameDir)})
try:
    from gamestate import GameState
    from game_config import GameConfig
    from game_optimization import OptimizationSetup
    from optimization_program.run_script import OptimizationExecution
    from src.write_data.write_configs import generate_configs

    config = GameConfig()
    gamestate = GameState(config)
    OptimizationSetup(config)

    # generate_configs BEFORE the optimiser, not just after.
    #
    # The Rust binary reads library/configs/math_config.json, and that file is
    # built from config.opt_params — which only exist once OptimizationSetup has
    # run. math:run writes it with no setup constructed, so it lands with empty
    # bet_modes/fences/dresses/bias arrays, and the optimiser panics on the first
    # mode with "betmode index not found in betmode summary array". Regenerating
    # it here is what fills those arrays in.
    generate_configs(gamestate)

    started = time.time()
    OptimizationExecution().run_all_modes(config, ${JSON.stringify(modes)}, ${threads})
    # And again afterwards: the frontend config carries the reweighted bet-mode
    # data, so skipping this leaves the app on pre-optimisation numbers.
    generate_configs(gamestate)
    out = {"ok": True, "seconds": round(time.time() - started, 2)}
except Exception as exc:
    out = {"ok": False, "error": f"{type(exc).__name__}: {exc}", "traceback": traceback.format_exc()}
print("STAKE_FORGE_JSON:" + json.dumps(out))
`;

	return new Promise((resolve) => {
		const child = spawn(python, ['-u', '-c', script], {
			cwd: mathSdkDir,
			env: {
				...process.env,
				PYTHONUNBUFFERED: '1',
				// run_rust_script() prepends ~/.cargo/bin itself, but only to what it
				// inherits — so a PATH without cargo still needs it here for the
				// `cargo` lookup to succeed at all.
				PATH: `${path.join(process.env.HOME ?? '', '.cargo', 'bin')}:${process.env.PATH ?? ''}`,
			},
		});

		let result = null;
		const pump = (stream) => {
			let buffer = '';
			return (chunk) => {
				buffer += chunk.toString();
				const parts = buffer.split('\n');
				buffer = parts.pop() ?? '';
				for (const text of parts) {
					if (text.startsWith('STAKE_FORGE_JSON:')) {
						result = JSON.parse(text.slice('STAKE_FORGE_JSON:'.length));
						continue;
					}
					if (!text.trim()) continue;
					log(stream === 'err' ? chalk.dim(text) : text);
				}
			};
		};
		child.stdout.on('data', pump('out'));
		child.stderr.on('data', pump('err'));

		child.on('error', (err) => {
			log(chalk.red(`failed to start python: ${err.message}`));
			resolve({ ok: false, error: err.message });
		});

		child.on('close', () => {
			if (!result) {
				log(chalk.red('\nThe optimiser produced no result.'));
				return resolve({ ok: false });
			}
			if (!result.ok) {
				log(chalk.red(`\n✗ ${result.error}`));
				// The three failures worth naming, because each has a different fix
				// and the raw exception does not say which one you hit.
				if (/AssertionError/.test(result.error)) {
					log(
						chalk.dim(
							'\n  An assertion in verify_optimization_input means the setup and the\n' +
								'  simulation disagree — usually a conditions key with no matching\n' +
								'  Distribution criteria, or condition RTPs that do not sum to the mode\n' +
								'  RTP. If you have hand-edited game_optimization.py, that is where to\n' +
								'  look; `--force` regenerates it from the spec.\n',
						),
					);
				} else if (/returned non-zero exit status/.test(result.error)) {
					// A non-zero exit means the optimiser RAN and rejected something —
					// never that Rust is missing. Saying "install Rust" here sent me
					// looking in entirely the wrong place twice: once for a panic
					// (101) and once for a fence that matched no books (1).
					// run_rust_script() captures stderr and raises before printing it,
					// so the real message never reaches here; the reproduction below
					// is the only way to read it.
					log(
						chalk.dim(
							'\n  The optimiser started and then failed. Its message is swallowed by\n' +
								'  the SDK (run_rust_script captures stderr and raises before printing it),\n' +
								'  so run it directly to read it:\n\n' +
								`    cd ${path.join(mathSdkDir, 'optimization_program')} && cargo run --release\n\n` +
								'  Two it says often:\n' +
								'    "betmode index not found in betmode summary array" — math_config.json\n' +
								'      has empty arrays; re-running this command rewrites it.\n' +
								'    "fence \'<name>\' matched 0 books" — the setup targets a criteria the\n' +
								'      simulation produced no rounds for. --force regenerates it.\n',
						),
					);
				} else if (/cargo|No such file/i.test(result.error)) {
					log(
						chalk.dim(
							'\n  The Rust optimiser could not be run. It needs a Rust toolchain:\n' +
								'    curl https://sh.rustup.rs -sSf | sh\n' +
								`    cd ${path.join(mathSdkDir, 'optimization_program')} && cargo build --release\n`,
						),
					);
				} else if (/FileNotFoundError.*math_config/.test(result.error)) {
					log(chalk.dim('\n  library/configs/math_config.json is missing — run "forge math:run" first.\n'));
				}
				if (process.env.DEBUG) log(chalk.dim(result.traceback));
				return resolve({ ok: false, error: result.error });
			}

			log(chalk.green('\n✓'), `optimised in ${result.seconds}s`);
			log(chalk.bold.cyan('\nNext:'));
			log(`  forge math:report --spec ${path.basename(specPath)} --math-sdk ${mathSdkDir}`);
			log(chalk.dim('  — now reading the optimised tables, so the RTP is the real one\n'));

			resolve({ ok: true, seconds: result.seconds, file, plan, optimised: true });
		});
	});
}

export { VOLATILITY_PROFILES };
