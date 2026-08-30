/**
 * Is this paytable payable at this RTP, on this board?
 *
 * ── The failure this exists to prevent ──────────────────────────────────────
 * A generated 5x4 ways game with a 100,000x cap simulated cleanly, reached its
 * max win, and then failed in the Rust optimiser with:
 *
 *     ERROR: create_ancestors failed to converge after 250000 iterations.
 *     pos_pigs=50/50, neg_pigs=0/50. Target avg_win=184.8000
 *
 * Read literally, that says: every candidate distribution pays MORE than the
 * target and none pays less. The optimiser reweights simulated rounds; it cannot
 * invent a cheaper one. The cheapest free-spin round in the entire simulation
 * paid 908.7x against a target AVERAGE of 184.8x, so no set of weights existed.
 *
 * The cause was not tuning. rtpModel puts a number on it: that game's base strip
 * paid an expected 60.2x per spin against a target of 0.43x — 140x out — and won
 * 91% of spins against a target of one in 5.5. Two arithmetic facts did it:
 *
 *   1. 5x4 is 1024 ways where 5x3 is 243, and ways pay PER WAY. The paytable had
 *      been written for a 5x3.
 *   2. Six payable symbols on a four-row board means some symbol occupies all
 *      five reels on nearly every spin.
 *
 * Neither is discoverable by staring at a spec, and both are cheap to compute.
 * That is the whole job of this file: catch it in a second, before a simulation
 * and an optimiser run spend an hour proving it.
 *
 * ── What it does and does not claim ─────────────────────────────────────────
 * It measures the BASE BOARD only — no multipliers, no cascades, no free spins.
 * That is a deliberate scope, not an omission: the question is whether the LEVEL
 * of the paytable is within reach of the target, and multipliers scale both
 * sides of that comparison. The tolerance band below is correspondingly wide.
 * The simulation remains the ground truth; this is the pre-flight check.
 */

import { stripColumns, VOLATILITY_ALPHA } from './reelDesign.js';
import { estimateStripEv } from './rtpModel.js';
import { VOLATILITY_PROFILES, wincapRtpAllocation, splitRtp } from './optimisation.js';
import { getMechanic } from './mechanics.js';

/**
 * How far the modelled EV may sit from target before it is a problem.
 *
 * Wide, because the model omits multipliers and features, and because the
 * optimiser genuinely can reweight a distribution that is a few times too rich.
 * What it cannot do is reweight one that is 140x too rich. Calibrated against
 * the four generated games: the three that optimised cleanly model at 0.20-0.94
 * against targets of 0.43-0.72; the one that failed models at 60.2.
 */
export const EV_TOLERANCE = { low: 0.4, high: 2.5 };

/** The alpha search range. Below 0.2 the paytable stops meaning anything; above
 * 4 only the cheapest symbol survives on the strip and the game has no shape. */
const ALPHA_RANGE = { min: 0.2, max: 4 };

/**
 * The base game's share of RTP, matching how planOptimisation splits it, so the
 * target measured against here is the target the optimiser is later given.
 */
export function baseGameTarget(spec, { volatility } = {}) {
	const profileId = volatility ?? spec.game.volatility ?? 'medium';
	const profile = VOLATILITY_PROFILES[profileId];
	if (!profile) throw new Error(`Unknown volatility "${profileId}".`);

	// The base bet mode is the one the game is certified on; a buy-bonus mode has
	// no base game to balance.
	const modes = Object.entries(spec.game.betModes);
	const [, mode] = modes.find(([, m]) => !m.buyBonus && !m.superspin) ?? modes[0];

	const rtp = mode.rtp ?? spec.game.rtp;
	const capRtp = wincapRtpAllocation(mode.maxWin ?? 0);
	const rest = Math.round((rtp - capRtp) * 1e5) / 1e5;
	const share = spec.freeSpins ? profile.freegameShare : 0;
	const [freeRtp, baseRtp] = splitRtp(rest, [share, 1 - share]);

	// The free strip is measured PER SPIN: the optimiser's free-game fence is an
	// average over a whole round, so the per-spin target is that divided by the
	// spins awarded.
	const spins = spec.freeSpins?.awardedSpins ?? 1;
	return {
		volatility: profileId,
		profile,
		baseRtp,
		freeRtp,
		baseHitRate: profile.baseHitRate,
		/** What one base spin should be worth. */
		baseEv: baseRtp,
		/** What one free spin should be worth, before multipliers. */
		freeEv: spec.freeSpins ? (freeRtp * profile.freegameHitRate) / spins : 0,
		/** The average a whole free-spin round should pay — the optimiser's fence. */
		freeRoundAverage: spec.freeSpins ? freeRtp * profile.freegameHitRate : 0,
	};
}

