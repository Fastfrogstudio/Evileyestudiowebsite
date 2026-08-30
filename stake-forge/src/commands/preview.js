import { spawn } from 'node:child_process';
import fs from 'fs-extra';
import path from 'node:path';
import chalk from 'chalk';

/**
 * `forge preview` — actually LOOK at the game, in a browser, on this machine.
 *
 * ── Why this is a command ───────────────────────────────────────────────────
 * Every other step in the pipeline produces a file and tells you a number.
 * `verify` proves the Python runs, `math:report` proves the RTP lands, `package`
 * proves the bundle assembles. None of them shows you the game.
 *
 * The web-sdk already ships the machinery: each scaffolded app has stories that
 * replay REAL simulated books through the real renderer, so you get the actual
 * game reading the actual maths without an RGS backend, a wallet, or a deploy.
 * But that is `npx storybook dev -p 6006 public` run from the right directory
 * with the right flags, which is exactly the kind of thing nobody remembers.
 *
 * ── What you are looking at ─────────────────────────────────────────────────
 * A `book` story plays a whole round end to end. A `bookEvent` story renders one
 * event at a time, which is the one to use when an animation is wrong and you
 * need to see the state it is wrong in. COMPONENTS/<Symbol> is the sheet — the
 * fastest way to check art dropped in at the right size.
 *
 * The stories read src/stories/data/*.ts, which `forge math:sync` writes from
 * the simulation. Preview a game you have not synced and you are looking at the
 * SDK's placeholder rounds, not yours — so this checks for that and says which
 * one you are about to see, rather than letting you review the wrong game.
 */
export function preview({ sdkDir, name, port = 6006, host = 'localhost', open = false }) {
	if (!fs.existsSync(sdkDir)) {
		throw new Error(`--sdk path does not exist: ${sdkDir}`);
	}
	const appDir = path.join(sdkDir, 'apps', name);
	if (!fs.existsSync(appDir)) {
		const available = fs.existsSync(path.join(sdkDir, 'apps'))
			? fs
					.readdirSync(path.join(sdkDir, 'apps'))
					.filter((d) => fs.existsSync(path.join(sdkDir, 'apps', d, 'package.json')))
			: [];
		throw new Error(
			`apps/${name} does not exist in ${sdkDir}.\n\n` +
				`Run \`forge scaffold\` first, or pick one of: ${available.join(', ') || '(none)'}`,
		);
	}
	if (!fs.existsSync(path.join(appDir, 'node_modules'))) {
		throw new Error(
			`apps/${name}/node_modules is missing, so the dev server cannot resolve its imports.\n\n` +
				`Run \`forge deps:link --sdk ${sdkDir}\` first — a freshly scaffolded app is a new pnpm ` +
				`workspace package and the workspace has to be re-linked before anything can run it.`,
		);
	}

	// Which maths is on screen. A synced app has real books written by math:sync;
	// an unsynced one still carries whatever the SDK sample shipped with, and
	// reviewing that as if it were your game is a silent waste of a review.
	const booksFile = path.join(appDir, 'src', 'stories', 'data', 'base_books.ts');
	const synced = fs.existsSync(booksFile);

	console.log(chalk.bold(`\nPreviewing ${name}\n`));
	if (synced) {
		const rounds = (fs.readFileSync(booksFile, 'utf8').match(/^\t\t"?id"?:/gm) ?? []).length;
		console.log(
			chalk.green('  ✓'),
			`playing ${rounds || 'the'} simulated rounds from src/stories/data — this is YOUR maths`,
		);
	} else {
		console.log(
			chalk.yellow('  !'),
			`no src/stories/data — you will be looking at the SDK sample's rounds, not yours.`,
		);
		console.log(chalk.dim(`    Run forge math:run then forge math:sync to put your maths in here.`));
	}

	console.log(chalk.dim(`\n  $ npx storybook dev -p ${port}`));
	console.log(chalk.dim(`  in ${appDir}\n`));

	return new Promise((resolve, reject) => {
		// `detached: true` puts storybook in its own PROCESS GROUP. npx spawns the
		// real storybook binary as a CHILD, so child.kill() reaches npx and leaves
		// storybook holding the port — the same orphan bug that made `package`
		// look like it hung. A negative pid signals the group.
		const args = ['storybook', 'dev', '-p', String(port), '--host', host, 'public'];
		if (!open) args.push('--no-open');
		const child = spawn('npx', args, {
			cwd: appDir,
			detached: true,
			env: { ...process.env, PUBLIC_CHROMATIC: 'true', NO_COLOR: '1' },
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		let announced = false;
		const announce = () => {
			if (announced) return;
			announced = true;
			console.log(chalk.green('\n✓'), chalk.bold(`http://${host}:${port}`));
			console.log(`
  ${chalk.bold('MODE_BASE/book')} · ${chalk.bold('MODE_BONUS/book')}
      a whole round, played through the real renderer. Click "Action" to start.
  ${chalk.bold('MODE_*/bookEvent')}
      one event at a time — the one to use when an animation is wrong and you
      need to see the state it is wrong in.
  ${chalk.bold('COMPONENTS/<Symbol>')}
      the symbol sheet, at real size. Fastest check that art dropped in right.

${chalk.dim('  Ctrl-C to stop.')}
`);
		};

		const watch = (buf) => {
			const text = buf.toString();
			if (/Storybook \d|Local:\s+http/.test(text)) announce();
			// Only surface real problems — storybook is extremely chatty otherwise.
			for (const line of text.split('\n')) {
				if (/error|EADDRINUSE|failed/i.test(line) && !/CSF Parsing error/.test(line)) {
					console.log(chalk.red('  '), line.trim());
				}
			}
		};
		child.stdout.on('data', watch);
		child.stderr.on('data', watch);

		const stop = () => {
			if (!child.pid) return;
			try {
				process.kill(-child.pid, 'SIGKILL');
			} catch {
				try {
					child.kill('SIGKILL');
				} catch {
					// Already gone.
				}
			}
		};
		process.on('SIGINT', () => {
			stop();
			process.exit(0);
		});

		child.on('error', (err) => {
			stop();
			reject(
				err.code === 'ENOENT'
					? new Error('npx is not on PATH — install Node.js 18+ and re-run.')
					: err,
			);
		});
		child.on('close', (code) => {
			// A dev server exiting on its own is a failure; it is supposed to run
			// until you stop it.
			if (code === 0) resolve({ ok: true });
			else reject(new Error(`storybook exited ${code}. Is port ${port} already in use?`));
		});
	});
}
