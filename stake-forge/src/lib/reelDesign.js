/**
 * Reel strip design.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * Everything upstream of this file was honest scaffolding: it produced a game
 * that RAN. It did not produce a game that PAID anything in particular, because
 * the reel strips were a uniform random draw with no relationship to the
 * paytable, the target RTP, the volatility or the max win. Every simulation
 * reported "max win never reached", and that was not a tuning problem — a strip
 * of uniformly-drawn symbols simply cannot reach a 5000x cap, let alone 100,000x.
 *
 * ── The one piece of arithmetic everything here rests on ─────────────────────
 * Max-win rounds are NOT sampled, they are MANUFACTURED. A `wincap` distribution
 * sets win_criteria = max_win and check_repeat() re-rolls the round until it pays
 * exactly that; the optimiser then assigns those rounds their real weight. So the
 * frequency of a max win is chosen, not discovered:
 *
 *     max_win_hit_rate = max_win / rtp_allocated_to_max_win
 *
 * Verified three ways: math-sdk docs/math_docs/gamestate_section/repeat_info.md
 * states 1% of RTP at 5000x is 1-in-500,000; games/0_0_lines/game_optimization.py
 * asks for rtp=0.001 at av_win=5000, i.e. 1-in-5,000,000; and 100,000x at 0.5% of
 * RTP works out to exactly 1-in-20,000,000, which is the threshold Stake's
 * approval checklist asks for.
 *
 * The consequence is the whole reason this file exists: **the re-roll loop only
 * terminates if the strips can actually produce a max-win board.** That is what
 * designWincapStrip is for, and it is why the wincap distribution had to be
 * removed from the generated bet modes until now.
 *
 * ── What is an estimate, and is labelled as one ──────────────────────────────
 * ceilingFor() computes an UPPER BOUND on what one board can pay. It answers
 * "is this max win obviously unreachable?", which is a question worth answering
 * exactly, rather than "what is the true maximum", which depends on interactions
 * this cannot see. It is deliberately optimistic: if it says a cap is
 * unreachable, it certainly is.
 */

import { getMechanic } from './mechanics.js';
import { effectivePaylines } from './generators.js';

/** Every payout in a symbol's paytable, as [kind, value] pairs, kind descending. */
function paytableEntries(symbol) {
	if (!symbol.paytable) return [];
	return Object.entries(symbol.paytable)
		.map(([kind, value]) => [Number(kind), Number(value)])
		.filter(([kind, value]) => Number.isFinite(kind) && Number.isFinite(value))
		.sort((a, b) => b[0] - a[0]);
}

/** The single best payout available anywhere in the paytable. */
export function topPayout(spec) {
	let best = { value: 0, symbol: null, kind: 0 };
	for (const symbol of spec.symbols) {
		for (const [kind, value] of paytableEntries(symbol)) {
			if (value > best.value) best = { value, symbol: symbol.name, kind };
		}
	}
	return best;
}

/**
 * The most one BOARD can pay, before multipliers.
 *
 * Per mechanic, because the four win evaluators count completely differently:
 *
 *   lines    every payline hits its best combination: paylines x top payout
 *   ways     ways = product of per-reel matching counts, so a full screen of one
 *            symbol on a 5x3 is 3^5 = 243 ways, each paying the top value
 *   cluster  the whole board is one cluster, paying whatever the paytable's
 *            highest declared kind pays
 *   scatter  same — position is irrelevant, only the count matters
 */
