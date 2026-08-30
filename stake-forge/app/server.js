/**
 * stake-forge — local app server.
 *
 * Binds to localhost only. It has full filesystem access to your SDK checkouts
 * and runs commands on your machine, which is exactly what the pipeline needs
 * and exactly why it must never be exposed to a network.
 */

import express from 'express';
import multer from 'multer';
import fs from 'fs-extra';
import YAML from 'yaml';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, saveConfig, validateConfig, guessPaths } from './lib/config.js';
import { listGames, readGame, writeGame, createGame, validateSpecObject, gameDir } from './lib/games.js';
import { STEPS, STEP_ORDER, runStep, auditJson } from './lib/runner.js';
import { startPreview, stopPreview, previewState, previewStories, stopAllPreviews } from './lib/preview.js';
import {
	assetsDir,
	listAssets,
	spineGroups,
	readManifest,
	attachSpine,
	attachSprite,
	attachScreen,
	attachSprite_,
	detachSprite_,
	detachSymbol,
	detachScreen,
	symbolWiring,
	safeName,
	soundsDir,
	listSounds,
	safeSoundName,
} from './lib/assets.js';

import { analyseInspiration } from '../src/lib/inspire.js';
import { BEHAVIOR_RECIPES } from '../src/lib/behaviorRecipes.js';
import { MECHANICS } from '../src/lib/mechanics.js';
import { SCREEN_SLOTS, WIN_LEVEL_ALIASES, WIN_LEVEL_ANIMATIONS, BANNER_WIN_LEVELS } from '../src/lib/screens.js';
import { ROLES, ENGINE_SPECIAL_KEYS, typeRequiredStates, defaultAnimationStates } from '../src/lib/taxonomy.js';
import { VOLATILITY_PROFILES } from '../src/lib/optimisation.js';
import { requiredStatesForSymbol } from '../src/lib/behaviorRecipes.js';
import { INSPIRATION_RULES } from '../src/lib/inspirationRules.js';
import { readSoundsUsed, readSoundVocabulary, readSoundSprite } from '../src/lib/sound.js';
import { loadGameSpec } from '../src/lib/loadSpec.js';
import { buildArtBrief } from '../src/lib/artBrief.js';
import { renderMarkdown, renderCsv, renderManifest } from '../src/commands/brief.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

/**
 * Uploads are buffered in memory and written by the route, so a rejected
 * filename never lands on disk at all. 64MB covers a large spine atlas with
 * room to spare; beyond that the file almost certainly does not belong in a
 * game bundle.
 */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 64 * 1024 * 1024 } });

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
		volatility: VOLATILITY_PROFILES,
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
			advisory: Boolean(STEPS[id].advisory),
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

// ── inspiration ─────────────────────────────────────────────────────────────
/**
 * Map a plain-language feature list onto the taxonomy. Called as you type, so
 * the tier-2/tier-3 split and the inferred mechanic update live.
 *
 * The boundary check runs first and its refusal is returned as a normal error,
 * so the UI can show exactly which field was the problem rather than silently
 * dropping it.
 */
app.post('/api/inspire/analyse', (req, res) => {
	try {
		res.json(analyseInspiration(req.body ?? {}));
	} catch (err) {
		res.status(400).json({ error: err.message });
	}
});

/** Create a game folder from an analysed draft. */
app.post('/api/inspire/create', (req, res) => {
	try {
		const config = loadConfig();
		if (!config.workspace) throw new Error('Set a games folder in Settings first');

		const { id } = req.body ?? {};
		const result = analyseInspiration(req.body ?? {});
		const draft = result.draft;
		draft.game.name = id;
		draft.game.gameId = `0_0_${String(id).replace(/-/g, '_')}`;

		const dir = gameDir(config.workspace, id);
		if (fs.existsSync(path.join(dir, 'game-spec.yaml'))) {
			throw new Error(`A game called "${id}" already exists`);
		}
		fs.ensureDirSync(path.join(dir, 'assets-source'));

		// Keep the report next to the game: it records what was off-the-shelf,
		// what needs custom code, and which lines nothing matched.
		writeGame(config.workspace, id, draft);
		fs.writeFileSync(
			path.join(dir, 'inspiration.yaml'),
			`# What this game was drawn from, in words. No asset, code or bundle from\n` +
				`# another game was read to produce the spec.\n\n` +
				YAML.stringify(
					{
						name: id,
						references: result.references,
						features: result.lines.map((l) => l.text),
					},
					{ lineWidth: 0 },
				),
			'utf8',
		);

		res.json({ id, dir, result });
	} catch (err) {
		fail(res, err);
	}
});

