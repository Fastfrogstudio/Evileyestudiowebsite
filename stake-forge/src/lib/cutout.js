import { opaqueBounds, crop, resize } from './image.js';

/**
 * Turn art generated on a white background into a transparent, correctly-sized
 * game asset.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 * Every image model worth using produces an OPAQUE picture. The studio's own
 * style guide says so in its prompt template — "isolated on white background" —
 * because asking for transparency gets you a checkerboard painted into the art.
 *
 * The game needs the opposite. Symbols are composited over the reel by Spine, so
 * `art:import` refuses an opaque one outright: "every pixel is opaque … it would
 * tile the board with rectangles". So the generated art and the art the game can
 * use were separated by a step that lived in a script on someone's laptop, and
 * the tool had no idea it existed.
 *
 * This is that step, ported so the pipeline owns it: knock out the white, feather
 * the edge, trim to the subject, and place it on the exact canvas the slot wants.
 *
 * ── Why brightness AND saturation ───────────────────────────────────────────
 * Brightness alone eats the highlights. A brass rivet's specular is 250,250,245
 * and a white background is 255,255,255 — both bright. What separates them is
 * that the background is neutral, so a low saturation is required as well.
 * Anything with colour in it survives however bright it is.
 *
 * ── And why that is still not enough: CONNECTIVITY ──────────────────────────
 * Colour alone cannot save a highlight that is genuinely near-white. Steel in
 * this house style has "near-white specular points" — the style guide says so —
 * and a 250,250,245 specular is bright AND neutral, so any test that looks at
 * pixels one at a time removes it and punches a hole through the middle of the
 * object. Measured on a test icon: the specular came out at alpha 0.
 *
 * What actually distinguishes background from highlight is not how it looks but
 * where it is. Background is the region REACHABLE FROM THE EDGE of the frame
 * without crossing the subject; a specular is enclosed by the thing it sits on.
 * So the mask is a flood fill inwards from the border, and an interior highlight
 * is safe however white it is.
 */

/** Defaults taken from the studio's own script, which is the reference. */
export const CUTOUT_DEFAULTS = {
	/** Brightness at or above which a NEUTRAL pixel counts as background. */
	threshold: 220,
	/** Max channel spread for a pixel to count as neutral. */
	saturation: 30,
	/** Pixels over which the edge fades in, so the cut is not a jagged step. */
	feather: 5,
};

/**
 * Exact squared Euclidean distance transform, one dimension.
 *
 * Felzenszwalb & Huttenlocher's lower-envelope algorithm. Exact rather than a
 * chamfer approximation because it is the same transform scipy's
 * `distance_transform_edt` computes, and the feather is the visible edge of
 * every asset in the game — an approximation there is a different picture.
 */
function edt1d(f, n) {
	const d = new Float64Array(n);
	const v = new Int32Array(n);
	const z = new Float64Array(n + 1);
	let k = 0;
	v[0] = 0;
	z[0] = -Infinity;
	z[1] = Infinity;

	for (let q = 1; q < n; q += 1) {
		let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
		while (s <= z[k]) {
			k -= 1;
			s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
		}
		k += 1;
		v[k] = q;
		z[k] = s;
		z[k + 1] = Infinity;
	}

	k = 0;
	for (let q = 0; q < n; q += 1) {
		while (z[k + 1] < q) k += 1;
		d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
	}
	return d;
}

/** Distance from every pixel to the nearest `true` in `sources`. */
function distanceToSources(sources, width, height) {
	const INF = 1e20;
	const grid = new Float64Array(width * height);
	for (let i = 0; i < grid.length; i += 1) grid[i] = sources[i] ? 0 : INF;

	const column = new Float64Array(height);
	for (let x = 0; x < width; x += 1) {
		for (let y = 0; y < height; y += 1) column[y] = grid[y * width + x];
		const d = edt1d(column, height);
		for (let y = 0; y < height; y += 1) grid[y * width + x] = d[y];
	}

	const row = new Float64Array(width);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) row[x] = grid[y * width + x];
		const d = edt1d(row, width);
		for (let x = 0; x < width; x += 1) grid[y * width + x] = Math.sqrt(d[x]);
	}
	return grid;
}

/**
 * Knock the white background out of an image.
 *
 * Returns the image plus what it did, because "it removed 4% of the picture" and
 * "it removed 96% of the picture" are both possible and only one of them is a
 * cutout — the other is art on a pale background that has just been destroyed.
 */