export function boardCeiling(spec) {
	const mechanic = spec._mechanic ?? getMechanic(spec.game.mechanic);
	const top = topPayout(spec);
	if (!top.symbol) return { value: 0, how: 'no paytable entries at all' };

	const reels = spec.game.reels.count;
	const rows = spec.game.reels.rows;
	const cells = rows.reduce((sum, r) => sum + r, 0);

	switch (mechanic.winType) {
		case 'lines': {
			// The MIRRORED count on a both-ways game — the ceiling is what the engine
			// can pay, and the engine evaluates the appended lines too.
			const paylines = Object.keys(effectivePaylines(spec)).length;
			return {
				value: paylines * top.value,
				how: `${paylines} paylines x ${top.value}x (${top.kind}-of-a-kind ${top.symbol})`,
			};
		}
		case 'ways': {
			const ways = rows.reduce((product, r) => product * r, 1);
			return {
				value: ways * top.value,
				how: `${ways} ways (${rows.join('x')}) x ${top.value}x (${top.symbol})`,
			};
		}
		case 'cluster':
		case 'scatter':
		default: {
			// One group covering the whole board. The paytable's highest declared
			// kind is the most it can pay however many symbols actually land.
			return {
				value: top.value,
				how: `whole board as one group x ${top.value}x (${top.kind}+ ${top.symbol}) over ${cells} cells`,
			};
		}
	}
}

/**
 * The most the multipliers can add on top of one board.
 *
 * ── Corrected against the engine, having first got this wrong ───────────────
 * There is no free choice between "additive" and "multiplicative" composition.
 * src/wins/multiplier_strategy.py offers exactly three strategies, and symbol
 * multipliers ALWAYS ADD:
 *
 *   global    win x global_multiplier
 *   symbol    win x SUM(symbol multipliers on winning positions), floored at 1
 *   combined  symbol sum, then x global
 *
 * cluster.py and scatter.py do the same summing inline (`cluster_mult += ...`).
 *
 * The one genuinely multiplicative case is WAYS under its `symbol` strategy, and
 * it works by a different route: ways.py adds the multiplier's VALUE to that
 * reel's symbol count rather than 1, and ways multiply across reels — so a 5x
 * symbol on each of five reels compounds. Its own comment says so: "multipliers
 * on subsequent reels multiply (not add, like in lines games)".
 *
 * Ways' OTHER two strategies do not compound, and reading the compounding
 * comment as if it covered all three is a mistake worth naming, because it sends
 * you looking for a runaway multiplier that is not there. Under `board`
 * (ways.py:87) each multiplier adds into board_mult_count and the win is scaled
 * by that SUM; under `global` the symbol multipliers are ignored entirely and
 * only the round's global multiplier applies. So a ways game set to `board` sums
 * exactly like a lines game does.
 *
 * The uncapped lever on every mechanic is the GLOBAL multiplier.
 * executables.py:104 is `self.global_multiplier += 1` with no ceiling, called
 * once per free spin — so a 20-spin feature reaches 20x on its own.
 */
export const MULTIPLIER_STRATEGIES = ['symbol', 'global', 'combined'];

