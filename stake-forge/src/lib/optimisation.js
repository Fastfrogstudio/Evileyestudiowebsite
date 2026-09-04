/**
 * Optimisation setup.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 * A raw simulation does not produce a game with a target RTP. The generated
 * distributions re-roll any round that pays nothing, so every simulated round is
 * a winner and the measured RTP is far above target by construction. What turns
 * that into a real game is the Rust optimiser: it reweights the simulated rounds
 * until the weighted distribution hits the RTP and hit rate you asked for.
 *
 * The optimiser is driven by a `game_optimization.py` next to `game_config.py`,
 * which the SDK's own run.py imports. This generates it from the spec.
 *
 * ── The three constraints, which are asserted, not documented ────────────────
 * verify_optimization_input() in optimization_program/optimization_config.py
 * enforces all of these, and a violation is an AssertionError before a single
 * round is optimised:
 *
 *   1. Every distribution criteria in a bet mode must appear as a `conditions`
 *      key for that mode. That is why the criteria list lives in one place
 *      (betModeCriteria) and both files are generated from it.
 *   2. The conditions' RTPs must SUM to the bet mode's rtp, to 5 decimal places.
 *      Not approximately — `round(bm_rtp, 5) == round(param_rtp, 5)`. The split
 *      below is therefore computed and then the remainder is assigned, rather
 *      than each part being rounded independently.
 *   3. Every condition must carry an `rtp` key, because the sum reads p["rtp"]
 *      directly. ConstructConditions only emits one when rtp is derivable, so
 *      every condition here is given an explicit rtp.
 *
 * ── What is a judgement call, and is labelled as one ─────────────────────────
 * How the RTP divides between base game and free game, and what hit rate to aim
 * for, IS the volatility of the game. Those numbers are opinions, not facts, so
 * they come from a named profile in the spec rather than being invented per
 * game — and the generated file says so, in the file, where whoever tunes it
 * next will read it.
 */

import { betModeCriteria } from './mathGenerators.js';

/**
 * Volatility profiles.
 *
 * `freegameShare` is the fraction of a mode's RTP delivered by the free game.
 * A high-volatility game pays most of its money in the feature and pays it
 * rarely; a low-volatility game pays more of it in the base game, more often.
 *
 * `baseHitRate` is one paying base-game round in N. `freegameHitRate` is one
 * feature trigger in N.
 *
 * These are starting points shaped after the sample games' own numbers
 * (0_0_lines runs a 0.599/0.367 base/free split at hr 3.5 and 200), not
 * measurements of anything. They exist so a new game starts somewhere sane and
 * has one knob to turn, not so anyone treats them as correct.
 *
 * ── The ceiling that shapes the whole ladder ────────────────────────────────
 * The obvious way to make a game more volatile is to make it pay less often,
 * and above `high` that route is CLOSED. Stake's approval criteria put the base
 * hit rate between 1-in-2 and 1-in-10, and `math:validate` fails a game outside
 * it — "too dry; players read a 1-in-20 game as broken". So there is nowhere to
 * go past about 1-in-8 without failing the gate.
 *
 * Volatility above `high` therefore has to come from DISPERSION rather than
 * rarity: the same number of paying rounds, but with the money concentrated in
 * far fewer of them. The three levers that do that are
 *
 *   freegameShare      how much of the RTP the base game never sees
 *   freegameHitRate    how rarely the feature that holds it arrives
 *   scaleSpread        how far the optimiser reaches for the top of the range
 *
 * At `extreme` the base game returns 15% of RTP and the other 85% arrives once
 * in ~700 spins. A player still hits something once in eight rounds; almost
 * none of those hits are worth anything. That is what extreme volatility
 * actually feels like, and it is reachable inside Stake's rule where a drier
 * base game is not.
 *
 * `wincapRtpAllocation` is deliberately NOT part of this. Max-win frequency is
 * derived from the cap itself to land on 1-in-20,000,000 whatever the profile,
 * so a tier cannot quietly trade Stake's max-win rule for a steeper curve.
 *
 * ── What the tiers MEASURE, so a game can be picked rather than guessed ──────
 *
 * One spec — 5x3 lines, 20,000x cap, sticky multiplier wilds + a colossal block
 * + a per-spin global multiplier — run at three tiers, 100,000 rounds each,
 * everything else identical. All three pass all 22 rules with no advisories, so
 * this is a choice about SHAPE, not about correctness:
 *
 *   tier        base hit   sub-stake spins   p99      p99.9    270x-1170x rounds
 *   medium        29.08%             25.2%   86.0x    174.1x                   7
 *   high          20.33%             16.7%   150.0x   276.7x                  91
 *   very_high     15.58%             14.6%   201.8x   517.4x                 469
 *
 * Two things that table says which are easy to get backwards:
 *
 * The MIDDLE of the range is what the tier really buys. Between medium and
 * very_high the p99.9 roughly triples, but the count of rounds paying 270x-1170x
 * goes up 67-fold. A medium game with a big cap does not have a thin tail so
 * much as an empty middle — nothing between the small wins and the rare tail,
 * which is what leaves a celebration ladder with dead rungs.
 *
 * Sub-stake "wins" — a paying round returning LESS than the stake — fall as
 * volatility rises, 25.2% of spins to 14.6%. They are the most-scrutinised
 * pattern in slot design, so the drier tiers are also the more honest ones here.
 *
 * `very_high` has the best-populated ladder of the three and is still not the
 * default pick: at 15.58% it sits under the ~18% that published hit-frequency
 * guidance calls punishing, where `high` clears it and stays well inside Stake's
 * 1-in-2 to 1-in-10 rule at 1-in-4.9.
 */