export function removeWhiteBackground(image, options = {}) {
	const { threshold, saturation, feather } = { ...CUTOUT_DEFAULTS, ...options };
	const { width, height, rgba } = image;
	const out = Buffer.from(rgba);

	// Candidates: bright and neutral. Necessary, not sufficient — see above.
	const candidate = new Uint8Array(width * height);
	for (let i = 0; i < width * height; i += 1) {
		const r = rgba[i * 4];
		const g = rgba[i * 4 + 1];
		const b = rgba[i * 4 + 2];
		const brightness = (r + g + b) / 3;
		const spread = Math.max(r, g, b) - Math.min(r, g, b);
		if (brightness >= threshold && spread < saturation) candidate[i] = 1;
	}

	// Background is the candidate region connected to the frame edge. Flood filled
	// with an explicit stack rather than recursion: a 2048-square page is four
	// million pixels and the recursive form overflows the stack on the first one.
	const isBackground = new Uint8Array(width * height);
	let backgroundPixels = 0;
	const stack = [];
	const push = (x, y) => {
		if (x < 0 || y < 0 || x >= width || y >= height) return;
		const i = y * width + x;
		if (isBackground[i] || !candidate[i]) return;
		isBackground[i] = 1;
		backgroundPixels += 1;
		stack.push(i);
	};
	for (let x = 0; x < width; x += 1) {
		push(x, 0);
		push(x, height - 1);
	}
	for (let y = 0; y < height; y += 1) {
		push(0, y);
		push(width - 1, y);
	}
	while (stack.length) {
		const i = stack.pop();
		const x = i % width;
		const y = (i - x) / width;
		push(x - 1, y);
		push(x + 1, y);
		push(x, y - 1);
		push(x, y + 1);
	}

	if (feather > 0 && backgroundPixels > 0 && backgroundPixels < width * height) {
		// Alpha ramps from 0 at the background up to opaque `feather` pixels in.
		// Combined with MIN against the existing alpha, so art that already had
		// transparency keeps it.
		const distance = distanceToSources(isBackground, width, height);
		for (let i = 0; i < width * height; i += 1) {
			const ramp = Math.max(0, Math.min(255, Math.round((distance[i] / feather) * 255)));
			out[i * 4 + 3] = Math.min(out[i * 4 + 3], ramp);
		}
	} else {
		for (let i = 0; i < width * height; i += 1) {
			if (isBackground[i]) out[i * 4 + 3] = 0;
		}
	}

	return {
		image: { width, height, rgba: out },
		removed: backgroundPixels / (width * height),
	};
}

/**
 * Does this look like art sitting on a white background?
 *
 * Judged from the BORDER, not the whole picture. A gothic icon is mostly dark
 * and a bright one is mostly pale, so the proportion of white says nothing —
 * whereas a generated asset is isolated, which means its edge is background all
 * the way round whatever is in the middle.
 */
export function looksWhiteBacked(image, options = {}) {
	const { threshold, saturation } = { ...CUTOUT_DEFAULTS, ...options };
	const { width, height, rgba } = image;
	let border = 0;
	let neutralBright = 0;

	const sample = (x, y) => {
		const i = (y * width + x) * 4;
		if (rgba[i + 3] < 250) return; // already transparent there — not our case
		border += 1;
		const brightness = (rgba[i] + rgba[i + 1] + rgba[i + 2]) / 3;
		const spread = Math.max(rgba[i], rgba[i + 1], rgba[i + 2]) - Math.min(rgba[i], rgba[i + 1], rgba[i + 2]);
		if (brightness >= threshold && spread < saturation) neutralBright += 1;
	};

	for (let x = 0; x < width; x += 1) {
		sample(x, 0);
		sample(x, height - 1);
	}
	for (let y = 1; y < height - 1; y += 1) {
		sample(0, y);
		sample(width - 1, y);
	}

	// Not "all of it": a generated image can carry a stray mark or a signature in
	// one corner, and refusing the cutout over that is worse than doing it.
	return border > 0 && neutralBright / border >= 0.9;
}

/**
 * Trim to the subject, then centre it on the slot's canvas.
 *
 * ── Why not just resample the whole frame ───────────────────────────────────
 * A generated 1024x1024 with the subject floating in the middle resamples to a
 * 200x200 symbol that is mostly empty — it reads as a small symbol on a big
 * board, and every symbol ends up a different visual size depending on how much
 * air its generation happened to leave. Trimming first makes the SUBJECT the
 * unit, so eleven symbols drawn at eleven framings still land the same size on
 * the reel.
 *
 * The margin is kept because a symbol touching its own edge looks clipped
 * against the cell next to it, and because Spine scales these — a subject at the
 * exact frame edge has nothing to grow into.
 */
export function fitOnCanvas(image, targetWidth, targetHeight, { margin = 0.06 } = {}) {
	const bounds = opaqueBounds(image);
	if (!bounds) return { image, trimmed: false };

	const subject =
		bounds.width === image.width && bounds.height === image.height ? image : crop(image, bounds);

	const inset = Math.round(Math.min(targetWidth, targetHeight) * margin);
	const boxWidth = Math.max(1, targetWidth - inset * 2);
	const boxHeight = Math.max(1, targetHeight - inset * 2);
	const scale = Math.min(boxWidth / subject.width, boxHeight / subject.height);
	const drawWidth = Math.max(1, Math.round(subject.width * scale));
	const drawHeight = Math.max(1, Math.round(subject.height * scale));
	const scaled = resize(subject, drawWidth, drawHeight);

	const canvas = Buffer.alloc(targetWidth * targetHeight * 4, 0);
	const offsetX = Math.floor((targetWidth - drawWidth) / 2);
	const offsetY = Math.floor((targetHeight - drawHeight) / 2);
	for (let y = 0; y < drawHeight; y += 1) {
		const from = y * drawWidth * 4;
		const to = ((y + offsetY) * targetWidth + offsetX) * 4;
		scaled.rgba.copy(canvas, to, from, from + drawWidth * 4);
	}

	return {
		image: { width: targetWidth, height: targetHeight, rgba: canvas },
		trimmed: true,
		subject: { width: subject.width, height: subject.height },
		drawn: { width: drawWidth, height: drawHeight },
	};
}
