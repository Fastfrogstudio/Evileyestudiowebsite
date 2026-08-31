/**
 * Storybook lifecycle, one server per game.
 *
 * Storybook is the web-sdk's own way to look at a game without an RGS
 * connection, so the preview panel embeds it rather than reinventing a renderer.
 * Each game gets its own port because storybook is per-app, and switching games
 * should not mean waiting for a restart every time.
 */

import fs from 'fs-extra';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

const BASE_PORT = 6100;
const MAX_PREVIEWS = 4;

/** gameName -> { port, child, status, log, startedAt } */
const previews = new Map();

/**
 * A port nothing is listening on.
 *
 * Checking our own map is not enough. A stopped preview's storybook can outlive
 * the SIGTERM by a second or two, and reusing its port immediately meant the
 * NEW storybook found the port taken, prompted "run on 6101 instead?", and sat
 * there forever — while the readiness poll happily got a 200 from the OLD
 * server still on that port and reported "ready". The app then showed a blank
 * page and nothing said why.
 */
async function isPortFree(port) {
	return new Promise((resolve) => {
		const server = net.createServer();
		server.once('error', () => resolve(false));
		server.once('listening', () => server.close(() => resolve(true)));
		server.listen(port, '127.0.0.1');
	});
}

async function nextPort() {
	const used = new Set([...previews.values()].map((p) => p.port));
	for (let port = BASE_PORT; port < BASE_PORT + 50; port += 1) {
		if (used.has(port)) continue;
		if (await isPortFree(port)) return port;
	}
	throw new Error('no free preview port');
}

export function previewState(gameName) {
	const preview = previews.get(gameName);
	if (!preview) return { status: 'stopped' };
	return {
		status: preview.status,
		port: preview.port,
		url: preview.status === 'ready' ? `http://localhost:${preview.port}` : null,
		startedAt: preview.startedAt,
		// 40 lines is enough to see a start-up; a Vite compile error and its stack
		// is longer than that, and it arrives after start-up, so trimming to 40
		// would cut off the one thing anybody opens the log for.
		log: preview.log.slice(-120),
		error: preview.error ?? null,
	};
}

export function allPreviews() {
	return Object.fromEntries([...previews.keys()].map((name) => [name, previewState(name)]));
}

export async function startPreview({ gameName, webSdk }) {
	const existing = previews.get(gameName);
	if (existing && existing.status !== 'stopped' && existing.status !== 'error') {
		return previewState(gameName);
	}

	const appDir = path.join(webSdk, 'apps', gameName);
	if (!fs.existsSync(appDir)) {
		throw new Error(`apps/${gameName} does not exist yet — run "Scaffold web app" first`);
	}
	if (!fs.existsSync(path.join(appDir, 'node_modules'))) {
		throw new Error(
			`apps/${gameName} has no node_modules. It is a new pnpm workspace package, so run ` +
				`\`pnpm install\` in ${webSdk} once, then try again.`,
		);
	}

	// Keep a lid on how many storybooks can be alive at once — each is a full
	// vite dev server, and a stray handful will eat the machine.
	if (previews.size >= MAX_PREVIEWS) {
		const oldest = [...previews.entries()].sort((a, b) => a[1].startedAt - b[1].startedAt)[0];
		if (oldest) stopPreview(oldest[0]);
	}

	const port = await nextPort();
	const child = spawn(
		'npx',
		// --ci so storybook never asks anything. Without it, a taken port turns
		// into an interactive "run on 6101 instead? (Y/n)" prompt that blocks
		// forever with no output explaining the hang.
		['--no-install', 'storybook', 'dev', '-p', String(port), '--no-open', '--quiet', '--ci'],
		{
			cwd: appDir,
			env: { ...process.env, PUBLIC_CHROMATIC: 'true', FORCE_COLOR: '0', NO_COLOR: '1', CI: 'true' },
			// Its own process group, so stopping it can kill the whole tree.
			// `npx` forks the real storybook process; SIGTERM to npx alone left
			// that child alive and holding the port.
			detached: true,
		},
	);

	const preview = { port, child, status: 'starting', log: [], startedAt: Date.now(), error: null };
	previews.set(gameName, preview);

	const record = (chunk) => {
		const text = chunk.toString();
		preview.log.push(...text.split('\n').filter(Boolean));
		if (preview.log.length > 200) preview.log.splice(0, preview.log.length - 200);
	};
	child.stdout.on('data', record);
	child.stderr.on('data', record);

	child.on('error', (err) => {
		preview.status = 'error';
		preview.error = err.message;
	});
	child.on('close', (code) => {
		if (preview.status !== 'stopping') {
			preview.status = 'error';
			preview.error = `storybook exited with code ${code}`;
		} else {
			preview.status = 'stopped';
		}
	});

	// Storybook prints its banner before it can actually serve, so poll the
	// index instead of matching on output — that is the real readiness signal.
	pollReady(preview, port);

	return previewState(gameName);
}

async function pollReady(preview, port) {
	const deadline = Date.now() + 240000;
	while (Date.now() < deadline) {
		if (preview.status === 'stopping' || preview.status === 'stopped') return;
		try {
			const res = await fetch(`http://localhost:${port}/index.json`, {
				signal: AbortSignal.timeout(5000),
			});
			if (res.ok) {
				await res.json();
				preview.status = 'ready';
				return;
			}
		} catch {
			// not up yet
		}
		await new Promise((r) => setTimeout(r, 2000));
	}
	if (preview.status === 'starting') {
		preview.status = 'error';
		preview.error = 'storybook did not become ready within 4 minutes';
	}
}

/** Story ids available in a running preview, for the story picker. */
export async function previewStories(gameName) {
	const preview = previews.get(gameName);
	if (!preview || preview.status !== 'ready') return [];
	try {
		const res = await fetch(`http://localhost:${preview.port}/index.json`, {
			signal: AbortSignal.timeout(8000),
		});
		const data = await res.json();
		return Object.entries(data.entries ?? {}).map(([id, entry]) => ({
			id,
			title: entry.title,
			name: entry.name,
		}));
	} catch {
		return [];
	}
}

export function stopPreview(gameName) {
	const preview = previews.get(gameName);
	if (!preview) return { status: 'stopped' };
	preview.status = 'stopping';
	killTree(preview.child);
	previews.delete(gameName);
	return { status: 'stopped' };
}

/**
 * Kill the whole process group, not just the process we spawned.
 *
 * `npx storybook` forks the real server, so signalling npx alone leaves a live
 * vite dev server holding the port. Negative pid signals the group, which is
 * why the child is spawned detached.
 */
function killTree(child) {
	try {
		process.kill(-child.pid, 'SIGTERM');
	} catch {
		try {
			child.kill('SIGTERM');
		} catch {
			// already gone
		}
	}
	// SIGKILL shortly after, in case something ignored the TERM. Unref'd so it
	// never holds the server process open on its own.
	const timer = setTimeout(() => {
		try {
			process.kill(-child.pid, 'SIGKILL');
		} catch {
			// already gone
		}
	}, 4000);
	timer.unref?.();
}

export function stopAllPreviews() {
	for (const name of [...previews.keys()]) stopPreview(name);
}
