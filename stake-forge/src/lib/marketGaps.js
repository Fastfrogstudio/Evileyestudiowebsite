/**
 * Where the market is crowded, where it is thin, and which of the thin places
 * we can actually build.
 *
 * ── The join that makes this useful ─────────────────────────────────────────
 * A gap nobody can build is not an opportunity, it is a reason. So every finding
 * here crosses the reference corpus with MECHANIC_LIBRARY status: a mechanic
 * that is rare in the market AND `built` in the tool is a game we could ship
 * next week; one that is rare and `blocked` is rare for a reason worth reading
 * before spending a quarter on it.
 *
 * ── What this is not ────────────────────────────────────────────────────────
 * Forty games is a reading list, not a census. There is no play or revenue data
 * behind any of it — the corpus is titles somebody thought worth recording, so
 * it is biased toward what gets written about. Treat everything here as a
 * prompt for a decision, never as evidence of demand. `sample` is reported on
 * every result so a two-game "trend" cannot be mistaken for one.
 */

import { REFERENCE_GAMES } from './referenceGames.js';
import { MECHANIC_LIBRARY } from './mechanicsLibrary.js';

/** Statuses we could actually ship a game on today. */
const BUILDABLE = new Set(['built', 'config']);

/**
 * Entries that are not a game's IDEA and so cannot be a market gap.
 *
 * Win types are the board, not a feature. `wincap` is in every game ever made.
 * `multiplier_composition` is a rule about how two numbers combine. Buy menus
 * are commercial packaging. Left in the demand table, where the counts are
 * honest, and kept out of the opportunity list, where a zero would read as
 * "nobody has done this" instead of "nobody would tag this".
 */
const STRUCTURAL = new Set([
	'lines_pays',
	'ways_pays',
	'cluster_pays',
	'scatter_pays',
	'wincap',
	'multiplier_composition',
	'buy_bonus',
	'ante_bet',
	'tiered_buy_menu',
	'freespins',
]);

/**
 * Per mechanic: how much of the corpus uses it, and whether we can build it.
 */
export function mechanicDemand({ games = REFERENCE_GAMES, library = MECHANIC_LIBRARY } = {}) {
	const all = Object.values(games);
	const counts = new Map();
	for (const game of all) {
		for (const id of game.mechanics ?? []) {
			counts.set(id, (counts.get(id) ?? 0) + 1);
		}
	}

	return Object.keys(library)
		.map((id) => {
			const used = counts.get(id) ?? 0;
			const entry = library[id];
			return {
				id,
				name: entry.name ?? id,
				used,
				share: all.length ? used / all.length : 0,
				status: entry.status,
				buildable: BUILDABLE.has(entry.status),
				trademark: entry.trademark?.owner ?? null,
			};
		})
		.sort((a, b) => b.used - a.used || a.id.localeCompare(b.id));
}

/**
 * The shortlist: mechanics we can build that the corpus barely uses.
 *
 * `rareBelow` is a SHARE, not a count, so the threshold keeps meaning as the
 * corpus grows. Trademarked mechanics are excluded outright — the name is not
 * ours to ship, and in at least one case neither is the mechanic.
 */
export function opportunities({ rareBelow = 0.1, ...opts } = {}) {
	const all = Object.values(opts.games ?? REFERENCE_GAMES);
	return mechanicDemand(opts)
		.filter((m) => m.buildable && !m.trademark && !STRUCTURAL.has(m.id) && m.share < rareBelow)
		.map((m) => ({
			...m,
			// A zero in a 40-game hand-tagged corpus means "we have not recorded a
			// game using this", which is a statement about the corpus. Saying so is
			// the difference between a prompt and a false finding.
			evidence: m.used === 0 ? 'absent-from-corpus' : 'rare-in-corpus',
			sample: all.length,
		}))
		.sort((a, b) => a.share - b.share || a.id.localeCompare(b.id));
}

/** The opposite: what we would be walking into a crowd to build. */
export function crowded({ commonAbove = 0.25, ...opts } = {}) {
	return mechanicDemand(opts).filter((m) => m.share >= commonAbove);
}

/**
 * Density by win type and max-win band — the shape of the market, not its
 * mechanics. Games with no recorded cap are counted separately rather than
 * dropped, because "unrecorded" is a different thing from "small".
 */
export const MAX_WIN_BANDS = [
	{ id: 'under_5k', label: 'under 5,000x', min: 0, max: 5000 },
	{ id: '5k_20k', label: '5,000x - 20,000x', min: 5000, max: 20000 },
	{ id: '20k_60k', label: '20,000x - 60,000x', min: 20000, max: 60000 },
	{ id: 'over_60k', label: 'over 60,000x', min: 60000, max: Infinity },
];

