import fs from 'fs-extra';
import path from 'node:path';
import chalk from 'chalk';

import { loadGameSpec } from '../lib/loadSpec.js';
import { getMechanic } from '../lib/mechanics.js';
import { loadArtGuide, buildGenerationManifest } from '../lib/artGuide.js';
import { buildAnimBrief } from '../lib/animBrief.js';

/**
 * `forge deliver` — one list of every file, and exactly what to call it.
 *
 * ── Why this is separate from the briefs ────────────────────────────────────
 * `art:prompts` says what to draw. `anim:brief` says what to rig. Both are
 * organised around the WORK. This is organised around the DELIVERY: a flat list
 * of filenames someone can tick off, because that is the artefact that decides
 * whether an import succeeds.
 *
 * The name is not cosmetic. `art:import` matches a delivered file to its slot by
 * name, and the front end loads a skeleton by its exact key. A correct asset
 * under the wrong name is an asset the game does not have.
 *
 * ── Two ways to deliver each visual ─────────────────────────────────────────
 * Every symbol and screen can arrive as either:
 *
 *   FLAT   a PNG per part. Imported, resampled and checked immediately. The game
 *          renders it, but nothing about it moves.
 *   RIGGED a Spine skeleton, its atlas and the atlas page. Animated, and the
 *          only form the sample apps actually ship.
 *
 * Flat first is the right order — it gets the game on screen with your art in it
 * and lets the animation work happen against something real, rather than against
 * a description. Both are listed so the choice is visible per asset rather than
 * assumed for all of them.
 */