export const VOLATILITY_PROFILES = {
	low: {
		label: 'Low — pays often, pays small',
		freegameShare: 0.2,
		baseHitRate: 2.5,
		freegameHitRate: 120,
		/** Multiplier applied to the win ranges the scaling curve targets. */
		scaleSpread: 0.5,
	},
	medium: {
		label: 'Medium — the shape most slots have',
		freegameShare: 0.38,
		baseHitRate: 3.5,
		freegameHitRate: 200,
		scaleSpread: 1,
	},
	high: {
		label: 'High — long dry spells, big features',
		freegameShare: 0.55,
		baseHitRate: 5,
		freegameHitRate: 350,
		scaleSpread: 2,
	},
	very_high: {
		label: 'Very high — most of the money is in the feature',
		freegameShare: 0.7,
		baseHitRate: 6.5,
		freegameHitRate: 550,
		scaleSpread: 3.2,
	},
	extreme: {
		label: 'Extreme — the base game barely pays; everything rides on the feature',
		// 85/15 to the feature, arriving once in ~700 spins. The base hit rate
		// stops at 8: the gate fails at 10 and a measured rate drifts from its
		// target, so the last two are left as headroom rather than spent.
		freegameShare: 0.85,
		baseHitRate: 8,
		freegameHitRate: 700,
		scaleSpread: 5,
	},
};

export const VOLATILITY_IDS = Object.keys(VOLATILITY_PROFILES);


/**
 * How much RTP to allocate to the max win, derived rather than guessed.
 *
 * The optimiser turns an RTP allocation into a frequency:
 *
 *     hit_rate = max_win / rtp_allocated
 *
 * so choosing the allocation IS choosing how often the cap is hit. Stake's
 * approval checklist asks for the max win to be obtainable at roughly
 * 1-in-20,000,000, so the allocation falls straight out of the target:
 *
 *     5,000x   -> 0.00025  (0.025% of RTP)
 *     100,000x -> 0.005    (0.5% of RTP)
 *
 * Verified against math-sdk docs (1% of RTP at 5000x = 1-in-500k) and against
 * 0_0_lines' own setup (rtp=0.001 at av_win=5000 = 1-in-5M).
 */
export const TARGET_WINCAP_HIT_RATE = 20_000_000;

export function wincapRtpAllocation(maxWin, { hitRate = TARGET_WINCAP_HIT_RATE } = {}) {
	const raw = maxWin / hitRate;
	// Never let the cap eat a meaningful share of the game's RTP: above ~2% the
	// rest of the paytable has nothing left to pay with.
	return Math.min(Math.round(raw * 1e5) / 1e5, 0.02);
}

/**
 * Split a mode's RTP across its criteria so the parts sum EXACTLY to the whole.
 *
 * Rounding each share independently is the obvious approach and it is wrong:
 * 0.965 split 0.38/0.62 and rounded to 5dp gives 0.3667 + 0.5983 = 0.965, but
 * a different share gives 0.96499 or 0.96501, and the SDK's assertion is exact.
 * So every part but the last is rounded, and the last takes the remainder.
 */
export function splitRtp(total, shares) {
	const round5 = (n) => Math.round(n * 1e5) / 1e5;
	const out = [];
	let assigned = 0;
	for (let i = 0; i < shares.length - 1; i += 1) {
		const value = round5(total * shares[i]);
		out.push(value);
		assigned = round5(assigned + value);
	}
	out.push(round5(total - assigned));
	return out;
}

