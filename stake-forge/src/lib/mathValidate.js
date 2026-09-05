/**
 * The honesty gate.
 *
 * `forge verify` proves a game EXECUTES. `forge math:report` says what it pays.
 * This says whether what it pays is SHIPPABLE — each rule stated, each measured,
 * each pass or fail carrying the number it was judged on, so a failure names its
 * own fix instead of sending someone back to read a distribution by eye.
 *
 * ── Where the rules come from, and how confident each one is ────────────────
 * Two of them are arithmetic and are certain:
 *
 *   max win reached      If no simulated round pays the cap, the game cannot pay
 *                        it, whatever the config claims. Non-negotiable.
 *   RTP on target        The optimiser's whole job. Off target after optimising
 *                        means the optimiser did not converge or was not run.
 *
 * The rest are Stake's approval criteria as we understand them, gathered from
 * research and cross-checked against the SDK's own docs where they overlap.
 * They are NOT quoted from a contract we hold, and this file says so rather than
 * implying an authority it does not have. Confirm before a submission:
 *
 *   cap frequency        max win obtainable at roughly 1-in-20,000,000
 *   hit-rate band        base mode paying roughly 1-in-3 to 1-in-8, not 1-in-20+
 *   no gaps              every win band between nothing and the cap reachable
 *   modes agree          every extra bet mode within 0.5pp of the base mode's RTP
 *
 * And one is ours, not Stake's, because a game can satisfy every rule above and
 * still not be the game that was asked for:
 *
 *   volatility in band   the richest 1% of rounds carrying the share of RTP the
 *                        chosen profile implies. A "high volatility" game whose
 *                        money arrives evenly is a low volatility game with a
 *                        label on it. ADVISORY — it reports, it does not fail
 *                        the gate; see VOLATILITY_BANDS for why.
 */

import { VOLATILITY_PROFILES } from './optimisation.js';
import {
	OPERATIVE_WINCAP_HIT_RATE,
	WINCAP_FREQUENCY_READINGS,
	failedReadings,
} from './approvalCriteria.js';

/**
 * Re-exported from the single source of truth. The threshold is CONTESTED and
 * this file used to hard-code it independently of optimisation.js, so a game
 * could in principle have been built to one number and validated against
 * another. See src/lib/approvalCriteria.js.
 */
export { OPERATIVE_WINCAP_HIT_RATE as TARGET_WINCAP_HIT_RATE };

/**
 * How far a measured wincap frequency may sit from 1-in-20M.
 *
 * Wide (a factor of 5 either way) on purpose. The frequency is set by an RTP
 * allocation the optimiser then honours to its own precision, and a 1,000-round
 * simulation resolves a 1-in-20M event by weight rather than by observation. A
 * tighter band would fail on sampling noise and teach everyone to ignore it.
 */
const WINCAP_TOLERANCE = 5;

/**
 * Volatility, as the share of RTP delivered by the richest 1% of rounds.
 *
 * ── Why this measure, and why it is ADVISORY ────────────────────────────────
 * The first version compared mean to median and failed a game measuring 7.68
 * against a band of 20+. That band was invented, not measured, and the game it
 * failed was fine — RTP on target, hit rate 1 in 5.4 against a 1 in 5.5 target,
 * every other rule green. A gate that fails a correct game on a number nobody
 * derived teaches people to ignore the gate.
 *
 * Two changes followed. The measure is now the top-1% RTP share, which is the
 * statistic volatility is normally discussed in and is bounded 0–1 rather than
 * unbounded. And this check WARNS rather than fails: the bands below are our
 * declaration of what the volatility profiles are meant to mean, not something
 * measured off certified games. None of the shipped math-sdk samples ships with
 * simulation output, so there was nothing to calibrate against.
 *
 * Treat a warning here as "the game is not the shape you asked for", and the
 * fix as the volatility profile in optimisation.js, not the game.
 */
