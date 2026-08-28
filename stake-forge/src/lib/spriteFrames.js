/**
 * Sprite frames.
 *
 * ── The failure this exists to catch ─────────────────────────────────────────
 * `SYMBOL_INFO_MAP` points each symbol state at an asset:
 *
 *   H1: { static: { type: 'sprite', assetKey: 'h1.webp', ... } }
 *
 * For `type: 'sprite'` that assetKey is a FRAME NAME inside a sprite sheet
 * (static/assets/sprites/<name>/<name>.json), not a key in assets.ts — which is
 * a genuinely easy thing to get wrong, because for `type: 'spine'` it IS an
 * assets.ts key.
 *
 * If the frame is not in any sheet, nothing throws. The symbol renders as
 * NOTHING — an empty cell on the reels, with no error and nothing in the
 * console. Same class of gap as a missing sound, and found the same way: by
 * looking at the running game and noticing the scatter was invisible.
 *
 * The scaffolder cannot avoid this on its own. It runs before any art exists,
 * so it names the placeholder frame after the symbol (`s.webp`) — which happens
 * to match the sample sheet for h1-h4 and l1-l4 and to miss for everything
 * else, because the sheet it was cloned from holds `s.png`, `w.png` and no
 * `l5` at all. The guess is fine; not being told it missed is not.
 */

import fs from 'fs-extra';
import path from 'node:path';

/**
 * Every frame name across the app's sprite sheets, mapped to the sheet it is in.
 *
 * All sheets are collected rather than only the one a symbol "should" be in,
 * because the sheet an assetKey resolves against is chosen at load time by the
 * asset loader, not declared per symbol.
 */
export function readSpriteFrames(appDir) {
	const root = path.join(appDir, 'static', 'assets', 'sprites');
	const frames = new Map();
	const sheets = [];
	if (!fs.existsSync(root)) return { frames, sheets, found: false };

	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const dir = path.join(root, entry.name);
		for (const file of fs.readdirSync(dir)) {
			if (!file.endsWith('.json')) continue;
			try {
				const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
				const names = Object.keys(data.frames ?? {});
				if (!names.length) continue;
				sheets.push({ sheet: entry.name, file, frames: names.length });
				for (const name of names) {
					if (!frames.has(name)) frames.set(name, `${entry.name}/${file}`);
				}
			} catch {
				// A sheet that will not parse is a separate problem, and the app's
				// own loader will say so loudly. Not this check's job.
			}
		}
	}

	return { frames, sheets, found: sheets.length > 0 };
}

/**
 * Sprite assetKeys the game's SYMBOL_INFO_MAP references, per symbol and state.
 *
 * Parsed from constants.ts rather than imported, because importing it would
 * mean running the app's TypeScript — and this has to work on a scaffolded app
 * that has not been built.
 */
export function readSpriteAssetKeys(appDir) {
	const file = path.join(appDir, 'src', 'game', 'constants.ts');
	if (!fs.existsSync(file)) return { entries: [], found: false };

	const source = fs.readFileSync(file, 'utf8');
	const start = source.indexOf('SYMBOL_INFO_MAP');
	if (start === -1) return { entries: [], found: false };
	const block = source.slice(start);

	const entries = [];
	let symbol = null;
	let state = null;

	for (const line of block.split('\n')) {
		// A top-level symbol key: one tab of indent inside the map.
		const symbolMatch = /^\t([A-Za-z0-9_]+):\s*\{/.exec(line);
		if (symbolMatch) {
			symbol = symbolMatch[1];
			continue;
		}
		const stateMatch = /^\t\t([A-Za-z0-9_]+):\s*\{/.exec(line);
		if (stateMatch) {
			state = stateMatch[1];
			continue;
		}
		const keyMatch = /assetKey:\s*'([^']+)'/.exec(line);
		if (keyMatch && symbol) {
			entries.push({ symbol, state, assetKey: keyMatch[1], line });
		}
	}

	// Only the sprite ones. A spine assetKey resolves against assets.ts instead,
	// which is a different namespace — checking it against sheet frames would
	// report every spine symbol as broken.
	const spriteOnly = [];
	const lines = block.split('\n');
	for (let i = 0; i < lines.length; i += 1) {
		if (!/assetKey:\s*'/.test(lines[i])) continue;
		// The type sits on the line above in the generated form, and on the same
		// line in the hand-written sample form. Look at both.
		const window = `${lines[i - 1] ?? ''}\n${lines[i]}`;
		if (!/type:\s*'sprite'/.test(window)) continue;
		const key = /assetKey:\s*'([^']+)'/.exec(lines[i])[1];
		spriteOnly.push(key);
	}

	return { entries, spriteKeys: [...new Set(spriteOnly)], found: true };
}

/**
 * Cross-check: does every sprite frame a symbol points at actually exist?
 *
 * Returns the missing ones grouped by symbol, because a symbol whose frame is
 * missing is invisible in every state at once — reporting six identical lines
 * per symbol would bury the finding it exists to surface.
 */
export function auditSpriteFrames(appDir) {
	const sheets = readSpriteFrames(appDir);
	const used = readSpriteAssetKeys(appDir);

	if (!used.found) return { ok: true, checked: 0, missing: [], sheets, skipped: 'no constants.ts' };
	if (!sheets.found) return { ok: true, checked: 0, missing: [], sheets, skipped: 'no sprite sheets' };

	const bySymbol = new Map();
	for (const entry of used.entries) {
		if (!used.spriteKeys.includes(entry.assetKey)) continue;
		if (sheets.frames.has(entry.assetKey)) continue;
		if (!bySymbol.has(entry.symbol)) bySymbol.set(entry.symbol, new Set());
		bySymbol.get(entry.symbol).add(entry.assetKey);
	}

	const missing = [...bySymbol.entries()].map(([symbol, keys]) => ({
		symbol,
		assetKeys: [...keys].sort(),
		// The near-miss is worth naming: `s.webp` against a sheet holding `s.png`
		// is one character from working, and saying so turns a puzzle into a fix.
		near: [...keys]
			.flatMap((key) => {
				const stem = key.replace(/\.[^.]+$/, '');
				return [...sheets.frames.keys()].filter(
					(f) => f !== key && f.replace(/\.[^.]+$/, '').toLowerCase() === stem.toLowerCase(),
				);
			})
			.sort(),
	}));

	return {
		ok: missing.length === 0,
		checked: used.spriteKeys.length,
		missing,
		sheets,
	};
}
