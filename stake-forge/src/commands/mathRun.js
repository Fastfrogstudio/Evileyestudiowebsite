import fs from 'fs-extra';
import path from 'node:path';
import chalk from 'chalk';
import { spawn } from 'node:child_process';

import { loadGameSpec } from '../lib/loadSpec.js';
import { resolvePython } from '../lib/verify.js';
import { mathGameId } from './mathScaffold.js';

/**
 * Run the real simulation.
 *
 * This is the step that turns placeholders into maths. It calls the same two
 * entry points a game's own run.py calls — `create_books` to simulate rounds and
 * `generate_configs` to write the frontend/backend config files — rather than
 * executing run.py itself, because run.py hardcodes simulation counts and also
 * wants the Rust optimiser, which is a separate (and much slower) concern.
 *
 * What it produces under games/<game_id>/library/:
 *   books/books_<mode>.json          simulated rounds, in the exact shape the
 *                                    web-sdk's story data files use
 *   configs/config_fe_<game_id>.json the authoritative frontend config
 *   lookup_tables/                    per-round payouts, which the RTP report reads
 *   publish_files/                    what actually gets uploaded
 */
/**
 * Peak resident memory during a run is one batch of simulated rounds held in
 * Python before it is flushed to a temp file. Measured on a feature-heavy bonus
 * mode — every round buys the free game — at 248 KB per round.
 *
 * The SDK's own default batch of 50,000 is therefore ~12 GB, which the kernel
 * kills on a 16 GB machine. It survives short runs only because base-game rounds
 * (mostly one spin, mostly losing) are an order of magnitude cheaper than feature
 * rounds, so the mode that OOMs is never the one you test with.
 */
const BYTES_PER_ROUND = 256 * 1024;
const BATCH_BUDGET_BYTES = 1.25 * 1024 ** 3;
export const DEFAULT_BATCH = Math.floor(BATCH_BUDGET_BYTES / BYTES_PER_ROUND);

/**
 * The SDK derives its batch count with `round(num_sims / batch)` and then divides
 * the rounds back out, so a batch that does not divide the round count silently
 * simulates slightly more or fewer rounds than asked for. Prefer an exact divisor
 * at or just below the budget.
 */
export function chooseBatchSize(sims, cap = DEFAULT_BATCH) {
	if (sims <= cap) return Math.max(10, sims);
	for (let n = cap; n >= Math.floor(cap / 2); n--) {
		if (sims % n === 0) return n;
	}
	return cap;
}

