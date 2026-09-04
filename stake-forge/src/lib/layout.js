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
 * The size to draw at, and why. Refuses a value that would overflow the
 * narrowest stage — a board wider than portrait is clipped, not just tight.
 */
export function symbolSizeFor(spec) {
	const reels = spec.game.reels.count;
	const rows = Math.max(...spec.game.reels.rows);
	const requested = Number(spec.game.symbolSize) || DEFAULT_SYMBOL_SIZE;

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
