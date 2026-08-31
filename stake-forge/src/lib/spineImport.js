import fs from 'fs-extra';
import path from 'node:path';

import { parseAtlas } from './atlasParts.js';

/**
 * Check a Spine delivery before it reaches the game.
 *
 * ── The failure this exists for ─────────────────────────────────────────────
 * A rig can be perfect work and still do nothing. The front end plays animations
 * by literal string — `Board.svelte` asks for `h4` and `h4_static` — so a
 * skeleton whose animations are called "win" and "idle" loads without error,
 * type-checks, passes every other gate, and plays nothing on screen. There is no
 * symptom except an inert board.
 *
 * That is the check that earns this file. The rest are the other ways a delivery
 * is subtly incomplete: an attachment with no region behind it, an atlas naming
 * a page that was not sent, a skeleton from a runtime the SDK cannot read.
 *
 * ── One thing that must NOT be flagged ──────────────────────────────────────
 * Not every attachment is an image. `type: "path"` attachments are path
 * constraints used to drive motion, and `clipping`, `boundingbox` and `point`
 * are likewise geometry rather than art — none of them appear in the atlas.
 * Measured on the shipped h4.json: 9 attachments, 2 of them paths. A validator
 * that checked all nine would report two false failures on a correct file, and
 * a validator that cries wolf gets switched off.
 */

/** Attachment types that must resolve to an atlas region. */
const IMAGE_ATTACHMENTS = new Set([undefined, 'region', 'mesh', 'linkedmesh']);

/** Parse a Spine skeleton, or say why it could not be read. */
export function readSkeleton(file) {
	let json;
	try {
		json = fs.readJsonSync(file);
	} catch (err) {
		return { error: `${path.basename(file)} is not valid JSON (${err.message})` };
	}
	if (!json.skeleton) {
		return {
			error:
				`${path.basename(file)} has no "skeleton" block — this is JSON, but not a Spine ` +
				`skeleton. Check it was exported as skeleton data rather than as a project file.`,
		};
	}

	// Attachment names, and the region each actually points at. Spine lets an
	// attachment carry a `path` that names a DIFFERENT region, so reading the key
	// alone would look for regions that were never meant to exist.
	const needsRegion = [];
	for (const skin of json.skins ?? []) {
		for (const [slot, attachments] of Object.entries(skin.attachments ?? {})) {
			for (const [name, body] of Object.entries(attachments ?? {})) {
				if (!IMAGE_ATTACHMENTS.has(body?.type)) continue;
				needsRegion.push({ slot, name, region: body?.path ?? name });
			}
		}
	}

	return {
		spineVersion: json.skeleton.spine ?? null,
		canvas:
			Number.isFinite(json.skeleton.width) && Number.isFinite(json.skeleton.height)
				? { width: Math.round(json.skeleton.width), height: Math.round(json.skeleton.height) }
				: null,
		animations: Object.keys(json.animations ?? {}),
		bones: (json.bones ?? []).length,
		slots: (json.slots ?? []).length,
		needsRegion,
	};
}

/** Region names an atlas provides, and the page files it references. */
export function readAtlasRegions(file) {
	const parts = parseAtlas(file);
	if (!parts) return { error: `${path.basename(file)} could not be read as an atlas` };
	return {
		regions: new Set(parts.map((p) => p.name)),
		pages: [...new Set(parts.map((p) => p.page).filter(Boolean))],
		parts,
	};
}

/**
 * Validate one skeleton + atlas + page(s) against what the game will ask for.
 *
 * `requiredAnimations` comes from the animation brief — the names the front end
 * calls. Everything else is internal consistency.
 */
