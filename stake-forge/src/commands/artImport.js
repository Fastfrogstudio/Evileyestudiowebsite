import fs from 'fs-extra';
import path from 'node:path';
import chalk from 'chalk';
import YAML from 'yaml';

import { loadGameSpec } from '../lib/loadSpec.js';
import { getMechanic } from '../lib/mechanics.js';
import { loadArtGuide, buildGenerationManifest } from '../lib/artGuide.js';
import { decodePng, resize, alphaCoverage, opaqueBounds, writePng } from '../lib/image.js';
import {
	groupSpineDeliveries,
	validateSpineDelivery,
	readAtlasRegions,
	atlasPageFiles,
} from '../lib/spineImport.js';
import { buildAnimBrief } from '../lib/animBrief.js';

/**
 * `forge art:import` — take art made anywhere else and make it work here.
 *
 * ── The seam this sits on ───────────────────────────────────────────────────
 * Art is generated in whatever tool the studio already uses. That tool knows
 * about style; it does not know that THIS game needs a 404x220 mine cart with an
 * alpha channel and a 2020x991 backdrop without one. So the handoff is: forge
 * says what to make (art:prompts), the studio makes it, and this brings it back
 * in and fixes what can be fixed.
 *
 * ── What "optimise" actually means here ─────────────────────────────────────
 * Three things, in order of how quietly they break a game:
 *
 * 1. SIZE. A generator asked for 404x220 returns 1024x1024 as often as not.
 *    Resampled here, premultiplied, so the atlas packer gets what the Spine slot
 *    expects rather than a prop at three times the scale of its scene.
 *
 * 2. ALPHA. A symbol delivered on an opaque background tiles the reel with
 *    rectangles. It looks perfectly fine in a folder. This is the single most
 *    common way a generated asset is unusable, so it is an error rather than a
 *    note — and the reverse is checked too, since a backdrop WITH alpha shows
 *    the void behind it.
 *
 * 3. EXTENT. A "symbol" that fills its whole frame edge to edge has no margin to
 *    animate into and will clip the moment it scales up on a win. Reported with
 *    the measured coverage rather than a guess.
 *
 * Nothing is silently altered beyond resampling. An asset that cannot be made
 * correct is refused with the reason, because a quietly patched asset is a bug
 * that surfaces three steps later wearing someone else's name.
 */

/**
 * Match a delivered file to the asset it is meant to be.
 *
 * Deliberately forgiving about the things people actually do — case, separators,
 * and the version suffixes that accumulate in an export folder (`w-final`,
 * `bg_base_v3`, `cart 2`). Deliberately unforgiving about ambiguity: a file that
 * could be two different assets is reported rather than assigned, because
 * guessing wrong puts the cart art in the shovel's slot and nothing downstream
 * would notice.
 */
export function matchFiles(files, jobs) {
	// Tokenise, drop trailing version words, rejoin. Done as tokens rather than a
	// regex on the whole string because the first version stripped trailing DIGITS
	// to catch "cart 2" — which collapsed h1, h2, h3 and h4 onto the same key and
	// made every high symbol ambiguous. The digits in a slot symbol's name ARE the
	// name.
	//
	// So a bare trailing number is left alone. "cart 2.png" will not match, and
	// will be listed as unmatched next to the name it should have had — which is
	// the right outcome, because the alternative is putting the cart art in the
	// shovel's slot and nothing downstream noticing.
	const VERSION_TOKEN = /^(final|copy|draft|new|v\d+)$/;
	const normalise = (name) => {
		const tokens = path
			.basename(name, path.extname(name))
			.toLowerCase()
			.split(/[\s_\-.]+/)
			.filter(Boolean);
		while (tokens.length > 1 && VERSION_TOKEN.test(tokens[tokens.length - 1])) tokens.pop();
		return tokens.join('');
	};

	const byKey = new Map();
	for (const job of jobs) {
		const key = normalise(job.partName ?? job.id);
		if (!byKey.has(key)) byKey.set(key, []);
		byKey.get(key).push(job);
	}

	const matched = [];
	const unmatched = [];
	const ambiguous = [];
	for (const file of files) {
		const candidates = byKey.get(normalise(file)) ?? [];
		if (candidates.length === 1) matched.push({ file, job: candidates[0] });
		else if (candidates.length > 1) ambiguous.push({ file, jobs: candidates });
		else unmatched.push(file);
	}
	return { matched, unmatched, ambiguous };
}

