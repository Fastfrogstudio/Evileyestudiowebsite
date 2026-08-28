/**
 * Asset uploads and manifest wiring.
 *
 * The job here is to get from "I have a spine export" to "the game plays it"
 * without anyone hand-writing YAML. Two things make that possible:
 *
 *  1. A spine skeleton JSON carries its animation names at the top level (an
 *     `animations` object). So instead of typing animation names blind and
 *     finding out at runtime, the UI reads them out of YOUR export and offers
 *     them per state.
 *  2. Symbol art comes in two shapes — a spine group (atlas + image + skeleton)
 *     or a flat sprite — and the manifest already distinguishes them. Replacing
 *     placeholder art is therefore a migration between those two, which is
 *     mechanical enough to do properly rather than leaving to a hand edit.
 */

import fs from 'fs-extra';
import path from 'node:path';
import YAML from 'yaml';

const IMAGE = /\.(png|webp|jpg|jpeg|gif|avif)$/i;
const SKELETON_JSON = /\.json$/i;
const SKELETON_BINARY = /\.(skel|bin)$/i;
const ATLAS = /\.atlas(\.txt)?$/i;

/** Anything we will accept into assets-source. */
export const ACCEPTED = /\.(png|webp|jpg|jpeg|gif|avif|atlas|json|skel|bin|txt)$/i;

export function assetsDir(gameDir) {
	return path.join(gameDir, 'assets-source');
}

/**
 * Classify a file and, for a spine skeleton, read its animation names.
 *
 * A skeleton and a sprite-atlas descriptor are both .json, so they are told
 * apart by content: a skeleton has top-level `bones` and `animations`.
 */
export function describeFile(dir, file) {
	const full = path.join(dir, file);
	const stat = fs.statSync(full);
	const base = { file, size: stat.size, modified: stat.mtimeMs };

	if (ATLAS.test(file)) {
		// The first non-empty line of an atlas names the image it needs.
		let image = null;
		try {
			const lines = fs.readFileSync(full, 'utf8').split('\n').map((l) => l.trim());
			image = lines.find((l) => l && IMAGE.test(l)) ?? null;
		} catch {
			image = null;
		}
		return { ...base, kind: 'atlas', image };
	}

	if (IMAGE.test(file)) return { ...base, kind: 'image' };

	if (SKELETON_BINARY.test(file)) {
		return {
			...base,
			kind: 'skeleton',
			binary: true,
			animations: [],
			note: 'binary skeleton — animation names cannot be read, type them by hand',
		};
	}

	if (SKELETON_JSON.test(file)) {
		try {
			const data = JSON.parse(fs.readFileSync(full, 'utf8'));
			if (data && typeof data === 'object' && data.animations && data.bones) {
				return {
					...base,
					kind: 'skeleton',
					binary: false,
					animations: Object.keys(data.animations),
					spineVersion: data.skeleton?.spine ?? null,
				};
			}
			// A sprite-atlas descriptor (the `sprites` asset type) rather than a skeleton.
			if (data?.frames || data?.textures) return { ...base, kind: 'spriteAtlas' };
			return { ...base, kind: 'json' };
		} catch (err) {
			return { ...base, kind: 'json', error: `could not parse: ${err.message}` };
		}
	}

	return { ...base, kind: 'other' };
}

export function listAssets(gameDir) {
	const dir = assetsDir(gameDir);
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir, { withFileTypes: true })
		.filter((e) => e.isFile() && !e.name.startsWith('.'))
		.map((e) => describeFile(dir, e.name))
		.sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * Group uploaded files into plausible spine sets, so a three-file export can be
 * attached to a symbol in one action rather than three.
 *
 * Grouping is by atlas: an atlas names its image, and every skeleton sitting
 * beside it is a candidate. Studios commonly export one shared atlas for all
 * symbols with a skeleton each, which is exactly this shape.
 */