export function validateSpineDelivery({ skeletonFile, atlasFile, requiredAnimations = [] }) {
	const problems = [];
	const notes = [];

	if (!fs.existsSync(skeletonFile)) {
		return { problems: [`missing skeleton ${path.basename(skeletonFile)}`], notes };
	}
	const skeleton = readSkeleton(skeletonFile);
	if (skeleton.error) return { problems: [skeleton.error], notes };

	// ── the check that matters ──────────────────────────────────────────────
	const present = new Set(skeleton.animations);
	const missing = requiredAnimations.filter((name) => !present.has(name));
	if (missing.length) {
		problems.push(
			`missing animation(s): ${missing.join(', ')}. The front end plays these by literal ` +
				`name, so the rig loads and plays nothing. It contains: ` +
				`${skeleton.animations.join(', ') || '(none)'}`,
		);
	}
	const extra = skeleton.animations.filter((name) => !requiredAnimations.includes(name));
	if (requiredAnimations.length && extra.length) {
		// Not a problem — a rig may carry working animations nothing calls yet.
		notes.push(`also contains ${extra.length} animation(s) nothing calls: ${extra.join(', ')}`);
	}

	// ── atlas agreement ─────────────────────────────────────────────────────
	if (!atlasFile || !fs.existsSync(atlasFile)) {
		problems.push(
			`no atlas beside it. A skeleton names regions but does not contain them — the ` +
				`.atlas and its .png have to be delivered together.`,
		);
	} else {
		const atlas = readAtlasRegions(atlasFile);
		if (atlas.error) {
			problems.push(atlas.error);
		} else {
			const unresolved = skeleton.needsRegion.filter((a) => !atlas.regions.has(a.region));
			if (unresolved.length) {
				const shown = unresolved.slice(0, 5).map((a) => a.region);
				problems.push(
					`${unresolved.length} attachment(s) have no region in the atlas ` +
						`(${shown.join(', ')}${unresolved.length > 5 ? ', …' : ''}). The skeleton and the ` +
						`atlas were exported from different states of the project.`,
				);
			}
			for (const page of atlas.pages) {
				const pageFile = path.join(path.dirname(atlasFile), page);
				if (!fs.existsSync(pageFile)) {
					problems.push(`the atlas names "${page}", which was not delivered beside it`);
				}
			}
		}
	}

	// ── runtime compatibility ───────────────────────────────────────────────
	// The web-sdk bundles spine-core 4.2.x, which reads 4.0 and 4.1 data. A 3.x
	// export is a different format the runtime will refuse.
	const major = Number.parseInt(skeleton.spineVersion ?? '', 10);
	if (Number.isFinite(major) && major < 4) {
		problems.push(
			`exported from Spine ${skeleton.spineVersion}. The SDK bundles the 4.2 runtime, which ` +
				`cannot read 3.x skeleton data — re-export from Spine 4.`,
		);
	}

	return { problems, notes, skeleton };
}

/**
 * Group a delivery folder into Spine bundles.
 *
 * A bundle is a skeleton plus whichever atlas sits with it. Several skeletons
 * legitimately share ONE atlas — that is how the sample stores its symbols, with
 * eleven skeletons against a single symbols.atlas — so the atlas is matched by
 * folder rather than by name.
 */
export function groupSpineDeliveries(dir) {
	if (!fs.existsSync(dir)) return [];
	const entries = fs.readdirSync(dir);
	const atlases = entries.filter((f) => f.endsWith('.atlas'));
	const bundles = [];

	for (const file of entries.filter((f) => f.endsWith('.json'))) {
		const full = path.join(dir, file);
		const probe = readSkeleton(full);
		if (probe.error) continue; // ordinary JSON in the folder, not a skeleton

		// Prefer an atlas with the same stem, fall back to the only one present.
		const stem = path.basename(file, '.json');
		const named = atlases.find((a) => path.basename(a, '.atlas') === stem);
		const atlas = named ?? (atlases.length === 1 ? atlases[0] : null);
		bundles.push({
			name: stem,
			skeletonFile: full,
			atlasFile: atlas ? path.join(dir, atlas) : null,
			animations: probe.animations,
		});
	}
	return bundles;
}