export function multiplierCeiling(spec) {
	const mechanic = spec._mechanic ?? (spec.game?.mechanic ? getMechanic(spec.game.mechanic) : null);
	// Both spellings, because the spec carries these under `game:` while callers
	// exploring alternatives (maxWinAdvice below) spread them at the top level.
	// Reading only the top-level one silently defaulted every game to "symbol",
	// which reported a ways game set to "board" as compounding when it sums.
	const strategy = spec.multiplierStrategy ?? spec.game?.multiplierStrategy ?? 'symbol';
	const globalPerSpin = spec.globalMultiplierPerSpin ?? spec.game?.globalMultiplierPerSpin;
	const hasMultiplierSymbol = spec.symbols.some((s) => s.special.includes('multiplier'));
	const ladder = spec.multiplierValues?.length ? spec.multiplierValues : [2, 3, 5, 10];
	const best = Math.max(...ladder);
	const reels = spec.game.reels.count;
	const cells = spec.game.reels.rows.reduce((sum, r) => sum + r, 0);

	// The global multiplier climbs by 1, uncapped — but ONLY if something calls
	// update_global_mult(). Nothing does by default: of all the samples only
	// 0_0_scatter calls it, once per tumble. So crediting it unconditionally
	// would be crediting a multiplier this game never increments, which is
	// exactly the kind of optimistic ceiling that sends you hunting for a max
	// win the game cannot produce. It counts only when the spec asks for it.
	const spins = spec.freeSpins?.awardedSpins ?? 0;
	const globalMax = globalPerSpin && spins > 0 ? spins : 1;

	let symbolPart = 1;
	let how = 'no multiplier symbol';
	if (hasMultiplierSymbol) {
		// Compounding is specific to ways' `symbol` strategy — see the note above.
		// Every other combination sums.
		if (mechanic?.winType === 'ways' && strategy === 'symbol') {
			symbolPart = Math.pow(best, reels);
			how = `${best}x on each of ${reels} reels, compounding through the ways count (${best}^${reels})`;
		} else {
			// Summing, so the ceiling is the ladder top times HOW MANY positions can
			// contribute — and that count is per-evaluator, not a constant:
			//
			//   lines        apply_mult sums over one payline's positions, so one
			//                per reel is the most a single win can collect
			//   ways/board   board_mult_count sums over every winning position on
			//                the board (ways.py:78, :88), so the whole grid counts
			//   cluster      cluster_mult sums over the cluster, up to the grid
			//   scatter      the same, position being irrelevant to it
			const positions = mechanic?.winType === 'lines' ? reels : cells;
			symbolPart = best * positions;
			how =
				`${positions} positions x ${best}x summed (symbol multipliers ADD under the ` +
				`"${strategy}" strategy on ${mechanic?.winType ?? 'this'} games)`;
		}
	}

	if (strategy === 'global') {
		return { value: globalMax, how: `global multiplier reaching ${globalMax}x over ${spins} free spins` };
	}
	if (strategy === 'combined') {
		return {
			value: symbolPart * globalMax,
			how: `${how}, then x a global multiplier reaching ${globalMax}x`,
		};
	}
	return { value: symbolPart, how };
}

/**
 * Can this game reach its max win at all?
 *
 * This is the check that was missing. A 100,000x cap on a paytable and
 * multiplier set that top out at 1,600x is not a tuning problem to be discovered
 * after an overnight simulation — it is arithmetic, and it can be reported in
 * milliseconds with a specific instruction for how to fix it.
 */
export function analyseMaxWin(spec, { maxWin } = {}) {
	const board = boardCeiling(spec);
	const multiplier = multiplierCeiling(spec);
	// One board. A tumbling game accumulates across cascades within a single
	// round, and evaluate_wincap tests the RUNNING round total, so a cascading
	// game reaches its cap through a rich sequence rather than one maximal board.
	// Crediting a fixed number of cascades here would be inventing one; instead
	// the fact is reported so an unreachable-looking cascading game is read
	// correctly rather than "fixed" by inflating its paytable.
	const cascades = Boolean(spec.tumble ?? spec.game?.tumble ?? spec._mechanic?.tumbles);
	const ceiling = board.value * multiplier.value;

	const target =
		maxWin ??
		Math.max(...Object.values(spec.game.betModes).map((mode) => Number(mode.maxWin) || 0));

	const reachable = ceiling >= target;
	// How much headroom, as a ratio. Below 1 it is impossible; a little above 1
	// means it is theoretically reachable but so contrived that the re-roll loop
	// will take a very long time to stumble on it.
	const headroom = target > 0 ? ceiling / target : Infinity;

	return {
		target,
		ceiling,
		board,
		multiplier,
		reachable,
		headroom,
		/** True when the round can accumulate across cascades, so `ceiling` is a
		 *  per-board figure and the real round ceiling is higher by an unknown
		 *  factor. Reported, not guessed at. */
		cascades,
		// Below this, the wincap re-roll is likely to be impractically slow even
		// though it is not strictly impossible.
		comfortable: headroom >= 2,
		shortfall: reachable ? 0 : target / ceiling,
	};
}

