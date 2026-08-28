/**
 * Placeholder symbol art.
 *
 * ── Scope, and why it stops where it does ────────────────────────────────────
 * This generates SYMBOLS only, and that is a deliberate limit rather than an
 * unfinished one.
 *
 * Symbols are reachable: SYMBOL_INFO_MAP entries may be `{ type: 'sprite',
 * assetKey }`, and pixi-svelte's asset loader registers a `sprite` under its own
 * key (assetLoad.ts PROCESS_METHOD_MAP.sprite), so a flat PNG per symbol renders
 * with no spine anywhere in the pipeline.
 *
 * Screens are not. Background.svelte, FreeSpinIntro.svelte, WinAnimation.svelte
 * and the rest hardcode <SpineProvider key="..."> and play named animation
 * tracks; handing them a PNG would need the components rewritten, not just a
 * different asset. So placeholder runs leave those on the sample app's art,
 * which already looks like something.
 *
 * Colours are derived from the symbol name, so H1 is the same hue on every
 * regenerate and across every game — you learn the board once.
 */

import { Canvas } from './png.js';
import { drawTextCentred, measureText } from './font5x7.js';

export const TILE_SIZE = 256;

/** Base hue per role, so a glance at the board reads as high/low/wild/scatter. */
const ROLE_PALETTE = {
	high: { hue: 18, sat: 0.62, label: 'HIGH' },
	low: { hue: 205, sat: 0.45, label: 'LOW' },
	wild: { hue: 45, sat: 0.85, label: 'WILD' },
	scatter: { hue: 285, sat: 0.7, label: 'SCATTER' },
};

/**
 * Spread symbols across a hue band by their rank within the role.
 *
 * Hashing the name was the obvious approach and produced near-collisions —
 * H1 and H2 landed two degrees apart, which is invisible on a spinning reel.
 * `order` already ranks symbols within a role, so use it: n symbols get n
 * evenly spaced hues, guaranteed distinct however many there are.
 */
function hueForRank(baseHue, rank, total, spread = 54) {
	if (total <= 1) return baseHue;
	const t = (rank - 1) / (total - 1); // 0..1
	return baseHue - spread / 2 + t * spread;
}

function hslToRgb(h, s, l) {
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const hp = (((h % 360) + 360) % 360) / 60;
	const x = c * (1 - Math.abs((hp % 2) - 1));
	const [r1, g1, b1] =
		hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x]
		: hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
	const m = l - c / 2;
	return [Math.round((r1 + m) * 255), Math.round((g1 + m) * 255), Math.round((b1 + m) * 255), 255];
}

/**
 * Render one symbol tile.
 *
 * `variant` distinguishes the extra states a behavior adds (expand_in, and so
 * on) so you can SEE the feature fire on the reels instead of inferring it from
 * the event log — the whole point of running with placeholder art.
 */
export function renderSymbolTile({
	name,
	role,
	order = 1,
	roleCount = 1,
	topPayout,
	variant = null,
	size = TILE_SIZE,
}) {
	const palette = ROLE_PALETTE[role] ?? ROLE_PALETTE.low;
	const hue = hueForRank(palette.hue, order, roleCount);
	// Rank also nudges lightness, so adjacent hues stay separable for anyone with
	// reduced colour discrimination.
	const rankLift = roleCount > 1 ? ((order - 1) / (roleCount - 1)) * 0.14 - 0.07 : 0;
	const canvas = new Canvas(size, size);

	const inset = Math.round(size * 0.05);
	const body = size - inset * 2;
	const radius = Math.round(size * 0.14);

	// Drop shadow, so tiles separate against any background the sample ships.
	canvas.fillRoundRect(inset + 3, inset + 5, body, body, radius, [0, 0, 0, 90]);

	// Face: a vertical gradient in the symbol's own hue.
	const top = hslToRgb(hue, palette.sat, (variant ? 0.62 : 0.46) + rankLift);
	const bottom = hslToRgb(hue, palette.sat, (variant ? 0.34 : 0.22) + rankLift);
	const face = new Canvas(body, body);
	face.fillVerticalGradient(0, 0, body, body, top, bottom);
	for (let y = 0; y < body; y += 1) {
		for (let x = 0; x < body; x += 1) {
			const at = (y * body + x) * 4;
			canvas.set(inset + x, inset + y, [face.data[at], face.data[at + 1], face.data[at + 2], 255]);
		}
	}
	// Re-cut the rounded corners: the gradient above filled the full square.
	const mask = new Canvas(body, body);
	mask.fillRoundRect(0, 0, body, body, radius, [255, 255, 255, 255]);
	for (let y = 0; y < body; y += 1) {
		for (let x = 0; x < body; x += 1) {
			if (mask.data[(y * body + x) * 4 + 3] === 0) {
				const at = ((inset + y) * size + (inset + x)) * 4;
				canvas.data[at + 3] = 0;
			}
		}
	}

	// The face is a light-to-dark vertical gradient, so the two small labels need
	// opposite ink or they wash out: dark on the bright top, light on the dark
	// bottom. A single translucent white for both was unreadable at tile size.
	const ink = [255, 255, 255, 250];
	const topInk = [15, 12, 8, 210];
	const bottomInk = [255, 255, 255, 225];

	// Border, brighter for specials so wild/scatter stand out mid-spin.
	const borderColour =
		role === 'wild' || role === 'scatter' ? [255, 245, 210, 235] : [255, 255, 255, 90];
	canvas.strokeRect(inset, inset, body, body, borderColour, Math.max(2, Math.round(size * 0.012)));

	// Symbol name, as large as fits.
	let nameScale = Math.max(2, Math.floor((body * 0.62) / Math.max(measureText(name, 1), 1)));
	nameScale = Math.min(nameScale, Math.floor((body * 0.42) / 7));
	drawTextCentred(canvas, name, inset, inset + Math.round(body * 0.24), body, ink, nameScale);

	// Role tag along the top.
	const tagScale = Math.max(2, Math.round(size / 96));
	drawTextCentred(canvas, palette.label, inset, inset + Math.round(body * 0.09), body, topInk, tagScale);

	// Payout or variant along the bottom.
	const footer = variant
		? variant.toUpperCase().replace(/_/g, ' ')
		: topPayout != null
			? `x${topPayout}`
			: order != null
				? `#${order}`
				: '';
	if (footer) {
		drawTextCentred(canvas, footer, inset, inset + Math.round(body * 0.76), body, bottomInk, tagScale);
	}

	// Variant tiles get a corner flash so a state change is unmistakable.
	if (variant) {
		const flash = Math.round(size * 0.1);
		canvas.fillRect(inset + body - flash - 4, inset + 4, flash, flash, [255, 255, 255, 220]);
	}

	return canvas.toPng();
}

/** Highest payout a symbol offers, for the tile footer. */
export function topPayoutOf(symbol) {
	if (!symbol.paytable) return null;
	const values = Object.values(symbol.paytable).filter((v) => typeof v === 'number');
	return values.length ? Math.max(...values) : null;
}
