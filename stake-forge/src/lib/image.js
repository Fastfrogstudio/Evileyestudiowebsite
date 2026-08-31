import fs from 'node:fs';
import zlib from 'node:zlib';

import { encodePng } from './png.js';

/**
 * Decode, measure, resize and trim PNGs — the operations the import path needs.
 *
 * ── Why this is hand-written and not a dependency ───────────────────────────
 * The whole job is: take a PNG an art tool produced, check it is what the game
 * asked for, and make it so if it is nearly right. That is decode, resize, trim
 * and re-encode — four operations on 8-bit RGBA. An image library brings a build
 * step, native bindings, or several megabytes for the ninety percent of its
 * surface this never touches. png.js already encodes for the same reason.
 *
 * Only the format the SDK actually ships is supported: 8-bit RGBA, non-interlaced.
 * Anything else is REFUSED by name rather than guessed at, because a silently
 * mis-decoded symbol is far worse than a rejected one — it looks plausible in a
 * folder and wrong in the game.
 */

/** PNG colour types, for saying what an unsupported file actually is. */
const COLOR_TYPES = {
	0: 'greyscale',
	2: 'RGB without alpha',
	3: 'palette',
	4: 'greyscale with alpha',
	6: 'RGBA',
};

/**
 * Undo the per-scanline filter PNG applies before compression.
 *
 * Each row is prefixed by a filter byte naming how it was encoded relative to
 * the pixel on its left (a), the row above (b), and the pixel above-left (c).
 * This is the one genuinely fiddly part of PNG and it is worth being exact: a
 * wrong Paeth predictor produces an image that decodes without error and looks
 * subtly smeared.
 */
function unfilter(raw, width, height, bpp) {
	const stride = width * bpp;
	const out = Buffer.alloc(stride * height);
	let pos = 0;
	for (let y = 0; y < height; y += 1) {
		const filter = raw[pos];
		pos += 1;
		const line = raw.subarray(pos, pos + stride);
		pos += stride;
		const target = out.subarray(y * stride, (y + 1) * stride);
		const prior = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;

		for (let x = 0; x < stride; x += 1) {
			const a = x >= bpp ? target[x - bpp] : 0;
			const b = prior ? prior[x] : 0;
			const c = prior && x >= bpp ? prior[x - bpp] : 0;
			const value = line[x];
			switch (filter) {
				case 0: target[x] = value; break;
				case 1: target[x] = (value + a) & 0xff; break;
				case 2: target[x] = (value + b) & 0xff; break;
				case 3: target[x] = (value + ((a + b) >> 1)) & 0xff; break;
				case 4: {
					// Paeth: pick whichever neighbour the gradient predicts.
					const p = a + b - c;
					const pa = Math.abs(p - a);
					const pb = Math.abs(p - b);
					const pc = Math.abs(p - c);
					const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
					target[x] = (value + pred) & 0xff;
					break;
				}
				default:
					throw new Error(`unknown PNG filter type ${filter} on row ${y}`);
			}
		}
	}
	return out;
}

/** Decode a PNG to `{ width, height, rgba }`. */
export function decodePng(file) {
	const buf = fs.readFileSync(file);
	if (buf.length < 8 || buf.toString('binary', 1, 4) !== 'PNG') {
		throw new Error(`${file} is not a PNG`);
	}

	let offset = 8;
	let header = null;
	const idat = [];
	while (offset + 8 <= buf.length) {
		const length = buf.readUInt32BE(offset);
		const type = buf.toString('ascii', offset + 4, offset + 8);
		const body = buf.subarray(offset + 8, offset + 8 + length);
		if (type === 'IHDR') {
			header = {
				width: body.readUInt32BE(0),
				height: body.readUInt32BE(4),
				depth: body[8],
				colorType: body[9],
				interlace: body[12],
			};
		} else if (type === 'IDAT') {
			idat.push(body);
		} else if (type === 'IEND') {
			break;
		}
		offset += 12 + length;
	}
	if (!header) throw new Error(`${file} has no IHDR chunk`);

	// Refused by name, not guessed at.
	if (header.depth !== 8) {
		throw new Error(`${file} is ${header.depth}-bit; only 8-bit is supported`);
	}
	if (header.interlace !== 0) {
		throw new Error(`${file} is interlaced (Adam7); save it non-interlaced`);
	}
	if (header.colorType !== 6 && header.colorType !== 2) {
		throw new Error(
			`${file} is ${COLOR_TYPES[header.colorType] ?? `colour type ${header.colorType}`}; ` +
				`only RGBA and RGB are supported`,
		);
	}

	const channels = header.colorType === 6 ? 4 : 3;
	const flat = unfilter(zlib.inflateSync(Buffer.concat(idat)), header.width, header.height, channels);

	// Normalise to RGBA so everything downstream has one shape. An RGB source is
	// fully opaque, which is exactly what a backdrop should be.
	if (channels === 4) return { width: header.width, height: header.height, rgba: flat };
	const rgba = Buffer.alloc(header.width * header.height * 4);
	for (let i = 0, j = 0; i < flat.length; i += 3, j += 4) {
		rgba[j] = flat[i];
		rgba[j + 1] = flat[i + 1];
		rgba[j + 2] = flat[i + 2];
		rgba[j + 3] = 255;
	}
	return { width: header.width, height: header.height, rgba };
}

