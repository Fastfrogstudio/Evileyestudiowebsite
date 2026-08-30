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
 * ── Seedream, not Seedance ──────────────────────────────────────────────────
 * Seedance is ByteDance's VIDEO model — 30-second clips with native audio. It is
 * the wrong tool for a slot symbol. Seedream is the image line, served from the
 * same BytePlus ModelArk endpoint, and Seedream 5.0 Pro does something this
 * pipeline wants specifically: from one prompt it returns a background plus
 * individual elements as separate transparent PNGs, which is the exact shape a
 * Spine screen is stored in (a backdrop plus named layers).
 *
 * The fields below are from the ModelArk image-generation API rather than
 * guessed. Two of them are easy to get wrong and expensive to get wrong:
 *
 *   size          ONE "WIDTHxHEIGHT" string, not two integers, and each side
 *                 must fall within 512..2048.
 *   watermark     must be explicitly false. A watermarked slot symbol is not a
 *                 slightly worse asset, it is an unusable one.
 *
 * Endpoint, model and key are all config, so a new model version is a settings
 * change. If a field name is wrong the fix is one function and nothing else in
 * the tool moves.
 */

/**
 * What the adapter assumes the provider wants and returns.
 *
 * Kept as data so the app can display it, and so correcting it is an edit to one
 * object rather than a hunt through request-building code.
 */
export const REQUEST_SHAPE = {
	endpoint: 'POST {base}/images/generations',
	bases: {
		'ap-southeast-1': 'https://ark.ap-southeast.bytepluses.com/api/v3',
		'eu-west-1': 'https://ark.eu-west.bytepluses.com/api/v3',
	},
	auth: 'Authorization: Bearer <apiKey>',
	body: {
		model: 'seedream-5-0-pro | seedream-5-0-lite | seedream-4-5',
		prompt: 'the composed prompt (keep under ~600 English words)',
		size: '"WIDTHxHEIGHT" — a STRING, each side within [512, 2048]',
		response_format: 'b64_json',
		watermark: 'false — a watermarked symbol is unusable',
	},
	response: { 'data[0].b64_json': 'base64 image', 'data[0].url': 'a URL to fetch' },
};

/**
 * The size limits the model will actually accept.
 *
 * Seedream takes 512..2048 per side. Most of what a slot game needs is smaller
 * than that: symbol parts in the shipped atlas are 160x160, and a background
 * particle is 17x17. Asking for those directly is a rejected request.
 */
export const SIZE_LIMITS = { min: 512, max: 2048 };

/**
 * The size to GENERATE at, for a part that must end up `width` x `height`.
 *
 * Scaled up to clear the minimum, preserving aspect ratio, then clamped to the
 * maximum. This is not a workaround for the API limit — it is how the art is
 * authored anyway: the sample symbol skeletons have a 1080x1080 authoring canvas
 * whose parts pack down to 160x160, so a high-resolution master that the packer
 * scales down is the correct artefact to hold. Generating a 160px master would
 * throw away detail the atlas could have used.
 *
 * The caller records both sizes, so the packing step knows what to resample to.
 */
export function generationSize(width, height) {
	const { min, max } = SIZE_LIMITS;
	let scale = 1;
	if (Math.min(width, height) < min) scale = min / Math.min(width, height);
	let w = Math.round(width * scale);
	let h = Math.round(height * scale);
	if (Math.max(w, h) > max) {
		const down = max / Math.max(w, h);
		w = Math.round(w * down);
		h = Math.round(h * down);
	}
	// A very long thin part can still fail the minimum after the clamp above —
	// there is no size that satisfies both ends, so the short side wins and the
	// aspect ratio gives slightly. Reported rather than silently distorted.
	const distorted = Math.min(w, h) < min;
	return {
		width: Math.max(min, Math.min(max, w)),
		height: Math.max(min, Math.min(max, h)),
		scaledFrom: { width, height },
		distorted,
	};
}

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
 * The Seedream adapter.
 *
 * `endpoint`, `model` and `apiKey` all come from config so none of them is baked
 * in — a new model version is a settings change, not a release.
 */
export function seedream({ endpoint, apiKey, model, fetchImpl = globalThis.fetch }) {
	if (!endpoint) throw new Error('no image endpoint configured');
	if (!apiKey) throw new Error('no image API key configured');

	return {
		name: 'seedream',
		model,
		async generate(job, { signal } = {}) {
			// The API takes ONE "WIDTHxHEIGHT" string, not two integers, and only
			// within 512..2048 — so the briefed size is scaled up to a valid master
			// and the target is carried through for the packer to resample to.
			const size = generationSize(job.width, job.height);
			const body = {
				model,
				prompt: job.prompt,
				size: `${size.width}x${size.height}`,
				response_format: 'b64_json',
				// Explicitly off. The default is not reliably false, and a watermarked
				// slot symbol is not a slightly worse asset — it is an unusable one.
				watermark: false,
			};
			if (job.negative) body.negative_prompt = job.negative;

			// Carried on every result, success or failure. When a request is
			// refused, the thing you need to see is what was actually sent — not a
			// description of what the adapter intends to send.
			const sent = { ...body };

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
					sent,
				};
			}

			const payload = await response.json();
			const { bytes, error } = await bytesFromResponse(payload, fetchImpl);
			if (error) {
				return {
					ok: false,
					error: `${error}. Response keys: ${Object.keys(payload ?? {}).join(', ') || '(none)'}`,
					sent,
				};
			}
			return { ok: true, bytes, generatedAt: size, sent };
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
	return seedream({
		endpoint: config.imageEndpoint,
		apiKey: config.imageApiKey,
		model: config.imageModel || 'seedream-5-0-pro',
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

	// Checked against what was REQUESTED, not against the briefed target. The
	// request is deliberately larger — the model has a 512 floor and a
	// high-resolution master is the right artefact to keep — so comparing to the
	// target would warn on every single asset and mean nothing.
	const asked = result.generatedAt ?? { width: job.width, height: job.height };
	const size = readPngSize(target);
	const warnings = [];
	if (size && (size.width !== asked.width || size.height !== asked.height)) {
		const sameShape = Math.abs(asked.width / asked.height - size.width / size.height) < 0.01;
		warnings.push(
			`returned ${size.width}x${size.height}, asked for ${asked.width}x${asked.height}` +
				(sameShape
					? ' — same aspect ratio, so it only needs resampling'
					: ' — and a different aspect ratio, so the model composed a different picture'),
		);
	}
	if (asked.distorted) {
		warnings.push(
			`no size satisfies both the 512 floor and the ${job.width}x${job.height} ratio, so this ` +
				`was generated slightly off-ratio and will need cropping rather than scaling`,
		);
	}
	return {
		id: job.id,
		ok: true,
		path: job.outputPath,
		bytes: result.bytes.length,
		size,
		// Both sizes, so the packing step knows what to resample the master down to.
		target: { width: job.width, height: job.height },
		warnings,
	};
}