export function spineGroups(assets) {
	const atlases = assets.filter((a) => a.kind === 'atlas');
	const skeletons = assets.filter((a) => a.kind === 'skeleton');
	const images = assets.filter((a) => a.kind === 'image');

	return atlases.map((atlas) => ({
		atlas: atlas.file,
		image: images.find((i) => i.file === atlas.image)?.file ?? atlas.image ?? null,
		imageMissing: Boolean(atlas.image) && !images.some((i) => i.file === atlas.image),
		skeletons: skeletons.map((s) => ({
			file: s.file,
			animations: s.animations,
			binary: s.binary,
		})),
	}));
}

// ── manifest ────────────────────────────────────────────────────────────────

export function manifestPath(gameDir) {
	return path.join(gameDir, 'assets-manifest.yaml');
}

export function readManifest(gameDir) {
	const file = manifestPath(gameDir);
	if (!fs.existsSync(file)) return { assetsSourceDir: './assets-source' };
	return YAML.parse(fs.readFileSync(file, 'utf8')) ?? { assetsSourceDir: './assets-source' };
}

export function writeManifest(gameDir, manifest) {
	const header =
		`# assets-manifest.yaml — which of your files map to which symbol state.\n` +
		`#\n` +
		`# spriteSymbols entries are flat images (a placeholder tile, or art that\n` +
		`# never animates). spineSymbols entries are real spine exports. A symbol\n` +
		`# belongs to exactly one of them — listing it in both would register two\n` +
		`# assets under the same key.\n\n`;
	fs.writeFileSync(manifestPath(gameDir), header + YAML.stringify(manifest, { lineWidth: 0 }), 'utf8');
	return manifest;
}

/**
 * Attach a spine export to a symbol, replacing whatever it had.
 *
 * Removing the spriteSymbols entry is the important half: loadAssetsManifest
 * refuses a symbol present in both, so a half-finished migration fails loudly
 * instead of registering conflicting assets.
 */
export function attachSpine(gameDir, symbol, { atlas, png, skeleton, animations }) {
	const manifest = readManifest(gameDir);
	manifest.spineSymbols ??= {};
	manifest.spineSymbols[symbol] = {
		atlas,
		png,
		skeleton,
		...(animations && Object.keys(animations).length ? { animations } : {}),
	};

	if (manifest.spriteSymbols?.[symbol]) delete manifest.spriteSymbols[symbol];
	if (manifest.spriteSymbols && !Object.keys(manifest.spriteSymbols).length) {
		delete manifest.spriteSymbols;
	}

	return writeManifest(gameDir, manifest);
}

/** Attach a flat image to a symbol, with optional per-state overrides. */
export function attachSprite(gameDir, symbol, { sprite, states }) {
	const manifest = readManifest(gameDir);
	manifest.spriteSymbols ??= {};
	manifest.spriteSymbols[symbol] = {
		sprite,
		...(states && Object.keys(states).length ? { states } : {}),
	};

	if (manifest.spineSymbols?.[symbol]) delete manifest.spineSymbols[symbol];
	if (manifest.spineSymbols && !Object.keys(manifest.spineSymbols).length) {
		delete manifest.spineSymbols;
	}

	return writeManifest(gameDir, manifest);
}

/** Attach a spine or image to a screen slot. */
export function attachScreen(gameDir, slotId, entry) {
	const manifest = readManifest(gameDir);
	manifest.screens ??= {};
	manifest.screens[slotId] = entry;
	return writeManifest(gameDir, manifest);
}

export function detachSymbol(gameDir, symbol) {
	const manifest = readManifest(gameDir);
	for (const key of ['spineSymbols', 'spriteSymbols']) {
		if (manifest[key]?.[symbol]) delete manifest[key][symbol];
		if (manifest[key] && !Object.keys(manifest[key]).length) delete manifest[key];
	}
	return writeManifest(gameDir, manifest);
}

/**
 * Register an image under an arbitrary asset key.
 *
 * The `sprites:` block exists for everything the sample apps have no slot for —
 * chrome, pop-up art, alternate variants of a symbol. `assets:import` registers
 * each as `{ type: 'sprite', src }`, so a component can look it up with
 * `<Sprite key="..." />`. Nothing renders it automatically: that part is a
 * component edit, and the UI says so rather than implying otherwise.
 */