/**
 * One paying round in N, from the distribution quotas.
 *
 * The zero-win criteria is the only one that pays nothing, so the paying share
 * is everything else — and the hit rate the optimiser should aim for is the
 * reciprocal of that share.
 */
export function payingHitRate(distributions) {
	const total = distributions.reduce((sum, d) => sum + d.quota, 0);
	const paying = distributions.filter((d) => d.criteria !== '0').reduce((sum, d) => sum + d.quota, 0);
	if (!paying) return 'x';
	return Math.round((total / paying) * 1e5) / 1e5;
}

/**
 * Plan the optimisation for every bet mode.
 *
 * Returns plain data — no Python — so it can be tested, shown in the app, and
 * rendered separately.
 */
export function planOptimisation(spec, { volatility } = {}) {
	const profileId = volatility ?? spec.game.volatility ?? 'medium';
	const profile = VOLATILITY_PROFILES[profileId];
	if (!profile) {
		throw new Error(
			`Unknown volatility "${profileId}". Use one of: ${VOLATILITY_IDS.join(', ')}.`,
		);
	}

	const hasFreeSpins = Boolean(spec.freeSpins);
	const modes = [];

	for (const [name, mode] of Object.entries(spec.game.betModes)) {
		const distributions = betModeCriteria(mode);
		const criteria = distributions.map((c) => c.criteria);
		const rtp = mode.rtp ?? spec.game.rtp;

		// A buy-bonus mode has one criteria, so it takes the whole RTP. Anything
		// else splits between free game and base game by the profile's share —
		// unless the game has no free spins at all, in which case the base game
		// is the only thing that pays and takes all of it.
		let conditions;
		if (mode.superspin) {
			// Building this from the mode's real criteria rather than assuming a
			// freegame/basegame pair is the point: an earlier version hardcoded a
			// freegame condition searching by scatter, which a superspin mode has
			// no rounds for, and the optimiser failed with "fence 'freegame'
			// matched 0 books".
			//
			// The hit rate is DERIVED, not "x". A hold-and-win round is bought, so
			// hr="x" — no target — looks right, and it is what the sample's bonus
			// mode uses. But that mode has no zero-win criteria: with one present,
			// an unconstrained hit rate lets the optimiser park weight in the zero
			// bucket, and the mode comes in at rtp × (paying share). Measured: 48%
			// against a 96% target, exactly half, because the optimiser had settled
			// on 50/50. Pinning the hit rate to the quotas fixes it.
			conditions = [
				{ criteria: '0', rtp: 0, avWin: 0, searchPayout: 0, kind: 'zero' },
				{ criteria: 'basegame', rtp, hitRate: payingHitRate(distributions), kind: 'basegame' },
			];
		} else if (mode.buyBonus) {
			// Keyed off the MODE, not the criteria count. That count used to be 1 for
			// a buy-bonus mode, but adding the wincap distribution made it 2 and this
			// branch silently stopped matching — the plan-time guard caught it.
			// hr="x" is how 0_0_lines' bonus mode expresses "no hit-rate target".
			// A bonus buy triggers every round by definition, so there is nothing
			// for the optimiser to hit one-in-N of.
			const capRtp = wincapRtpAllocation(mode.maxWin ?? 0);
			conditions = [
				{ criteria: 'wincap', rtp: capRtp, avWin: mode.maxWin, searchPayout: mode.maxWin, kind: 'wincap' },
				{
					criteria: criteria.find((c) => c !== 'wincap') ?? 'freegame',
					rtp: Math.round((rtp - capRtp) * 1e5) / 1e5,
					hitRate: 'x',
					kind: 'freegame',
				},
			];
		} else {
			// The cap takes its allocation first; everything else splits what is left.
			const capRtp = wincapRtpAllocation(mode.maxWin ?? 0);
			const rest = Math.round((rtp - capRtp) * 1e5) / 1e5;
			const share = hasFreeSpins ? profile.freegameShare : 0;
			const [freeRtp, baseRtp] = splitRtp(rest, [share, 1 - share]);
			conditions = [
				{
					criteria: 'wincap',
					rtp: capRtp,
					avWin: mode.maxWin,
					searchPayout: mode.maxWin,
					kind: 'wincap',
				},
				{
					criteria: 'freegame',
					rtp: freeRtp,
					hitRate: profile.freegameHitRate,
					kind: 'freegame',
					// The optimiser has to be told how to FIND free-game rounds in the
					// simulated set. Searching by the scatter symbol is how the sample
					// games do it, and it is the only handle that exists — a free-game
					// round is not otherwise labelled in the book.
					searchSymbol: hasFreeSpins ? 'scatter' : null,
				},
				// The losing rounds. rtp 0 and av_win 0, so it contributes nothing to
				// the RTP sum the SDK asserts on — its whole job is to give the
				// optimiser rounds that pay nothing, which is what makes a hit rate
				// below 1-in-1 reachable at all.
				{ criteria: '0', rtp: 0, avWin: 0, searchPayout: 0, kind: 'zero' },
				{ criteria: 'basegame', rtp: baseRtp, hitRate: profile.baseHitRate, kind: 'basegame' },
			];
		}

		// The SDK asserts every distribution criteria appears as a conditions key.
		// Asserting it here too means a planner bug is a clear error at plan time
		// rather than a Rust fence failure minutes into an optimiser run.
		const planned = new Set(conditions.map((c) => c.criteria));
		const missing = criteria.filter((c) => !planned.has(c));
		const extra = [...planned].filter((c) => !criteria.includes(c));
		if (missing.length || extra.length) {
			throw new Error(
				`optimisation plan for bet mode "${name}" does not match its distributions: ` +
					`${missing.length ? `missing ${missing.join(', ')}` : ''}` +
					`${missing.length && extra.length ? '; ' : ''}` +
					`${extra.length ? `has no distribution for ${extra.join(', ')}` : ''}.`,
			);
		}

		modes.push({
			name,
			cost: mode.cost ?? 1,
			maxWin: mode.maxWin,
			rtp,
			conditions,
			scaling: scalingFor(conditions, profile, mode),
			parameters: parametersFor(mode),
			// Only the criteria that actually exist can be biased; biasing a
			// criteria the mode does not have is an assertion failure.
			bias: {
				criteria: conditions[0].criteria,
				range: biasRange(conditions[0], profile, mode),
				weight: profileId === 'high' ? 0.3 : 0.5,
			},
		});
	}

	return { volatility: profileId, profile, modes };
}