/**
 * Check one decoded image against what its slot requires.
 *
 * Returns problems (refuse) and notes (proceed, but say so). The split matters:
 * a wrong size is fixable here, a symbol with no transparency is not.
 */
export function inspect(image, job) {
	const problems = [];
	const notes = [];

	const coverage = alphaCoverage(image);
	const wantsAlpha = job.kind !== 'backdrop';

	if (wantsAlpha && coverage > 0.995) {
		problems.push(
			'no transparency — every pixel is opaque. This is composited over the reel by Spine, ' +
				'so it would tile the board with rectangles. Re-export with an alpha channel.',
		);
	}
	if (!wantsAlpha && coverage < 0.995) {
		notes.push(
			`${((1 - coverage) * 100).toFixed(1)}% of this backdrop is transparent — a backdrop ` +
				'is the bottom layer, so anything see-through shows the void behind it.',
		);
	}

	if (wantsAlpha && coverage > 0) {
		const bounds = opaqueBounds(image);
		const fillsFrame =
			bounds &&
			bounds.width >= image.width - 1 &&
			bounds.height >= image.height - 1;
		if (fillsFrame) {
			notes.push(
				'the artwork reaches the edge of its frame, so it has no margin to grow into — ' +
					'it will clip when it scales up on a win.',
			);
		}
	}
	if (coverage === 0) {
		problems.push('the image is entirely transparent — nothing was drawn');
	}

	return { problems, notes, coverage };
}


/**
 * Write what was imported into assets-manifest.yaml.
 *
 * ── Why importing files is not importing art ────────────────────────────────
 * `assets:import` copies into the web-sdk app from the MANIFEST, not from the
 * folder. So art landing in assets-source/ changes nothing on its own: the
 * manifest still names whatever `art:placeholder` put there, and the build
 * cheerfully ships stand-in tiles over the top of real work. Every step passes,
 * the pipeline is green, and the game renders placeholders — the worst shape a
 * failure can take, because there is nothing to notice.
 *
 * Two shapes have to agree here. Flat symbol art is written to
 * `assets-source/symbols/l5.png`, while placeholders sit at `assets-source/
 * l5.png` — the same symbol, two files, and the manifest decides which one is
 * the game's. Paths are therefore written exactly as the files sit relative to
 * assetsSourceDir, never as bare basenames.
 *
 * ── Why rigs get a folder each ──────────────────────────────────────────────
 * A Spine export names its atlas page after the skeleton, so `l5.json` ships
 * with an `l5.png` that is the PACKED PAGE — which collides with the flat
 * `l5.png` this same import writes for the same symbol. Different pictures,
 * identical name. `assets-source/spines/l5/` keeps each rig with its own page
 * and makes the collision impossible rather than merely unlikely.
 */