export function deliver({ specPath, guidePath, sdkDir, out = null, json = false }) {
	const spec = loadGameSpec(specPath);
	const mechanic = getMechanic(spec.game.mechanic);
	const referenceAppDir = sdkDir ? path.join(sdkDir, 'apps', mechanic.webApp) : null;

	// The art side needs a guide; the animation side does not. A missing guide
	// should not withhold the half of the list that does not depend on it.
	let artJobs = [];
	let guideMissing = false;
	try {
		const guide = loadArtGuide(guidePath);
		if (guide) {
			artJobs = buildGenerationManifest({ spec, guide, referenceAppDir }).jobs.filter(
				(j) => !j.skipped,
			);
		} else {
			guideMissing = true;
		}
	} catch {
		guideMissing = true;
	}

	const anim = buildAnimBrief({ spec, referenceAppDir });

	// Group the flat files by the asset key they belong to, because that is how
	// they are delivered — one folder per Spine asset.
	const byAsset = new Map();
	for (const job of artJobs) {
		if (!byAsset.has(job.assetKey)) byAsset.set(job.assetKey, []);
		byAsset.get(job.assetKey).push(job);
	}

	const payload = {
		game: spec.game.name,
		flat: [...byAsset.entries()].map(([assetKey, jobs]) => ({
			assetKey,
			files: jobs.map((j) => ({
				name: path.basename(j.outputPath),
				width: j.width,
				height: j.height,
				transparent: j.kind !== 'backdrop',
				id: j.id,
			})),
		})),
		rigged: anim.entries.map((e) => ({
			id: e.id,
			skeleton: e.skeletonFile,
			atlas: e.atlasFile,
			animations: e.animations.map((a) => a.name),
			canvas: e.canvas,
		})),
	};

	if (json) {
		console.log(JSON.stringify(payload, null, 2));
		return { ok: true, payload };
	}

	const lines = [];
	lines.push(`# Delivery checklist — ${spec.game.name}`);
	lines.push('');
	lines.push(
		'Names are not cosmetic. Files are matched to slots by name on import, and the game ' +
			'loads skeletons by their exact key — a correct asset under the wrong name is an asset ' +
			'the game does not have.',
	);
	lines.push('');
	lines.push('Matching is forgiving about case, separators and export suffixes: `w_final_v2.png`');
	lines.push('finds `w.png`. It is not forgiving about ambiguity — `cart 2.png` matches nothing,');
	lines.push('because guessing would put the cart art in another slot with nothing to catch it.');
	lines.push('');
	lines.push('**Two folders, not one.** A Spine export names its atlas page after the skeleton, so');
	lines.push('`l5.json` ships alongside an `l5.png` that is the PACKED ATLAS — which collides with the');
	lines.push('flat `l5.png` this list also asks for. They are different pictures with the same name.');
	lines.push('Keep them apart:');
	lines.push('');
	lines.push('```');
	lines.push('delivered/');
	lines.push('  symbols/     l5.png        <- the flat symbol');
	lines.push('  spines/      l5.json  l5.atlas  l5.png   <- the rig and its packed page');
	lines.push('```');
	lines.push('');
	lines.push('Import each folder separately, then:');
	lines.push('');
	lines.push('```bash');
	lines.push(`forge art:import --spec game-spec.yaml --from <folder> --dry-run`);
	lines.push('```');
	lines.push('');

	if (guideMissing) {
		lines.push(
			'> No `art-guide.yaml` yet, so the flat PNG list is not included. Run `forge art:guide`.',
		);
		lines.push('');
	}

	// ── flat ────────────────────────────────────────────────────────────────
	if (payload.flat.length) {
		lines.push('## Flat PNGs');
		lines.push('');
		lines.push(
			'The game renders these immediately. Transparency is not a preference: every part ' +
				'except a full-bleed backdrop is composited by Spine, and one delivered opaque tiles ' +
				'the board with rectangles.',
		);
		lines.push('');
		for (const group of payload.flat) {
			lines.push(`### \`${group.assetKey}/\` — ${group.files.length} file(s)`);
			lines.push('');
			lines.push('| Filename | Size | Background |');
			lines.push('|---|---|---|');
			for (const file of group.files) {
				lines.push(
					`| \`${file.name}\` | ${file.width} × ${file.height} | ` +
						`${file.transparent ? '**transparent**' : 'opaque'} |`,
				);
			}
			lines.push('');
		}
	}

	// ── rigged ──────────────────────────────────────────────────────────────
	lines.push('## Spine deliveries');
	lines.push('');
	lines.push(
		'Each is a skeleton, its atlas, and the atlas page — all three, together, exactly as Spine ' +
			'exports them. A skeleton names regions but does not contain them.',
	);
	lines.push('');
	lines.push(
		'**Self-contained per symbol.** No shared atlas, nothing to pack, nothing to coordinate — ' +
			'one symbol can be re-exported and re-delivered without touching the others.',
	);
	lines.push('');
	lines.push(
		'**One animation per symbol — the name is up to you.** A symbol\'s track is wired up by ' +
			'name on import, so whatever it is called is what plays on a win; Spine\'s default ' +
			'"animation" is fine and needs no re-export. What cannot be worked out is which of ' +
			'SEVERAL tracks is the win, so a symbol rig carrying more than one is refused rather ' +
			'than guessed at.',
	);
	lines.push('');
	lines.push(
		'Screens are the exception. Background.svelte and friends call their tracks as literal ' +
			'strings in their own source, with nothing in between, so those names are exact.',
	);
	lines.push('');
	lines.push('| Skeleton | Atlas | Animations it must contain |');
	lines.push('|---|---|---|');
	for (const entry of payload.rigged) {
		if (!entry.skeleton) continue;
		lines.push(
			`| \`${entry.skeleton}\` | \`${entry.atlas ?? '—'}\` | ` +
				`${entry.animations.map((a) => `\`${a}\``).join(' ') || '—'} |`,
		);
	}
	lines.push('');

	const markdown = `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;

	if (out) {
		fs.outputFileSync(out, markdown, 'utf8');
		const flatCount = payload.flat.reduce((sum, g) => sum + g.files.length, 0);
		console.log(
			chalk.green('✓'),
			`wrote ${out} — ${flatCount} PNG(s), ${payload.rigged.filter((r) => r.skeleton).length} ` +
				`Spine delivery(s)`,
		);
	} else {
		console.log(markdown);
	}
	return { ok: true, payload };
}