/**
 * What to change when a max win is out of reach.
 *
 * Concrete and ordered by how much each option moves the number, because "your
 * max win is unreachable" without a next step is only half a finding.
 */
export function maxWinAdvice(analysis, spec) {
	if (analysis.reachable && analysis.comfortable) return [];

	const advice = [];
	const mechanic = spec._mechanic ?? (spec.game?.mechanic ? getMechanic(spec.game.mechanic) : null);
	const strategy = spec.multiplierStrategy ?? spec.game?.multiplierStrategy ?? 'symbol';

	if (!spec.symbols.some((s) => s.special.includes('multiplier'))) {
		advice.push(
			'Give a symbol special: [multiplier]. With none, the board payout IS the ceiling and no ' +
				'paytable alone reaches a five-figure cap.',
		);
	}

	// The global multiplier is the only uncapped lever, on every mechanic — but
	// only worth suggesting once the game HAS a multiplier symbol for it to
	// compose with. Without one this advice used to read "takes the ceiling from
	// 4,000x to 4,000x", which is not advice.
	if (strategy !== 'combined' && spec.symbols.some((s) => s.special.includes('multiplier'))) {
		const combined = multiplierCeiling({ ...spec, multiplierStrategy: 'combined' });
		advice.push(
			`Set multiplierStrategy: "combined" — symbol multipliers then a GLOBAL multiplier, which ` +
				`executables.py increments once per free spin with no ceiling. That takes the ceiling ` +
				`from ${fmt(analysis.ceiling)}x to ${fmt(analysis.board.value * combined.value)}x.`,
		);
	}

	if (!(spec.globalMultiplierPerSpin ?? spec.game?.globalMultiplierPerSpin)) {
		advice.push(
			'Set globalMultiplierPerSpin: true. Nothing calls update_global_mult() by default, so the ' +
				'global multiplier sits at 1 forever — it is the only uncapped lever and it is currently off.',
		);
	}
	if (!spec.freeSpins) {
		advice.push(
			'Add a freeSpins block. The global multiplier climbs per free spin, so a game with no ' +
				'feature has nothing for it to climb during.',
		);
	} else if (strategy === 'combined' || strategy === 'global') {
		advice.push(
			`Award more free spins (currently ${spec.freeSpins.awardedSpins}). The global multiplier ` +
				`gains +1 per spin, so the round length IS the ceiling on it.`,
		);
	}

	if (mechanic?.winType !== 'ways') {
		advice.push(
			'Consider the "ways" mechanic with multiplierStrategy: "symbol". That is the one ' +
				'combination in the engine where multiplier symbols compound rather than sum — they ' +
				"inflate each reel's ways count, and ways multiply across reels.",
		);
	} else if (strategy !== 'symbol') {
		advice.push(
			`Switch multiplierStrategy from "${strategy}" to "symbol". On a ways game that is the ` +
				`difference between multipliers summing and multipliers compounding across reels: ` +
				`${fmt(multiplierCeiling({ ...spec, multiplierStrategy: 'symbol' }).value)}x instead of ` +
				`${fmt(analysis.multiplier.value)}x.`,
		);
	}

	if (analysis.cascades) {
		advice.push(
			'This game cascades, so the ceiling above is for ONE board. evaluate_wincap tests the ' +
				'running round total, which accumulates across every tumble — the real round ceiling is ' +
				'higher by however many cascades a round sustains, which only a simulation measures.',
		);
	}

	advice.push(
		`Or lower maxWin to ${fmt(Math.floor(analysis.ceiling / 2))}x or below, which this game can ` +
			`actually produce${analysis.cascades ? ' from a single board' : ''}.`,
	);

	return advice;
}

const fmt = (n) => (n >= 1000 ? Math.round(n).toLocaleString('en-US') : Math.round(n * 100) / 100);

export { fmt as formatMultiplier };