export function attachSprite_(gameDir, key, file) {
	const manifest = readManifest(gameDir);
	manifest.sprites ??= {};
	manifest.sprites[key] = file;
	return writeManifest(gameDir, manifest);
}

export function detachSprite_(gameDir, key) {
	const manifest = readManifest(gameDir);
	if (manifest.sprites?.[key]) delete manifest.sprites[key];
	if (manifest.sprites && !Object.keys(manifest.sprites).length) delete manifest.sprites;
	return writeManifest(gameDir, manifest);
}

export function detachScreen(gameDir, slotId) {
	const manifest = readManifest(gameDir);
	if (manifest.screens?.[slotId]) delete manifest.screens[slotId];
	if (manifest.screens && !Object.keys(manifest.screens).length) delete manifest.screens;
	return writeManifest(gameDir, manifest);
}

/**
 * How each symbol is currently supplied, plus the states it needs. This is what
 * the UI renders: one row per symbol, showing whether it is still on a
 * placeholder and which states are unmapped.
 */
export function symbolWiring({ manifest, symbols, requiredStatesFor }) {
	return symbols.map((symbol) => {
		const spine = manifest.spineSymbols?.[symbol.name];
		const sprite = manifest.spriteSymbols?.[symbol.name];
		const required = requiredStatesFor(symbol);

		if (spine) {
			const mapped = spine.animations ?? (spine.animationName ? { win: spine.animationName } : {});

			// A state with no animation of its own is not necessarily a problem:
			// assets:import points it at the static pose, which is exactly how the
			// sample apps handle the non-animated states — apps/lines aims
			// static/spin/land/postWinStatic at one sprite and only `win` at a spine.
			//
			// So there are three outcomes, and conflating them is what made a
			// perfectly good two-animation export look broken:
			//   mapped      — has its own animation
			//   fallback    — will show the static pose, which is fine for a base
			//                 state and NOT fine for one a behavior added, because
			//                 the feature then never visibly fires
			//   unmapped    — nothing to fall back to either
			const hasStatic = Boolean(mapped.static || spine.staticSprite);
			const missing = required.filter((s) => !mapped[s]);

			return {
				symbol: symbol.name,
				role: symbol.role,
				behaviors: symbol.behaviors,
				kind: 'spine',
				source: spine,
				required,
				mapped,
				fallback: hasStatic ? missing.filter((s) => BASE_STATES.includes(s)) : [],
				// A behavior state silently showing the static pose is a real gap:
				// the expanding wild would expand with no animation at all.
				inert: missing.filter((s) => !BASE_STATES.includes(s)),
				unmapped: hasStatic ? missing.filter((s) => !BASE_STATES.includes(s)) : missing,
			};
		}

		if (sprite) {
			return {
				symbol: symbol.name,
				role: symbol.role,
				behaviors: symbol.behaviors,
				kind: 'sprite',
				source: sprite,
				required,
				mapped: sprite.states ?? {},
				fallback: [],
				inert: [],
				unmapped: [],
				placeholder: true,
			};
		}

		return {
			symbol: symbol.name,
			role: symbol.role,
			behaviors: symbol.behaviors,
			kind: 'none',
			required,
			mapped: {},
			fallback: [],
			inert: [],
			unmapped: required,
		};
	});
}

/** States the web-sdk's SymbolState union defines for every game. */
const BASE_STATES = ['static', 'spin', 'land', 'win', 'postWinStatic', 'explosion'];

/** Reject a filename that could escape assets-source. */
export function safeName(name) {
	const base = path.basename(String(name));
	if (!base || base.startsWith('.') || base !== name) {
		throw new Error(`Unsafe filename: ${name}`);
	}
	if (!ACCEPTED.test(base)) {
		throw new Error(`${base} is not a file type this accepts (images, .atlas, .json, .skel)`);
	}
	return base;
}
