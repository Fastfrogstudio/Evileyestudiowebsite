import fs from 'fs-extra';
import YAML from 'yaml';

import { spineAssetParts } from './atlasParts.js';
import { buildArtBrief } from './artBrief.js';

/**
 * Turn a game spec plus a house style into one prompt per asset PART.
 *
 * ── The workflow this serves ────────────────────────────────────────────────
 * Write a style guide once, generate candidates, keep the ones that work, and
 * let those keepers anchor the style of everything generated afterwards. The
 * part nobody wants to do by hand is the middle: knowing that THIS game needs a
 * 404x219 mine cart and a 17x17 particle and eleven 200x200 symbols, and that
 * the win banners depend on the max win.
 *
 * forge already derives all of that. `buildArtBrief` knows the symbols, states,
 * screens and banner bands for the spec; `spineAssetParts` reads the exact layer
 * list out of the reference app's atlases. This joins them to a style guide and
 * emits prompts.
 *
 * ── One thing this deliberately will not do ─────────────────────────────────
 * The guide is a plain-language description of a look. It is not a place to put
 * another studio's assets, screenshots, sprite sheets or extracted bundles, and
 * `references` accepts only images generated for THIS project. That line is the
 * same one inspirationRules.js holds for mechanics, for the same reason: a
 * description of a style is yours to write, and a file taken out of someone's
 * shipped game is not yours to feed anywhere.
 */

/** The style guide, as YAML. Everything is optional except `style.summary`. */
export const ART_GUIDE_TEMPLATE = `# art-guide.yaml — the look, once, for every asset in this game.
#
# This is a DESCRIPTION, not a collection. Do not paste another studio's
# screenshots, sprite sheets or extracted files in here or under references/ —
# describe what you want in your own words and generate it.

style:
  # The one line every prompt inherits. Be concrete about place, era and light.
  summary: A Victorian mining town at night, lit by purple crystal glow

  # Rendering, not subject. This is what keeps eleven symbols looking related.
  rendering: painterly digital illustration, soft edges, strong rim light, subtle grain

  palette:
    - deep indigo shadows
    - amethyst purple glow
    - warm brass highlights

  mood: mysterious but inviting, not grim

  # Anything the model reliably gets wrong for you.
  avoid:
    - text or lettering
    - photorealism
    - harsh black outlines

# Confirmed assets that anchor the style of everything generated after them.
# Paths are relative to this file. These must be images generated for THIS
# project — see the note at the top.
references: []

# Optional per-asset-type overrides, merged over the base style.
overrides:
  symbols:
    rendering: painterly digital illustration, crisp silhouette readable at 200px
  background:
    mood: atmospheric and deep, the board must stay readable on top of it
`;

export function loadArtGuide(file) {
	if (!fs.existsSync(file)) return null;
	const guide = YAML.parse(fs.readFileSync(file, 'utf8')) ?? {};
	if (!guide.style?.summary) {
		throw new Error(
			`${file} has no style.summary — that one line is what every prompt inherits, so a guide ` +
				`without it produces eleven unrelated pictures.`,
		);
	}
	return guide;
}

/** Merge the base style with a per-type override. */
function styleFor(guide, type) {
	return { ...(guide.style ?? {}), ...(guide.overrides?.[type] ?? {}) };
}

/**
 * Compose one prompt.
 *
 * Order matters and is not arbitrary: subject first, because models weight early
 * tokens most heavily and the subject is the only part that differs between
 * assets; then style, which is identical across the set and is what makes them
 * look like one game; then the technical constraints.
 */
function composePrompt({ subject, style, technical }) {
	const parts = [subject, style.summary, style.rendering];
	if (style.palette?.length) parts.push(`palette: ${style.palette.join(', ')}`);
	if (style.mood) parts.push(style.mood);
	parts.push(...technical);
	const prompt = parts.filter(Boolean).join('. ');
	return style.avoid?.length ? { prompt, negative: style.avoid.join(', ') } : { prompt };
}

/**
 * Technical constraints per asset kind.
 *
 * ── Why these ask for WHITE, not transparency ───────────────────────────────
 * The game needs transparency: everything except the full-bleed backdrop is
 * composited over something else by Spine, and a symbol on an opaque square
 * tiles the reel with rectangles. So the obvious prompt is "transparent
 * background" — and it is the wrong one. Image models return an opaque picture
 * whatever you ask for, and asking for transparency gets you a checkerboard
 * PAINTED INTO the art, which is worse than a plain ground because it cannot be
 * removed.
 *
 * A plain white ground is the one thing they do reliably, and `art:import` cuts
 * it out on the way in — flood filled from the frame edge, so a near-white
 * specular inside the subject survives. The prompt therefore asks for what the
 * model can actually deliver, and the pipeline supplies the alpha.
 *
 * The plain ground has to be stated explicitly rather than left unsaid: an
 * unprompted background is a scene, and a scene cannot be cut out at all.
 */
