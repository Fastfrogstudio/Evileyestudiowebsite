/**
 * Placeholder SCREEN art — the backdrop and the board frame.
 *
 * ── Why this exists, when placeholderArt.js explicitly said it could not ─────
 * That module's docblock drew the line honestly: symbols are reachable because
 * SYMBOL_INFO_MAP accepts `{ type: 'sprite' }`, but screens hardcode
 * <SpineProvider key="..."> and play named animation tracks, so a flat PNG
 * cannot stand in for one *without changing the component*.
 *
 * The conclusion drawn from that was "leave screens on the sample app's art,
 * which already looks like something". Screenshotting a real build is what
 * showed the cost of that: the game reads as the SDK's mine-themed sample, and
 * a reviewer cannot tell which pixels are ours. Inheriting a finished-looking
 * identity is worse than showing an obvious hole, because only one of the two
 * is visible.
 *
 * So the component DOES get changed — see patchScreenComponents in
 * screenPatch.js — and this module draws what it points at.
 *
 * ── What these are supposed to look like ────────────────────────────────────
 * Neutral, composed, and unmistakably not finished. A flat grey box is honest
 * but makes the board unreadable and the game unreviewable; a handsome themed
 * backdrop would recreate the exact problem being fixed, one theme later. So:
 * a quiet graded ground with a vignette, a faint hatch, and no motif of any
 * kind. Base and feature grounds are given different hues because "did the
 * background change when free spins started" is a real thing to check, and
 * identical placeholders would hide it.
 */

import { Canvas } from './png.js';
import { drawText, measureText, unsupportedChars } from './font5x7.js';

/** Big enough to scale up to the largest SDK stage without banding. */
export const BACKDROP_SIZE = { width: 1200, height: 1200 };

/**
 * Ground colours per game type, as [top, bottom] of a vertical grade.
 *
 * Both are desaturated and dark: the board sits on top of this and the symbols
 * have to stay legible, which a saturated ground would fight.
 */
const GROUNDS = {
	basegame: { top: [22, 26, 36], bottom: [13, 15, 21], accent: [92, 106, 140] },
	freegame: { top: [38, 24, 46], bottom: [19, 13, 26], accent: [138, 98, 152] },
};

/** Label colour — readable on both grounds, quiet enough not to draw the eye. */
const LABEL = [120, 132, 158, 210];

/**
 * A radial darkening toward the edges.
 *
 * Done as an alpha-blended black overlay rather than by recomputing the grade,
 * so the vignette strength is independent of the ground colours and the two
 * variants stay visually consistent.
 */
function vignette(canvas, strength = 0.55) {
	const { width, height } = canvas;
	const cx = (width - 1) / 2;
	const cy = (height - 1) / 2;
	const maxDist = Math.hypot(cx, cy);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const t = Math.hypot(x - cx, y - cy) / maxDist;
			// Ease in, so the centre stays clean and the falloff lives at the edge.
			const a = Math.round(255 * strength * t * t);
			if (a > 0) canvas.set(x, y, [0, 0, 0, a]);
		}
	}
}

/**
 * The backdrop behind the board.
 *
 * @param {object} opts
 * @param {'basegame'|'freegame'} [opts.variant]
 * @returns {Buffer} PNG
 */
export function renderBackdrop({ variant = 'basegame', width, height } = {}) {
	const w = width ?? BACKDROP_SIZE.width;
	const h = height ?? BACKDROP_SIZE.height;
	const ground = GROUNDS[variant] ?? GROUNDS.basegame;
	const canvas = new Canvas(w, h);

	canvas.fillVerticalGradient(0, 0, w, h, ground.top, ground.bottom);
	vignette(canvas);

	// A single horizon rule, low and faint. It gives the eye something to place
	// the board against without implying a setting — the point is that this
	// backdrop has no theme, not that it has a boring one.
	const horizon = Math.round(h * 0.62);
	canvas.fillRect(0, horizon, w, 1, [...ground.accent, 38]);

	// A very faint diagonal hatch, as the "this is not finished" signal.
	//
	// A corner text label was tried first and was the wrong tool: the component
	// draws this through normalBackgroundLayout({ scale: 0.5 }), which crops and
	// offsets it, so the label landed half off-screen and on top of the UI. A
	// hatch reads the same at every crop and cannot collide with anything.
	const spacing = Math.round(w / 26);
	for (let d = -h; d < w + h; d += spacing) {
		for (let y = 0; y < h; y += 1) {
			const x = d + y;
			if (x >= 0 && x < w) canvas.set(x, y, [...ground.accent, 12]);
		}
	}

	return canvas.toPng();
}

/**
 * The frame drawn around the board.
 *
 * Transparent through the middle — the reels are drawn under it — with a border
 * and corner ticks. Rendered at the board's own aspect ratio rather than square,
 * because the component stretches this to the board and a square source would
 * put visibly different corner radii on the long and short edges.
 *
 * @param {object} opts
 * @param {number} opts.reels
 * @param {number} opts.rows
 * @returns {Buffer} PNG
 */
export function renderBoardFrame({ reels = 5, rows = 3, cell = 240, label = '' } = {}) {
	const inset = Math.round(cell * 0.22);
	const w = reels * cell + inset * 2;
	const h = rows * cell + inset * 2;
	const canvas = new Canvas(w, h);

	const border = Math.max(3, Math.round(cell * 0.05));
	const accent = [104, 118, 152, 255];
	const shadow = [8, 10, 16, 170];

	// A soft dark plate behind the reels, so symbols do not sit directly on the
	// backdrop grade and lose their edges.
	canvas.fillRoundRect(inset, inset, w - inset * 2, h - inset * 2, Math.round(cell * 0.12), shadow);

	// The border itself, drawn just outside the plate.
	canvas.strokeRect(inset, inset, w - inset * 2, h - inset * 2, accent, border);

	// Corner ticks — enough to read as a deliberate frame at a glance, and to
	// make it obvious where the board's bounds are when checking the layout.
	const tick = Math.round(cell * 0.38);
	for (const [cx, sx] of [
		[inset, 1],
		[w - inset - 1, -1],
	]) {
		for (const [cy, sy] of [
			[inset, 1],
			[h - inset - 1, -1],
		]) {
			for (let i = 0; i < tick; i += 1) {
				for (let t = 0; t < border; t += 1) {
					canvas.set(cx + sx * i, cy + sy * t, accent);
					canvas.set(cx + sx * t, cy + sy * i, accent);
				}
			}
		}
	}

	if (label) {
		const scale = Math.max(2, Math.round(cell / 90));
		const text = label.toUpperCase();
		// This font has no ':' and drawText substitutes '?' for anything unknown,
		// so a label written with one shipped as "PLACEHOLDER? BOARDFRAME" with
		// nothing to explain it. Refuse rather than draw nonsense.
		const missing = unsupportedChars(text);
		if (missing.length) {
			throw new Error(
				`renderBoardFrame label "${label}" uses characters this font cannot draw: ${missing.join(' ')}. ` +
					`Use only A-Z 0-9 and - _ . / + ! ? # *`,
			);
		}
		const tw = measureText(text, scale);
		drawText(canvas, text, Math.round((w - tw) / 2), Math.round(inset * 0.28), LABEL, scale);
	}

	return canvas.toPng();
}
