import fs from 'fs-extra';
import path from 'node:path';
import chalk from 'chalk';

import { loadGameSpec } from '../lib/loadSpec.js';
import { getMechanic } from '../lib/mechanics.js';
import { ART_GUIDE_TEMPLATE, loadArtGuide, buildGenerationManifest } from '../lib/artGuide.js';

/**
 * `forge art:guide` — write the style guide template next to the spec.
 */
export function artGuide({ out, force = false }) {
	if (fs.existsSync(out) && !force) {
		throw new Error(`${out} already exists. Re-run with --force to overwrite it.`);
	}
	fs.ensureDirSync(path.dirname(out));
	fs.writeFileSync(out, ART_GUIDE_TEMPLATE, 'utf8');
	console.log(chalk.green('✓'), `wrote ${out}`);
	console.log(
		chalk.dim(
			'\n  Describe the look in your own words. The one line that matters most is\n' +
				'  style.summary — every prompt inherits it, and it is what makes eleven\n' +
				'  separately generated symbols look like one game.\n',
		),
	);
	return { ok: true };
}

/**
 * `forge art:prompts` — one prompt per asset part, at the exact size it must be.
 *
 * ── What this is for ────────────────────────────────────────────────────────
 * The generation loop that works is: describe the style once, generate
 * candidates, keep the good ones, and let those anchor everything after. The
 * tedious middle is knowing what to ask for — that THIS game needs eleven
 * 200x200 symbols, a 2020x991 backdrop, a 404x220 mine cart and a 17x17
 * particle, and which of those need a transparent background.
 *
 * forge already derives all of it, so this emits it as prompts a generator can
 * consume directly.
 *
 * Provider-agnostic. It writes subject, prompt, negative prompt and exact
 * dimensions; pointing that at Seedance or anything else is the adapter's job,
 * which also means changing model does not invalidate the manifest.
 */
export function artPrompts({ specPath, guidePath, sdkDir, out, only = null, json = false }) {
	const spec = loadGameSpec(specPath);
	const guide = loadArtGuide(guidePath);
	if (!guide) {
		throw new Error(
			`no art guide at ${guidePath}. Run "forge art:guide" to write one, then describe the look.`,
		);
	}

	// The reference app is where the layer lists come from: its atlases name the
	// exact parts this game's Spine skeletons expect. Without it we would be
	// inventing a part list, and art that fits nothing is worse than none.
	const mechanic = getMechanic(spec.game.mechanic);
	const referenceAppDir = sdkDir ? path.join(sdkDir, 'apps', mechanic.webApp) : null;
	if (sdkDir && !fs.existsSync(referenceAppDir)) {
		throw new Error(`${referenceAppDir} does not exist — is --sdk pointing at a web-sdk checkout?`);
	}

	const manifest = buildGenerationManifest({ spec, guide, referenceAppDir });
	if (only) {
		const kinds = only.split(',').map((s) => s.trim());
		manifest.jobs = manifest.jobs.filter(
			(j) => kinds.includes(j.kind) || kinds.includes(j.assetKey),
		);
	}

	if (json) {
		console.log(JSON.stringify(manifest, null, 2));
		return { ok: true, manifest };
	}

	if (out) {
		fs.ensureDirSync(path.dirname(out));
		fs.writeFileSync(out, JSON.stringify(manifest, null, 2), 'utf8');
	}

	const usable = manifest.jobs.filter((j) => !j.skipped);
	const undescribed = usable.filter((j) => !j.described);

	console.log(chalk.bold(`\nGeneration manifest — ${spec.game.name}\n`));
	console.log(`  ${usable.length} asset(s) to generate, at the sizes this game needs`);

	const byKind = {};
	for (const job of usable) byKind[job.kind] = (byKind[job.kind] ?? 0) + 1;
	for (const [kind, count] of Object.entries(byKind)) {
		console.log(chalk.dim(`    ${String(count).padStart(4)}  ${kind}`));
	}

	// An undescribed job still gets a prompt, but a generic one. Saying so is the
	// difference between a set that looks like one game and eleven strangers.
	if (undescribed.length) {
		console.log(
			chalk.yellow(`\n  ${undescribed.length} have no subject line in the guide`),
			chalk.dim('— they will generate from the style alone.'),
		);
		console.log(
			chalk.dim(
				`    Add them under "symbols:" or "parts:" in ${path.basename(guidePath)} to say what each one IS.`,
			),
		);
		for (const job of undescribed.slice(0, 6)) {
			console.log(chalk.dim(`      ${job.id}  ${job.width}x${job.height}`));
		}
		if (undescribed.length > 6) console.log(chalk.dim(`      ... and ${undescribed.length - 6} more`));
	}

	const skipped = manifest.jobs.filter((j) => j.skipped);
	for (const job of skipped) {
		console.log(chalk.yellow('  !'), `${job.id}: ${job.skipped}`);
	}

	if (out) console.log(chalk.green('\n✓'), `wrote ${out}`);
	console.log(
		chalk.dim(
			'\n  Each job carries a prompt, a negative prompt and exact pixel dimensions.\n' +
				'  Generate candidates, then "forge art:accept" to promote the keepers into\n' +
				'  assets-source/ and register them as style references for the next batch.\n',
		),
	);

	return { ok: true, manifest };
}