const VOLATILITY_BANDS = {
	low: { min: 0, max: 0.5 },
	medium: { min: 0.2, max: 0.8 },
	high: { min: 0.4, max: 1 },
	// Above `high` the bands only have a floor worth stating. The top 1% of
	// rounds carrying nearly all the RTP is the DEFINITION of these tiers, not a
	// symptom of anything, so the ceiling stays at 1 and the floor does the work.
	very_high: { min: 0.6, max: 1 },
	extreme: { min: 0.75, max: 1 },
};

/** The win bands a game should have no holes in, as fractions of the cap. */
const WIN_BANDS = [
	{ label: 'small', from: 0, to: 0.001 },
	{ label: 'medium', from: 0.001, to: 0.02 },
	{ label: 'large', from: 0.02, to: 0.2 },
	{ label: 'huge', from: 0.2, to: 1 },
];

/**
 * What share of total RTP the richest `fraction` of rounds delivers.
 *
 * Weighted throughout: the lookup table is a weighted distribution, so taking
 * the top 1% of ROWS rather than the top 1% of weight would measure the shape of
 * the simulation's sampling, not the shape of the game.
 */
export function topShareOfRtp(rows, fraction) {
	const totalWeight = rows.reduce((sum, r) => sum + r.weight, 0);
	const totalPay = rows.reduce((sum, r) => sum + r.weight * r.payout, 0);
	if (!totalWeight || !totalPay) return 0;

	const sorted = [...rows].sort((a, b) => b.payout - a.payout);
	const cutoff = totalWeight * fraction;
	let seenWeight = 0;
	let seenPay = 0;
	for (const row of sorted) {
		// The row straddling the cutoff contributes only its share, so the answer
		// does not jump around with how the simulation happened to bucket rounds.
		const take = Math.min(row.weight, cutoff - seenWeight);
		if (take <= 0) break;
		seenWeight += take;
		seenPay += take * row.payout;
	}
	return seenPay / totalPay;
}

/** Total weight of a lookup table, used in more than one check. */
function totalWeightOf(rows) {
	return rows.reduce((sum, r) => sum + r.weight, 0);
}

const pct = (v) => `${(v * 100).toFixed(2)}%`;
const fmt = (n) =>
	!Number.isFinite(n) ? 'never' : n >= 1000 ? Math.round(n).toLocaleString('en-US') : Math.round(n * 100) / 100;

/**
 * Validate one bet mode.
 *
 * `rows` are the mode's lookup-table rows ({ weight, payout }), payout in
 * hundredths of the bet, exactly as readLookupTable returns them.
 */
/**
 * How much of the designed feature actually ships.
 *
 * ── The hole this closes ────────────────────────────────────────────────────
 * Every other rule here reads the OPTIMISED table, where RTP, hit rate and the
 * win bands are correct by construction — that is what the optimiser is for. So
 * a mechanic can inflate the raw feature by any amount and the gate stays green:
 * measured on a sticky-wilds game against the identical game without it, raw RTP
 * went 21.8x to 338.4x and BOTH games reported 96.50% RTP, a 1-in-3.4 hit rate
 * and the same feature frequency. Every rule passed on both.
 *
 * What actually changed was the weight INSIDE the feature. The optimiser holds
 * RTP by leaning on the cheapest feature rounds, and the richer the raw feature,
 * the harder it has to lean. Taken far enough, the rounds the mechanic exists to
 * produce are simulated and then almost never served — the designed feature and
 * the shipped feature stop being the same thing, and nothing says so.
 *
 * Measured on a game stacking six enriching mechanics: 96.9% of the base-mode
 * feature weight sat on ONE round of the fifty simulated. It passed every other
 * rule.
 *
 * ── Why the metric is a FRACTION and not a count ────────────────────────────
 * Effective sample size, ESS = (sum w)^2 / sum(w^2), is the standard "how many
 * samples is this weighted set really worth". The obvious rule is a floor on it:
 * fewer than N distinct feature rounds and the feature is repetitive.
 *
 * That rule is wrong, and the arithmetic says so. ESS scales with the
 * simulation, so a floor on it mostly measures how long you simulated. Verified
 * by re-running one game at 5x the rounds — ESS went 9.7 to 30.2 while the
 * FRACTION barely moved, 4.8% to 3.0%. Projected to the 100,000-round run the
 * README recommends for production, every game measured here clears any floor
 * worth setting, including the six-mechanic game whose feature is genuinely one
 * round: ESS 1.1 at 1,000 rounds becomes ~106 at 100,000.
 *
 * So the absolute count is reported as context and the FRACTION is the rule. It
 * is scale-free, and it says the thing that matters: what share of the feature
 * rounds the simulation produced carry any real weight in the shipped game. At
 * 2.1% the optimiser is discarding 98% of the feature it was given. At 42% it is
 * keeping most of it.
 *
 * ADVISORY. This is ours, not a Stake criterion, and the 5% line is a judgement
 * about where "the optimiser discards almost all of it" begins, not a calibrated
 * figure — so it reports loudly and never fails a build, like volatility-shape.
 */
