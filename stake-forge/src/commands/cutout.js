import fs from 'fs-extra';
import path from 'node:path';
import chalk from 'chalk';

import { decodePng, writePng, alphaCoverage, opaqueBounds } from '../lib/image.js';
import { removeWhiteBackground, looksWhiteBacked, fitOnCanvas, CUTOUT_DEFAULTS } from '../lib/cutout.js';

/**
 * `forge art:cutout` — knock the white background out of generated art.
 *
 * `art:import` already does this on the way in, so this exists for the other
 * half of the job: looking at a batch before committing it to a game, and
 * preparing art for something that is not a slot yet. It takes a file or a
 * folder, same as the script it replaces, and needs no Python.
 */
export function cutout({ input, out = null, size = null, threshold, saturation, feather, dryRun = false }) {
	if (!fs.existsSync(input)) throw new Error(`no such file or folder: ${input}`);

	const stat = fs.statSync(input);
	const files = stat.isDirectory()
		? fs
				.readdirSync(input)
				.filter((f) => /\.png$/i.test(f) && !/_trans\.png$/i.test(f))
				.map((f) => path.join(input, f))
		: [input];

	if (!files.length) throw new Error(`no PNGs in ${input}`);

	const options = { threshold, saturation, feather };
	for (const key of Object.keys(options)) {
		if (options[key] === undefined || options[key] === null) delete options[key];
	}
	const settings = { ...CUTOUT_DEFAULTS, ...options };
	const outDir = out ?? (stat.isDirectory() ? input : path.dirname(input));

	console.log(chalk.bold(`\nCutting out ${files.length} image(s)\n`));
	console.log(
		chalk.dim(
			`  brightness >= ${settings.threshold}, neutral within ${settings.saturation}, ` +
				`${settings.feather}px feather` + (size ? `, fitted to ${size.width}x${size.height}` : ''),
		),
	);
	console.log('');

	let done = 0;
	const skipped = [];

	for (const file of files) {
		const name = path.basename(file);
		let image;
		try {
			image = decodePng(file);
		} catch (err) {
			skipped.push({ name, why: err.message });
			continue;
		}

		if (alphaCoverage(image) <= 0.995) {
			skipped.push({ name, why: 'already has transparency — nothing to cut' });
			continue;
		}
		if (!looksWhiteBacked(image, options)) {
			skipped.push({ name, why: 'its border is not white — this is not art on a background' });
			continue;
		}

		const result = removeWhiteBackground(image, options);
		// The two ways a cutout is not a cutout. Writing either would produce a
		// file that passes every later check and is the wrong picture.
		if (result.removed <= 0.02) {
			skipped.push({ name, why: `only ${(result.removed * 100).toFixed(1)}% matched — nothing removed` });
			continue;
		}
		if (result.removed >= 0.98) {
			skipped.push({ name, why: `${(result.removed * 100).toFixed(1)}% matched — this would erase the art` });
			continue;
		}

		let finished = result.image;
		let fitted = null;
		if (size) {
			fitted = fitOnCanvas(finished, size.width, size.height);
			finished = fitted.image;
		}

		const bounds = opaqueBounds(finished);
		const target = path.join(outDir, `${path.basename(file, '.png')}_trans.png`);
		if (!dryRun) writePng(target, finished);
		done += 1;
		console.log(
			chalk.green('  ✓'),
			`${name} -> ${path.basename(target)}`,
			chalk.dim(
				`${image.width}x${image.height}, ${(result.removed * 100).toFixed(0)}% removed, ` +
					`subject ${bounds.width}x${bounds.height}`,
			),
		);
	}

	for (const entry of skipped) {
		console.log(chalk.yellow('  ·'), `${entry.name} — ${entry.why}`);
	}

	console.log('');
	console.log(
		`  ${chalk.green(`${done} cut out`)}` +
			(skipped.length ? `  ${chalk.yellow(`${skipped.length} skipped`)}` : '') +
			(dryRun ? chalk.dim('   (dry run — nothing written)') : ''),
	);
	console.log('');
	return { ok: true, done, skipped: skipped.length };
}