/**
 * Search alpha for the steepness that lands the base strip closest to target.
 *
 * ── Why this is a scan and not a bisection ──────────────────────────────────
 * The obvious implementation bisects, on the reasoning that a steeper payout
 * curve makes the top symbols rarer and so lowers EV. Measured, that is wrong:
 * EV is U-shaped in alpha. Raising alpha does make the top symbols rare, but it
 * does so by concentrating the strip onto the CHEAPEST symbol — and a strip
 * dominated by one symbol lands that symbol on every reel on nearly every spin.
 * On the 5x4 ways game, alpha 4 produced a strip paying 1,656x per spin, against
 * 58.8x at the profile's own alpha of 1.0. A bisection walked straight to the
 * wrong end of the curve and reported it as the answer.
 *
 * So: scan the range, keep the closest point. Twenty-five samples over a bounded
 * range is a few hundred milliseconds and cannot be fooled by the shape.
 */
export function calibrateAlpha(spec, { target, stripId = 'BR0', spins = 6000 } = {}) {
	const measure = (alpha) => {
		const columns = stripColumns(spec, stripId, { alpha });
		return { alpha, ...estimateStripEv(spec, columns, { spins, seed: `cal:${stripId}` }) };
	};

	const steps = 24;
	let best = null;
	let bestErr = Infinity;
	const curve = [];
	for (let i = 0; i <= steps; i += 1) {
		const alpha =
			Math.round((ALPHA_RANGE.min + ((ALPHA_RANGE.max - ALPHA_RANGE.min) * i) / steps) * 1000) /
			1000;
		const point = measure(alpha);
		curve.push({ alpha, ev: point.ev });
		// Ratio error, so being 10x under scores the same as being 10x over.
		const err = Math.abs(Math.log((point.ev || 1e-9) / target));
		if (err < bestErr) {
			bestErr = err;
			best = point;
		}
	}

	const ratio = best.ev / target;
	return {
		...best,
		curve,
		converged: ratio >= EV_TOLERANCE.low && ratio <= EV_TOLERANCE.high,
		reason:
			ratio > EV_TOLERANCE.high
				? 'no strip frequency in range is lean enough'
				: ratio < EV_TOLERANCE.low
					? 'no strip frequency in range is rich enough'
					: null,
	};
}

/**
 * The full pre-flight report.
 *
 * `paytableScale` is the number that matters when calibration cannot get there
 * on its own: multiply every payout in the spec by it and the game becomes
 * payable at the target. It is exact, because EV is linear in the paytable.
 */