/**
 * The weighted multiplier ladder a game hands to `mult_values`.
 *
 * ── Why this is not one hardcoded table ─────────────────────────────────────
 * It used to be `{1: 20, 2: 50, 3: 80, 5: 40, 10: 10}` for every game. That is a
 * defensible ladder for a mechanic where multipliers SUM — five of them on a
 * board reaches 50x at the very top. It is not defensible where they COMPOUND:
 * on a ways game under the `symbol` strategy a 10x on each of five reels is
 * 100,000x from the multipliers alone, before the paytable pays anything, so the
 * top of the ladder stops being a rare treat and becomes the whole game.
 *
 * So the ladder is chosen from two facts about the game: whether its multipliers
 * compound (see multiplierCeiling), and how volatile it is meant to be. A
 * compounding ladder is short and weighted hard toward 1x; an additive one can
 * afford a long tail.
 *
 * Weights, not probabilities: the SDK normalises them.
 */
export function multiplierLadder(spec, mechanic) {
	const strategy = spec.game?.multiplierStrategy ?? spec.multiplierStrategy ?? 'symbol';
	const winType = mechanic?.winType ?? spec._mechanic?.winType;
	const compounds = winType === 'ways' && strategy === 'symbol';
	const volatility = spec.game?.volatility ?? 'medium';

	if (compounds) {
		return {
			low: { 1: 400, 2: 40, 3: 5 },
			medium: { 1: 300, 2: 60, 3: 15 },
			high: { 1: 200, 2: 80, 3: 30, 5: 5 },
		}[volatility] ?? { 1: 300, 2: 60, 3: 15 };
	}
	return {
		low: { 1: 60, 2: 40, 3: 15, 5: 4 },
		medium: { 1: 30, 2: 60, 3: 40, 5: 15, 10: 4 },
		high: { 1: 20, 2: 50, 3: 80, 5: 40, 10: 10 },
	}[volatility] ?? { 1: 30, 2: 60, 3: 40, 5: 15, 10: 4 };
}

/** Render a ladder as the Python dict literal the config expects. */
export function renderLadder(ladder) {
	return `{${Object.entries(ladder)
		.map(([value, weight]) => `${value}: ${weight}`)
		.join(', ')}}`;
}

/**
 * Strip profiles, measured off the shipped samples rather than chosen.
 *
 *   strip     wild %        max wild stack     rows
 *   BR0       0.0 - 0.9     0 - 1              219 - 251
 *   FR0       2.4 - 6.4     3 - 5              203 - 252
 *   FRWCAP    7.0 - 13.0    4 - 10              97 - 173
 *
 * The progression IS the mechanism. A max-win board needs whole reels of wilds,
 * so the cap strip is wild-dense with stacks at least as tall as the board — on
 * 0_0_lines' FRWCAP that is 13% wilds stacked up to 10 on a 3-row board. And it
 * is deliberately SHORT, because check_repeat() re-rolls until the round pays
 * exactly the cap and a shorter strip reaches that board sooner.
 */
export const STRIP_PROFILES = {
	BR0: { wildPct: 0.009, wildStack: 1, rows: 220, gametype: 'basegame', scatterPct: 0.0145 },
	FR0: { wildPct: 0.06, wildStack: 3, rows: 220, gametype: 'freegame', scatterPct: 0.009 },
	WCAP: { wildPct: 0.13, wildStack: 'full', rows: 100, gametype: 'basegame', cap: true, scatterPct: 0.007 },
	FRWCAP: { wildPct: 0.13, wildStack: 'full', rows: 100, gametype: 'freegame', cap: true, scatterPct: 0.007 },
};