export function mathRun({ specPath, mathSdkDir, sims, python: pythonOverride, compress, batch, onLine }) {
	const spec = loadGameSpec(specPath);
	const gameId = mathGameId(spec);
	const gameDir = path.join(mathSdkDir, 'games', gameId);

	if (!fs.existsSync(gameDir)) {
		throw new Error(`games/${gameId} does not exist — run "forge math:scaffold" first.`);
	}

	// One count per bet mode. A single --sims applies to all of them, which is
	// what you want while iterating; per-mode counts matter only near release.
	const modes = Object.keys(spec.game.betModes);
	const numSims = Object.fromEntries(modes.map((m) => [m, sims]));

	const python = resolvePython(mathSdkDir, pythonOverride);
	// Varargs, because the success lines below are written the way the rest of
	// the CLI writes them: a coloured tick followed by the message.
	const log = onLine ?? ((...parts) => console.log(...parts));

	log(chalk.bold(`\nSimulating "${spec.game.name}" — ${sims} rounds × ${modes.length} bet mode(s)\n`));
	log(chalk.dim(`  python: ${python}`));
	log(chalk.dim(`  game:   games/${gameId}\n`));
	const batchSize = batch ? Math.max(10, batch) : chooseBatchSize(sims);
	if (batchSize < sims) {
		log(chalk.dim(`  batch:  ${batchSize} rounds at a time (${Math.ceil(sims / batchSize)} batches per mode)\n`));
	}

	const script = `
import sys, json, time, traceback
sys.path.insert(0, ${JSON.stringify(mathSdkDir)})
sys.path.insert(0, ${JSON.stringify(gameDir)})
try:
    from gamestate import GameState
    from game_config import GameConfig
    from src.state.run_sims import create_books
    from src.write_data.write_configs import generate_configs

    config = GameConfig()
    gamestate = GameState(config)

    started = time.time()
    create_books(
        gamestate,
        config,
        ${JSON.stringify(numSims)},
        ${batchSize},
        1,
        ${compress ? 'True' : 'False'},
        False,
    )
    generate_configs(gamestate)
    out = {"ok": True, "seconds": round(time.time() - started, 2), "modes": ${JSON.stringify(modes)}}
except Exception as exc:
    out = {"ok": False, "error": f"{type(exc).__name__}: {exc}", "traceback": traceback.format_exc()}
print("STAKE_FORGE_JSON:" + json.dumps(out))
`;

	return new Promise((resolve) => {
		// Detached so the multiprocessing workers land in their own process group:
		// killing only the process we spawned leaves those workers orphaned, and an
		// orphan holding the stdout pipe open turns a crash into a silent hang.
		const child = spawn(python, ['-u', '-c', script], {
			cwd: mathSdkDir,
			env: { ...process.env, PYTHONUNBUFFERED: '1' },
			detached: true,
		});

		const killGroup = () => {
			try {
				process.kill(-child.pid, 'SIGKILL');
			} catch {
				child.kill('SIGKILL');
			}
		};

		let result = null;
		let aborted = null;
		/**
		 * A distribution the maths cannot satisfy does not fail — check_repeat()
		 * simply re-rolls the round forever, and the SDK only warns. Left alone
		 * that is an overnight hang with no error, so treat a runaway repeat count
		 * as a failure and say which criteria caused it.
		 */
		let repeatCriteria = null;
		const REPEAT_LIMIT = 20000;

		const pump = (stream) => {
			let buffer = '';
			return (chunk) => {
				buffer += chunk.toString();
				const lines = buffer.split('\n');
				buffer = lines.pop() ?? '';
				for (const text of lines) {
					if (text.startsWith('STAKE_FORGE_JSON:')) {
						result = JSON.parse(text.slice('STAKE_FORGE_JSON:'.length));
						continue;
					}

					const criteria = /Criteria:\s*(\S+)/.exec(text);
					if (criteria) repeatCriteria = criteria[1];
					const count = /Current Count:\s*(\d+)/.exec(text);
					if (count && Number(count[1]) >= REPEAT_LIMIT && !aborted) {
						aborted =
							`the "${repeatCriteria ?? 'unknown'}" distribution re-rolled ${count[1]} times ` +
							'without ever satisfying its criteria.';
						killGroup();
						continue;
					}

					// The SDK's own progress output is worth showing — a long run is
					// otherwise a silent wait with no way to tell it is alive. The
					// repeat warnings are suppressed: they arrive in fives and say the
					// same thing each time.
					if (!text.trim() || /High repeat count|Current Count|Criteria:|Simulation:|warn\($/.test(text)) continue;
					log(stream === 'err' ? chalk.dim(text) : text);
				}
			};
		};
		child.stdout.on('data', pump('out'));
		child.stderr.on('data', pump('err'));

		child.on('error', (err) => {
			log(chalk.red(`failed to start python: ${err.message}`));
			resolve({ ok: false });
		});

		/**
		 * A run can end three ways: cleanly, by our own abort, or by the kernel
		 * killing python for using too much memory. Only the first two used to be
		 * handled — an OOM kill left node waiting on a stdout pipe that an orphaned
		 * multiprocessing worker was still holding open, so a dead run looked like a
		 * running one, indefinitely. Settle on whichever of exit/close arrives, and
		 * give the other a short grace period rather than waiting on it forever.
		 */
		let exited = null;
		let settled = false;
		let grace = null;

		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(grace);
			done();
		};

		child.on('exit', (code, signal) => {
			exited = { code, signal };
			grace = setTimeout(() => {
				killGroup();
				finish();
			}, 2000);
			grace.unref?.();
		});
		child.on('close', finish);

		function done() {
			if (aborted) {
				log(chalk.red(`\n✗ Stopped: ${aborted}`));
				log(
					chalk.dim(
						'\n  This is a distribution asking for an outcome the maths cannot produce —\n' +
							'  most often a "wincap" criteria, which re-rolls until a round pays EXACTLY\n' +
							'  max_win. Placeholder reel strips never reach that.\n\n' +
							'  Either widen the criteria in game_config.py, or run this once you have\n' +
							'  real reel strips that can actually hit it.\n',
					),
				);
				return resolve({ ok: false, error: aborted });
			}

			if (!result) {
				if (exited?.signal === 'SIGKILL' || exited?.code === 137) {
					const error =
						'the simulator was killed by the operating system for using too much memory.';
					log(chalk.red(`\n✗ Stopped: ${error}`));
					log(
						chalk.dim(
							`\n  Peak memory is one batch of rounds held before it is written out, and\n` +
								`  feature-heavy modes cost far more per round than base-game ones. This run\n` +
								`  used a batch of ${batchSize}.\n\n` +
								'  Re-run with a smaller --batch (halving it halves the memory) — the round\n' +
								'  count and the maths are unchanged, it just writes out more often.\n',
						),
					);
					return resolve({ ok: false, error });
				}
				log(chalk.red('\nSimulation produced no result.'));
				return resolve({ ok: false });
			}
			if (!result.ok) {
				log(chalk.red(`\n✗ ${result.error}`));
				if (process.env.DEBUG) log(chalk.dim(result.traceback));
				return resolve({ ok: false, error: result.error });
			}

			const library = path.join(gameDir, 'library');
			const books = modes
				.map((m) => ({ mode: m, file: path.join(library, 'books', `books_${m}.json`) }))
				.filter((b) => fs.existsSync(b.file));

			log(chalk.green('\n✓'), `simulated in ${result.seconds}s`);
			for (const book of books) {
				const rounds = JSON.parse(fs.readFileSync(book.file, 'utf8')).length;
				log(chalk.green('✓'), `books/${path.basename(book.file)} — ${rounds} rounds`);
			}
			const feConfig = path.join(library, 'configs', `config_fe_${gameId}.json`);
			if (fs.existsSync(feConfig)) {
				log(chalk.green('✓'), `configs/config_fe_${gameId}.json — the authoritative frontend config`);
			}

			log(chalk.bold.cyan('\nNext:'));
			log(`  forge math:sync --spec ${path.basename(specPath)} --math-sdk ${mathSdkDir} --sdk ./web-sdk`);
			log(chalk.dim('  — replaces the placeholder config and reel strips with these\n'));

			resolve({ ok: true, seconds: result.seconds, gameDir, library });
		}
	});
}