function wireManifest({ gameDir, imported, spineWired, dryRun }) {
	const manifestPath = path.join(gameDir, 'assets-manifest.yaml');
	let manifest = {};
	if (fs.existsSync(manifestPath)) {
		manifest = YAML.parse(fs.readFileSync(manifestPath, 'utf8')) ?? {};
	}
	manifest.assetsSourceDir = manifest.assetsSourceDir ?? './assets-source';

	const changed = { sprites: [], spines: [], screens: [] };

	// Flat symbol art. A symbol that also has a working rig takes the flat PNG as
	// its resting pose instead, so the two are never registered as rivals.
	const riggedSymbols = new Set(spineWired.filter((w) => w.symbol).map((w) => w.symbol));
	for (const entry of imported) {
		const match = /^symbol\.(.+)$/.exec(entry.job.id);
		if (!match) continue;
		const name = match[1];
		const rel = entry.job.outputPath.replace(/^assets-source\//, '');
		if (riggedSymbols.has(name)) continue; // handled as staticSprite below
		manifest.spriteSymbols = manifest.spriteSymbols ?? {};
		manifest.spriteSymbols[name] = { ...(manifest.spriteSymbols[name] ?? {}), sprite: rel };
		changed.sprites.push(name);
	}

	for (const wired of spineWired) {
		if (wired.symbol) {
			manifest.spineSymbols = manifest.spineSymbols ?? {};
			const flat = imported.find((e) => e.job.id === `symbol.${wired.symbol}`);
			manifest.spineSymbols[wired.symbol] = {
				skeleton: wired.skeleton,
				atlas: wired.atlas,
				png: wired.png,
				// Naming the track is not optional. Without it importAssets wires the
				// symbol's win state to the static frame, so the rig ships, loads, and
				// the symbol still does not move when it pays — the same silent
				// nothing as a misnamed animation, arrived at from the other side.
				// One animation per symbol, and it is the win: everything else renders
				// the flat PNG. See buildAnimBrief.
				...(wired.winAnimation ? { animations: { win: wired.winAnimation } } : {}),
				...(flat
					? { staticSprite: flat.job.outputPath.replace(/^assets-source\//, '') }
					: {}),
			};
			// loadSpec refuses a symbol present in both maps — they would register
			// conflicting assets under one key — so the placeholder entry goes.
			if (manifest.spriteSymbols) delete manifest.spriteSymbols[wired.symbol];
			changed.spines.push(wired.symbol);
		} else if (wired.screen) {
			manifest.screens = manifest.screens ?? {};
			manifest.screens[wired.screen] = {
				skeleton: wired.skeleton,
				atlas: wired.atlas,
				png: wired.png,
			};
			changed.screens.push(wired.screen);
		}
	}

	if (manifest.spriteSymbols && !Object.keys(manifest.spriteSymbols).length) {
		delete manifest.spriteSymbols;
	}

	if (!dryRun && (changed.sprites.length || changed.spines.length || changed.screens.length)) {
		const header =
			`# assets-manifest.yaml — updated by \`forge art:import\`.\n` +
			`#\n` +
			`# Paths are relative to assetsSourceDir. A symbol with a rig lists its\n` +
			`# skeleton/atlas/png here and keeps the flat PNG as staticSprite, which is\n` +
			`# what the non-win states render.\n\n`;
		fs.writeFileSync(manifestPath, header + YAML.stringify(manifest, { lineWidth: 0 }), 'utf8');
	}
	return changed;
}

export function artImport({ specPath, guidePath, sdkDir, fromDir, gameDir, dryRun = false }) {
	const spec = loadGameSpec(specPath);
	// The guide describes the LOOK, and importing does not need one. Every fact an
	// import uses — which slots exist, their pixel sizes, whether each takes alpha
	// — comes from the spec and the reference app. Requiring a guide here made
	// bringing in finished art wait on writing a style document for art that was
	// already drawn.
	const guide = loadArtGuide(guidePath) ?? {};
	if (!fs.existsSync(fromDir)) throw new Error(`--from does not exist: ${fromDir}`);

	const mechanic = getMechanic(spec.game.mechanic);
	const referenceAppDir = sdkDir ? path.join(sdkDir, 'apps', mechanic.webApp) : null;
	const manifest = buildGenerationManifest({ spec, guide, referenceAppDir });
	const jobs = manifest.jobs.filter((j) => !j.skipped);

	const delivered = fs
		.readdirSync(fromDir, { withFileTypes: true })
		.filter((e) => e.isFile() && /\.png$/i.test(e.name))
		.map((e) => e.name);

	// Atlas PAGES are part of a Spine delivery, not loose art. Left in, a page is
	// matched to the symbol it is named after and refused for having the wrong
	// shape — it is whatever size it packed to, never the 200x200 a slot wants —
	// so the report blames the artist for a file they delivered correctly.
	const atlasPages = atlasPageFiles(fromDir);

	const { matched, unmatched: loose, ambiguous } = matchFiles(
		delivered.filter((f) => !atlasPages.has(f)),
		jobs,
	);
	const unmatched = loose;

	console.log(chalk.bold(`\nImporting art for ${spec.game.name}\n`));
	console.log(
		`  ${delivered.length} PNG(s) in ${path.relative(process.cwd(), fromDir) || fromDir}`,
	);
	console.log(`  ${jobs.length} asset slot(s) this game needs\n`);

	const imported = [];
	const refused = [];
	const noted = [];

	for (const { file, job } of matched) {
		const source = path.join(fromDir, file);
		let image;
		try {
			image = decodePng(source);
		} catch (err) {
			refused.push({ file, job, reasons: [err.message] });
			continue;
		}

		const { problems, notes } = inspect(image, job);
		if (problems.length) {
			refused.push({ file, job, reasons: problems });
			continue;
		}

		const needsResize = image.width !== job.width || image.height !== job.height;
		const ratioChanged =
			Math.abs(image.width / image.height - job.width / job.height) > 0.02;
		if (ratioChanged) {
			// Resampling a different shape squashes it. That is a re-export, not
			// something to fix silently.
			refused.push({
				file,
				job,
				reasons: [
					`delivered ${image.width}x${image.height} for a ${job.width}x${job.height} slot — ` +
						'a different aspect ratio, so this is a different composition rather than the ' +
						'same picture at another size. Resampling it would squash it.',
				],
			});
			continue;
		}

		const finished = needsResize ? resize(image, job.width, job.height) : image;
		const target = path.join(gameDir, job.outputPath);
		if (!dryRun) {
			fs.ensureDirSync(path.dirname(target));
			writePng(target, finished);
		}
		imported.push({ file, job, resizedFrom: needsResize ? image : null });
		if (notes.length) noted.push({ file, job, notes });
	}

	// ── Spine deliveries ────────────────────────────────────────────────────
	// A rigged asset is a skeleton, its atlas and the atlas page — validated as a
	// set, because a skeleton names regions it does not contain. The check that
	// matters is the animation NAMES: the front end plays them by literal string,
	// so a rig with the right motion under a different name loads without error
	// and plays nothing on screen.
	const anim = buildAnimBrief({ spec, referenceAppDir });
	const requiredByName = new Map();
	const slotByName = new Map();
	for (const entry of anim.entries) {
		if (!entry.skeletonFile) continue;
		const key = path.basename(entry.skeletonFile, '.json').toLowerCase();
		requiredByName.set(key, entry.animations.map((a) => a.name));
		slotByName.set(key, entry);
	}

	const spineResults = [];
	for (const bundle of groupSpineDeliveries(fromDir)) {
		const required = requiredByName.get(bundle.name.toLowerCase()) ?? [];
		const slot = slotByName.get(bundle.name.toLowerCase()) ?? null;
		const result = validateSpineDelivery({
			skeletonFile: bundle.skeletonFile,
			atlasFile: bundle.atlasFile,
			requiredAnimations: required,
			// Symbols are wired by name through the manifest, so the rig's own
			// animation names are free. Screens are called as literals in the
			// sample components and are not.
			indirect: Boolean(slot && /^symbol\./.test(slot.id)),
		});
		// A skeleton nothing asked for is worth saying, not failing on — it may be
		// a shared asset or something delivered ahead of the spec.
		if (!required.length) {
			result.notes.push('nothing in this game asks for a skeleton by this name');
		}
		spineResults.push({ ...bundle, ...result, required, slot });
	}

	// A rig only reaches the game if it passed. Wiring a broken one in would put
	// an inert symbol on the board with a green pipeline behind it.
	const spineWired = [];
	for (const entry of spineResults) {
		if (entry.problems.length || !entry.slot) continue;
		const relDir = path.join('spines', entry.name);
		const destDir = path.join(gameDir, 'assets-source', relDir);
		const pages = readAtlasRegions(entry.atlasFile)?.pages ?? [];
		if (!dryRun) {
			fs.ensureDirSync(destDir);
			fs.copySync(entry.skeletonFile, path.join(destDir, path.basename(entry.skeletonFile)));
			fs.copySync(entry.atlasFile, path.join(destDir, path.basename(entry.atlasFile)));
			for (const page of pages) {
				fs.copySync(path.join(fromDir, page), path.join(destDir, page));
			}
		}
		const symbolMatch = /^symbol\.(.+)$/.exec(entry.slot.id);
		spineWired.push({
			name: entry.name,
			symbol: symbolMatch ? symbolMatch[1] : null,
			screen: symbolMatch ? null : entry.slot.assetKey,
			skeleton: path.posix.join(relDir, path.basename(entry.skeletonFile)),
			atlas: path.posix.join(relDir, path.basename(entry.atlasFile)),
			png: pages[0] ? path.posix.join(relDir, pages[0]) : null,
			// The track the manifest will name — the required name when the rig uses
			// it, otherwise whatever the rig actually calls it.
			winAnimation: entry.resolved?.[entry.required[0]] ?? entry.required[0] ?? null,
		});
	}

	const wired = wireManifest({ gameDir, imported, spineWired, dryRun });

	const missing = jobs.filter((job) => !matched.some((m) => m.job.id === job.id));

	// ── report ──────────────────────────────────────────────────────────────
	for (const entry of imported) {
		const from = entry.resizedFrom;
		console.log(
			chalk.green('  ✓'),
			`${entry.job.id}`,
			chalk.dim(
				from
					? `— ${from.width}x${from.height} resampled to ${entry.job.width}x${entry.job.height}`
					: `— ${entry.job.width}x${entry.job.height}`,
			),
		);
	}
	for (const entry of noted) {
		for (const note of entry.notes) console.log(chalk.yellow('  !'), `${entry.job.id}: ${note}`);
	}
	for (const entry of refused) {
		console.log(chalk.red('  ✗'), `${entry.file} -> ${entry.job.id}`);
		for (const reason of entry.reasons) console.log(chalk.red(`      ${reason}`));
	}
	for (const entry of spineResults) {
		const ok = entry.problems.length === 0;
		console.log(
			ok ? chalk.green('  ✓') : chalk.red('  ✗'),
			`${entry.name}.json`,
			chalk.dim(`— ${entry.animations.length} animation(s)`),
		);
		for (const problem of entry.problems) console.log(chalk.red(`      ${problem}`));
		for (const note of entry.notes) console.log(chalk.dim(`      ${note}`));
	}
	for (const entry of ambiguous) {
		console.log(
			chalk.yellow('  ?'),
			`${entry.file} could be ${entry.jobs.map((j) => j.id).join(' or ')} — rename it to match one`,
		);
	}
	if (unmatched.length) {
		console.log(chalk.dim(`\n  ${unmatched.length} file(s) matched no slot:`));
		for (const file of unmatched.slice(0, 8)) console.log(chalk.dim(`      ${file}`));
		if (unmatched.length > 8) console.log(chalk.dim(`      ... and ${unmatched.length - 8} more`));
	}

	if (wired.spines.length || wired.sprites.length || wired.screens.length) {
		const parts = [];
		if (wired.spines.length) parts.push(`${wired.spines.join(', ')} as rigs`);
		if (wired.sprites.length) parts.push(`${wired.sprites.length} as flat sprites`);
		if (wired.screens.length) parts.push(`${wired.screens.join(', ')} as screens`);
		console.log(
			chalk.green('\n  ✓'),
			`assets-manifest.yaml now points at your art — ${parts.join(', ')}`,
		);
	}

	console.log('');
	console.log(
		`  ${chalk.green(`${imported.length} imported`)}` +
			(refused.length ? `  ${chalk.red(`${refused.length} refused`)}` : '') +
			(missing.length ? `  ${chalk.yellow(`${missing.length} still missing`)}` : '') +
			(spineResults.length
				? `  ${spineResults.length - spineResults.filter((r) => r.problems.length).length}/` +
					`${spineResults.length} spine ok`
				: '') +
			(dryRun ? chalk.dim('   (dry run — nothing written)') : ''),
	);

	if (missing.length) {
		console.log(chalk.dim('\n  Not yet delivered, with the name each file should have:'));
		for (const job of missing.slice(0, 10)) {
			console.log(
				chalk.dim(`      ${path.basename(job.outputPath)}`.padEnd(28) +
					`${job.width}x${job.height}  ${job.kind === 'backdrop' ? 'opaque' : 'transparent'}`),
			);
		}
		if (missing.length > 10) console.log(chalk.dim(`      ... and ${missing.length - 10} more`));
	}
	console.log('');

	const badSpine = spineResults.filter((r) => r.problems.length).length;
	return {
		ok: refused.length === 0 && badSpine === 0,
		imported: imported.length,
		refused: refused.length,
		missing: missing.length,
		unmatched: unmatched.length,
		spine: { checked: spineResults.length, failed: badSpine },
		wired,
	};
}
