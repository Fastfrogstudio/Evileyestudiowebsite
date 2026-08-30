import fs from 'fs-extra';
import path from 'node:path';

import { readPngSize } from './png.js';

/**
 * Where generated art actually comes from.
 *
 * ── The shape of this file, and why ─────────────────────────────────────────
 * Everything upstream — the art brief, the spec, the atlas layer lists — is
 * settled and testable. The one unsettled thing is the vendor's HTTP contract,
 * so it lives HERE, in one adapter, behind an interface the rest of the tool
 * codes against. Change provider and nothing else moves.
 *
 * ── An honest note about the Seedance adapter ───────────────────────────────
 * The request and response shapes below are a documented GUESS. I have not seen
 * Seedance's API and could not call it from here to find out, so `REQUEST_SHAPE`
 * spells out exactly what is assumed. If a field name is wrong, the fix is one
 * line in `seedance()` and nothing else in the tool changes.
 *
 * The alternative was to invent something confident-looking and let it fail at
 * runtime with a message that blamed the wrong thing. This way the assumption is
 * legible, and `forge art:check` calls the endpoint once and reports what came
 * back so it can be corrected against reality rather than against a guess.
 */

/**
 * What the adapter assumes the provider wants and returns.
 *
 * Kept as data so the app can display it, and so correcting it is an edit to one
 * object rather than a hunt through request-building code.
 */
export const REQUEST_SHAPE = {
	method: 'POST',
	auth: 'Authorization: Bearer <apiKey>',
	body: {
		model: '<model>',
		prompt: '<the composed prompt>',
		negative_prompt: '<the avoid list, when the guide has one>',
		width: '<int>',
		height: '<int>',
		// Every part except a full-bleed backdrop is composited by Spine, so it
		// must arrive with an alpha channel. If the provider spells this
		// differently, this is the field to change.
		transparent: '<bool>',
		n: 1,
	},
	response: {
		// Checked in this order; the first that is present wins.
		'data[0].b64_json': 'base64 PNG',
		'data[0].url': 'a URL to fetch',
		'images[0]': 'base64 PNG or URL',
	},
};

/** Pull image bytes out of whatever the provider returned. */
async function bytesFromResponse(payload, fetchImpl) {
	const first =
		payload?.data?.[0] ?? payload?.images?.[0] ?? payload?.output?.[0] ?? payload?.result?.[0];
	if (!first) return { error: 'no image in the response' };

	const b64 = typeof first === 'string' ? null : (first.b64_json ?? first.base64 ?? first.image);
	if (b64) return { bytes: Buffer.from(b64, 'base64') };

	const url = typeof first === 'string' ? first : (first.url ?? first.image_url);
	if (!url) return { error: 'the response held neither base64 nor a URL' };
	if (url.startsWith('data:')) {
		return { bytes: Buffer.from(url.slice(url.indexOf(',') + 1), 'base64') };
	}
	const image = await fetchImpl(url);
	if (!image.ok) return { error: `fetching the image URL returned ${image.status}` };
	return { bytes: Buffer.from(await image.arrayBuffer()) };
}

/**
 * The Seedance adapter.
 *
 * `endpoint`, `model` and `apiKey` all come from config so none of them is baked
 * in — a new model version is a settings change, not a release.
 */
export function seedance({ endpoint, apiKey, model, fetchImpl = globalThis.fetch }) {
	if (!endpoint) throw new Error('no image endpoint configured');
	if (!apiKey) throw new Error('no image API key configured');

	return {
		name: 'seedance',
		model,
		async generate(job, { signal } = {}) {
			const body = {
				model,
				prompt: job.prompt,
				width: job.width,
				height: job.height,
				n: 1,
			};
			if (job.negative) body.negative_prompt = job.negative;
			// A backdrop is the one thing that must NOT have alpha.
			if (job.kind !== 'backdrop') body.transparent = true;

			const response = await fetchImpl(endpoint, {
				method: 'POST',
				signal,
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify(body),
			});

			if (!response.ok) {
				const text = await response.text().catch(() => '');
				return {
					ok: false,
					// The provider's own message, not a paraphrase — a 401 and a bad
					// field name need completely different fixes and only it knows which.
					error: `${response.status} ${response.statusText}${text ? `: ${text.slice(0, 300)}` : ''}`,
				};
			}

			const payload = await response.json();
			const { bytes, error } = await bytesFromResponse(payload, fetchImpl);
			if (error) {
				return {
					ok: false,
					error: `${error}. Response keys: ${Object.keys(payload ?? {}).join(', ') || '(none)'}`,
				};
			}
			return { ok: true, bytes };
		},
	};
}

/** A provider that writes nothing, for testing the pipeline without spending. */
export function dryRunProvider() {
	return {
		name: 'dry-run',
		async generate() {
			return { ok: false, error: 'dry run — no image requested' };
		},
	};
}

export function makeProvider(config) {
	if (!config?.imageEndpoint || !config?.imageApiKey) return null;
	return seedance({
		endpoint: config.imageEndpoint,
		apiKey: config.imageApiKey,
		model: config.imageModel || 'seedance-2.5',
	});
}

/**
 * Generate one job straight to the path the manifest says it belongs at.
 *
 * No candidate folder and no selection step: the brief describes the style, the
 * job describes the asset, and the result lands where the game expects it. A
 * regeneration overwrites — which is what makes "change the brief and re-run"
 * the way to iterate, rather than accumulating a folder of near-misses.
 *
 * The size check stays, because it is not a matter of taste. A generator asked
 * for 404x220 will cheerfully return 1024x1024, and the atlas packer takes it at
 * face value — the prop lands at three times the scale of the scene it sits in.
 */
export async function generateJob({ job, provider, gameDir, signal }) {
	const result = await provider.generate(job, { signal });
	if (!result.ok) return { id: job.id, ok: false, error: result.error };

	const target = path.join(gameDir, job.outputPath);
	fs.ensureDirSync(path.dirname(target));
	fs.writeFileSync(target, result.bytes);

	const size = readPngSize(target);
	const warnings = [];
	if (size && (size.width !== job.width || size.height !== job.height)) {
		const sameShape = Math.abs(job.width / job.height - size.width / size.height) < 0.01;
		warnings.push(
			`returned ${size.width}x${size.height}, briefed ${job.width}x${job.height}` +
				(sameShape
					? ' — same aspect ratio, so it only needs resampling'
					: ' — and a different aspect ratio, so the model composed a different picture'),
		);
	}
	return { id: job.id, ok: true, path: job.outputPath, bytes: result.bytes.length, size, warnings };
}