/**
 * Resample to a new size.
 *
 * Bilinear, and premultiplied while sampling. That second part is not a detail:
 * a transparent PNG's fully-clear pixels usually carry garbage RGB, and
 * averaging those in unpremultiplied produces a dark halo around every symbol on
 * the reel. It is the classic transparent-asset artefact and it appears only
 * after packing, which is the worst time to find it.
 */
export function resize(image, targetWidth, targetHeight) {
	const { width, height, rgba } = image;
	if (width === targetWidth && height === targetHeight) return image;

	const out = Buffer.alloc(targetWidth * targetHeight * 4);
	const xRatio = width / targetWidth;
	const yRatio = height / targetHeight;

	for (let y = 0; y < targetHeight; y += 1) {
		const sy = Math.min(height - 1, (y + 0.5) * yRatio - 0.5);
		const y0 = Math.max(0, Math.floor(sy));
		const y1 = Math.min(height - 1, y0 + 1);
		const wy = sy - y0;

		for (let x = 0; x < targetWidth; x += 1) {
			const sx = Math.min(width - 1, (x + 0.5) * xRatio - 0.5);
			const x0 = Math.max(0, Math.floor(sx));
			const x1 = Math.min(width - 1, x0 + 1);
			const wx = sx - x0;

			let r = 0;
			let g = 0;
			let b = 0;
			let a = 0;
			for (const [px, py, weight] of [
				[x0, y0, (1 - wx) * (1 - wy)],
				[x1, y0, wx * (1 - wy)],
				[x0, y1, (1 - wx) * wy],
				[x1, y1, wx * wy],
			]) {
				const i = (py * width + px) * 4;
				const alpha = rgba[i + 3] / 255;
				// Premultiply before weighting.
				r += rgba[i] * alpha * weight;
				g += rgba[i + 1] * alpha * weight;
				b += rgba[i + 2] * alpha * weight;
				a += rgba[i + 3] * weight;
			}

			const o = (y * targetWidth + x) * 4;
			const alpha = a / 255;
			// Un-premultiply, guarding the fully-clear case.
			out[o] = alpha > 0 ? Math.min(255, Math.round(r / alpha)) : 0;
			out[o + 1] = alpha > 0 ? Math.min(255, Math.round(g / alpha)) : 0;
			out[o + 2] = alpha > 0 ? Math.min(255, Math.round(b / alpha)) : 0;
			out[o + 3] = Math.round(a);
		}
	}
	return { width: targetWidth, height: targetHeight, rgba: out };
}

/**
 * The bounding box of everything not fully transparent.
 *
 * The atlas packer stores trimmed regions and records the original size, so
 * knowing the real extent is what makes packing efficient — and it is also how
 * you tell that a "transparent" asset is actually a full opaque rectangle.
 */
export function opaqueBounds(image) {
	const { width, height, rgba } = image;
	let minX = width;
	let minY = height;
	let maxX = -1;
	let maxY = -1;
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			if (rgba[(y * width + x) * 4 + 3] === 0) continue;
			if (x < minX) minX = x;
			if (x > maxX) maxX = x;
			if (y < minY) minY = y;
			if (y > maxY) maxY = y;
		}
	}
	if (maxX < 0) return null; // entirely transparent
	return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** How much of the image is not fully transparent, 0..1. */
export function alphaCoverage(image) {
	const { rgba } = image;
	let solid = 0;
	for (let i = 3; i < rgba.length; i += 4) if (rgba[i] > 0) solid += 1;
	return solid / (rgba.length / 4);
}

/** Crop to a box. */
export function crop(image, box) {
	const out = Buffer.alloc(box.width * box.height * 4);
	for (let y = 0; y < box.height; y += 1) {
		const from = ((box.y + y) * image.width + box.x) * 4;
		image.rgba.copy(out, y * box.width * 4, from, from + box.width * 4);
	}
	return { width: box.width, height: box.height, rgba: out };
}

export function writePng(file, image) {
	fs.writeFileSync(file, encodePng(image.width, image.height, image.rgba));
}
