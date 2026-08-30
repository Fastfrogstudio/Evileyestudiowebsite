import { tsStringify } from './tsSerialize.js';
import { highSymbolNames, sortSymbols, typeRequiredStates } from './taxonomy.js';
import { getMechanic } from './mechanics.js';

export const DEFAULT_20_LINES = {
	'1': [0, 0, 0, 0, 0],
	'2': [1, 1, 1, 1, 1],
	'3': [2, 2, 2, 2, 2],
	'4': [0, 1, 2, 1, 0],
	'5': [2, 1, 0, 1, 2],
	'6': [0, 0, 1, 2, 2],
	'7': [2, 2, 1, 0, 0],
	'8': [1, 0, 1, 2, 1],
	'9': [1, 2, 1, 0, 1],
	'10': [0, 1, 1, 1, 2],
	'11': [2, 1, 1, 1, 0],
	'12': [0, 1, 0, 1, 2],
	'13': [2, 1, 2, 1, 0],
	'14': [1, 1, 0, 1, 1],
	'15': [1, 1, 2, 1, 1],
	'16': [0, 2, 1, 0, 2],
	'17': [2, 0, 1, 2, 0],
	'18': [0, 0, 2, 0, 0],
	'19': [2, 2, 0, 2, 2],
	'20': [1, 0, 0, 0, 1],
};

/**
 * The payline table the ENGINE will actually evaluate, as a plain object.
 *
 * One source of truth for three consumers that must never disagree: the
 * generated game_config.py, the Monte Carlo EV model, and the max-win ceiling
 * estimate. When they disagreed the model was blind to both-ways and reported an
 * EV 10% under what the engine paid — the sort of gap that only shows up as a
 * failed optimisation run an hour later.
 *
 * With `game.paysBothWays`, each mirrored pattern is appended UNLESS the table
 * already contains it. Two ways it can already be there, and both would
 * double-pay the same win if let through:
 *
 *   self-symmetric   [1,1,1,1,1] reversed is itself
 *   mirror pairs     [0,0,1,2,2] and [2,2,1,0,0] are both in the default 20
 *
 * Measured on DEFAULT_20_LINES, that leaves only 2 genuinely new lines — 22, not
 * the 30 a naive append produces, because the default set is drawn as a symmetric
 * fan. A line set that leans one direction gains far more.
 */
export function effectivePaylines(spec, defaultLines = DEFAULT_20_LINES) {
	const source = spec?.paylines === 'default_20' ? defaultLines : (spec?.paylines ?? defaultLines);
	const out = {};
	for (const [key, rows] of Object.entries(source)) out[String(Number(key))] = rows;
	if (!spec?.game?.paysBothWays) return out;

	let next = Math.max(...Object.keys(source).map(Number)) + 1;
	const seen = new Set(Object.values(source).map((rows) => rows.join(',')));
	for (const rows of Object.values(source)) {
		const mirrored = [...rows].reverse();
		const key = mirrored.join(',');
		if (seen.has(key)) continue;
		seen.add(key);
		out[String(next)] = mirrored;
		next += 1;
	}
	return out;
}


function weightedReelStrip(weights, length, rng) {
	const pool = [];
	for (const [name, weight] of Object.entries(weights)) {
		for (let i = 0; i < weight; i++) pool.push(name);
	}
	const strip = [];
	for (let i = 0; i < length; i++) {
		strip.push({ name: pool[Math.floor(rng() * pool.length)] });
	}
	return strip;
}

