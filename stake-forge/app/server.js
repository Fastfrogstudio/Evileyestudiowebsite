/**
 * stake-forge — local app server.
 *
 * Binds to localhost only. It has full filesystem access to your SDK checkouts
 * and runs commands on your machine, which is exactly what the pipeline needs
 * and exactly why it must never be exposed to a network.
 */

import express from 'express';
import fs from 'fs-extra';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, saveConfig, validateConfig, guessPaths } from './lib/config.js';
import { listGames, readGame, writeGame, createGame, validateSpecObject, gameDir } from './lib/games.js';
import { STEPS, STEP_ORDER, runStep, auditJson } from './lib/runner.js';
import { startPreview, stopPreview, previewState, previewStories, stopAllPreviews } from './lib/preview.js';

import { BEHAVIOR_RECIPES } from '../src/lib/behaviorRecipes.js';
import { MECHANICS } from '../src/lib/mechanics.js';
import { SCREEN_SLOTS, WIN_LEVEL_ALIASES, WIN_LEVEL_ANIMATIONS, BANNER_WIN_LEVELS } from '../src/lib/screens.js';
import { ROLES, ENGINE_SPECIAL_KEYS, typeRequiredStates, defaultAnimationStates } from '../src/lib/taxonomy.js';
import { INSPIRATION_RULES } from '../src/lib/inspirationRules.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const fail = (res, err, status = 400) =>
	res.status(status).json({ error: err.message ?? String(err), details: err.details ?? null });

// ── registry ────────────────────────────────────────────────────────────────
// The editor is driven entirely by this, so the UI can never offer a role,
// special key or behavior the engine does not actually have.
app.get('/api/registry', (_req, res) => {
	res.json({
		roles: ROLES,
		engineSpecialKeys: ENGINE_SPECIAL_KEYS,
		typeRequiredStates: typeRequiredStates(),
		mechanics: Object.fromEntries(
			Object.entries(MECHANICS).map(([id, m]) => [
				id,
				{
					id,
					winType: m.winType,
					webApp: m.webApp,
					mathSample: m.mathSample,
					supportsPaylines: m.supportsPaylines,
					tumbles: m.tumbles,
					gameTypes: m.gameTypes,
					defaultReels: m.defaultReels,
					requiredSymbols: m.requiredSymbols ?? [],
					artStates: defaultAnimationStates({ mechanic: id }),
				},
			]),
		),
		behaviors: Object.fromEntries(
			Object.entries(BEHAVIOR_RECIPES).map(([id, r]) => [
				id,
				{
					id,
					title: r.title,
					status: r.status,
					tier: r.tier,
					summary: r.summary ?? '',
					appliesToRoles: r.appliesToRoles,
					requiredAnimationStates: r.requiredAnimationStates,
					requiredSpecialKeys: r.requiredSpecialKeys,
					suggestedSpecialKeys: r.suggestedSpecialKeys,
					verifiedForMechanics: r.verifiedForMechanics ?? null,
					requiresMechanic: r.requiresMechanic ?? null,
					referenceSample: r.referenceSample,
					verifiedAgainst: r.verifiedAgainst,
					generatesCode: Boolean(r.emitMath || r.emitWeb),
					config: r.config ?? null,
				},
			]),
		),
		screenSlots: SCREEN_SLOTS,
		winLevels: { aliases: WIN_LEVEL_ALIASES, animations: WIN_LEVEL_ANIMATIONS, banners: BANNER_WIN_LEVELS },
		inspirationVocabulary: INSPIRATION_RULES.map((r) => ({
			id: r.id,
			tier: r.tier,
			implies: r.implies,
			reference: r.reference,
			note: r.note ?? null,
		})),
		steps: STEP_ORDER.map((id) => ({
			id,
			title: STEPS[id].title,
			blurb: STEPS[id].blurb,
			needs: STEPS[id].needs,
		})),
	});
});

// ── config ──────────────────────────────────────────────────────────────────
app.get('/api/config', (_req, res) => {
	const config = loadConfig();
	res.json({ config, problems: validateConfig(config), guesses: config._exists ? null : guessPaths() });
});

app.post('/api/config', (req, res) => {
	try {
		const config = saveConfig(req.body ?? {});
		res.json({ config, problems: validateConfig(config) });
	} catch (err) {
		fail(res, err);
	}
});

// ── games ───────────────────────────────────────────────────────────────────
app.get('/api/games', (_req, res) => {
	const config = loadConfig();
	res.json({ games: listGames(config.workspace), workspace: config.workspace });
});

app.post('/api/games', (req, res) => {
	try {
		const config = loadConfig();
		if (!config.workspace) throw new Error('Set a games folder in Settings first');
		res.json(createGame(config.workspace, req.body ?? {}));
	} catch (err) {
		fail(res, err);
	}
});

