import fs from 'node:fs';
/**
 * Minimal PNG encoder — 8-bit RGBA, no interlacing, single IDAT.
 *
 * Written by hand rather than pulled in as a dependency: stake-forge only needs
 * to emit flat placeholder tiles, and a full image library is a large amount of
 * surface area (and install weight) for that. Everything here is straight from
 * the PNG spec (RFC 2083); node's zlib supplies both the deflate and the CRC.
 */

import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type, data) {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length, 0);
	const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(zlib.crc32(typeAndData), 0);
	return Buffer.concat([length, typeAndData, crc]);
}

/**
 * @param {number} width
 * @param {number} height
 * @param {Buffer} rgba  width*height*4 bytes, row-major, non-premultiplied
 * @returns {Buffer} a complete PNG file
 */
export function encodePng(width, height, rgba) {
	if (rgba.length !== width * height * 4) {
		throw new Error(`encodePng: expected ${width * height * 4} bytes of RGBA, got ${rgba.length}`);
	}

	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // colour type 6 = truecolour with alpha
	ihdr[10] = 0; // deflate
	ihdr[11] = 0; // adaptive filtering
	ihdr[12] = 0; // no interlace

	// Each scanline is prefixed with its filter type. Filter 0 (None) keeps the
	// encoder trivial; these are flat-colour tiles, so deflate compresses them
	// to almost nothing regardless.
	const raw = Buffer.alloc(height * (width * 4 + 1));
	for (let y = 0; y < height; y += 1) {
		const at = y * (width * 4 + 1);
		raw[at] = 0;
		rgba.copy(raw, at + 1, y * width * 4, (y + 1) * width * 4);
	}

	return Buffer.concat([
		SIGNATURE,
		chunk('IHDR', ihdr),
		chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
		chunk('IEND', Buffer.alloc(0)),
	]);
}

/** A width*height RGBA canvas with simple drawing primitives. */
export class Canvas {
	constructor(width, height) {
		this.width = width;
		this.height = height;
		this.data = Buffer.alloc(width * height * 4);
	}

	/** Alpha-blend one pixel. `colour` is [r, g, b, a] with a in 0-255. */
	set(x, y, colour) {
		if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
		const at = (y * this.width + x) * 4;
		const [r, g, b, a] = colour;
		if (a >= 255) {
			this.data[at] = r;
			this.data[at + 1] = g;
			this.data[at + 2] = b;
			this.data[at + 3] = 255;
			return;
		}
		const src = a / 255;
		const dstA = this.data[at + 3] / 255;
		const outA = src + dstA * (1 - src);
		if (outA === 0) return;
		this.data[at] = Math.round((r * src + this.data[at] * dstA * (1 - src)) / outA);
		this.data[at + 1] = Math.round((g * src + this.data[at + 1] * dstA * (1 - src)) / outA);
		this.data[at + 2] = Math.round((b * src + this.data[at + 2] * dstA * (1 - src)) / outA);
		this.data[at + 3] = Math.round(outA * 255);
	}

	fillRect(x, y, w, h, colour) {
		for (let dy = 0; dy < h; dy += 1) {
			for (let dx = 0; dx < w; dx += 1) this.set(x + dx, y + dy, colour);
		}
	}

	strokeRect(x, y, w, h, colour, thickness = 1) {
		for (let t = 0; t < thickness; t += 1) {
			for (let dx = 0; dx < w; dx += 1) {
				this.set(x + dx, y + t, colour);
				this.set(x + dx, y + h - 1 - t, colour);
			}
			for (let dy = 0; dy < h; dy += 1) {
				this.set(x + t, y + dy, colour);
				this.set(x + w - 1 - t, y + dy, colour);
			}
		}
	}

	/** Rounded-corner fill, so tiles read as symbols rather than raw squares. */
	fillRoundRect(x, y, w, h, radius, colour) {
		for (let dy = 0; dy < h; dy += 1) {
			for (let dx = 0; dx < w; dx += 1) {
				const cx = dx < radius ? radius - dx : dx >= w - radius ? dx - (w - radius - 1) : 0;
				const cy = dy < radius ? radius - dy : dy >= h - radius ? dy - (h - radius - 1) : 0;
				if (cx * cx + cy * cy > radius * radius) continue;
				this.set(x + dx, y + dy, colour);
			}
		}
	}

	/** Vertical linear gradient between two colours. */
	fillVerticalGradient(x, y, w, h, top, bottom) {
		for (let dy = 0; dy < h; dy += 1) {
			const t = h === 1 ? 0 : dy / (h - 1);
			const colour = [
				Math.round(top[0] + (bottom[0] - top[0]) * t),
				Math.round(top[1] + (bottom[1] - top[1]) * t),
				Math.round(top[2] + (bottom[2] - top[2]) * t),
				255,
			];
			for (let dx = 0; dx < w; dx += 1) this.set(x + dx, y + dy, colour);
		}
	}

	toPng() {
		return encodePng(this.width, this.height, this.data);
	}
}

/**
 * Width and height from a PNG header, without decoding the image.
 *
 * The IHDR chunk is always first and always at a fixed offset: an 8-byte
 * signature, a 4-byte length, the 4-byte type "IHDR", then width and height as
 * big-endian uint32. So this reads 24 bytes and stops, which matters when the
 * caller is checking a folder of 2000x1400 generated candidates.
 *
 * Returns null for anything that is not a PNG rather than guessing, because the
 * caller uses this to REFUSE a wrongly-sized asset and a wrong answer here would
 * wave one through.
 */
export function readPngSize(file) {
	let fd;
	try {
		fd = fs.openSync(file, 'r');
		const header = Buffer.alloc(24);
		if (fs.readSync(fd, header, 0, 24, 0) < 24) return null;
		if (header.toString('binary', 1, 4) !== 'PNG') return null;
		if (header.toString('ascii', 12, 16) !== 'IHDR') return null;
		return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
	} catch {
		return null;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}
