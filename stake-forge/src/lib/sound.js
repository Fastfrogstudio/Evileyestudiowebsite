/**
 * Sound.
 *
 * ── How the web-sdk actually plays audio ─────────────────────────────────────
 * Not as loose files. One audio SPRITE: a single timeline exported in several
 * formats, plus a JSON of millisecond offsets:
 *
 *   { "sprite": { "bgm_main": [71000, 132452.8, true] },
 *     "src":    ["./assets/audio/sounds.ogg", ".m4a", ".mp3", ".ac3"],
 *     "config": { "bgm_main": { "volume": 1 } } }
 *
 * Names are a fixed vocabulary declared as string unions in
 * apps/<app>/src/game/sound.ts, and the event handlers broadcast them by name.
 *
 * ── Why an audit is worth more here than anywhere else ───────────────────────
 * A missing sound does not throw. It is silent — literally. There is no error
 * and nothing in the console; the game just plays nothing at that moment. That
 * is exactly the class of gap an audit exists to catch, and the same shape as
 * the animation-state audit that already exists.
 */

import fs from 'fs-extra';
import path from 'node:path';

/** Parse the MusicName / SoundEffectName string unions out of sound.ts. */
export function readSoundVocabulary(appDir) {
	const file = path.join(appDir, 'src', 'game', 'sound.ts');
	if (!fs.existsSync(file)) return { music: [], effects: [], found: false };

	const source = fs.readFileSync(file, 'utf8');
	const union = (typeName) => {
		const match = new RegExp(`export type ${typeName}\\s*=([\\s\\S]*?);`).exec(source);
		if (!match) return [];
		return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
	};

	return { music: union('MusicName'), effects: union('SoundEffectName'), found: true };
}

/**
 * Which sound names this game's code actually broadcasts.
 *
 * Scans the app's own source for the emitter events that play audio, so the
 * answer reflects THIS game — including any handler a behavior recipe added —
 * rather than a generic list.
 */
export function readSoundsUsed(appDir) {
	const roots = [path.join(appDir, 'src', 'game'), path.join(appDir, 'src', 'components')];
	const used = new Map();

	const walk = (dir) => {
		if (!fs.existsSync(dir)) return;
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			if (!/\.(ts|svelte)$/.test(entry.name)) continue;
			const source = fs.readFileSync(full, 'utf8');

			// The handlers broadcast { type: 'soundOnce' | 'soundMusic' | 'soundLoop',
			// name: '<sound>' }. Match the name beside such a broadcast rather than
			// every quoted string that happens to look like a sound.
			for (const match of source.matchAll(
				/type:\s*'sound(?:Once|Music|Loop)'\s*,\s*name:\s*'([^']+)'/g,
			)) {
				push(used, match[1], path.relative(appDir, full));
			}
			// Some are written the other way round.
			for (const match of source.matchAll(
				/name:\s*'([^']+)'\s*,\s*type:\s*'sound(?:Once|Music|Loop)'/g,
			)) {
				push(used, match[1], path.relative(appDir, full));
			}
			// Sound.svelte calls the player directly rather than broadcasting:
			//   sound.players.once.play({ name: 'sfx_btn_spin' })
			// Missing this shape meant the audit silently under-reported — it found
			// bgm_main (broadcast by a handler) but not sfx_btn_spin (played here).
			for (const match of source.matchAll(/\.play\(\{\s*name:\s*'([^']+)'/g)) {
				push(used, match[1], path.relative(appDir, full));
			}
			// winLevelMap declares its sounds as data, not as a call.
			for (const match of source.matchAll(/(?:sfx|bgm):\s*'([^']+)'/g)) {
				push(used, match[1], path.relative(appDir, full));
			}
		}
	};

	walk(roots[0]);
	walk(roots[1]);
	return used;
}

function push(map, name, where) {
	if (!map.has(name)) map.set(name, new Set());
	map.get(name).add(where);
}

/** Read the audio sprite the app currently ships. */
export function readSoundSprite(appDir) {
	const file = path.join(appDir, 'static', 'assets', 'audio', 'sounds.json');
	if (!fs.existsSync(file)) return { supplied: [], formats: [], found: false, file };

	try {
		const data = JSON.parse(fs.readFileSync(file, 'utf8'));
		return {
			found: true,
			file,
			supplied: Object.keys(data.sprite ?? {}),
			formats: (data.src ?? []).map((s) => path.extname(String(s)).replace('.', '')),
			config: data.config ?? {},
			missingFiles: (data.src ?? []).filter(
				(s) => !fs.existsSync(path.join(appDir, 'static', String(s).replace(/^\.\//, ''))),
			),
		};
	} catch (err) {
		return { supplied: [], formats: [], found: true, file, error: err.message };
	}
}

/**
 * Cross-check: what the code plays, what the sprite supplies, what the
 * vocabulary allows.
 *
 * Three findings matter, in descending order:
 *   missing   played by this game's code, absent from the sprite — silent at
 *             runtime with no error at all
 *   unknown   played by the code but not in sound.ts's union — a typo, and a
 *             type error waiting to happen
 *   unused    supplied but never played — harmless weight, worth knowing
 */
export function auditSound(appDir) {
	const vocabulary = readSoundVocabulary(appDir);
	const used = readSoundsUsed(appDir);
	const sprite = readSoundSprite(appDir);

	const allowed = new Set([...vocabulary.music, ...vocabulary.effects]);
	const supplied = new Set(sprite.supplied);
	const usedNames = [...used.keys()].sort();

	return {
		vocabulary,
		sprite,
		used: usedNames.map((name) => ({ name, where: [...used.get(name)] })),
		missing: usedNames.filter((n) => allowed.has(n) && !supplied.has(n)),
		unknown: usedNames.filter((n) => !allowed.has(n)),
		unused: [...supplied].filter((n) => !used.has(n)).sort(),
		declaredNotSupplied: [...allowed].filter((n) => !supplied.has(n)).sort(),
	};
}
