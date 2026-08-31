import fs from 'fs-extra';
import path from 'node:path';

import { buildArtBrief } from './artBrief.js';
import { spineAssetParts } from './atlasParts.js';

/**
 * What the animation team needs, once the PNGs exist.
 *
 * ── The handoff this closes ─────────────────────────────────────────────────
 * Art is made somewhere else and imported. Rigging is done somewhere else too,
 * by people working in Spine. The gap between them is a list of facts that only
 * the game knows, and that are invisible from a folder of PNGs:
 *
 *   - which SKELETON each set of parts belongs to, and what the file must be
 *     called, because the game loads it by that exact key
 *   - the ANIMATION NAMES inside it, because the front end calls them by string
 *     and a rig with the right motion under the wrong name plays nothing
 *   - the AUTHORING CANVAS, because a skeleton rigged at a different size lands
 *     at the wrong scale relative to everything around it
 *   - which animations LOOP and which play once
 *
 * The animation names are the sharp edge. Board.svelte plays `h4` and `h4_static`
 * by literal string; a rig that calls them "win" and "idle" imports cleanly,
 * validates cleanly, and does nothing on screen. That failure costs a day and is
 * completely avoidable by stating the names up front.
 *
 * Every number here is read from the reference app the game is scaffolded from,
 * not chosen — those are the skeletons its code already expects.
 */

/**
 * Animations the front end plays on a loop rather than once.
 *
 * Matched on the END of the name, case-insensitively, against the real state and
 * animation vocabulary rather than a guess at it:
 *
 *   symbols   static, spin, land, win, postWinStatic
 *   screens   idle, dust, glow, intro, outro, *_idle, *_intro, *_exit
 *
 * `postWinStatic` is the case that forced this. It is a resting pose and must
 * loop, but there is no underscore before "Static" — so an `_static` pattern
 * misses it and briefs a held pose as a one-shot, which reads on screen as the
 * symbol snapping back to nothing after a win.
 */
const LOOPING = /(static|idle|loop|dust|glow)$/i;

/** Read the skeleton facts out of a Spine JSON. */
function skeletonFacts(file) {
	try {
		const json = fs.readJsonSync(file);
		const skeleton = json.skeleton ?? {};
		return {
			spineVersion: skeleton.spine ?? null,
			canvas:
				Number.isFinite(skeleton.width) && Number.isFinite(skeleton.height)
					? { width: Math.round(skeleton.width), height: Math.round(skeleton.height) }
					: null,
			animations: Object.keys(json.animations ?? {}),
			bones: (json.bones ?? []).length,
			slots: (json.slots ?? []).length,
		};
	} catch {
		return null;
	}
}

/**
 * One entry per Spine asset this game needs rigged.
 *
 * Symbols are handled separately from screens because their animation names are
 * derived from the SPEC — a symbol's role and behaviours decide which states it
 * needs — whereas a screen's come from the reference skeleton.
 */