export const FEATURE_VARIETY = { minFraction: 0.05 };

export function featureVariety(rows) {
	const feature = (rows ?? []).filter((r) => r.feature && r.weight > 0);
	if (feature.length < 5) return null;

	const total = feature.reduce((sum, r) => sum + r.weight, 0);
	if (!total) return null;
	const sumSquares = feature.reduce((sum, r) => sum + r.weight * r.weight, 0);
	const ess = (total * total) / sumSquares;

	// The most directly interpretable form of the same fact: how few rounds carry
	// almost all of the weight.
	const shares = feature.map((r) => r.weight / total).sort((a, b) => b - a);
	let carried = 0;
	let roundsFor95 = 0;
	for (const share of shares) {
		carried += share;
		roundsFor95 += 1;
		if (carried >= 0.95) break;
	}

	const fraction = ess / feature.length;
	return {
		simulated: feature.length,
		ess,
		fraction,
		roundsFor95,
		ok: fraction >= FEATURE_VARIETY.minFraction,
	};
}

export function validateMode({ name, mode, rows, rawRows, summary, spec, baseRtp, optimised }) {
	const checks = [];
	const target = mode.rtp ?? spec.game.rtp;
	const maxWin = mode.maxWin ?? 5000;
	const volatility = spec.game.volatility ?? 'medium';

	const add = (id, ok, statement, detail) => checks.push({ id, ok, statement, detail });

	// ── 1. the cap is reachable ──────────────────────────────────────────────
	add(
		'max-win-reached',
		summary.maxPayout >= maxWin * 0.999,
		`max win of ${fmt(maxWin)}x is reachable`,
		summary.maxPayout >= maxWin * 0.999
			? `highest round pays ${fmt(summary.maxPayout)}x`
			: `highest round pays ${fmt(summary.maxPayout)}x — ${fmt(maxWin / summary.maxPayout)}x short. ` +
				`Either the wincap distribution is missing from this mode, or the strips cannot ` +
				`produce a capping board (run forge math:balance, then check analyseMaxWin's ceiling).`,
	);

	// ── 2. RTP on target ─────────────────────────────────────────────────────
	// Only meaningful after optimisation: before it, every simulated round is a
	// re-rolled winner and the RTP is above target by construction.
	if (optimised) {
		const delta = summary.rtp - target;
		add(
			'rtp-on-target',
			Math.abs(delta) <= 0.005,
			`RTP within 0.5pp of the ${pct(target)} target`,
			`measured ${pct(summary.rtp)} (${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(2)}pp)`,
		);
	} else {
		add(
			'rtp-on-target',
			null,
			`RTP within 0.5pp of the ${pct(target)} target`,
			'not judged — the optimiser has not run, so every round is a re-rolled winner by design',
		);
	}

	// ── 3. how often the cap pays ────────────────────────────────────────────
	if (summary.wincapHitRate) {
		// Per unit STAKED, not per round. The optimiser works in multiples of the
		// bet, so a 100x bonus buy reaching its cap once in 200,000 rounds is
		// reaching it once in 20,000,000 units staked — the same frequency as the
		// base mode, correctly. Comparing rounds to rounds failed that mode at
		// "0.01x the target" when nothing was wrong with it.
		const cost = mode.cost ?? 1;
		const perUnitStaked = summary.wincapHitRate * cost;
		const ratio = perUnitStaked / OPERATIVE_WINCAP_HIT_RATE;
		// A tick here is a claim about a threshold two sources disagree on, so it
		// passes only when EVERY reading is satisfied — and names any that are not.
		const failed = failedReadings(perUnitStaked, { tolerance: WINCAP_TOLERANCE });
		add(
			'wincap-frequency',
			failed.length === 0,
			`max win pays often enough for every reading of the rule ` +
				`(target 1 in ${OPERATIVE_WINCAP_HIT_RATE.toLocaleString('en-US')} staked)`,
			`measured 1 in ${fmt(summary.wincapHitRate)} rounds` +
				(cost === 1 ? '' : ` at ${cost}x cost = 1 in ${fmt(perUnitStaked)} staked`) +
				` (${fmt(ratio)}x the target). The frequency is chosen, not discovered: it is ` +
				`maxWin ÷ the RTP allocated to the wincap distribution. ` +
				(failed.length
					? `FAILS ${failed.length} of ${WINCAP_FREQUENCY_READINGS.length} readings: ` +
						failed.map((r) => `${r.claim} (${r.source.split('.')[0]})`).join('; ') + '.'
					: `Satisfies all ${WINCAP_FREQUENCY_READINGS.length} readings of the rule. ` +
						`Neither is verified against a document from Stake — CONFIRM before submitting.`),
		);
	} else {
		add('wincap-frequency', false, 'max win pays at a certifiable frequency', 'no round pays the cap at all');
	}

	// ── 4. base hit rate in band ─────────────────────────────────────────────
	// Only for the mode a player actually spins. A bought bonus triggers every
	// round by definition, so a hit rate of 1-in-1 is correct there, not a fault.
	if (!mode.buyBonus && !mode.superspin) {
		const hr = summary.hitRate;
		add(
			'hit-rate',
			hr >= 2 && hr <= 10,
			'base mode pays between 1 in 2 and 1 in 10 rounds',
			`measured 1 in ${fmt(hr)}` +
				(hr > 10 ? ' — too dry; players read a 1-in-20 game as broken' : '') +
				(hr < 2 ? ' — too wet; nearly every spin paying leaves nothing for the feature' : ''),
		);
	}

	// ── 4b. a bought mode's COST must be reachable from its rounds ───────────
	// A buy mode forces the feature every round, so its RTP is entirely the
	// feature's average payout over the entry cost. Get the cost wrong and no set
	// of weights fixes it: the optimiser fails with a message about pig counts
	// rather than about price.
	//
	// The condition is NOT "the mean matches", and this took two wrong versions to
	// get right. Measured on the OPTIMISED table the weighted mean is rtp x cost
	// by construction, so the check passed on every game. Measured on the RAW
	// table the mean is far too high, because every simulated round is re-rolled
	// until it satisfies its criteria — so it flagged four games that had
	// optimised perfectly well.
	//
	// What actually has to be true is that the target sits INSIDE the range of
	// rounds the simulation produced. The optimiser reweights; it needs rounds
	// both above and below the target to weight between. That is exactly the
	// condition, and it is what "pos_pigs=50/50, neg_pigs=0/50" reports failing.
	if (mode.buyBonus) {
		const cost = mode.cost ?? 1;
		const source = (rawRows ?? rows).filter((r) => r.payout > 0);
		const targetAverage = cost * target;
		const payouts = source.map((r) => r.payout / 100).sort((a, b) => a - b);
		const min = payouts[0] ?? 0;
		const max = payouts[payouts.length - 1] ?? 0;
		const reachable = payouts.length > 1 && targetAverage > min && targetAverage < max;
		add(
			'buy-cost-reachable',
			reachable,
			`the ${fmt(cost)}x entry cost is reachable from the rounds simulated`,
			reachable
				? `target average ${fmt(targetAverage)}x sits inside the ${fmt(min)}x–${fmt(max)}x the ` +
					`simulation produced, so the optimiser has rounds on both sides to weight between`
				: `target average ${fmt(targetAverage)}x is ${targetAverage <= min ? 'BELOW' : 'ABOVE'} ` +
					`everything the simulation produced (${fmt(min)}x–${fmt(max)}x). The optimiser can ` +
					`only choose among rounds that exist, so no weighting reaches it. ` +
					(targetAverage <= min
						? `Raise the cost to about ${fmt(min / target)}x or more, or make the feature leaner.`
						: `Lower the cost to about ${fmt(max / target)}x or less, or enrich the feature.`),
		);
	}

	// ── 5. no gaps across the win range ──────────────────────────────────────
	// A HOLE, not a floor. The first version failed a bonus-buy mode for having
	// nothing between 0x and 10x, which is not a gap — at 80x entry every round
	// pays at least 39x, so the distribution has a floor and is continuous above
	// it. A gap is an empty band with populated bands on BOTH sides: pays 5x and
	// 500x but never 50x. That is the shape the rule exists to catch, and the
	// only one a player would experience as a hole.
	const totalWeight = rows.reduce((sum, r) => sum + r.weight, 0);
	const occupancy = WIN_BANDS.map((band) => {
		const from = band.from * maxWin * 100;
		const to = band.to * maxWin * 100;
		const weight = rows
			.filter((r) => r.payout > from && r.payout <= to && r.payout > 0)
			.reduce((sum, r) => sum + r.weight, 0);
		return { band, occupied: weight / totalWeight >= 1e-9 };
	});
	const first = occupancy.findIndex((o) => o.occupied);
	const last = occupancy.map((o) => o.occupied).lastIndexOf(true);
	const holes =
		first === -1
			? []
			: occupancy
					.slice(first, last + 1)
					.filter((o) => !o.occupied)
					.map((o) => `${o.band.label} (${fmt(o.band.from * maxWin)}x-${fmt(o.band.to * maxWin)}x)`);

	const floorBands = first > 0 ? occupancy.slice(0, first).map((o) => o.band.label) : [];
	add(
		'no-gaps',
		holes.length === 0,
		'no holes in the win range — every band between the smallest and largest win pays',
		holes.length
			? `nothing pays in: ${holes.join(', ')}, but bands on both sides do. That is a hole a ` +
				`player would feel as "it never pays anything in between".`
			: `bands ${first + 1}-${last + 1} of ${WIN_BANDS.length} occupied, continuously` +
				(floorBands.length
					? `. Nothing below ${fmt(WIN_BANDS[first].from * maxWin)}x (${floorBands.join(', ')}), which is a ` +
						`FLOOR rather than a gap — normal on a bought mode where the entry cost sets a minimum.`
					: '.'),
	);

	// ── 6. the shape matches the declared volatility ─────────────────────────
	// Base mode only. A bought bonus has a compressed shape by construction —
	// every round is a feature — so holding it to the base game's volatility band
	// fails it for being exactly what it is.
	if (!mode.buyBonus && !mode.superspin) {
		const band = VOLATILITY_BANDS[volatility] ?? VOLATILITY_BANDS.medium;
		const share = topShareOfRtp(rows, 0.01);
		checks.push({
			id: 'volatility-shape',
			// Advisory: it reports, it does not fail the gate. See VOLATILITY_BANDS.
			ok: share >= band.min && share <= band.max ? true : null,
			advisory: true,
			statement:
				`${volatility}-volatility shape — richest 1% of rounds carry ` +
				`${pct(band.min)}–${pct(band.max)} of RTP`,
			detail:
				`measured ${pct(share)}` +
				(share >= band.min && share <= band.max
					? ''
					: share > band.max
						? ' — more top-heavy than the profile asks for; the game plays drier than "' +
							volatility +
							'" implies'
						: ' — flatter than the profile asks for; the money is arriving too evenly for "' +
							volatility +
							'"'),
		});
	}

	// ── 7. every mode agrees with the base mode ──────────────────────────────
	if (optimised && baseRtp !== null && baseRtp !== undefined && name !== 'base') {
		const delta = Math.abs(summary.rtp - baseRtp);
		add(
			'modes-agree',
			delta <= 0.005,
			'within 0.5pp of the base mode',
			`base ${pct(baseRtp)}, this mode ${pct(summary.rtp)} (${(delta * 100).toFixed(2)}pp apart)`,
		);
	}

	// ── how much of the feature actually ships ───────────────────────────────
	// The one rule here that does NOT read a quantity the optimiser makes correct
	// by construction. See featureVariety.
	const variety = featureVariety(rows);
	if (variety) {
		checks.push({
			id: 'feature-variety',
			// Advisory: ours, and the 5% line is a judgement rather than a calibrated
			// figure. It reports loudly; it never fails a build.
			ok: variety.ok ? true : null,
			advisory: true,
			statement:
				`${pct(variety.fraction)} of the simulated free-game rounds carry real weight in the ` +
				`shipped game`,
			detail:
				`${variety.ess.toFixed(1)} effectively distinct round(s) of ${variety.simulated} ` +
				`simulated; ${variety.roundsFor95} carry 95% of the feature weight` +
				(variety.ok
					? ''
					: `. The optimiser is discarding ${pct(1 - variety.fraction)} of the free game it ` +
						`was given: it holds RTP by leaning on the cheapest feature rounds, so the rounds ` +
						`the mechanics exist to produce are simulated and then almost never served. ` +
						`Every other rule passes on this, because RTP, hit rate and the win bands are ` +
						`exactly what the optimiser makes correct. This share is scale-free — a longer ` +
						`simulation raises the round COUNT but not this number, so the fix is to thin ` +
						`whatever is enriching the feature (forge math:balance lists what is stacked), ` +
						`not to simulate more.`),
		});
	}

	const failed = checks.filter((c) => c.ok === false);
	return { name, checks, ok: failed.length === 0, failed: failed.length };
}