/**
 * ...and the profiles above are LINES AND WAYS profiles. They were measured off
 * 0_0_lines and 0_0_ways only, and applying them to the other two mechanics is
 * what hung a simulation.
 *
 * Measured across every shipped sample, wild density per strip:
 *
 *   0_0_lines     BR0 0.9%   FR0 6.4%   FRWCAP 13.0%
 *   0_0_ways      BR0 0.5%   FR0 5.9%   FRWCAP 10.1%
 *   0_0_cluster   BR0 0.0%   FR0 2.4%   WCAP    7.1%
 *   0_0_scatter   BR0 0.0%   FR0 0.0%   WCAP    0.0%   — no wilds at all
 *
 * The reason is in what a max-win board looks like per evaluator. A lines or
 * ways cap board needs whole REELS of wilds, so the cap strip is wild-dense and
 * stacked taller than the board. A cluster cap board needs one big CONNECTED
 * group, and since a wild joins every group it touches, the same density makes
 * every board a winner — which on a tumbling mechanic means a round that never
 * ends. A scatter game counts symbols anywhere and has no use for substitution
 * at all.
 *
 * Applying the lines profile to a 7x7 cluster game put 13% wilds in stacks nine
 * tall on the cap strip. 93% of boards won, the expected round ran 14 cascades,
 * and the forced max-win loop never finished a batch.
 */
const CLUSTER_STRIP_PROFILES = {
	BR0: { wildPct: 0, wildStack: 1, rows: 251, gametype: 'basegame', scatterPct: 0.012 },
	FR0: { wildPct: 0.024, wildStack: 1, rows: 251, gametype: 'freegame', scatterPct: 0.008 },
	WCAP: { wildPct: 0.071, wildStack: 1, rows: 172, gametype: 'basegame', cap: true, scatterPct: 0.008 },
	FRWCAP: { wildPct: 0.071, wildStack: 1, rows: 172, gametype: 'freegame', cap: true, scatterPct: 0.008 },
};

const SCATTER_STRIP_PROFILES = {
	BR0: { wildPct: 0, wildStack: 1, rows: 251, gametype: 'basegame', scatterPct: 0.0126 },
	FR0: { wildPct: 0, wildStack: 1, rows: 251, gametype: 'freegame', scatterPct: 0.008 },
	WCAP: { wildPct: 0, wildStack: 1, rows: 251, gametype: 'basegame', cap: true, scatterPct: 0.008 },
	FRWCAP: { wildPct: 0, wildStack: 1, rows: 251, gametype: 'freegame', cap: true, scatterPct: 0.008 },
};

/** The profile for one strip, on the mechanic that will actually read it. */
export function stripProfileFor(mechanic, stripId) {
	const table =
		mechanic?.winType === 'cluster'
			? CLUSTER_STRIP_PROFILES
			: mechanic?.winType === 'scatter'
				? SCATTER_STRIP_PROFILES
				: STRIP_PROFILES;
	return table[stripId] ?? STRIP_PROFILES[stripId];
}

/**
 * How often each symbol should appear, from what it pays.
 *
 * The placeholder generator gave every symbol the same weight, which is why the
 * generated games had no shape: a top symbol paying 50x appeared exactly as
 * often as a low paying 0.5x. Frequency has to fall as payout rises or the
 * paytable means nothing.
 *
 * `1 / payout^alpha`, with alpha from the volatility profile. A LOW-volatility
 * game wants a flatter curve (alpha near 0.4) so high symbols still land often
 * and wins are frequent and small; an EXTREME one wants a steep curve so the top
 * symbols are genuinely rare and the tail is long.
 */
export const VOLATILITY_ALPHA = {
	low: 0.4,
	medium: 0.7,
	high: 1.0,
	very_high: 1.2,
	extreme: 1.4,
};

