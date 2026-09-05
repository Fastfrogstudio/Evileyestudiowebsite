/**
 * Stake's approval criteria — and, where our sources disagree, the disagreement.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * `math:validate` prints a green tick against each of these. A tick is a claim,
 * and the worst thing this tool can do is make a confident one that is wrong:
 * the maths freezes at approval, so a game built to the wrong number cannot be
 * corrected afterwards without starting again.
 *
 * The max-win frequency is the case that forced this. Two independent readings
 * of Stake's guidelines disagree by a factor of two, and the constant was
 * previously duplicated in optimisation.js and mathValidate.js with no note that
 * it was contested at all.
 *
 * ── The disagreement, and how it is resolved here ───────────────────────────
 * Reading A (this project's own research, carried since the plan): the cap must
 * be obtainable at ABOUT 1-in-20,000,000 staked. Applied with a factor-of-five
 * tolerance, so it accepts 4M to 100M.
 *
 * Reading B (a third-party distillation of Stake's approval guidelines): the
 * cap must be obtainable MORE OFTEN than 1-in-10,000,000. That rejects anything
 * rarer, which includes reading A's own centre.
 *
 * Neither is verified against a document from Stake. Their INTERSECTION is 4M to
 * 10M, so a game built at 1-in-10,000,000 satisfies both — which is why that is
 * the default rather than the number this project started with. Building at the
 * old 20,000,000 would earn a green tick from us and fail reading B outright.
 *
 * When Stake confirms, edit OPERATIVE and delete the reading that lost. Until
 * then the tick says which reading it is asserting.
 */

/** @typedef {{ id: string, hitRate: number, claim: string, source: string }} Reading */

/** @type {Reading[]} */
export const WINCAP_FREQUENCY_READINGS = [
	{
		id: 'about-20m',
		hitRate: 20_000_000,
		claim: 'the cap must be obtainable at about 1-in-20,000,000 staked',
		source:
			"this project's own research, recorded in the plan and carried since. Cross-checked " +
			'against math-sdk docs (1% of RTP at 5000x = 1-in-500k) and 0_0_lines\' own ' +
			'game_optimization.py — but those confirm the ARITHMETIC, not the threshold.',
	},
	{
		id: 'more-often-than-10m',
		hitRate: 10_000_000,
		claim: 'the cap must be obtainable more often than 1-in-10,000,000',
		source:
			'a third-party distillation of Stake Engine approval guidelines ' +
			'(ReSkin-Games/stake-engine-skills, approval-math.md). States it derives from ' +
			'internal Stake guidelines; cites no document.',
	},
];

/**
 * The target every game is built and checked against.
 *
 * Set INSIDE the intersection rather than on its edge. Reading B's threshold is
 * 1-in-10,000,000 and building exactly to it puts every game on a knife-edge:
 * the frequency is realised through integer lookup-table weights, so a game
 * aimed at the boundary lands a hair either side of it and passes or fails on
 * rounding. 5% of headroom costs nothing and makes the check mean something.
 *
 * 1-in-9,500,000 is more frequent than reading B demands and sits at 0.475x
 * reading A's centre, comfortably inside its factor-of-five tolerance.
 */
export const OPERATIVE_WINCAP_HIT_RATE = 9_500_000;

/** True when a measured frequency satisfies EVERY reading, not just the target. */
export function satisfiesAllReadings(perUnitStaked, { tolerance = 5 } = {}) {
	return WINCAP_FREQUENCY_READINGS.every((r) =>
		r.id === 'more-often-than-10m'
			? perUnitStaked <= r.hitRate
			: perUnitStaked >= r.hitRate / tolerance && perUnitStaked <= r.hitRate * tolerance,
	);
}

/** Which readings a measured frequency fails, for saying so out loud. */
export function failedReadings(perUnitStaked, { tolerance = 5 } = {}) {
	return WINCAP_FREQUENCY_READINGS.filter((r) =>
		r.id === 'more-often-than-10m'
			? !(perUnitStaked <= r.hitRate)
			: !(perUnitStaked >= r.hitRate / tolerance && perUnitStaked <= r.hitRate * tolerance),
	);
}

/**
 * The one rule here that is arithmetic rather than policy: choosing how much RTP
 * the wincap distribution gets IS choosing how often the cap pays.
 *
 *     hitRate = maxWin / rtpAllocatedToTheCap
 */
export function wincapRtpAllocation(maxWin, { hitRate = OPERATIVE_WINCAP_HIT_RATE } = {}) {
	const raw = maxWin / hitRate;
	// Never let the cap eat a meaningful share of the game's RTP: above ~2% the
	// rest of the paytable has nothing left to pay with.
	return Math.min(Math.round(raw * 1e5) / 1e5, 0.02);
}
