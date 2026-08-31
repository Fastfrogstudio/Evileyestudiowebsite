import fs from 'fs-extra';
import path from 'node:path';

import { parseAtlas } from './atlasParts.js';
import { decodePng, premultipliedSignal } from './image.js';

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
export function validateSpineDelivery({
	skeletonFile,
	atlasFile,
	requiredAnimations = [],
	indirect = false,
}) {
	const problems = [];
	const notes = [];

	if (!fs.existsSync(skeletonFile)) {
		return { problems: [`missing skeleton ${path.basename(skeletonFile)}`], notes };
	}
	const skeleton = readSkeleton(skeletonFile);
	if (skeleton.error) return { problems: [skeleton.error], notes };

	// ── animation names ─────────────────────────────────────────────────────
	// Whether the NAME matters depends on who is doing the calling, and the two
	// cases are genuinely different:
	//
	//   SYMBOLS go through assets-manifest.yaml, which carries an explicit
	//   `animations: { win: <name> }` map that importAssets writes into
	//   constants.ts as animationName. That map is an indirection layer — the
	//   name in the rig never has to match anything, because the manifest says
	//   which track to play. So there is no naming rule to enforce here, only a
	//   track to identify.
	//
	//   SCREENS do not. Background.svelte plays "idle" and "dust" as literals in
	//   its own source; nothing indirects them. A rig whose tracks are called
	//   something else loads cleanly and plays nothing, and the only fix is the
	//   name.
	//
	// Conflating the two produced a rule that was half wrong: it rejected correct
	// symbol rigs over a string the manifest was about to override anyway, which
	// sends the delivery back to the animation team for no reason.
	const present = new Set(skeleton.animations);
	const missing = requiredAnimations.filter((name) => !present.has(name));

	// Which track each required name will actually play. Names that match are
	// themselves; for symbols, one required name against one animation resolves
	// to that animation whatever it is called.
	const resolved = {};
	for (const name of requiredAnimations) if (present.has(name)) resolved[name] = name;

	if (indirect && missing.length === 1 && requiredAnimations.length === 1 && skeleton.animations.length === 1) {
		// Nothing to work out: one track, one slot for it.
		resolved[missing[0]] = skeleton.animations[0];
		notes.push(
			`its animation is called "${skeleton.animations[0]}", not "${missing[0]}" — wired up ` +
				`by name in the manifest, so it plays as delivered and nothing needs re-exporting.`,
		);
	} else if (missing.length) {
		problems.push(
			indirect && skeleton.animations.length > 1
				? `${skeleton.animations.length} animations, and none is called ` +
					`${missing.join(' or ')} — so which one plays on a win is a guess, and guessing ` +
					`wrong plays the wrong motion. Rename the right one, or name it in ` +
					`assets-manifest.yaml. It contains: ${skeleton.animations.join(', ')}`
				: `missing animation(s): ${missing.join(', ')}. The front end plays these by literal ` +
					`name, so the rig loads and plays nothing. It contains: ` +
					`${skeleton.animations.join(', ') || '(none)'}`,
		);
	}

	const used = new Set(Object.values(resolved));
	const extra = skeleton.animations.filter((name) => !used.has(name));
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
			// Whether the atlas says its page is premultiplied. Spine writes this
			// when the exporter's "Premultiply alpha" box is ticked.
			const declaresPma = /^\s*pma\s*:\s*true/im.test(fs.readFileSync(atlasFile, 'utf8'));

			// An atlas that names no page is not a rig, it is a region list. Said
			// plainly here because the downstream symptoms point everywhere else:
			// the page gets matched to a symbol slot and refused for its size, and
			// every check that reads pages quietly does nothing.
			const named = atlas.pages.length
				? atlas.pages
				: fs
						.readdirSync(path.dirname(atlasFile))
						.filter((f) => /\.(png|webp)$/i.test(f))
						.filter(
							(f) =>
								path.basename(f, path.extname(f)).toLowerCase() ===
								path.basename(atlasFile, '.atlas').toLowerCase(),
						);
			if (!atlas.pages.length) {
				notes.push(
					named.length
						? `the atlas names no page image, so "${named[0]}" is being used on the export ` +
							`convention that the page is named after the skeleton. Worth adding the page ` +
							`line — nothing else can confirm it.`
						: `the atlas names no page image and none was found beside it, so this rig has ` +
							`region names with no texture behind them.`,
				);
			}

			for (const page of named) {
				const pageFile = path.join(path.dirname(atlasFile), page);
				if (!fs.existsSync(pageFile)) {
					problems.push(`the atlas names "${page}", which was not delivered beside it`);
					continue;
				}
				// ── the box-around-the-symbol bug ───────────────────────────────
				// A page exported with premultiplied alpha, in an atlas that does
				// not declare it, is composited as straight alpha. Soft additive
				// layers — every glow and flare — then render as their bounding
				// RECTANGLE: a hard-edged box of colour around the symbol. The rig
				// is valid, the animation plays, the names match, and nothing
				// anywhere reports it. The SDK's own pages are straight alpha, so
				// that is the convention to match.
				if (!/\.png$/i.test(page) || declaresPma) continue;
				try {
					const signal = premultipliedSignal(decodePng(pageFile));
					if (signal.premultiplied) {
						problems.push(
							`"${page}" looks premultiplied (${signal.semiTransparent} soft pixels, not one ` +
								`with a colour channel above its alpha) but the atlas does not say "pma: true". ` +
								`Composited as straight alpha, every soft glow in this rig renders as a hard ` +
								`rectangle around the symbol. Re-export with "Premultiply alpha" OFF, which is ` +
								`what the SDK's own art uses.`,
						);
					}
				} catch {
					// Unreadable as a PNG is the atlas's problem to report, not this
					// check's to guess at.
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

	return { problems, notes, skeleton, resolved };
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

/**
 * The PNGs in a delivery folder that belong to a rig rather than to a slot.
 *
 * ── Why this is a function and not four lines at each call site ─────────────
 * It was four lines at each call site, and they were not the same four lines.
 * `validateSpineDelivery` found a rig's page through `parseAtlas`, which walks
 * the file structurally; the import and the review tab each re-scanned the
 * atlas with a regex of their own. So an atlas whose header the regex did not
 * recognise validated as a complete rig AND had its page handed to the matcher
 * as loose art — matched to the symbol it is named after, then refused for
 * being 454x481 in a 200x200 slot, because a packed page is whatever size it
 * packed to. The delivery was correct; the report blamed the artist for it.
 *
 * Both readings are kept, because they fail differently: parseAtlas
 * understands the format, the scan catches a page in a file parseAtlas gives up
 * on. What matters is that every caller now asks the same question and gets the
 * same answer.
 */
export function atlasPageFiles(dir) {
	if (!fs.existsSync(dir)) return new Set();
	const entries = fs.readdirSync(dir);
	const pages = new Set();

	for (const file of entries.filter((f) => f.endsWith('.atlas'))) {
		const full = path.join(dir, file);
		const found = new Set();

		// The structural read — the same one validateSpineDelivery trusts.
		for (const page of readAtlasRegions(full)?.pages ?? []) {
			found.add(path.basename(page));
		}

		// And the textual one, for a header it could not follow. A BOM is stripped
		// as well as whitespace: it is invisible in every editor and makes an
		// exact-name comparison fail for no reason anybody can see.
		for (const line of fs.readFileSync(full, 'utf8').split('\n')) {
			const trimmed = line.replace(/^\uFEFF/, '').trim();
			if (/\.(png|webp|jpg|jpeg)$/i.test(trimmed) && !trimmed.includes(':')) {
				found.add(path.basename(trimmed));
			}
		}

		// ── when the atlas names nothing ────────────────────────────────────
		// Some exports carry no page line either reader can find. With no page
		// identified there is nothing to exclude, so the packed page is handed to
		// the matcher as loose art, matched to the symbol it is named after, and
		// refused for being the size it packed to. That is the worst available
		// outcome, and it happens on a delivery that is otherwise correct.
		//
		// So fall back to the export CONVENTION, but only here — where there is
		// no better evidence. Spine names the page after the skeleton, which is
		// exactly why `l5.json` arrives beside an `l5.png` that is the page. When
		// the atlas DOES name its page, that always wins, so a delivery whose
		// flat symbol art is legitimately called `l5.png` is untouched.
		if (!found.size) {
			const stem = path.basename(file, '.atlas').toLowerCase();
			for (const candidate of entries) {
				if (!/\.(png|webp)$/i.test(candidate)) continue;
				if (path.basename(candidate, path.extname(candidate)).toLowerCase() === stem) {
					found.add(candidate);
				}
			}
		}

		for (const page of found) pages.add(page);
	}
	return pages;
}
