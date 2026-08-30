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

import { stripColumns, VOLATILITY_ALPHA, STRIP_PROFILES, stripProfileFor } from './reelDesign.js';
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
 * On a TUMBLING mechanic, how often a board may win is a hard constraint.
 *
 * ── Found by hanging a simulation ───────────────────────────────────────────
 * A cluster game whose EV landed correctly on target still ran for minutes at
 * 100% CPU with memory climbing past 2.8 GB and never finished a batch. Nothing
 * about its RTP was wrong. What was wrong was its hit rate.
 *
 * A cascade repeats while the refilled board keeps winning, so the expected
 * number of drops in ONE round is 1/(1 - p) where p is the chance a board pays.
 * That is 1.6 drops at p=0.38, 5 at p=0.80, 20 at p=0.95, and unbounded as p
 * approaches 1. The generated game sat at p=0.76 on its base strip and p=0.94 on
 * its cap strip, so every forced max-win attempt was a very long round and the
 * re-roll loop did thousands of them.
 *
 * Measured for comparison, with this same model, off the SHIPPED 0_0_cluster
 * sample — the only ground truth available, since no sample ships with
 * simulation output:
 *
 *     BR0   EV 0.774/spin   p = 38%
 *     FR0   EV 2.104/spin   p = 57%
 *     WCAP  EV 10.06/spin   p = 77%
 *
 * The EV levels were right; only p was out. So p is now calibrated for, not just
 * reported. The cap strip is allowed to run hotter on purpose: it has to sustain
 * a long round to reach the cap at all.
 */
export const CASCADE_LIMITS = { ordinary: 0.8, cap: 0.92, comfortable: 0.65 };

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
 *
 * ── Two objectives, because they are two independent knobs ──────────────────
 * Strip composition sets HOW OFTEN a board pays. The paytable sets HOW MUCH.
 * Trying to hit an EV target by moving frequency alone makes them fight, and on
 * a tumbling mechanic the frequency side has to win: hit rate there is not a
 * preference but the expected cascade length, 1/(1 - p).
 *
 * So a caller passing `targetHitRate` gets frequency solved for that, and the
 * level is then corrected exactly by the paytable scale balanceSpec reports —
 * which is a one-step solve, since EV is linear in the paytable. A caller
 * passing only `target` gets the older EV-first behaviour, which is what the
 * non-cascading mechanics use and what the 100,000x ways game was proved on.
 */
