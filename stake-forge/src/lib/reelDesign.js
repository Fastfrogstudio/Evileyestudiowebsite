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
			const paylines =
				spec.paylines === 'default_20' ? 20 : Object.keys(spec.paylines ?? {}).length;
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
 * How multipliers COMPOSE is the single biggest lever on max win, and the SDK
 * samples contain both patterns: 0_0_lines ADDS wild multipliers together, while
 * 0_0_ways MULTIPLIES them. Two 5x wilds are worth 10x under one rule and 25x
 * under the other, and the gap compounds brutally across a free-spin round.
 */
export function multiplierCeiling(spec) {
	const values = spec.multiplierValues ?? [];
	const hasMultiplierSymbol = spec.symbols.some((s) => s.special.includes('multiplier'));
	if (!hasMultiplierSymbol && !values.length) {
		return { value: 1, how: 'no multiplier symbol — nothing multiplies the board' };
	}

	// Default ladder matches what the scaffolder emits into mult_values.
	const ladder = values.length ? values : [2, 3, 5, 10];
	const best = Math.max(...ladder);
	const composition = spec.multiplierComposition ?? 'additive';

	// How many can be in play at once: at most one per reel.
	const slots = spec.game.reels.count;

	if (composition === 'multiplicative') {
		return {
			value: Math.pow(best, slots),
			how: `${slots} x ${best}x multiplied together (${best}^${slots})`,
		};
	}
	return {
		value: best * slots,
		how: `${slots} x ${best}x added together`,
	};
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
	const need = analysis.shortfall || 2 / analysis.headroom;

	const composition = spec.multiplierComposition ?? 'additive';
	if (composition === 'additive' && analysis.multiplier.value > 1) {
		const multiplicative = multiplierCeiling({ ...spec, multiplierComposition: 'multiplicative' });
		advice.push(
			`Switch multiplierComposition to "multiplicative" — ${analysis.multiplier.how} becomes ` +
				`${multiplicative.how}, taking the ceiling from ${fmt(analysis.ceiling)}x to ` +
				`${fmt(analysis.board.value * multiplicative.value)}x. This is the single biggest lever, ` +
				`and both patterns exist in the SDK samples (0_0_lines adds, 0_0_ways multiplies).`,
		);
	}

	if (analysis.multiplier.value === 1) {
		advice.push(
			`Give a symbol special: [multiplier]. With no multiplier at all the board payout IS the ` +
				`ceiling, and no paytable alone reaches a five-figure cap.`,
		);
	} else {
		advice.push(
			`Raise the top of the multiplier ladder. It needs roughly ${Math.ceil(need)}x more headroom.`,
		);
	}

	advice.push(
		`Or lower maxWin to ${fmt(Math.floor(analysis.ceiling / 2))}x or below, which this paytable ` +
			`and multiplier set can actually produce.`,
	);

	return advice;
}

const fmt = (n) => (n >= 1000 ? Math.round(n).toLocaleString('en-US') : Math.round(n * 100) / 100);

export { fmt as formatMultiplier };