/**
 * Scaling nudges the shape of the distribution WITHIN a criteria: make wins in
 * this range more or less likely, without changing the criteria's total RTP.
 *
 * The curve here lifts small wins slightly (so the game does not feel dead) and
 * lifts the top of the feature range (so the big wins that make a game
 * memorable are reachable), scaled by how volatile the profile is.
 */
function scalingFor(conditions, profile, mode) {
	const spread = profile.scaleSpread;
	const cap = mode.maxWin ?? 5000;
	const out = [];

	for (const condition of conditions) {
		// Nothing to shape in the zero-win criteria: every round in it pays zero,
		// so a win_range scaling factor has nothing to apply to.
		if (condition.kind === 'zero' || condition.kind === 'wincap') continue;
		if (condition.kind === 'basegame') {
			out.push(
				{ criteria: 'basegame', scale_factor: 1.2, win_range: [1, 2], probability: 1.0 },
				{ criteria: 'basegame', scale_factor: 1.5, win_range: [10, 20 * spread], probability: 1.0 },
			);
		} else {
			// Expressed as fractions of the cap rather than absolute wins, so a
			// 500x game and a 50000x game both get a curve that reaches its own top
			// end instead of one tuned for a cap it does not have.
			out.push(
				{ criteria: condition.criteria, scale_factor: 1.2, win_range: [1, 20 * spread], probability: 1.0 },
				{
					criteria: condition.criteria,
					scale_factor: 0.8,
					win_range: [round2(cap * 0.2), round2(cap * 0.4)],
					probability: 1.0,
				},
				{
					criteria: condition.criteria,
					scale_factor: 1.2,
					win_range: [round2(cap * 0.6), round2(cap * 0.8)],
					probability: 1.0,
				},
			);
		}
	}
	return out;
}

/**
 * The optimiser's own run parameters — how hard it searches.
 *
 * These are the sample games' values. They are runtime cost, not game design:
 * raising them makes the optimiser slower and its answer better. The one thing
 * that genuinely differs per mode is test_spins — how many spins a simulated
 * player session is assumed to last — because a bonus buy is played in far
 * shorter bursts than a base game.
 */
function parametersFor(mode) {
	const buy = Boolean(mode.buyBonus);
	return {
		num_show: 5000,
		num_per_fence: 10000,
		min_m2m: 4,
		max_m2m: 8,
		pmb_rtp: 1.0,
		sim_trials: 5000,
		test_spins: buy ? [10, 20, 50] : [50, 100, 200],
		test_weights: buy ? [0.6, 0.2, 0.2] : [0.3, 0.4, 0.3],
		score_type: 'rtp',
	};
}