function technicalFor(kind, { width, height }) {
	const size = `exactly ${width}x${height} pixels`;
	// Said the same way every time. The cutout keys off a uniform, near-white
	// border, so "white background" is a technical requirement here rather than
	// an aesthetic preference, and any drift in how it is phrased shows up as an
	// asset that cannot be cut out.
	const isolated = 'isolated on a plain pure white background, no scene, no ground shadow, no vignette';
	switch (kind) {
		case 'symbol':
			return [
				size,
				isolated,
				'single centred object, fully inside the frame with a small even margin',
				'readable as a silhouette at a third of this size',
			];
		case 'backdrop':
			return [size, 'full-bleed illustration, no transparency, no border', 'nothing important in the centre third, the reels sit there'];
		case 'layer':
			return [size, isolated, 'one isolated element, no scene around it'];
		case 'banner':
			return [size, isolated, 'centred, with room around it for a number to be drawn on top'];
		default:
			return [size, isolated];
	}
}

/**
 * Which atlas parts are a full-bleed backdrop rather than a floating layer.
 *
 * A backdrop fills most of its page and must NOT be transparent; a layer is a
 * prop that sits on top and must be. Guessing wrong either way produces an
 * unusable asset, so it is decided by area rather than by name — a part covering
 * most of the page is the backdrop whatever it happens to be called.
 */
function isBackdrop(part, parts) {
	const largest = Math.max(...parts.map((p) => p.width * p.height));
	return part.width * part.height >= largest * 0.9 && part.width * part.height > 500_000;
}

/**
 * Build the full generation manifest.
 *
 * Provider-agnostic on purpose. It emits subject, prompt, negative prompt and
 * exact dimensions; whichever model you point at it is a detail of the adapter,
 * not of the brief. That also means a model change does not invalidate the
 * manifest.
 */
export function buildGenerationManifest({ spec, guide, referenceAppDir, assetKeys = null }) {
	const brief = buildArtBrief(spec);
	const atlases = referenceAppDir ? spineAssetParts(referenceAppDir) : {};
	const jobs = [];

	// ── symbols ─────────────────────────────────────────────────────────────
	const symbolStyle = styleFor(guide, 'symbols');
	for (const symbol of brief.symbols) {
		const { width, height } = symbol.size ?? { width: 200, height: 200 };
		const described = guide.symbols?.[symbol.name];
		jobs.push({
			id: `symbol.${symbol.name}`,
			kind: 'symbol',
			assetKey: 'symbols',
			partName: symbol.name.toLowerCase(),
			width,
			height,
			// A symbol with no description in the guide still gets a prompt, but a
			// generic one — flagged so it is obvious which ones need a line written.
			described: Boolean(described),
			...composePrompt({
				subject: described ?? `a ${symbol.label ?? symbol.role} slot symbol for "${symbol.name}"`,
				style: symbolStyle,
				technical: technicalFor('symbol', { width, height }),
			}),
			states: (symbol.states ?? []).map((s) => s.state),
			outputPath: `assets-source/symbols/${symbol.name.toLowerCase()}.png`,
		});
	}

	// ── screens, layer by layer ─────────────────────────────────────────────
	for (const screen of brief.screens) {
		if (screen.assetType !== 'spine') continue;
		const asset = atlases[screen.assetKey];
		if (assetKeys && !assetKeys.includes(screen.assetKey)) continue;
		if (!asset) {
			// No reference atlas means no part list, and inventing one would brief art
			// that fits nothing. Recorded so the gap is visible rather than silent.
			jobs.push({
				id: `screen.${screen.id}`,
				kind: 'unknown',
				assetKey: screen.assetKey,
				skipped: `no atlas for "${screen.assetKey}" in the reference app — its layer list is unknown`,
			});
			continue;
		}

		const screenStyle = styleFor(guide, screen.id.startsWith('background') ? 'background' : screen.assetKey);
		for (const part of asset.parts) {
			const backdrop = isBackdrop(part, asset.parts);
			const described = guide.parts?.[`${screen.assetKey}.${part.name}`];
			jobs.push({
				id: `screen.${screen.id}.${part.name}`,
				kind: backdrop ? 'backdrop' : 'layer',
				assetKey: screen.assetKey,
				partName: part.name,
				width: part.width,
				height: part.height,
				described: Boolean(described),
				...composePrompt({
					subject:
						described ??
						(backdrop
							? `the main backdrop for ${screen.id.replace('.', ' ')}`
							: `an isolated "${part.name.replace(/[_-]+/g, ' ')}" element`),
					style: screenStyle,
					technical: technicalFor(backdrop ? 'backdrop' : 'layer', part),
				}),
				animations: screen.animations ?? [],
				outputPath: `assets-source/${screen.assetKey}/${part.name}.png`,
			});
		}
	}

	return {
		game: brief.game,
		guide: { summary: guide.style?.summary ?? null, references: guide.references ?? [] },
		jobs,
		totals: {
			jobs: jobs.filter((j) => !j.skipped).length,
			described: jobs.filter((j) => j.described).length,
			skipped: jobs.filter((j) => j.skipped).length,
		},
	};
}