export function buildAnimBrief({ spec, referenceAppDir }) {
	const art = buildArtBrief(spec);
	const atlases = referenceAppDir ? spineAssetParts(referenceAppDir) : {};
	const spineDir = referenceAppDir
		? path.join(referenceAppDir, 'static', 'assets', 'spines')
		: null;

	const entries = [];

	// ── symbols ─────────────────────────────────────────────────────────────
	// ONE SELF-CONTAINED BUNDLE PER SYMBOL: h1.json + h1.atlas + its page.
	//
	// The shipped sample points every symbol at one shared symbols.atlas, but
	// nothing requires that — assets.ts declares an atlas and a skeleton path per
	// asset key, and importAssets writes whatever the manifest names. They simply
	// happen to be the same file there.
	//
	// Per-symbol is what Spine exports by default, so it is the delivery that
	// needs no coordination: one symbol can be re-exported and re-delivered
	// without touching the other ten, and nobody has to pack anything.
	//
	// The cost is real but small at this scale: each atlas is a separate texture,
	// so eleven symbols is eleven texture bindings rather than one. Packing them
	// into a shared atlas stays available later as an optimisation, and doing it
	// later does not change what anyone delivers.
	// The reference symbols do NOT share one canvas — measured across the lines
	// sample they run 1072x1076, 1080x1080, 1200x1023, 1225x1242. So reporting any
	// single one of them as "the" canvas would be inventing a requirement.
	//
	// What actually matters is stated instead: pick one canvas and use it for
	// every symbol in the game, because they scale together on the board, and
	// match the aspect of the size they render at. The observed range is given as
	// a sanity check on magnitude, not as a number to copy.
	const symbolRef = spineDir ? path.join(spineDir, 'symbols') : null;
	let symbolFacts = null;
	let canvasRange = null;
	if (symbolRef && fs.existsSync(symbolRef)) {
		const jsons = fs.readdirSync(symbolRef).filter((f) => f.endsWith('.json'));
		const seen = jsons.map((f) => skeletonFacts(path.join(symbolRef, f))).filter(Boolean);
		symbolFacts = seen[0] ?? null;
		const sides = seen.flatMap((f) => (f.canvas ? [f.canvas.width, f.canvas.height] : []));
		if (sides.length) canvasRange = { min: Math.min(...sides), max: Math.max(...sides) };
	}

	for (const symbol of art.symbols) {
		const lower = symbol.name.toLowerCase();

		// ── ONE animation per symbol, not one per state ──────────────────────
		// The first version of this brief asked for a rig per state — static,
		// spin, land, win, postWinStatic — which is five animations a symbol and
		// fifty-five for a game. That is not what the engine plays.
		//
		// Read off the shipped lines app: every symbol's `static`, `spin`, `land`
		// and `postWinStatic` all point at ONE flat sprite (h1Static -> h1.webp),
		// and only `win` is a Spine animation. `explosion` is a single shared rig
		// for the whole game, not one per symbol.
		//
		//   H1: { win: {type:'spine', animationName:'h1'},
		//         static: h1Static, spin: h1Static, land: h1Static,
		//         postWinStatic: h1Static }
		//
		// So the ask is one animation — the one that plays when the symbol takes
		// part in a win — and a flat PNG for everything else. Getting this wrong
		// costs the animation team five times the work for no visible difference.
		const animations = [
			{
				name: lower,
				loops: false,
				why: 'plays when this symbol is part of a win',
			},
		];
		// The states that need no rig at all, so the brief can say so rather than
		// leaving someone to wonder where they went.
		const flatStates = (symbol.states ?? [])
			.map((state) => state.state)
			.filter((state) => state !== 'win');
		entries.push({
			id: `symbol.${symbol.name}`,
			kind: 'symbol',
			skeletonFile: `${lower}.json`,
			atlasFile: `${lower}.atlas`,
			assetKey: 'symbols',
			// Deliberately not a single number — see canvasRange above.
			canvas: null,
			canvasRange,
			spineVersion: symbolFacts?.spineVersion ?? null,
			renderedAt: symbol.size ?? null,
			animations,
			flatStates,
			parts: (atlases.symbols?.parts ?? []).filter((p) =>
				p.name.toLowerCase().startsWith(lower),
			),
			note:
				`Only the win animation is rigged. ${flatStates.join(', ')} all render the flat ` +
				`${lower}.png, so they need no animation. The NAME is a convention, not a ` +
				`requirement: a symbol's track is wired up by name on import, so one animation ` +
				`under any name works — Spine's default "animation" included. What does matter ` +
				`is that there is exactly ONE, because with several nothing can tell which plays ` +
				`on a win.`,
		});
	}

	// ── screens ─────────────────────────────────────────────────────────────
	for (const screen of art.screens) {
		if (screen.assetType !== 'spine') continue;
		const asset = atlases[screen.assetKey];
		const dir = spineDir ? path.join(spineDir, screen.assetKey) : null;
		let facts = null;
		if (dir && fs.existsSync(dir)) {
			const json = fs.readdirSync(dir).find((f) => f.endsWith('.json'));
			if (json) facts = skeletonFacts(path.join(dir, json));
		}

		entries.push({
			id: `screen.${screen.id}`,
			kind: 'screen',
			assetKey: screen.assetKey,
			skeletonFile: asset ? asset.atlas.replace(/\.atlas$/, '.json') : null,
			atlasFile: asset?.atlas ?? null,
			canvas: facts?.canvas ?? null,
			spineVersion: facts?.spineVersion ?? null,
			// The names the component calls, from the art brief, falling back to
			// what the reference skeleton actually contains.
			animations: (screen.animations?.length ? screen.animations : (facts?.animations ?? [])).map(
				(name) => ({ name, loops: LOOPING.test(name), why: screen.component ?? '' }),
			),
			parts: asset?.parts ?? [],
			component: screen.component,
			required: screen.required,
			note: screen.note ?? '',
		});
	}

	const totals = {
		skeletons: entries.length,
		animations: entries.reduce((sum, e) => sum + e.animations.length, 0),
		parts: entries.reduce((sum, e) => sum + (e.parts?.length ?? 0), 0),
	};
	return { game: art.game, entries, totals };
}