export function symbolFrequencies(spec, { volatility, alpha: alphaOverride } = {}) {
	const profileId = volatility ?? spec.game.volatility ?? 'medium';
	// The volatility profile sets the DEFAULT steepness; calibrateStrips searches
	// around it to land the modelled EV on target, so an override wins.
	const alpha = alphaOverride ?? VOLATILITY_ALPHA[profileId] ?? 0.7;

	const payable = spec.symbols.filter(
		(s) => s.paytable && !s.special.includes('scatter') && !s.special.includes('prize'),
	);
	if (!payable.length) return new Map();

	const weights = new Map();
	for (const symbol of payable) {
		const top = Math.max(...Object.values(symbol.paytable).map(Number).filter(Number.isFinite));
		// A wild is scarcer than its payout alone implies — it substitutes for
		// everything, so its real value is far above its own paytable row.
		const scarcity = symbol.special.includes('wild') ? 3 : 1;
		weights.set(symbol.name, 1 / (Math.pow(Math.max(top, 0.1), alpha) * scarcity));
	}

	const total = [...weights.values()].reduce((sum, w) => sum + w, 0);
	for (const [name, w] of weights) weights.set(name, w / total);
	return weights;
}

/**
 * Build one strip as a per-reel column of symbol names.
 *
 * Wilds are PLACED in stacks rather than rolled, for the same reason scatters
 * are: a max-win board needs a whole reel of wilds, and leaving that to chance
 * on a 13%-wild strip still almost never produces a clean full column.
 */
export function designStrip(spec, { profile, seed, rng, alpha }) {
	const reels = spec.game.reels.count;
	const rows = spec.game.reels.rows;
	const length = profile.rows;

	const freq = symbolFrequencies(spec, { alpha });
	const wildName = spec.symbols.find((s) => s.special.includes('wild'))?.name ?? null;

	// The non-wild pool, sized to the frequency table.
	const pool = [];
	for (const [name, share] of freq) {
		if (name === wildName) continue;
		const count = Math.max(1, Math.round(share * 1000));
		for (let i = 0; i < count; i += 1) pool.push(name);
	}
	if (!pool.length) throw new Error('no payable non-wild symbols to build a strip from');

	const columns = Array.from({ length: reels }, () =>
		Array.from({ length }, () => pool[Math.floor(rng() * pool.length)]),
	);

	// ── wild stacks ──────────────────────────────────────────────────────────
	if (wildName && profile.wildPct > 0) {
		for (let reel = 0; reel < reels; reel += 1) {
			const stack =
				profile.wildStack === 'full' ? rows[reel] + 2 : Math.min(profile.wildStack, rows[reel]);
			const wilds = Math.max(stack, Math.round(length * profile.wildPct));
			const stacks = Math.max(1, Math.floor(wilds / stack));
			const slot = Math.floor(length / stacks);
			for (let n = 0; n < stacks; n += 1) {
				const at = (n * slot + Math.floor(rng() * Math.max(1, slot - stack))) % length;
				for (let k = 0; k < stack; k += 1) columns[reel][(at + k) % length] = wildName;
			}
		}
	}

	return columns;
}

