import fs from 'fs-extra';
import path from 'node:path';

/**
 * Read the PARTS a Spine asset is built from, out of its .atlas file.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The art brief could say "a background" and give the atlas size, 2028x1439.
 * That is the wrong instruction, and following it produces something unusable.
 *
 * A shipped background is not one image. mm_bg.atlas holds named layers:
 *
 *   bg_base          2020x991    the backdrop
 *   bg_cart_add       404x219    a prop
 *   bg_cart_shine     377x104    a highlight over that prop
 *   bg_shovel_add     130x282    another prop
 *   bg_particles1      17x17     one particle
 *   dust1, dust2      ~200x840   drifting dust
 *
 * Spine animates those parts — the `idle` and `dust` tracks move them
 * independently. A single flat 2028x1439 painting cannot be animated at all,
 * because there is nothing to move.
 *
 * That distinction is also what makes AI generation viable here. Asking a model
 * for "an animated mine background" is a bad prompt with no usable output; asking
 * for "a mine cart, 404x219, transparent background" is a good one, and the parts
 * assemble into something a rig can drive.
 *
 * So the part list is read from the reference app the game is scaffolded from,
 * rather than invented — those are the exact slots its Spine skeletons expect.
 */

/**
 * Parse a libGDX/Spine .atlas file.
 *
 * The format is a page header (image name, then `key:value` lines), followed by
 * region entries: a bare name line, then indented `key:value` lines. Sizes come
 * from `bounds:x,y,w,h` in the 4.x format and from `size:w,h` in the older one,
 * so both are read — the shipped samples use 4.x but an artist's export may not.
 *
 * `offsets:x,y,origW,origH` records the size BEFORE whitespace was trimmed during
 * packing, which is the size the artist actually drew. That is the one to brief,
 * so it wins when present.
 */
export function parseAtlas(file) {
	if (!fs.existsSync(file)) return null;
	const lines = fs.readFileSync(file, 'utf8').split('\n');

	const parts = [];
	let page = null;
	let current = null;
	// A page declaration is a bare line at the START of the file or immediately
	// after a blank one; regions follow each other with no blank between. Without
	// tracking that, "any bare line ending in .png is a page" looks reasonable and
	// is wrong: symbols.atlas contains a REGION named `heart_shadow.png`, which
	// that rule swallows as a second page. The region then vanishes from the part
	// list — so the art brief never asks for it — and the atlas is reported as
	// naming a page nobody delivered. One typo'd export name, two silent failures.
	let atBoundary = true;

	const flush = () => {
		if (current?.name) parts.push(current);
		current = null;
	};

	for (const raw of lines) {
		const line = raw.replace(/\s+$/, '');
		if (!line.trim()) {
			flush();
			atBoundary = true;
			continue;
		}

		const kv = line.match(/^\s*([a-zA-Z]+)\s*:\s*(.+)$/);
		if (!kv) {
			// A bare line is either the page image or a region name. The page is the
			// first one after a blank, and it is the only one with a file extension.
			flush();
			if (atBoundary && /\.(png|webp|jpg|jpeg)$/i.test(line.trim())) {
				page = line.trim();
			} else {
				current = { name: line.trim(), page };
			}
			atBoundary = false;
			continue;
		}

		const [, key, value] = kv;
		atBoundary = false;
		if (!current) continue; // a page-level key such as size/filter/scale

		if (key === 'bounds') {
			const [, , w, h] = value.split(',').map((n) => Number(n.trim()));
			current.width = w;
			current.height = h;
		} else if (key === 'size' && current.width === undefined) {
			const [w, h] = value.split(',').map((n) => Number(n.trim()));
			current.width = w;
			current.height = h;
		} else if (key === 'offsets') {
			// The pre-trim size — what the artist drew, before packing removed the
			// transparent margin.
			const [, , origW, origH] = value.split(',').map((n) => Number(n.trim()));
			if (Number.isFinite(origW) && origW > 0) current.drawnWidth = origW;
			if (Number.isFinite(origH) && origH > 0) current.drawnHeight = origH;
		} else if (key === 'rotate' && value.trim() !== 'false') {
			// Packed rotated to save space. This describes the BOUNDS rect only —
			// `offsets` already records the original in its drawn orientation, so the
			// swap below applies only when falling back to bounds.
			//
			// Getting this backwards is not a rounding error, it is a brief asking for
			// the wrong picture: MM_BigWin packs as 308x86 rotated with offsets
			// 540x150, and swapping the offsets would have briefed a 150x540 "BIG WIN"
			// banner — a wide word drawn tall.
			current.rotated = true;
		}
	}
	flush();

	return parts
		.filter((p) => Number.isFinite(p.width) && Number.isFinite(p.height))
		.map((p) => {
			const hasOffsets = p.drawnWidth !== undefined && p.drawnHeight !== undefined;
			// offsets are already the drawn orientation; bounds are the packed one and
			// need the rotation undone.
			const swap = p.rotated && !hasOffsets;
			const w = hasOffsets ? p.drawnWidth : p.width;
			const h = hasOffsets ? p.drawnHeight : p.height;
			return {
				name: p.name,
				width: swap ? h : w,
				height: swap ? w : h,
				trimmed: hasOffsets,
				page: p.page,
			};
		});
}

/**
 * Every Spine asset in an app, with the parts each is built from.
 *
 * Keyed by the asset key the game code loads it under (`foregroundAnimation`,
 * `symbols`, ...), which is the directory name — that is how the SDK's own
 * index.ts files resolve them.
 */
export function spineAssetParts(appDir) {
	const root = path.join(appDir, 'static', 'assets', 'spines');
	if (!fs.existsSync(root)) return {};

	const out = {};
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const dir = path.join(root, entry.name);
		const atlas = fs.readdirSync(dir).find((f) => f.endsWith('.atlas'));
		if (!atlas) continue;
		const parts = parseAtlas(path.join(dir, atlas));
		if (parts?.length) out[entry.name] = { atlas, parts };
	}
	return out;
}