/** Markdown, because this leaves the machine and goes to a person. */
export function renderAnimBrief(brief) {
	const out = [];
	out.push(`# Animation brief — ${brief.game.name}`);
	out.push('');
	out.push(
		`${brief.totals.skeletons} skeletons, ${brief.totals.animations} named animations, ` +
			`${brief.totals.parts} attachment parts.`,
	);
	out.push('');
	out.push(
		'**Animation names are literal.** The front end calls each one by string — a rig with the ' +
			'right motion under a different name imports cleanly, validates cleanly, and plays ' +
			'nothing. Match them exactly.',
	);
	out.push('');
	out.push(
		'**Rig at the canvas size given.** A skeleton authored at a different size lands at the ' +
			'wrong scale next to everything around it. Where a screen names an exact canvas, match ' +
			'it — the component positions against that.',
	);
	out.push('');
	out.push(
		'**Symbols are the exception:** the reference set does not share one canvas, so there is no ' +
			'number to copy. Pick one and use it for every symbol in the game — they scale together ' +
			'on the board, so consistency between them matters more than the value.',
	);
	out.push('');
	out.push(
		'**One animation per symbol.** Only the win animation is rigged; the resting, spinning and ' +
			'landing states all render the flat PNG. The shipped sample works exactly this way, and ' +
			'rigging a state that renders a still image is five times the work for no visible ' +
			'difference. The explosion is one shared rig for the whole game, not one per symbol.',
	);
	out.push('');
	out.push(
		'**Each symbol is self-contained** — its own skeleton, its own atlas, its own page, exactly ' +
			'as Spine exports them. Nothing needs packing and nothing needs coordinating: one symbol ' +
			'can be re-exported and re-delivered without touching the others.',
	);
	out.push('');

	// ── how many, per asset, before any detail ──────────────────────────────
	// The question an animation lead asks first is "how much work is this", and
	// the answer was only derivable by counting rows across a dozen sections.
	// Every count here is read from what the components actually call, not from
	// what the sample rigs happen to contain — the shipped anticipation file has
	// sixteen animations and the game plays four of them, so briefing the file
	// would be four times the work for no visible difference.
	out.push('## How many animations');
	out.push('');
	out.push('| Asset | Animations | Names |');
	out.push('|---|---|---|');
	for (const entry of brief.entries) {
		if (!entry.animations.length) continue;
		out.push(
			`| ${entry.id} | **${entry.animations.length}** | ` +
				`${entry.animations.map((a) => `\`${a.name}\``).join(' ')} |`,
		);
	}
	out.push('');
	const symbolCount = brief.entries.filter((e) => e.kind === 'symbol').length;
	const symbolAnims = brief.entries
		.filter((e) => e.kind === 'symbol')
		.reduce((sum, e) => sum + e.animations.length, 0);
	const screenAnims = brief.totals.animations - symbolAnims;
	out.push(
		`**${brief.totals.animations} animations in total** — ${symbolAnims} across ` +
			`${symbolCount} symbols (one each), ${screenAnims} across the screens.`,
	);
	out.push('');

	for (const kind of ['symbol', 'screen']) {
		const group = brief.entries.filter((e) => e.kind === kind);
		if (!group.length) continue;
		out.push('');
		out.push(kind === 'symbol' ? '## Symbols' : '## Screens');
		out.push('');
		for (const entry of group) {
			out.push(`### ${entry.id}`);
			out.push('');
			out.push(`| | |`);
			out.push(`|---|---|`);
			if (entry.skeletonFile) out.push(`| Skeleton file | \`${entry.skeletonFile}\` |`);
			if (entry.atlasFile) out.push(`| Atlas | \`${entry.atlasFile}\` |`);
			if (entry.canvas) {
				out.push(`| **Authoring canvas** | **${entry.canvas.width} × ${entry.canvas.height}** |`);
			} else if (entry.canvasRange) {
				out.push(
					`| Authoring canvas | your choice, but the SAME for every symbol ` +
						`(reference set runs ${entry.canvasRange.min}–${entry.canvasRange.max} per side) |`,
				);
			}
			if (entry.renderedAt) {
				out.push(
					`| Rendered in game at | ${entry.renderedAt.width} × ${entry.renderedAt.height} |`,
				);
			}
			if (entry.spineVersion) out.push(`| Spine version | ${entry.spineVersion} |`);
			if (entry.component) out.push(`| Played by | \`${entry.component}\` |`);
			out.push('');
			if (entry.animations.length) {
				out.push(`**${entry.animations.length} animation(s).**`);
				out.push('');
				out.push('| Animation name | Plays | Why |');
				out.push('|---|---|---|');
				for (const anim of entry.animations) {
					out.push(`| \`${anim.name}\` | ${anim.loops ? 'loops' : 'once'} | ${anim.why ?? ''} |`);
				}
				out.push('');
			}
			if (entry.flatStates?.length) {
				out.push(
					`_No rig needed for ${entry.flatStates.map((s) => `\`${s}\``).join(', ')} — ` +
						`they all render the flat PNG._`,
				);
				out.push('');
			}
			if (entry.parts?.length) {
				out.push(`<details><summary>${entry.parts.length} attachment part(s)</summary>`);
				out.push('');
				out.push('| Part | Size |');
				out.push('|---|---|');
				for (const part of entry.parts) {
					out.push(`| \`${part.name}\` | ${part.width} × ${part.height} |`);
				}
				out.push('');
				out.push('</details>');
				out.push('');
			}
		}
	}
	return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}
