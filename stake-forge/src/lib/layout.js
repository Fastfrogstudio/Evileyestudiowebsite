/**
 * How big the board is drawn.
 *
 * ── The stage this is measured against ──────────────────────────────────────
 * The SDK does not scale to the browser window directly. utils-layout picks a
 * fixed LOGICAL stage per layout type and scales that to fit the canvas, so a
 * board's size is only meaningful as a fraction of those stages. The sample
 * declares four, and they are not the same shape:
 *
 *   desktop    1422 x 800      landscape  1600 x 900
 *   tablet     1000 x 1000     portrait    800 x 1422
 *
 * One SYMBOL_SIZE serves all four, and PORTRAIT is the one that binds: it is
 * the narrowest stage, so it runs out of width first.
 *
 * ── Why the sample's 120 is not the right default ───────────────────────────
 * At SYMBOL_SIZE 120 a 5-reel board is 600px wide, which is:
 *
 *   portrait   75% of stage width      desktop    42%
 *
 * Reasonable in portrait, loose on desktop — which is what makes a landscape
 * screenshot look like the board is floating in the middle of nothing.
 *
 * Published guidance for 2026 puts over 70% of slot sessions on mobile, with
 * studios designing portrait-first and treating desktop as secondary. So the
 * size is chosen by what portrait wants and desktop follows:
 *
 *   size  portrait  desktop
 *   120       75%      42%    the sample
 *   140       88%      49%    default here
 *   150       94%      53%    no margin left in portrait
 *
 * 140 fills portrait the way a mobile slot is expected to while keeping a
 * margin either side, and takes desktop with it.
 */
/**
 * The share of the tightest stage a board should fill.
 *
 * Chosen from the portrait-first research and then verified by rendering: at
 * 0.88 a 5x3 board fills portrait edge to edge with a visible margin either
 * side, which is where mobile slots sit.
 */
export const TARGET_COVERAGE = 0.88;

/**
 * Kept for the 5x3 case this was originally measured on, and as the ceiling no
 * grid may exceed — past this the art is being upscaled rather than fitted.
 */
export const DEFAULT_SYMBOL_SIZE = 140;

/** The logical stages the SDK scales to fit, per layout type. */
export const MAIN_STAGES = {
	desktop: { width: 1422, height: 800 },
	landscape: { width: 1600, height: 900 },
	tablet: { width: 1000, height: 1000 },
	portrait: { width: 800, height: 1422 },
};

/** How much of each stage a board of this size covers. */
export function boardCoverage(symbolSize, { reels, rows }) {
	const width = symbolSize * reels;
	const height = symbolSize * rows;
	return Object.fromEntries(
		Object.entries(MAIN_STAGES).map(([name, stage]) => [
			name,
			{ width: width / stage.width, height: height / stage.height },
		]),
	);
}

/**
 * The largest cell size that keeps EVERY stage inside the coverage target.
 *
 * ── Why this is derived and not a constant ──────────────────────────────────
 * The first version of this shipped a flat 140, chosen by measuring a 5x3 board.
 * That silently only works for 5-reel games. Checked against the grids the
 * reference corpus actually records:
 *
 *   5x3 / 5x4 lines    88% of portrait — the shape it was measured on
 *   6x5 scatter       105% of portrait — CLIPPED
 *   7x7 cluster       123% of desktop  — CLIPPED
 *   8x8 cluster       140% of desktop  — CLIPPED
 *
 * 6x5 is the Sweet Bonanza / Gates of Olympus shape and 7x7 is Sugar Rush and
 * Reactoonz, so the two most common non-lines boards in the market were both
 * broken. Note the binding stage CHANGES with the grid — portrait runs out of
 * width on a 6-reel board, desktop runs out of HEIGHT on a 7-row one — which is
 * why a single measured number could never have covered it.
 */
export function fitSymbolSize({ reels, rows, coverage = TARGET_COVERAGE } = {}) {
	let limit = Infinity;
	for (const stage of Object.values(MAIN_STAGES)) {
		limit = Math.min(limit, (stage.width * coverage) / reels, (stage.height * coverage) / rows);
	}
	return Math.max(1, Math.min(DEFAULT_SYMBOL_SIZE, Math.floor(limit)));
}

/**
 * The size to draw at, and why. Refuses a value that would overflow the
 * narrowest stage — a board wider than portrait is clipped, not just tight.
 */
export function symbolSizeFor(spec) {
	const reels = spec.game.reels.count;
	const rows = Math.max(...spec.game.reels.rows);
	const requested = Number(spec.game.symbolSize) || fitSymbolSize({ reels, rows });

	const coverage = boardCoverage(requested, { reels, rows });
	const widest = Math.max(...Object.values(coverage).map((c) => c.width));
	const tallest = Math.max(...Object.values(coverage).map((c) => c.height));

	return {
		size: requested,
		coverage,
		// 1.0 would be edge to edge with no margin; past it the board is cut off.
		overflows: widest > 1 || tallest > 1,
	};
}