export function densityGrid({ games = REFERENCE_GAMES } = {}) {
	const all = Object.values(games);
	const winTypes = [...new Set(all.map((g) => g.winType))].sort();
	const grid = {};
	let unrecorded = 0;

	for (const winType of winTypes) {
		grid[winType] = Object.fromEntries(MAX_WIN_BANDS.map((b) => [b.id, 0]));
	}
	for (const game of all) {
		if (typeof game.maxWin !== 'number') {
			unrecorded += 1;
			continue;
		}
		const band = MAX_WIN_BANDS.find((b) => game.maxWin >= b.min && game.maxWin < b.max);
		if (band) grid[game.winType][band.id] += 1;
	}

	return { grid, winTypes, bands: MAX_WIN_BANDS, sample: all.length, unrecorded };
}

/**
 * Combinations, not single mechanics — because a game is a pairing and the
 * interesting question is which pairings nobody has shipped. Only pairs where
 * BOTH halves are buildable and untrademarked are returned; the rest are noise.
 */
export function pairGaps({ games = REFERENCE_GAMES, library = MECHANIC_LIBRARY } = {}) {
	const all = Object.values(games);
	const shippable = Object.keys(library).filter(
		(id) => BUILDABLE.has(library[id].status) && !library[id].trademark,
	);

	const seen = new Set();
	for (const game of all) {
		const ids = (game.mechanics ?? []).filter((id) => shippable.includes(id)).sort();
		for (let i = 0; i < ids.length; i += 1) {
			for (let j = i + 1; j < ids.length; j += 1) seen.add(`${ids[i]}+${ids[j]}`);
		}
	}

	const gaps = [];
	for (let i = 0; i < shippable.length; i += 1) {
		for (let j = i + 1; j < shippable.length; j += 1) {
			const [a, b] = [shippable[i], shippable[j]].sort();
			const key = `${a}+${b}`;
			if (seen.has(key)) continue;
			// A pair the library says cannot coexist is not a market gap.
			const conflicts = (library[a].conflictsWith ?? []).some((c) => (c.id ?? c) === b);
			if (conflicts) continue;
			gaps.push({ pair: [a, b], names: [library[a].name ?? a, library[b].name ?? b] });
		}
	}
	return { gaps, shippable: shippable.length, sample: all.length, seenPairs: seen.size };
}

/**
 * Board shapes, by win type — the sizing half of the reference corpus.
 *
 * Only games with a RECORDED grid count. A win type with one recorded board is
 * not a convention, so `sample` travels with every row and callers are expected
 * to say so rather than presenting n=1 as "the standard".
 */
export function gridConventions({ games = REFERENCE_GAMES } = {}) {
	const byType = {};
	for (const game of Object.values(games)) {
		if (!game.grid) continue;
		const key = `${game.grid.reels}x${game.grid.rows}`;
		byType[game.winType] ??= { shapes: {}, sample: 0 };
		byType[game.winType].shapes[key] = (byType[game.winType].shapes[key] ?? 0) + 1;
		byType[game.winType].sample += 1;
	}

	return Object.fromEntries(
		Object.entries(byType).map(([winType, { shapes, sample }]) => {
			const ranked = Object.entries(shapes).sort((a, b) => b[1] - a[1]);
			return [
				winType,
				{
					shapes: ranked.map(([shape, count]) => ({ shape, count })),
					typical: ranked[0]?.[0] ?? null,
					sample,
					// One game is an example. Say which it is.
					confident: sample >= 3,
				},
			];
		}),
	);
}

/**
 * Is this spec's board an unusual shape for its win type?
 *
 * Cluster pays on a 5x3 is the case worth catching: the mechanic needs room for
 * five adjacent symbols to form, and every cluster game with a recorded grid
 * here is 7x7. Returns null when there is not enough recorded evidence to say
 * anything, which is most win types on a 40-game corpus.
 */
export function gridCheck(spec, opts = {}) {
	const winType = spec?.game?.mechanic;
	const reels = spec?.game?.reels?.count;
	const rows = Math.max(...(spec?.game?.reels?.rows ?? [0]));
	const convention = gridConventions(opts)[winType];
	if (!convention || !convention.confident) return null;

	const shape = `${reels}x${rows}`;
	const known = convention.shapes.some((s) => s.shape === shape);
	return {
		shape,
		winType,
		typical: convention.typical,
		sample: convention.sample,
		unusual: !known,
	};
}
