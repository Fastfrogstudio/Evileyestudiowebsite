import fs from 'fs-extra';
import path from 'node:path';
import chalk from 'chalk';

import { loadGameSpec } from '../lib/loadSpec.js';
import { getMechanic } from '../lib/mechanics.js';
import { loadArtGuide, buildGenerationManifest } from '../lib/artGuide.js';
import { decodePng, resize, alphaCoverage, opaqueBounds, writePng } from '../lib/image.js';

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

export function artImport({ specPath, guidePath, sdkDir, fromDir, gameDir, dryRun = false }) {
	const spec = loadGameSpec(specPath);
	const guide = loadArtGuide(guidePath);
	if (!guide) {
		throw new Error(`no art guide at ${guidePath} — run "forge art:guide" first.`);
	}
	if (!fs.existsSync(fromDir)) throw new Error(`--from does not exist: ${fromDir}`);

	const mechanic = getMechanic(spec.game.mechanic);
	const referenceAppDir = sdkDir ? path.join(sdkDir, 'apps', mechanic.webApp) : null;
	const manifest = buildGenerationManifest({ spec, guide, referenceAppDir });
	const jobs = manifest.jobs.filter((j) => !j.skipped);

	const delivered = fs
		.readdirSync(fromDir, { withFileTypes: true })
		.filter((e) => e.isFile() && /\.png$/i.test(e.name))
		.map((e) => e.name);

	const { matched, unmatched, ambiguous } = matchFiles(delivered, jobs);

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

	console.log('');
	console.log(
		`  ${chalk.green(`${imported.length} imported`)}` +
			(refused.length ? `  ${chalk.red(`${refused.length} refused`)}` : '') +
			(missing.length ? `  ${chalk.yellow(`${missing.length} still missing`)}` : '') +
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

	return {
		ok: refused.length === 0,
		imported: imported.length,
		refused: refused.length,
		missing: missing.length,
		unmatched: unmatched.length,
	};
}