app.get('/api/games/:id', (req, res) => {
	try {
		const config = loadConfig();
		const game = readGame(config.workspace, req.params.id);
		game.preview = previewState(game.raw?.game?.name ?? req.params.id);
		// The same derivation mathGameId uses. Reading game.gameId alone reported
		// every game without an explicit id as un-scaffolded, which blocked the
		// math steps on games that were in fact scaffolded.
		const gameId = game.raw?.game?.gameId ?? game.raw?.game?.name?.replace(/-/g, '_');
		const mathDir = config.mathSdk && gameId ? path.join(config.mathSdk, 'games', gameId) : null;

		game.scaffolded = {
			web: Boolean(
				config.webSdk && game.raw?.game?.name &&
					fs.existsSync(path.join(config.webSdk, 'apps', game.raw.game.name)),
			),
			math: Boolean(mathDir && fs.existsSync(mathDir)),
		};
		// Lookup tables, not books: they are what math:report reads, and both are
		// written by the same run, so their presence is the honest signal that a
		// simulation has actually produced results.
		// Drives the sound:build step's blocked state on the Build tab.
		game.soundCount = listSounds(game.dir).length;
		game.simulated = Boolean(
			mathDir &&
				fs.existsSync(path.join(mathDir, 'library', 'lookup_tables')) &&
				fs.readdirSync(path.join(mathDir, 'library', 'lookup_tables')).some((f) => f.endsWith('.csv')),
		);
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

/**
 * The art brief for a game.
 *
 * The one screen an art studio actually opens first: what to draw, before any
 * art exists. Returns the structured brief plus the rendered Markdown, so the
 * tab can show it and the download button can hand over a file without a
 * second round trip.
 */
app.get('/api/games/:id/brief', (req, res) => {
	try {
		const config = loadConfig();
		const specPath = path.join(gameDir(config.workspace, req.params.id), 'game-spec.yaml');
		const spec = loadGameSpec(specPath);
		const data = buildArtBrief(spec);
		res.json({
			data,
			markdown: renderMarkdown(data),
			csv: renderCsv(data),
			manifest: renderManifest(data),
		});
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

// ── your own assets ─────────────────────────────────────────────────────────
/**
 * Everything in assets-source, classified — and for a spine skeleton, the
 * animation names read out of it, so states can be mapped from a dropdown
 * rather than typed blind.
 */
app.get('/api/games/:id/assets', (req, res) => {
	try {
		const config = loadConfig();
		const dir = gameDir(config.workspace, req.params.id);
		const game = readGame(config.workspace, req.params.id);
		const assets = listAssets(dir);
		const manifest = readManifest(dir);

		const symbols = game.normalised?.symbols ?? [];
		const mechanicId = game.normalised?.mechanic?.id;
		const artStates = mechanicId ? defaultAnimationStates({ mechanic: mechanicId }) : [];

		res.json({
			assets: assets.map((a) => ({
				...a,
				url: a.kind === 'image' ? `/api/games/${req.params.id}/art/${encodeURIComponent(a.file)}` : null,
			})),
			groups: spineGroups(assets),
			manifest,
			wiring: symbolWiring({
				manifest,
				symbols,
				requiredStatesFor: (symbol) => [...requiredStatesForSymbol(symbol, artStates).keys()],
			}),
			namedSprites: Object.entries(manifest.sprites ?? {}).map(([key, file]) => ({ key, file })),
			screenSlots: Object.entries(SCREEN_SLOTS)
				.filter(([, slot]) => !slot.onlyMechanics || slot.onlyMechanics.includes(mechanicId))
				.map(([slotId, slot]) => ({ slotId, ...slot, supplied: manifest.screens?.[slotId] ?? null })),
		});
	} catch (err) {
		fail(res, err);
	}
});

app.post('/api/games/:id/assets/upload', upload.array('files', 200), (req, res) => {
	try {
		const config = loadConfig();
		const dir = assetsDir(gameDir(config.workspace, req.params.id));
		fs.ensureDirSync(dir);

		const written = [];
		const rejected = [];
		for (const file of req.files ?? []) {
			try {
				const name = safeName(file.originalname);
				fs.writeFileSync(path.join(dir, name), file.buffer);
				written.push(name);
			} catch (err) {
				rejected.push({ file: file.originalname, reason: err.message });
			}
		}
		res.json({ written, rejected, assets: listAssets(gameDir(config.workspace, req.params.id)) });
	} catch (err) {
		fail(res, err);
	}
});

// ── sounds ──────────────────────────────────────────────────────────────────
// Audio is not wired per-symbol like art is: the filename is the sound name,
// and the whole folder is built into one sprite by `forge sound:build`.
app.get('/api/games/:id/sounds', (req, res) => {
	try {
		const config = loadConfig();
		const dir = gameDir(config.workspace, req.params.id);
		const game = readGame(config.workspace, req.params.id);
		const appDir =
			config.webSdk && game.raw?.game?.name
				? path.join(config.webSdk, 'apps', game.raw.game.name)
				: null;

		// What the game's own code plays, so an uploaded folder can be checked
		// against it right here rather than after a build.
		const played = appDir && fs.existsSync(appDir) ? [...readSoundsUsed(appDir).keys()].sort() : [];
		const vocabulary = appDir && fs.existsSync(appDir) ? readSoundVocabulary(appDir) : { music: [], effects: [] };
		const sounds = listSounds(dir);
		const supplied = new Set(sounds.map((s) => s.name));
		const allowed = new Set([...vocabulary.music, ...vocabulary.effects]);

		res.json({
			sounds,
			played,
			// The finding that matters: played by the game, absent from the folder.
			// It is silent at runtime with no error at all.
			missing: played.filter((n) => allowed.has(n) && !supplied.has(n)),
			unknown: sounds.filter((s) => allowed.size && !allowed.has(s.name)).map((s) => s.name),
			unused: sounds.filter((s) => !played.includes(s.name)).map((s) => s.name),
			vocabulary: [...allowed].sort(),
			sprite: appDir && fs.existsSync(appDir) ? readSoundSprite(appDir) : { found: false },
		});
	} catch (err) {
		fail(res, err);
	}
});

app.post('/api/games/:id/sounds/upload', upload.array('files', 400), (req, res) => {
	try {
		const config = loadConfig();
		const dir = soundsDir(gameDir(config.workspace, req.params.id));
		fs.ensureDirSync(dir);

		const written = [];
		const rejected = [];
		for (const file of req.files ?? []) {
			try {
				const name = safeSoundName(file.originalname);
				fs.writeFileSync(path.join(dir, name), file.buffer);
				written.push(name);
			} catch (err) {
				rejected.push({ file: file.originalname, reason: err.message });
			}
		}
		res.json({ written, rejected, sounds: listSounds(gameDir(config.workspace, req.params.id)) });
	} catch (err) {
		fail(res, err);
	}
});

app.delete('/api/games/:id/sounds/:file', (req, res) => {
	try {
		const config = loadConfig();
		const dir = soundsDir(gameDir(config.workspace, req.params.id));
		fs.removeSync(path.join(dir, safeSoundName(req.params.file)));
		res.json({ sounds: listSounds(gameDir(config.workspace, req.params.id)) });
	} catch (err) {
		fail(res, err);
	}
});

app.delete('/api/games/:id/assets/:file', (req, res) => {
	try {
		const config = loadConfig();
		const dir = assetsDir(gameDir(config.workspace, req.params.id));
		const name = safeName(req.params.file);
		fs.removeSync(path.join(dir, name));
		res.json({ removed: name });
	} catch (err) {
		fail(res, err);
	}
});

/** Attach a spine export or a flat image to a symbol, replacing what it had. */
app.post('/api/games/:id/assets/attach', (req, res) => {
	try {
		const config = loadConfig();
		const dir = gameDir(config.workspace, req.params.id);
		const { symbol, slotId, kind, ...rest } = req.body ?? {};

		if (kind === 'named') {
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(rest.key ?? '')) {
				throw new Error('Asset key must be a plain identifier, e.g. logo or popup_bg');
			}
			res.json({ manifest: attachSprite_(dir, rest.key, rest.file) });
			return;
		}
		if (slotId) {
			res.json({ manifest: attachScreen(dir, slotId, rest.entry) });
			return;
		}
		if (!symbol) throw new Error('symbol or slotId is required');

		const manifest =
			kind === 'spine' ? attachSpine(dir, symbol, rest) : attachSprite(dir, symbol, rest);
		res.json({ manifest });
	} catch (err) {
		fail(res, err);
	}
});

app.post('/api/games/:id/assets/detach', (req, res) => {
	try {
		const config = loadConfig();
		const dir = gameDir(config.workspace, req.params.id);
		const { symbol, slotId, key } = req.body ?? {};
		if (key) return res.json({ manifest: detachSprite_(dir, key) });
		res.json({ manifest: slotId ? detachScreen(dir, slotId) : detachSymbol(dir, symbol) });
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
app.post('/api/games/:id/preview/start', async (req, res) => {
	try {
		const config = loadConfig();
		const game = readGame(config.workspace, req.params.id);
		res.json(await startPreview({ gameName: game.raw.game.name, webSdk: config.webSdk }));
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
