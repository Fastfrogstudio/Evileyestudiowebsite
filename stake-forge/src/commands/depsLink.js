import { spawn } from 'node:child_process';
import fs from 'fs-extra';
import path from 'node:path';
import chalk from 'chalk';

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

	return new Promise((resolve, reject) => {
		const child = spawn('pnpm', args, { cwd: sdkDir, stdio: 'inherit' });
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			reject(new Error(`pnpm install did not finish within ${Math.round(timeoutMs / 1000)}s.`));
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
			if (code === 0) {
				console.log(chalk.green('\n✓'), 'workspace linked — `forge verify --sdk` can now type-check');
				resolve({ ok: true });
			} else {
				reject(new Error(`pnpm install exited ${code}.`));
			}
		});
	});
}