export function balanceSpec(spec, { volatility, spins = 6000 } = {}) {
	const mechanic = spec._mechanic ?? getMechanic(spec.game.mechanic);
	const target = baseGameTarget(spec, { volatility });
	const defaultAlpha = VOLATILITY_ALPHA[target.volatility] ?? 0.7;

	const asDesigned = estimateStripEv(spec, stripColumns(spec, 'BR0'), {
		spins,
		seed: 'balance',
	});
	const calibrated = calibrateAlpha(spec, { target: target.baseEv, spins });

	// How much of the win comes from geometry alone, reported because it is the
	// single most common reason a paytable is out: a ways paytable copied from a
	// 5x3 onto a 5x4 is four times too rich before anything else is considered.
	const ways = spec.game.reels.rows.reduce((p, r) => p * r, 1);
	const geometry =
		mechanic.winType === 'ways'
			? { unit: 'ways', count: ways, reference: 243 }
			: mechanic.winType === 'lines'
				? {
						unit: 'paylines',
						count: spec.paylines === 'default_20' ? 20 : Object.keys(spec.paylines ?? {}).length,
						reference: 20,
					}
				: { unit: 'cells', count: spec.game.reels.rows.reduce((s, r) => s + r, 0), reference: 36 };

	const achieved = calibrated.ev;
	const ratio = target.baseEv > 0 ? achieved / target.baseEv : Infinity;
	const inBand = ratio >= EV_TOLERANCE.low && ratio <= EV_TOLERANCE.high;
	// To three significant figures, not three decimal places: the needed scale on
	// the 5x4 ways game was 0.00026, which decimal rounding reported as "multiply
	// every payout by 0".
	const paytableScale = achieved > 0 ? sigFigs(target.baseEv / achieved, 3) : 1;

	const findings = [];
	if (!inBand) {
		findings.push(
			`Base strip models ${fmt(achieved)}x per spin against a target of ${fmt(target.baseEv)}x — ` +
				`${fmt(ratio)}x out. The optimiser cannot reweight its way out of this: it can only ` +
				`choose among the rounds the simulation produced, and all of them are too ${ratio > 1 ? 'rich' : 'poor'}.`,
		);
		findings.push(
			`Multiply every payout in the spec by ${paytableScale} (\`forge math:balance --apply\`). ` +
				`Expected value is linear in the paytable, so this lands it exactly.`,
		);
		if (geometry.count !== geometry.reference) {
			findings.push(
				`This board has ${geometry.count} ${geometry.unit} where the default paytable assumes ` +
					`${geometry.reference}. ${mechanic.winType === 'ways' || mechanic.winType === 'lines' ? 'Wins pay per ' + geometry.unit.replace(/s$/, '') + ', so that alone is a factor of ' + fmt(geometry.count / geometry.reference) + '.' : ''}`,
			);
		}
		const payable = spec.symbols.filter((s) => s.paytable && !s.special?.includes('scatter')).length;
		if (payable < 6 && ratio > 1) {
			findings.push(
				`Only ${payable} payable symbols. With a small symbol set some symbol lands everywhere ` +
					`on nearly every spin, which is why the hit rate models at one in ${fmt(calibrated.hitRate)}.`,
			);
		}
	}
	if (!calibrated.converged && !inBand) {
		findings.push(
			`Reel-strip calibration could not reach the target on its own (${calibrated.reason}); ` +
				`alpha stopped at ${calibrated.alpha}. Frequency alone does not fix this one.`,
		);
	}

	return {
		volatility: target.volatility,
		target,
		geometry,
		mechanic: mechanic.winType,
		asDesigned: { alpha: defaultAlpha, ev: asDesigned.ev, hitRate: asDesigned.hitRate },
		calibrated: {
			alpha: Math.round(calibrated.alpha * 1000) / 1000,
			ev: achieved,
			hitRate: calibrated.hitRate,
			converged: calibrated.converged,
		},
		ratio,
		inBand,
		paytableScale,
		findings,
	};
}

/**
 * Rescale a spec's paytable.
 *
 * Applied to the SPEC, never to the generated config. The spec is what the art
 * brief, the frontend paytable screen and the certification submission all read;
 * a config quietly paying something the spec does not state is a divergence
 * nobody would find until it mattered.
 */
export function scalePaytable(spec, scale) {
	const round = (n) => {
		if (n >= 100) return Math.round(n);
		if (n >= 10) return Math.round(n * 10) / 10;
		return Math.max(0.01, Math.round(n * 100) / 100);
	};
	const symbols = spec.symbols.map((symbol) => {
		if (!symbol.paytable) return symbol;
		const paytable = {};
		for (const [key, value] of Object.entries(symbol.paytable)) {
			paytable[key] = round(Number(value) * scale);
		}
		return { ...symbol, paytable };
	});
	return { ...spec, symbols };
}

function sigFigs(n, digits) {
	if (!Number.isFinite(n) || n === 0) return n;
	const magnitude = Math.ceil(Math.log10(Math.abs(n)));
	const factor = Math.pow(10, digits - magnitude);
	return Math.round(n * factor) / factor;
}

const fmt = (n) =>
	!Number.isFinite(n)
		? '∞'
		: n >= 100
			? Math.round(n).toLocaleString('en-US')
			: Math.round(n * 100) / 100;
