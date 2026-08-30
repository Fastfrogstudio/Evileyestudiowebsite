import fs from 'fs-extra';
import path from 'node:path';
import chalk from 'chalk';
import YAML from 'yaml';

import { readPngSize } from '../lib/png.js';

/**
 * `forge art:accept` — promote a generated candidate into the game.
 *
 * ── The loop this closes ────────────────────────────────────────────────────
 * Generate several candidates, keep the one that works, and let the keepers
 * anchor the style of everything generated after them. That last step is the one
 * that makes a set look like one game rather than eleven strangers, and it is
 * the step people skip because it is bookkeeping.
 *
 * So accepting an asset does three things at once:
 *   1. copies it to the path the manifest said it belongs at
 *   2. checks it is actually the size that was asked for
 *   3. adds it to the guide's `references`, so the NEXT batch inherits it
 *
 * ── Why the size check is not a formality ───────────────────────────────────
 * A generator asked for 404x220 will cheerfully return 1024x1024. It looks fine
 * in a folder and it is wrong in the game: the atlas packer will take it at face
 * value, the Spine slot expects the briefed size, and the prop lands at three
 * times the scale of the scene it sits in. Caught here it is one regeneration;
 * caught in the build it is a day of confusion.
 *
 * Off-by-a-pixel is allowed because trimming transparent margins legitimately
 * changes the size by a little; a different aspect ratio is not, because that
 * means the model composed a different picture.
 */
export function artAccept({ manifestPath, id, file, guidePath, gameDir, force = false }) {
	if (!fs.existsSync(manifestPath)) {
		throw new Error(`no manifest at ${manifestPath}. Run "forge art:prompts --out" first.`);
	}
	const manifest = fs.readJsonSync(manifestPath);
	const job = manifest.jobs.find((j) => j.id === id);
	if (!job) {
		const near = manifest.jobs
			.filter((j) => j.id.includes(id))
			.slice(0, 5)
			.map((j) => j.id);
		throw new Error(
			`no job "${id}" in the manifest.` + (near.length ? `\n\nDid you mean: ${near.join(', ')}` : ''),
		);
	}
	if (!fs.existsSync(file)) throw new Error(`no such file: ${file}`);

	// ── the size gate ───────────────────────────────────────────────────────
	const size = readPngSize(file);
	if (!size) {
		console.log(chalk.yellow('  !'), `${path.basename(file)} is not a PNG — size not checked`);
	} else if (size.width !== job.width || size.height !== job.height) {
		const briefedRatio = job.width / job.height;
		const actualRatio = size.width / size.height;
		const sameShape = Math.abs(briefedRatio - actualRatio) < 0.01;
		const message =
			`${path.basename(file)} is ${size.width}x${size.height}, but ${job.id} was briefed at ` +
			`${job.width}x${job.height}` +
			(sameShape
				? ' — same aspect ratio, so it only needs resampling.'
				: ' — and a DIFFERENT aspect ratio, so the model composed a different picture. ' +
					'Resampling this will squash it.');
		if (!force) {
			throw new Error(
				`${message}\n\nRegenerate at the briefed size, or re-run with --force to accept it as is.`,
			);
		}
		console.log(chalk.yellow('  !'), message);
	}

	const target = path.join(gameDir, job.outputPath);
	fs.ensureDirSync(path.dirname(target));
	fs.copyFileSync(file, target);
	console.log(chalk.green('✓'), `${job.id} -> ${job.outputPath}`);

	// ── register it as a style anchor ───────────────────────────────────────
	if (guidePath && fs.existsSync(guidePath)) {
		const raw = fs.readFileSync(guidePath, 'utf8');
		const guide = YAML.parse(raw) ?? {};
		const relative = path.relative(path.dirname(guidePath), target);
		guide.references = guide.references ?? [];
		if (!guide.references.includes(relative)) {
			guide.references.push(relative);
			fs.writeFileSync(guidePath, YAML.stringify(guide, { lineWidth: 0 }), 'utf8');
			console.log(
				chalk.green('✓'),
				`added to ${path.basename(guidePath)} references — the next batch inherits this style`,
			);
		}
	}

	return { ok: true, job, target };
}
