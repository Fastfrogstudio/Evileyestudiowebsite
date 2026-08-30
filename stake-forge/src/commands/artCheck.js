import fs from 'fs-extra';
import path from 'node:path';
import chalk from 'chalk';

import { seedream, generationSize, REQUEST_SHAPE } from '../lib/imageProvider.js';
import { readPngSize } from '../lib/png.js';

/**
 * `forge art:check` — one request, reported in full.
 *
 * ── Why this exists before the batch does ───────────────────────────────────
 * The first real call to a provider is where every wrong assumption surfaces at
 * once: a bad key, a field the API does not know, a model id that moved, a size
 * outside the accepted range, a response shaped differently from what the parser
 * expects. Discovering that partway through 178 requests tells you almost
 * nothing, costs money, and leaves a half-written asset folder.
 *
 * So this sends ONE request, with the smallest valid payload, and prints what
 * came back — including the provider's own error text rather than a paraphrase.
 * A 401 and an unknown-field 400 need completely different fixes, and only the
 * provider knows which one happened.
 *
 * It writes the image to a temp path rather than into the game, because the
 * point is to prove the wiring, not to produce an asset.
 */
export function artCheck({ endpoint, apiKey, model, out = null, prompt = null }) {
	if (!endpoint) throw new Error('no --endpoint, and none configured');
	if (!apiKey) throw new Error('no --key, and none configured');

	const provider = seedream({ endpoint, apiKey, model });
	// A square well inside the accepted range, so a size rejection means the
	// FIELD is wrong rather than the value.
	const size = generationSize(512, 512);
	const job = {
		id: 'art:check',
		kind: 'symbol',
		width: size.width,
		height: size.height,
		prompt:
			prompt ??
			'a single polished brass coin, centred, painterly digital illustration, ' +
				'transparent background, no text',
		negative: 'text or lettering',
	};

	console.log(chalk.bold('\nChecking the image provider\n'));
	console.log(chalk.dim(`  endpoint  ${endpoint}`));
	console.log(chalk.dim(`  model     ${model}`));
	console.log(chalk.dim(`  size      ${job.width}x${job.height}`));
	console.log(chalk.dim(`  prompt    ${job.prompt.slice(0, 72)}…\n`));

	return provider
		.generate(job)
		.then((result) => {
			if (!result.ok) {
				console.log(chalk.red('✗'), 'the provider refused the request\n');
				console.log(chalk.red(`  ${result.error}\n`));
				// The REAL body, not REQUEST_SHAPE — that object documents the
				// contract with placeholder text, and printing it on a failure reads
				// as if those placeholder strings were literally sent.
				console.log(chalk.bold('  What was actually sent:'));
				console.log(
					chalk.dim(`    ${JSON.stringify(result.sent ?? {}, null, 2).replace(/\n/g, '\n    ')}\n`),
				);
				console.log(chalk.bold('  What the adapter expects back:'));
				console.log(
					chalk.dim(`    ${Object.entries(REQUEST_SHAPE.response).map(([k, v]) => `${k} — ${v}`).join('\n    ')}\n`),
				);
				console.log(
					chalk.dim(
						'  If a field name is wrong, fix it in src/lib/imageProvider.js — the whole\n' +
							'  vendor contract is in that one function and nothing else changes.\n',
					),
				);
				return { ok: false, error: result.error };
			}

			const target = out ?? path.join(process.cwd(), 'art-check.png');
			fs.writeFileSync(target, result.bytes);
			const actual = readPngSize(target);

			console.log(chalk.green('✓'), `the provider returned ${(result.bytes.length / 1024).toFixed(0)}KB`);
			console.log(chalk.green('✓'), `wrote ${target}`);
			if (actual) {
				const matches = actual.width === job.width && actual.height === job.height;
				console.log(
					matches ? chalk.green('✓') : chalk.yellow('  !'),
					`image is ${actual.width}x${actual.height}` +
						(matches ? '' : ` — asked for ${job.width}x${job.height}`),
				);
			} else {
				// Not a PNG. Worth saying plainly: the pipeline writes .png paths and
				// the atlas packer will read them as PNG whatever the bytes are.
				console.log(
					chalk.yellow('  !'),
					'the bytes are not a PNG — check whether the provider needs a format field',
				);
			}
			console.log(
				chalk.dim(
					'\n  Open it. If it has a watermark, the watermark:false field is not being\n' +
						'  honoured and the batch is not worth running yet.\n',
				),
			);
			return { ok: true, path: target, size: actual };
		})
		.catch((err) => {
			// A network-level failure, not an API one — a wrong host looks nothing
			// like a wrong key and should not be reported as if it did.
			console.log(chalk.red('✗'), `could not reach the endpoint: ${err.message}\n`);
			return { ok: false, error: err.message };
		});
}