/** Deterministic PRNG so regenerating a spec twice produces an identical diff. */
function makeRng(seedText) {
	let h = 2166136261;
	for (let i = 0; i < seedText.length; i++) {
		h ^= seedText.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return () => {
		h ^= h << 13;
		h ^= h >>> 17;
		h ^= h << 5;
		return ((h >>> 0) % 100000) / 100000;
	};
}

/**
 * Build the plain-object equivalent of apps/<mechanic>/src/game/config.ts's
 * `export default { ... }`.
 *
 * Verified against all four sample apps: the top-level key set is identical
 * across lines/cluster/scatter/ways, with `paylines` present only on lines.
 * The one shape that genuinely differs is `paddingReels` — see mechanics.js.
 */
export function buildConfigObject(spec) {
	const mechanic = spec._mechanic ?? getMechanic(spec.game.mechanic);
	const symbols = {};
	for (const s of sortSymbols(spec.symbols)) {
		symbols[s.name] = {};
		if (s.paytable) {
			symbols[s.name].paytable = Object.entries(s.paytable)
				.sort((a, b) => Number(b[0]) - Number(a[0]))
				.map(([count, mult]) => ({ [count]: mult }));
		}
		if (s.special.length) symbols[s.name].special_properties = s.special;
	}

	const config = {
		providerName: spec.game.providerName,
		gameName: spec.game.name.replace(/-/g, '_'),
		gameID: spec.game.gameId,
		rtp: spec.game.rtp,
		numReels: spec.game.reels.count,
		numRows: spec.game.reels.rows,
		betModes: Object.fromEntries(
			Object.entries(spec.game.betModes).map(([key, mode]) => {
				const entry = {
					cost: mode.cost,
					feature: !!mode.feature,
					buyBonus: !!mode.buyBonus,
					rtp: mode.rtp ?? spec.game.rtp,
					max_win: mode.maxWin,
				};
				if (mode.description) entry.description = mode.description;
				return [key, entry];
			}),
		),
	};

	if (mechanic.supportsPaylines) {
		config.paylines = spec.paylines === 'default_20' ? DEFAULT_20_LINES : spec.paylines;
	}

	config.symbols = symbols;
	config.paddingReels = buildPaddingReels(spec, mechanic);

	return config;
}

/**
 * `paddingReels` per mechanic.
 *
 * lines/scatter ship real strips; cluster/ways ship empty strings. Getting this
 * wrong is not cosmetic: apps/<m>/src/game/types.ts derives
 * `GameType = keyof typeof config.paddingReels`, so the KEY SET is part of the
 * app's type surface — omitting `superspingame` on ways drops a game type that
 * the reveal bookEvent can legitimately carry.
 */
function buildPaddingReels(spec, mechanic) {
	if (mechanic.paddingReelsStyle === 'empty') {
		return Object.fromEntries(mechanic.gameTypes.map((t) => [t, '']));
	}

	const reelLength = 150;
	const weights =
		spec.placeholderReelWeights || Object.fromEntries(spec.symbols.map((s) => [s.name, 10]));
	const rng = makeRng(spec.game.name);

	return Object.fromEntries(
		mechanic.gameTypes.map((gameType) => [
			gameType,
			Array.from({ length: spec.game.reels.count }, () =>
				weightedReelStrip(weights, reelLength, rng),
			),
		]),
	);
}

export function renderConfigTs(spec) {
	const obj = buildConfigObject(spec);
	const mechanic = spec._mechanic ?? getMechanic(spec.game.mechanic);
	const paddingNote =
		mechanic.paddingReelsStyle === 'empty'
			? `// paddingReels is intentionally empty strings — that is what apps/${mechanic.webApp}\n` +
				`// ships. Its KEYS define GameType, so do not remove any.\n`
			: `// paddingReels below is a PLACEHOLDER weighted strip so storybook/dev mode runs\n` +
				`// immediately. Replace it with your math-sdk output before production.\n`;

	return (
		`// GENERATED by stake-forge from game-spec.yaml. Do not hand-edit.\n` +
		`// paytable / betModes / metadata are authoritative.\n` +
		paddingNote +
		`export default ${tsStringify(obj)};\n`
	);
}

/**
 * Minimal, valid SYMBOL_INFO_MAP for constants.ts.
 *
 * Every state points at a flat sprite placeholder named after the symbol until
 * `forge assets:import` swaps in the real spine/sprite references.
 */
export function buildSymbolInfoMap(spec, { availableFrames } = {}) {
	// Every state in the SymbolState union, for every mechanic — see
	// taxonomy.js typeRequiredStates() for why this is not conditional.
	const states = typeRequiredStates();
	const map = {};

	/**
	 * Pick the sprite frame for a symbol.
	 *
	 * `<name>.webp` is a guess, and for a sample sheet holding `s.png`, `w.png`
	 * and no `l5` at all it is a wrong one — the symbol then renders as nothing,
	 * with no error anywhere. When the caller can tell us which frames the
	 * cloned sheet actually holds, match against them: same stem, any extension,
	 * case-insensitive. Where nothing matches, the guess stands and `forge audit`
	 * reports it rather than the game silently showing an empty cell.
	 */
	// Materialised ONCE, outside frameFor. Callers pass a Map's .keys(), which is
	// a one-shot iterator: spreading it per symbol drained it on the first one,
	// so W resolved correctly and every symbol after it silently fell back to
	// the guess.
	const frames = availableFrames ? [...availableFrames] : null;

	const frameFor = (name) => {
		const guess = `${name.toLowerCase()}.webp`;
		if (!frames) return guess;
		if (frames.includes(guess)) return guess;
		const stem = name.toLowerCase();
		return frames.find((f) => f.replace(/\.[^.]+$/, '').toLowerCase() === stem) ?? guess;
	};

	for (const s of sortSymbols(spec.symbols)) {
		const placeholder = {
			type: 'sprite',
			assetKey: frameFor(s.name),
			sizeRatios: { width: 1, height: 1 },
		};
		map[s.name] = {};
		for (const state of states) {
			map[s.name][state] = placeholder;
		}
	}
	return map;
}

export function renderConstantsPatch(spec) {
	const map = buildSymbolInfoMap(spec);
	return (
		`// GENERATED by stake-forge — paste-replace SYMBOL_INFO_MAP and HIGH_SYMBOLS\n` +
		`// in src/game/constants.ts with the blocks below.\n\n` +
		`export const HIGH_SYMBOLS = ${tsStringify(highSymbolNames(spec.symbols))};\n\n` +
		`export const SYMBOL_INFO_MAP = ${tsStringify(map)} as const;\n`
	);
}

/**
 * A legal starting board: reels x (rows + 2), since the sample apps pad the
 * board by one row top and bottom when the math sets include_padding.
 * Scatters are excluded so the initial render never looks like a trigger.
 */
export function buildInitialBoard(spec) {
	const names = sortSymbols(spec.symbols)
		.filter((s) => !s.special.includes('scatter'))
		.map((s) => s.name);
	const pool = names.length ? names : spec.symbols.map((s) => s.name);

	return Array.from({ length: spec.game.reels.count }, (_, reelIdx) =>
		Array.from({ length: spec.game.reels.rows[reelIdx] + 2 }, (_, rowIdx) => ({
			name: pool[(reelIdx + rowIdx) % pool.length],
		})),
	);
}
