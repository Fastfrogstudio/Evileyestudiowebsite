/**
 * Resources the built game would fetch from outside Stake's CDN.
 *
 * ── Why this is an approval gate and not a nicety ───────────────────────────
 * Stake's RGS approval notes state that a submitted build must consist only of
 * static files, and that external resources beyond the Stake Engine CDN raise
 * console errors and fail approval.
 *
 * The sample apps every generated game is cloned from load a stylesheet from
 * use.typekit.net, and the font it provides — proxima-nova — is referenced by
 * roughly a dozen components across components-shared, components-pixi and
 * components-ui-pixi: buttons, popups, the bet counter, the buy-bonus button,
 * the game name, every rendered amount. So it is inherited by every game built
 * this way, it is genuinely load-bearing, and nobody notices because it
 * resolves fine on a developer's machine.
 *
 * ── What counts, and what deliberately does not ─────────────────────────────
 * Only things the BROWSER would fetch: stylesheet links, script sources, fonts,
 * images, and preloads. Not URLs in comments, not documentation links, and not
 * the `"app": "https://www.codeandweb.com/texturepacker"` line that TexturePacker
 * writes into every sprite atlas — that is inert metadata inside a JSON file the
 * game parses, not a request. Flagging those would bury the one that matters
 * under a dozen that do not.
 */

import fs from 'fs-extra';
import path from 'node:path';

/** Hosts a submitted build may legitimately reach. */
const ALLOWED_HOSTS = [/(^|\.)stake\.com$/i, /(^|\.)stake-engine\.com$/i];

/** Attributes a browser actually fetches from. */
const FETCHING_ATTRIBUTES = /(?:href|src)\s*=\s*["'](https?:\/\/[^"']+)["']/gi;

/** Files worth scanning: the HTML shell and anything that ships as markup/CSS. */
const SCANNED = ['.html', '.css', '.svelte'];

function isAllowed(url) {
	try {
		const { hostname } = new URL(url);
		return ALLOWED_HOSTS.some((re) => re.test(hostname));
	} catch {
		return false;
	}
}

/**
 * Walk an app directory and report every external resource the build would
 * fetch. Returns [{ file, url, line }].
 */
export function externalResources(appDir, { root = appDir } = {}) {
	const found = [];
	if (!fs.existsSync(appDir)) return found;

	for (const entry of fs.readdirSync(appDir, { withFileTypes: true })) {
		const full = path.join(appDir, entry.name);
		if (entry.isDirectory()) {
			// build output is generated FROM src, so reporting both would double
			// every finding and point at a file nobody edits.
			if (['node_modules', '.svelte-kit', 'build', 'dist', 'static'].includes(entry.name)) continue;
			found.push(...externalResources(full, { root }));
			continue;
		}
		if (!SCANNED.includes(path.extname(entry.name))) continue;

		const source = fs.readFileSync(full, 'utf8');
		const lines = source.split('\n');
		for (let i = 0; i < lines.length; i += 1) {
			const line = lines[i];
			// A URL inside a comment is not a request.
			if (/^\s*(\/\/|\*|<!--)/.test(line)) continue;
			for (const match of line.matchAll(FETCHING_ATTRIBUTES)) {
				const url = match[1];
				if (isAllowed(url)) continue;
				found.push({ file: path.relative(root, full), url, line: i + 1 });
			}
		}
	}
	return found;
}