export function calibrateAlpha(
	spec,
	{ target, stripId = 'BR0', spins = 6000, maxHitProbability = null, targetHitRate = null } = {},
) {
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
		const hitProbability = 1 / point.hitRate;
		curve.push({ alpha, ev: point.ev, hitProbability });
		// Ratio error, so being 10x under scores the same as being 10x over.
		let err = targetHitRate
			? Math.abs(Math.log(point.hitRate / targetHitRate))
			: Math.abs(Math.log((point.ev || 1e-9) / target));
		// On a tumbling mechanic an over-hot board is not a shape preference, it is
		// a round that never ends. Penalise heavily rather than exclude, so a game
		// where NOTHING qualifies still returns its least-bad point and the caller
		// reports why instead of throwing.
		if (maxHitProbability !== null && hitProbability > maxHitProbability) {
			err += 10 + (hitProbability - maxHitProbability) * 100;
		}
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
 * How far a free-spin round expands through retriggers.
 *
 * ── Found by hanging a simulation, again ────────────────────────────────────
 * With the cascade limits satisfied and the RTP on target, a cluster game still
 * ran one round for minutes. The stack showed it inside run_freespin, and the
 * count showed why: a round awarding 12 free spins had reached 194 of them. Each
 * free-game board landing the trigger count again calls update_fs_retrigger_amt
 * and awards another 12.
 *
 * The arithmetic is a branching process. If one free spin awards `awarded` more
 * with probability `p`, the expected total is a geometric series that converges
 * only while `awarded x p < 1`, to a factor of 1/(1 - awarded x p). At 0.54 —
 * where that game sat — the mean is 2.2x the awarded spins but the tail is long,
 * and a simulation runs the tail thousands of times. At 1 it never ends.
 *
 * Every shipped sample avoids this by thinning scatters on the free-game strip
 * (0_0_cluster runs 1.2% on BR0 and 0.8% on FR0). Ours used one density on every
 * strip, which is the whole bug.
 */
export const RETRIGGER_LIMIT = { safe: 0.35, hard: 0.6 };

export function retriggerSafety(spec, { alpha, spins = 4000 } = {}) {
	if (!spec.freeSpins?.retrigger) return null;
	const mechanic = spec._mechanic ?? getMechanic(spec.game.mechanic);
	const stripId = stripProfileFor(mechanic, 'FRWCAP') ? 'FRWCAP' : 'FR0';
	const columns = stripColumns(spec, stripId, { alpha, withScatters: true });
	const rows = spec.game.reels.rows;
	// The RETRIGGER threshold, which is not the trigger count. renderFreespinTriggers
	// floors it at 3 and a spec may set it lower explicitly; either way the number
	// that matters here is the one the engine will compare against, since
	// check_fs_condition takes min(freespin_triggers[freegame].keys()).
	const triggerCount = Math.max(
		spec.freeSpins.retriggerCount ?? 3,
		spec.freeSpins.retriggerCount ? 1 : 3,
	);
	const awardedOnRetrigger =
		spec.freeSpins.retriggerSpins ?? Math.ceil((spec.freeSpins.awardedSpins ?? 10) / 2);
	const scatterNames = new Set(
		spec.symbols.filter((s) => s.special?.includes('scatter')).map((s) => s.name),
	);
	if (!scatterNames.size) return null;

	// Count trigger boards directly off the designed strip rather than deriving a
	// Poisson approximation: scatters are PLACED at fixed spacing, not rolled, so
	// their on-screen count is not Poisson and an approximation would be wrong in
	// the direction that matters.
	let hits = 0;
	let h = 99991;
	const rng = () => {
		h ^= h << 13;
		h ^= h >>> 17;
		h ^= h << 5;
		return ((h >>> 0) % 100000) / 100000;
	};
	for (let n = 0; n < spins; n += 1) {
		let seen = 0;
		for (let reel = 0; reel < columns.length; reel += 1) {
			const col = columns[reel];
			const stop = Math.floor(rng() * col.length);
			for (let row = 0; row < rows[reel]; row += 1) {
				if (scatterNames.has(col[(stop + row) % col.length])) seen += 1;
			}
		}
		if (seen >= triggerCount) hits += 1;
	}

	const p = hits / spins;
	// The spins a RETRIGGER awards, not the spins the feature starts with — the
	// branching factor is how many more each retrigger adds.
	const awarded = awardedOnRetrigger;
	const expansion = awarded * p;
	return {
		strip: stripId,
		triggerProbability: p,
		awarded,
		expansion,
		// The mean round length as a multiple of the spins awarded.
		roundMultiplier: expansion >= 1 ? Infinity : 1 / (1 - expansion),
		ok: expansion <= RETRIGGER_LIMIT.hard,
		comfortable: expansion <= RETRIGGER_LIMIT.safe,
	};
}

/**
 * How much of the board a sticky-wild round ends up owning.
 *
 * ── Why this needs a number and not a shrug ─────────────────────────────────
 * Sticky wilds never leave, so the board fills monotonically and the paytable
 * stops describing the game some way into the round. The failure is invisible on
 * a single spin and invisible to balanceSpec, which models the BASE board.
 *
 * The model is the naive one — each cell is wild by the end of spin n with
 * probability 1 - (1-p)^n — and the obvious objection is that lines strips carry
 * WILD STACKS, so cells in a column are not independent and the model should
 * under-report. Measured against 2,000 simulated rounds on a generated 5x3 game
 * (FR0 wild density 0.0545), it does not: model 6.91 stuck cells at spin 10
 * against 6.95 measured, and within 1% at every spin from 1 to 14. Stacking
 * changes WHICH cells stick together, not how many stick.
 *
 * The multiplier load is the second half and the part that actually costs RTP.
 * A cell that sticks on spin k is worth min(start + step*(spins-1-k), cap) by the
 * end, so the expected total on the board at the last spin is the sum of that
 * over the spins weighted by how many cells stick on each. It is an upper bound
 * on what any single win can collect, because apply_added_symbol_mult() SUMS only
 * the wilds actually on the winning line — but it is the right order of magnitude
 * and it is what runs away.
 */
export const STICKY_SATURATION_LIMIT = { comfortable: 0.35, warn: 0.5 };

export function stickySaturation(spec, { alpha } = {}) {
	const options = spec.game?.stickyMultiplierWilds;
	if (!options) return null;
	const cfg = options === true ? {} : options;

	const mechanic = spec._mechanic ?? getMechanic(spec.game.mechanic);
	const stripId = stripProfileFor(mechanic, 'FR0') ? 'FR0' : 'BR0';
	const columns = stripColumns(spec, stripId, { alpha, withScatters: true });
	const wild = spec.symbols.find((sym) => sym.special?.includes('wild'))?.name;
	if (!wild) return null;

	const total = columns.reduce((sum, col) => sum + col.length, 0);
	const wilds = columns.reduce(
		(sum, col) => sum + col.filter((name) => name === wild).length,
		0,
	);
	const p = total ? wilds / total : 0;

	const cells = spec.game.reels.rows.reduce((sum, r) => sum + r, 0);
	// The LONGEST round the trigger table can award, not the average — the
	// saturation question is about the round that goes furthest.
	const awarded = Math.max(
		spec.freeSpins?.awardedSpins ?? 10,
		...Object.values(spec.freeSpins?.spinsByCount ?? {}).map(Number).filter(Number.isFinite),
	);

	const start = cfg.start ?? 2;
	const step = cfg.step ?? 1;
	const cap = cfg.cap ?? 25;

	const stuckFraction = 1 - (1 - p) ** awarded;
	let multiplierLoad = 0;
	for (let k = 0; k < awarded; k += 1) {
		const newlyStuck = cells * (1 - p) ** k * p;
		multiplierLoad += newlyStuck * Math.min(start + step * (awarded - 1 - k), cap);
	}

	return {
		strip: stripId,
		wildDensity: p,
		cells,
		spins: awarded,
		stuckAtEnd: cells * stuckFraction,
		stuckFraction,
		// The ceiling a single win could collect if every stuck wild were on it.
		multiplierLoad,
		ok: stuckFraction <= STICKY_SATURATION_LIMIT.warn,
		comfortable: stuckFraction <= STICKY_SATURATION_LIMIT.comfortable,
	};
}

/**
 * How many mechanics are piling into the FREE GAME, which this model cannot see.
 *
 * ── The blind spot this covers ──────────────────────────────────────────────
 * balanceSpec evaluates the base board with no multipliers, no cascades and no
 * feature. That is a deliberate scope and usually the right one — but it means a
 * spec can come back "in band" and still be unshippable, because everything that
 * makes the FEATURE rich is invisible to it.
 *
 * Measured: a cluster game stacking expanding wilds, guaranteed cascade wilds,
 * random wilds, a wild spawner, doubling grid multipliers and a doubling global
 * multiplier modelled at 0.90x of target on the base board — and its CHEAPEST
 * free-spin round paid 12,656x against an optimiser target of 185x. The median
 * feature hit the 25,000x cap. Every one of the six mechanics worked correctly;
 * together they left no distribution to optimise.
 *
 * The model cannot price them, so it counts them and says so. Weaker than a
 * number, and much better than silence.
 */
export const FEATURE_LOAD_LIMIT = { comfortable: 2, warn: 4 };

export function featureLoad(spec) {
	const g = spec.game ?? {};
	const carried = [];

	// Wild injection: each puts more wilds on a feature board, and on a cluster
	// grid a wild joins every group it touches.
	if (g.randomWilds) carried.push({ id: 'randomWilds', kind: 'wild injection' });
	if (g.guaranteedCascadeWild) carried.push({ id: 'guaranteedCascadeWild', kind: 'wild injection' });
	if (g.wildSpawner) carried.push({ id: 'wildSpawner', kind: 'wild injection' });
	for (const symbol of spec.symbols ?? []) {
		for (const tag of symbol.behaviors ?? []) {
			if (tag === 'expanding') carried.push({ id: `${symbol.name}:expanding`, kind: 'wild injection' });
			if (tag === 'sticky') carried.push({ id: `${symbol.name}:sticky`, kind: 'accumulation' });
		}
	}

	// Multiplier growth: each is a separate multiplicative axis on the same win.
	if (g.gridMultipliers) {
		carried.push({
			id: 'gridMultipliers',
			kind: 'multiplier',
			doubling: (g.gridMultipliers.growth ?? 'increment') === 'double',
		});
	}
	if (g.globalMultiplierPerSpin) {
		carried.push({
			id: 'globalMultiplier',
			kind: 'multiplier',
			doubling: (g.globalMultiplier?.growth ?? 'increment') === 'double',
		});
	}

	// Round extension: more spins is more chances for everything above.
	if (spec.freeSpins?.resetOnSymbol) carried.push({ id: 'freeSpinReset', kind: 'round extension' });
	if (spec.freeSpins?.retrigger) carried.push({ id: 'retrigger', kind: 'round extension' });

	const doubling = carried.filter((c) => c.doubling).length;
	return {
		mechanics: carried,
		count: carried.length,
		doubling,
		// Two doubling multipliers on one win is multiplicative in the ceiling AND
		// in how often it is reached — the specific shape that made every feature a
		// max win.
		severe: carried.length > FEATURE_LOAD_LIMIT.warn || doubling >= 2,
		ok: carried.length <= FEATURE_LOAD_LIMIT.comfortable,
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

	// On a tumbling mechanic the hit rate sets the expected cascade length, so it
	// is calibrated for and not merely reported. See CASCADE_LIMITS.
	const tumbles = Boolean(mechanic.tumbles);
	const asDesigned = estimateStripEv(spec, stripColumns(spec, 'BR0'), {
		spins,
		seed: 'balance',
	});
	const calibrated = calibrateAlpha(spec, {
		target: target.baseEv,
		spins,
		maxHitProbability: tumbles ? CASCADE_LIMITS.ordinary : null,
		// A cascading game solves frequency for the hit rate and corrects the level
		// with the paytable; everything else solves frequency for the level. See
		// the note on calibrateAlpha.
		targetHitRate: tumbles ? target.baseHitRate : null,
	});

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

	// ── cascade safety ───────────────────────────────────────────────────────
	// Measured on every strip, because the one that hung a simulation was the CAP
	// strip, not the base strip — and the cap strip is the one nothing else
	// looks at.
	const cascade = [];
	if (tumbles) {
		for (const stripId of ['BR0', 'FR0', 'WCAP', 'FRWCAP']) {
			const profile = stripProfileFor(mechanic, stripId);
			if (!profile) continue;
			const alphaFor = calibrated.alpha;
			const measured = estimateStripEv(spec, stripColumns(spec, stripId, { alpha: alphaFor }), {
				spins: Math.min(spins, 4000),
				seed: `cascade:${stripId}`,
			});
			const p = 1 / measured.hitRate;
			const limit = profile.cap ? CASCADE_LIMITS.cap : CASCADE_LIMITS.ordinary;
			cascade.push({
				strip: stripId,
				hitProbability: p,
				expectedDrops: p >= 1 ? Infinity : 1 / (1 - p),
				limit,
				ok: p <= limit,
			});
		}
	}
	const cascadeRisk = cascade.filter((c) => !c.ok);

	const retrigger = retriggerSafety(spec, { alpha: calibrated.alpha });
	const load = featureLoad(spec);
	const sticky = stickySaturation(spec, { alpha: calibrated.alpha });

	const findings = [];
	if (!load.ok) {
		const detail = load.mechanics.map((m) => m.id).join(', ');
		findings.push(
			`${load.count} mechanics enrich the FREE GAME (${detail})` +
				(load.doubling >= 2 ? `, ${load.doubling} of them DOUBLING multipliers` : '') +
				`. Everything above models the base board only — no multipliers, no cascades, no ` +
				`feature — so none of that is priced here. A spec measured in band on the base game ` +
				`can still have a feature with no distribution to optimise.`,
		);
		if (load.severe) {
			findings.push(
				`Measured on a game with six of these: the CHEAPEST free-spin round paid 12,656x ` +
					`against an optimiser target of 185x, and the median feature hit the cap. Every ` +
					`mechanic worked; together they left nothing to reweight. Simulate a few hundred ` +
					`rounds and read the freegame distribution before going further.`,
			);
		}
	}
	if (retrigger && !retrigger.ok) {
		findings.push(
			`A free-spin round expands ${fmt(retrigger.roundMultiplier)}x through retriggers: the ` +
				`${retrigger.strip} strip triggers on ${pctOf(retrigger.triggerProbability)} of boards and ` +
				`each trigger awards ${retrigger.awarded} more spins, so every spin awards ` +
				`${fmt(retrigger.expansion)} on average. Above 1 the round never ends; even at this level ` +
				`the tail is long enough that the simulation spends minutes inside single rounds.`,
		);
		findings.push(
			`Thin the scatters on the free-game strip (STRIP_PROFILES.${retrigger.strip}.scatterPct), ` +
				`award fewer spins per retrigger, or set freeSpins.retrigger: false. Every shipped ` +
				`sample carries roughly a third fewer scatters on its free strip than its base strip.`,
		);
	}
	if (sticky && !sticky.comfortable) {
		findings.push(
			`Sticky wilds own ${fmt(sticky.stuckAtEnd)} of ${sticky.cells} cells (` +
				`${pctOf(sticky.stuckFraction)}) by the last spin of a ${sticky.spins}-spin round: the ` +
				`${sticky.strip} strip is ${pctOf(sticky.wildDensity)} wild and a stuck cell never comes ` +
				`back. The multipliers on that board sum to about ${fmt(sticky.multiplierLoad)}x, none ` +
				`of which balanceSpec prices — it models the BASE board.`,
		);
		findings.push(
			`Nothing downstream FAILS on this, which is why it needs saying here. Measured on a ` +
				`generated 5x3 lines game against the same game with the mechanic off: raw RTP 21.8x ` +
				`to 338.4x, and after optimisation both games report 96.50% RTP, a 1-in-3.4 hit rate ` +
				`and the same 0.5% feature frequency. math:validate passes every rule on both. What ` +
				`actually moved is the weight INSIDE the feature — mean free-game payout went 34x to ` +
				`73x on the plain game (weighted UP toward target) and 3,329x to 73x on the sticky one ` +
				`(weighted DOWN 45x). The optimiser holds RTP by leaning almost all the weight onto the ` +
				`poorest sticky rounds, so the saturated boards the mechanic is FOR are simulated and ` +
				`then rarely served.`,
		);
		findings.push(
			`The upside from the same measurement: the sticky game's free rounds reach the 5,000x cap ` +
				`on their own, against 290x for the plain game. If max win is meant to come out of the ` +
				`feature rather than a forced wincap round, this is the mechanic that gets it there.`,
		);
		findings.push(
			`Thin the wilds on ${sticky.strip}, award fewer spins, or lower ` +
				`game.stickyMultiplierWilds.cap. The saturation is driven by the strip's wild density ` +
				`and the round length, not by the ladder — the ladder only sets what the saturated ` +
				`board is worth.`,
		);
	}
	for (const risk of cascadeRisk) {
		findings.push(
			`${risk.strip} wins ${pctOf(risk.hitProbability)} of boards, above the ${pctOf(risk.limit)} ` +
				`limit for a cascading game — one round would run ${fmt(risk.expectedDrops)} drops on ` +
				`average. The simulation does not fail on this, it HANGS: every forced max-win attempt ` +
				`becomes a very long round and the re-roll loop does thousands of them.`,
		);
	}
	if (cascadeRisk.length) {
		const payable = spec.symbols.filter((s) => s.paytable && !s.special?.includes('scatter')).length;
		const capRisk = cascadeRisk.some((c) => c.strip.includes('CAP'));
		findings.push(
			capRisk && cascadeRisk.length === 1
				? `Only the cap strip is over. That strip is meant to run hot — it has to sustain a long ` +
					`round to reach the cap at all — so the fix is its wild density in ` +
					`reelDesign.js, not the paytable. Raise the minimum win size, or cut the cap strip's ` +
					`wildPct: a wild joins every group it touches, so on a cluster board wild density ` +
					`translates almost directly into hit rate.`
				: `Add payable symbols (this game has ${payable}) or shrink the grid. With few symbols ` +
					`on a large grid some group of the minimum size lands on almost every board — the ` +
					`shipped 0_0_cluster sample wins 38% of boards on the same 7x7.`,
		);
	}

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
		tumbles,
		cascade,
		cascadeSafe: cascadeRisk.length === 0,
		retrigger,
		retriggerSafe: !retrigger || retrigger.ok,
		featureLoad: load,
		sticky,
		stickySafe: !sticky || sticky.ok,
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

const pctOf = (v) => `${(v * 100).toFixed(0)}%`;

const fmt = (n) =>
	!Number.isFinite(n)
		? '∞'
		: n >= 100
			? Math.round(n).toLocaleString('en-US')
			: Math.round(n * 100) / 100;