/** Deterministic per (game, strip), so a re-run produces no spurious diff. */
function seededRng(key) {
	let h = 2166136261;
	for (const ch of key) {
		h ^= ch.charCodeAt(0);
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
 * The designed columns for one strip, before scatters are placed.
 *
 * Exported so the RTP model measures the strip that actually ships rather than
 * a re-derivation of it. Scatters are excluded on purpose: they do not pay as
 * ordinary symbols, so they contribute nothing to the level being measured.
 */
export function stripColumns(spec, stripId, { alpha, withScatters = false } = {}) {
	const mechanic = spec._mechanic ?? (spec.game?.mechanic ? getMechanic(spec.game.mechanic) : null);
	const profile = stripProfileFor(mechanic, stripId);
	if (!profile) throw new Error(`unknown strip "${stripId}"`);
	const rng = seededRng(`${spec.game.name}:${stripId}`);
	const columns = designStrip(spec, { profile, rng, alpha });
	// Off by default: scatters do not pay as ordinary symbols, so leaving them out
	// keeps the EV model measuring only what pays. The retrigger check needs them.
	return withScatters ? placeScatters(spec, columns, { profile, stripId, rng }) : columns;
}

/**
 * A designed reel strip as CSV.
 *
 * Replaces the uniform-random placeholder. Two behaviours are carried over
 * verbatim because both were learned the hard way:
 *
 *   Scatters are PLACED, never rolled. Board.force_special_board() loops until
 *   the board holds EXACTLY the requested trigger count, so every reel must
 *   carry at least one scatter and no two may fall inside one visible window —
 *   otherwise that loop can never reach its target and hangs with no error.
 *
 *   Prize symbols never appear on an ordinary strip. Nothing in a normal spin
 *   collects a prize, so one landing there looks valuable and pays nothing.
 */
/**
 * Place scatters into an already-built strip, in place.
 *
 * Split out of renderDesignedReelCsv because the retrigger-safety check needs
 * the strip a player actually spins, scatters and all. Reading the scatterless
 * strip made that check measure a 0% trigger rate on every game — a check that
 * silently passes everything is worse than no check.
 */
export function placeScatters(spec, columns, { profile, stripId, rng, scatterDensity }) {
	const scatterNames = spec.symbols.filter((s) => s.special.includes('scatter')).map((s) => s.name);
	if (!scatterNames.length) return columns;

	const length = profile.rows;
	const reels = spec.game.reels.count;
	const window = Math.max(...spec.game.reels.rows) + 2;

	// Per-strip, because every shipped sample thins scatters on the free-game
	// and cap strips and one constant density does not:
	//
	//   0_0_cluster   BR0 1.2%   FR0 0.8%   WCAP 1.2%
	//   0_0_lines     BR0 1.6%   FR0 1.1%   FRWCAP 0.6%
	//   0_0_ways      BR0 1.6%   FR0 1.5%   FRWCAP 2.1%
	//
	// The reason is the retrigger loop. A free-game strip as scatter-rich as the
	// base strip keeps re-awarding spins: at 1.4% on a 7x7 board, a round
	// awarding 12 free spins ran to 194 of them, and the simulation spent minutes
	// inside single rounds. The expansion factor is
	// awardedSpins x P(trigger during the feature), and it has to stay below 1 or
	// the round does not end at all. mathBalance checks it.
	const density = scatterDensity ?? profile.scatterPct ?? 0.014;
	const perReel = Math.max(2, Math.round(length * density));
	const slot = Math.floor(length / perReel);
	if (slot <= window) {
		throw new Error(
			`strip "${stripId}" of ${length} rows cannot hold ${perReel} spaced scatters for a ` +
				`${window - 2}-row board — raise its rows in STRIP_PROFILES`,
		);
	}
	for (let reel = 0; reel < reels; reel += 1) {
		for (let n = 0; n < perReel; n += 1) {
			const at = (n * slot + Math.floor(rng() * (slot - window))) % length;
			columns[reel][at] = scatterNames[Math.floor(rng() * scatterNames.length)];
		}
	}
	return columns;
}

export function renderDesignedReelCsv(spec, { stripId = 'BR0', scatterDensity, alpha } = {}) {
	const mechanic = spec._mechanic ?? (spec.game?.mechanic ? getMechanic(spec.game.mechanic) : null);
	const profile = stripProfileFor(mechanic, stripId);
	if (!profile) throw new Error(`unknown strip "${stripId}" — expected one of ${Object.keys(STRIP_PROFILES).join(', ')}`);

	const rng = seededRng(`${spec.game.name}:${stripId}`);
	const columns = placeScatters(spec, designStrip(spec, { profile, rng, alpha }), {
		profile,
		stripId,
		rng,
		scatterDensity,
	});

	const length = profile.rows;
	const rows = [];
	for (let i = 0; i < length; i += 1) rows.push(columns.map((col) => col[i]).join(','));
	return `${rows.join('\n')}\n`;
}
