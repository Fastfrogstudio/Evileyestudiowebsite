import fs from 'fs-extra';
import path from 'node:path';
import chalk from 'chalk';

import { makeProvider, providerFor, generationSize, REQUEST_SHAPE } from '../lib/imageProvider.js';
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

	// Through makeProvider, so this checks the adapter the pipeline will really
	// use. Building one directly is how it came to test Seedream against an
	// OpenRouter endpoint: it sent prompt/size/watermark to a chat API, which
	// answered 200 with no image, and the report blamed the response shape. The
	// one command whose job is to prove the wiring has to use the wiring.
	const provider = makeProvider({ imageEndpoint: endpoint, imageApiKey: apiKey, imageModel: model });
	if (!provider) throw new Error('could not build a provider for that endpoint and key');
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
			// White, not transparent — the same instruction the real prompts carry,
			// since a check that asks for something the pipeline never asks for is
			// testing a request nobody sends.
			'a single polished brass coin, centred, painterly digital illustration, ' +
				'isolated on a plain pure white background, no text',
		negative: 'text or lettering',
	};

	console.log(chalk.bold('\nChecking the image provider\n'));
	console.log(chalk.dim(`  adapter   ${provider.name}`));
	console.log(chalk.dim(`  endpoint  ${endpoint}`));
	console.log(chalk.dim(`  model     ${provider.model ?? model}`));
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
				const expects =
					provider.name === 'openrouter'
						? { 'choices[0].message.images[0].image_url.url': 'a data:image/png;base64 URL' }
						: REQUEST_SHAPE.response;
				console.log(
					chalk.dim(`    ${Object.entries(expects).map(([k, v]) => `${k} — ${v}`).join('\n    ')}\n`),
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

		console.log(
				chalk.green('✓'),
				`the provider returned ${result.bytes.length < 1024 ? `${result.bytes.length} bytes` : `${(result.bytes.length / 1024).toFixed(0)}KB`}`,
			);
			console.log(chalk.green('✓'), `wrote ${target}`);
			if (actual) {
				// Only a mismatch worth reporting where a size was ASKED FOR. A chat
				// endpoint has no size field, so flagging "asked for 512x512" there
				// reports a request that was never made, and sends someone looking for
				// a setting that does not exist.
				const sizeable = provider.name !== 'openrouter';
				const matches = actual.width === job.width && actual.height === job.height;
				console.log(
					!sizeable || matches ? chalk.green('✓') : chalk.yellow('  !'),
					`image is ${actual.width}x${actual.height}` +
						(sizeable
							? matches
								? ''
								: ` — asked for ${job.width}x${job.height}`
							: ' — this endpoint has no size field, and art:import trims the subject onto the slot canvas anyway'),
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
					provider.name === 'openrouter'
						? '\n  Open it. A watermark, or a picture of something else entirely, means the\n' +
							'  model is wrong for this rather than the wiring — the batch is not worth\n' +
							'  running yet.\n'
						: '\n  Open it. If it has a watermark, the watermark:false field is not being\n' +
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
