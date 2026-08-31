import { spawn } from 'node:child_process';
import fs from 'fs-extra';
import path from 'node:path';
import chalk from 'chalk';

/**
 * Workspace packages whose declared entry point is not on disk.
 *
 * Most of the web-sdk's packages point `main` straight at `index.ts` and need no
 * build. `pixi-svelte` does not: it declares `./dist/index.js`, produced by
 * svelte-package. Until that exists, Vite reports
 *
 *   Failed to resolve entry for package "pixi-svelte"
 *
 * against every file that imports it — which is every component in every app.
 * In storybook that surfaces as "Failed to fetch dynamically imported module"
 * on EVERY story, with three generic suggestions and no mention of the package.
 *
 * Nothing installs it either, because the install runs --ignore-scripts, so the
 * prepare hook that would have built it never fires. A fresh checkout therefore
 * links cleanly, type-checks, and cannot render a single frame.
 */
export function unbuiltPackages(sdkDir) {
	const dir = path.join(sdkDir, 'packages');
	if (!fs.existsSync(dir)) return [];
	const out = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const manifest = path.join(dir, entry.name, 'package.json');
		if (!fs.existsSync(manifest)) continue;
		let pkg;
		try {
			pkg = fs.readJsonSync(manifest);
		} catch {
			continue;
		}
		// Only a package that declares a build script can be missing a build; one
		// pointing at source is complete as delivered.
		if (!pkg.scripts?.build) continue;
		const target = pkg.main ?? pkg.module;
		if (!target) continue;
		if (!fs.existsSync(path.join(dir, entry.name, target))) {
			out.push({ name: entry.name, entry: target });
		}
	}
	return out;
}

/** Run a command in the SDK, streaming its output. */
function runIn(sdkDir, args, { timeoutMs }) {
	return new Promise((resolve, reject) => {
		const child = spawn('pnpm', args, { cwd: sdkDir, stdio: 'inherit' });
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			reject(new Error(`pnpm ${args[0]} did not finish within ${Math.round(timeoutMs / 1000)}s.`));
		}, timeoutMs);
		child.on('error', (err) => {
			clearTimeout(timer);
			reject(
				err.code === 'ENOENT'
					? new Error(
							'pnpm is not on PATH. The web-sdk is a pnpm workspace and npm cannot link it — ' +
								'install pnpm (npm i -g pnpm) and re-run.',
						)
					: err,
			);
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			if (code === 0) resolve();
			else reject(new Error(`pnpm ${args.join(' ')} exited ${code}.`));
		});
	});
}

/**
 * `forge deps:link` — re-link the web-sdk workspace after scaffolding an app.
 *
 * ── Why this is a command and not a footnote ────────────────────────────────
 * A scaffolded app is a new pnpm workspace package. Until the workspace is
 * re-linked, its node_modules does not exist, every import in it fails to
 * resolve, and `forge verify` reports dozens of type errors that have nothing to
 * do with the generated code.
 *
 * That was documented — verify's own failure message says to run pnpm install —
 * but documented is not the same as done. Running the full pipeline end to end
 * showed a step that reliably fails on a fresh game for a reason no step fixes,
 * and "read the error and run a different tool" is not a pipeline. So it is a
 * step.
 *
 * `--ignore-scripts` matches what the e2e run does: postinstall scripts in a
 * slot SDK mostly fetch browsers and build native modules, none of which a
 * type-check needs, and skipping them turns minutes into seconds.
 */
export function depsLink({ sdkDir, ignoreScripts = true, timeoutMs = 900_000 }) {
	if (!fs.existsSync(sdkDir)) {
		throw new Error(`--sdk path does not exist: ${sdkDir}`);
	}
	const workspaceFile = path.join(sdkDir, 'pnpm-workspace.yaml');
	if (!fs.existsSync(workspaceFile)) {
		throw new Error(
			`${sdkDir} has no pnpm-workspace.yaml — this should point at the ROOT of a web-sdk ` +
				`checkout, not at one app inside it.`,
		);
	}

	const args = ['install', ...(ignoreScripts ? ['--ignore-scripts'] : [])];
	console.log(chalk.bold(`\nLinking the web-sdk workspace\n`));
	console.log(chalk.dim(`  $ pnpm ${args.join(' ')}`));
	console.log(chalk.dim(`  in ${sdkDir}\n`));

	return runIn(sdkDir, args, { timeoutMs }).then(async () => {
		console.log(chalk.green('\n✓'), 'workspace linked');

		// Linked is not the same as runnable. See unbuiltPackages.
		const unbuilt = unbuiltPackages(sdkDir);
		if (!unbuilt.length) {
			console.log(chalk.green('✓'), 'all workspace packages have their entry points');
			return { ok: true, built: [] };
		}

		console.log('');
		for (const pkg of unbuilt) {
			console.log(chalk.yellow('  !'), `${pkg.name} has no ${pkg.entry} — building it`);
		}
		console.log('');
		// pnpm's own recursive runner rather than `pnpm build`, which is
		// `turbo run build` and would build every APP too — minutes of work for
		// something no app needs in order to run in dev.
		await runIn(sdkDir, ['--filter', './packages/**', 'run', 'build'], { timeoutMs });

		const stillMissing = unbuiltPackages(sdkDir);
		if (stillMissing.length) {
			throw new Error(
				`built the workspace packages, but ${stillMissing
					.map((p) => p.name)
					.join(', ')} still has no entry point. Run \`pnpm --filter './packages/**' run build\` ` +
					`in ${sdkDir} and read what it says.`,
			);
		}
		console.log(
			chalk.green('\n✓'),
			`built ${unbuilt.map((p) => p.name).join(', ')} — storybook can resolve them now`,
		);
		return { ok: true, built: unbuilt.map((p) => p.name) };
	});
}