/** Where to bias the distribution's mean, as a win range. */
function biasRange(condition, profile, mode) {
	const cap = mode.maxWin ?? 5000;
	if (condition.kind === 'basegame') return [2 * profile.scaleSpread, 3 * profile.scaleSpread];
	return [round2(cap * 0.04), round2(cap * 0.07)];
}

const round2 = (n) => Math.round(n * 100) / 100;

/** Render a JS value as Python. Tuples where the SDK asserts on tuples. */
function py(value, { tuple = false } = {}) {
	if (Array.isArray(value)) {
		const inner = value.map((v) => py(v)).join(', ');
		return tuple ? `(${inner})` : `[${inner}]`;
	}
	if (typeof value === 'string') return JSON.stringify(value);
	if (typeof value === 'boolean') return value ? 'True' : 'False';
	if (value === null || value === undefined) return 'None';
	return String(value);
}

/** Generate `game_optimization.py`. */
export function renderOptimisationPy(spec, plan) {
	const modeBlocks = plan.modes.map((mode) => {
		const conditions = mode.conditions
			.map((c) => {
				// py(), not interpolation: hr is "x" for a mode with no hit-rate
				// target, and a bare x is a NameError rather than a string.
				const args = [`rtp=${py(c.rtp)}`];
				if (c.avWin !== undefined) args.push(`av_win=${py(c.avWin)}`);
				if (c.hitRate !== undefined) args.push(`hr=${py(c.hitRate)}`);
				if (c.searchSymbol) args.push(`search_conditions={"symbol": ${py(c.searchSymbol)}}`);
				// A numeric search condition is a payout to match exactly, which is
				// how the zero-win rounds are located.
				if (c.searchPayout !== undefined) args.push(`search_conditions=${py(c.searchPayout)}`);
				return `                    ${py(c.criteria)}: ConstructConditions(\n` +
					`                        ${args.join(', ')}\n` +
					`                    ).return_dict(),`;
			})
			.join('\n');

		const scaling = mode.scaling
			.map(
				(s) =>
					`                        {\n` +
					`                            "criteria": ${py(s.criteria)},\n` +
					`                            "scale_factor": ${s.scale_factor},\n` +
					`                            "win_range": ${py(s.win_range, { tuple: true })},\n` +
					`                            "probability": ${s.probability},\n` +
					`                        },`,
			)
			.join('\n');

		const p = mode.parameters;

		return `            ${py(mode.name)}: {
                "conditions": {
${conditions}
                },
                "scaling": ConstructScaling(
                    [
${scaling}
                    ]
                ).return_dict(),
                "parameters": ConstructParameters(
                    num_show=${p.num_show},
                    num_per_fence=${p.num_per_fence},
                    min_m2m=${p.min_m2m},
                    max_m2m=${p.max_m2m},
                    pmb_rtp=${p.pmb_rtp},
                    sim_trials=${p.sim_trials},
                    test_spins=${py(p.test_spins)},
                    test_weights=${py(p.test_weights)},
                    score_type=${py(p.score_type)},
                ).return_dict(),
                "distribution_bias": ConstructFenceBias(
                    applied_criteria=[${py(mode.bias.criteria)}],
                    bias_ranges=[${py(mode.bias.range, { tuple: true })}],
                    bias_weights=[${mode.bias.weight}],
                ).return_dict(),
            },`;
	});

	return `"""Optimisation setup for ${spec.game.name} — GENERATED by stake-forge.

Volatility profile: ${plan.volatility} — ${plan.profile.label}

WHAT IS FACT HERE AND WHAT IS OPINION
-------------------------------------
Fact, and asserted by the SDK:
  * every 'conditions' key matches a Distribution criteria in game_config.py
  * the conditions' rtp values sum EXACTLY to the bet mode's rtp

Opinion, generated from the "${plan.volatility}" volatility profile:
  * how that RTP divides between the base game and the free game
  * the target hit rates
  * the scaling curve and the distribution bias

The opinions are a starting point, not an answer. Tune them here — this file is
yours once generated, and stake-forge will not overwrite it without --force.
"""

from optimization_program.optimization_config import (
    ConstructScaling,
    ConstructParameters,
    ConstructConditions,
    ConstructFenceBias,
    verify_optimization_input,
)


class OptimizationSetup:
    """Per-bet-mode targets for the Rust optimiser."""

    def __init__(self, game_config):
        self.game_config = game_config

        self.game_config.opt_params = {
${modeBlocks.join('\n')}
        }

        verify_optimization_input(self.game_config, self.game_config.opt_params)
`;
}