/** Every rule this gate applies, and where each one came from. */
export const RULE_PROVENANCE = {
	'max-win-reached': 'arithmetic — a cap no round reaches cannot be paid',
	'rtp-on-target': 'arithmetic — this is what the optimiser is for',
	'wincap-frequency':
		'Stake approval criteria — CONTESTED. Two readings disagree by a factor of two ' +
		'(1-in-20M vs more often than 1-in-10M); this checks against BOTH. See ' +
		'src/lib/approvalCriteria.js. CONFIRM with Stake before submitting.',
	'hit-rate': 'Stake approval criteria (researched, CONFIRM before submitting)',
	'no-gaps': 'Stake approval criteria (researched, CONFIRM before submitting)',
	'modes-agree': 'Stake approval criteria (researched, CONFIRM before submitting)',
	'buy-cost-reachable': 'arithmetic — the optimiser can only weight between rounds that exist',
	'tables-match-books': 'arithmetic — weights that index rounds the books do not contain are meaningless',
	'volatility-shape': 'ours, ADVISORY and uncalibrated — no shipped sample has simulation output to calibrate against',
	'feature-variety':
		'ours, ADVISORY — the one rule that does not read a quantity the optimiser makes correct ' +
		'by construction. The 5% line is a judgement about where "discards almost all of it" begins',
};

export { VOLATILITY_BANDS, WIN_BANDS, VOLATILITY_PROFILES };
