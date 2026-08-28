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
export function mathRun({ specPath, mathSdkDir, sims, python: pythonOverride, compress, onLine }) {
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
        ${Math.max(10, Math.min(sims, 50000))},
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
		const child = spawn(python, ['-u', '-c', script], {
			cwd: mathSdkDir,
			env: { ...process.env, PYTHONUNBUFFERED: '1' },
		});

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
						child.kill('SIGKILL');
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

		child.on('close', () => {
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
		});
	});
}