app.get('/api/games/:id', (req, res) => {
	try {
		const config = loadConfig();
		const game = readGame(config.workspace, req.params.id);
		game.preview = previewState(game.raw?.game?.name ?? req.params.id);
		game.scaffolded = {
			web: Boolean(
				config.webSdk && game.raw?.game?.name &&
					fs.existsSync(path.join(config.webSdk, 'apps', game.raw.game.name)),
			),
			math: Boolean(
				config.mathSdk && game.raw?.game?.gameId &&
					fs.existsSync(path.join(config.mathSdk, 'games', game.raw.game.gameId)),
			),
		};
		res.json(game);
	} catch (err) {
		fail(res, err, 404);
	}
});

app.put('/api/games/:id', (req, res) => {
	try {
		const config = loadConfig();
		const result = writeGame(config.workspace, req.params.id, req.body?.spec ?? {});
		res.json({ saved: true, ...result });
	} catch (err) {
		fail(res, err);
	}
});

/** Validate without saving, so the editor can show problems while you type. */
app.post('/api/games/:id/validate', (req, res) => {
	try {
		const config = loadConfig();
		res.json(validateSpecObject(req.body?.spec ?? {}, gameDir(config.workspace, req.params.id)));
	} catch (err) {
		fail(res, err);
	}
});

app.get('/api/games/:id/audit', async (req, res) => {
	try {
		const config = loadConfig();
		res.json(await auditJson({ dir: gameDir(config.workspace, req.params.id) }));
	} catch (err) {
		fail(res, err);
	}
});

/** List the generated placeholder / imported art, so the editor can show it. */
app.get('/api/games/:id/art', (req, res) => {
	try {
		const config = loadConfig();
		const dir = path.join(gameDir(config.workspace, req.params.id), 'assets-source');
		if (!fs.existsSync(dir)) return res.json({ files: [] });
		const files = fs
			.readdirSync(dir)
			.filter((f) => /\.(png|webp|jpg|jpeg|gif)$/i.test(f))
			.map((f) => ({ file: f, url: `/api/games/${req.params.id}/art/${encodeURIComponent(f)}` }));
		res.json({ files });
	} catch (err) {
		fail(res, err);
	}
});

app.get('/api/games/:id/art/:file', (req, res) => {
	try {
		const config = loadConfig();
		const dir = path.join(gameDir(config.workspace, req.params.id), 'assets-source');
		const file = path.join(dir, path.basename(req.params.file));
		if (!fs.existsSync(file)) return res.status(404).end();
		res.sendFile(file);
	} catch (err) {
		fail(res, err, 404);
	}
});

// ── pipeline ────────────────────────────────────────────────────────────────
/** Server-sent events, so output appears line by line rather than all at once. */
app.get('/api/games/:id/run/:step', async (req, res) => {
	const config = loadConfig();
	res.set({
		'Content-Type': 'text/event-stream',
		'Cache-Control': 'no-cache',
		Connection: 'keep-alive',
		'X-Accel-Buffering': 'no',
	});
	res.flushHeaders?.();

	const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

	try {
		const game = readGame(config.workspace, req.params.id);
		if (!game.raw) throw new Error('game-spec.yaml could not be parsed');

		const code = await runStep({
			step: req.params.step,
			dir: game.dir,
			config,
			spec: game.raw,
			onLine: (line) => send('line', line),
		});
		send('done', { code });
	} catch (err) {
		send('line', { stream: 'err', text: err.message });
		send('done', { code: 1 });
	}
	res.end();
});

// ── preview ─────────────────────────────────────────────────────────────────
app.post('/api/games/:id/preview/start', (req, res) => {
	try {
		const config = loadConfig();
		const game = readGame(config.workspace, req.params.id);
		res.json(startPreview({ gameName: game.raw.game.name, webSdk: config.webSdk }));
	} catch (err) {
		fail(res, err);
	}
});

app.post('/api/games/:id/preview/stop', (req, res) => {
	try {
		const config = loadConfig();
		const game = readGame(config.workspace, req.params.id);
		res.json(stopPreview(game.raw.game.name));
	} catch (err) {
		fail(res, err);
	}
});

app.get('/api/games/:id/preview', async (req, res) => {
	try {
		const config = loadConfig();
		const game = readGame(config.workspace, req.params.id);
		const state = previewState(game.raw.game.name);
		res.json({ ...state, stories: state.status === 'ready' ? await previewStories(game.raw.game.name) : [] });
	} catch (err) {
		fail(res, err);
	}
});

// ── boot ────────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT ?? 4173);
const server = app.listen(PORT, '127.0.0.1', () => {
	console.log(`\n  stake-forge  →  http://localhost:${PORT}\n`);
	console.log('  Local only. It runs commands and reads/writes files on this machine.\n');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
	process.on(signal, () => {
		stopAllPreviews();
		server.close(() => process.exit(0));
		setTimeout(() => process.exit(0), 2000).unref();
	});
}
