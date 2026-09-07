/**
 * Strip the sample game's IDENTITY out of a freshly scaffolded app.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * `scaffold` clones a whole sample app and then patches the handful of things it
 * knows about — the symbol map, the board size, the recipe hooks. Everything it
 * does not name stays exactly as the sample left it. That is the right default
 * for behaviour (you inherit a working spin/reveal/win flow) and the wrong one
 * for identity: the game ships under the sample's name, with the sample's logo
 * placeholder, and with the SDK's translation-debug panel drawn over the reels.
 *
 * All four samples carry the same three leftovers, so this was never a one-off:
 *
 *   apps/lines    <I18nTest />   name="LINES GAME"
 *   apps/ways     <I18nTest />   name="WAYS GAME"
 *   apps/cluster  <I18nTest />   name="CLUSTER GAME"
 *   apps/scatter  <I18nTest />   name="SCATTER GAME"
 *
 * Verified against a real production build before writing this: "TRANSLATIONS
 * TEST", "ADD YOUR LOGO" and "LINES GAME" all survive `vite build` into
 * index.html and the JS bundle. They are not dev-only — <I18nTest /> sits
 * unconditionally inside Game.svelte's loaded branch, so it renders for players.
 *
 * ── What this deliberately does NOT do ──────────────────────────────────────
 * Theme art — background, reel frame, symbol sheets — is not identity text and
 * cannot be fixed by a string replacement; the components hardcode
 * <SpineProvider key="..."> and play named tracks. That is handled separately by
 * the placeholder pass, which owns the question of what an undelivered asset
 * should look like. This function only removes words that name the wrong game.
 */

import fs from 'fs-extra';
import path from 'node:path';

/** The debug overlay, its import, and the file itself. */
const I18N_TEST = {
	component: /^\s*<I18nTest \/>\n/m,
	import: /^\s*import I18nTest from '\.\/I18nTest\.svelte';\n/m,
	file: 'I18nTest.svelte',
};

/** `<UiGameName name="LINES GAME" />` — the sample's title, drawn top-left. */
const GAME_NAME = /(<UiGameName\s+name=)"[^"]*"/;

/** The logo snippet's placeholder string, drawn top-right. */
const LOGO_TEXT = /(\btext=)"ADD YOUR LOGO"/;

/**
 * The name to show players.
 *
 * `game.name` is kebab-case because it is also the directory name, so it is the
 * wrong thing to draw on screen ("vol-medium"). `workingName` is the field the
 * spec template documents as human-readable ("Le Bandit"), so prefer it and fall
 * back only when a spec omits it.
 */
export function displayName(spec) {
	const working = spec?.game?.workingName;
	if (typeof working === 'string' && working.trim()) return working.trim();
	return String(spec?.game?.name ?? '').trim();
}

/**
 * Remove the sample's identity from an app directory.
 *
 * Returns what changed and what could not be found, rather than throwing: a
 * future SDK sample may drop one of these on its own, and a scaffold should not
 * fail because there was nothing left to clean up. The caller reports `missed`
 * so a silently-skipped replacement is visible instead of assumed.
 *
 * @param {string} appDir
 * @param {object} spec
 * @returns {{changed: string[], missed: string[], name: string}}
 */
export function desample(appDir, spec) {
	const changed = [];
	const missed = [];
	const name = displayName(spec);

	const gamePath = path.join(appDir, 'src', 'components', 'Game.svelte');
	if (!fs.existsSync(gamePath)) {
		return { changed, missed: ['Game.svelte'], name };
	}

	let source = fs.readFileSync(gamePath, 'utf8');

	// The debug panel: drop the usage and the now-unused import together, or
	// svelte-check fails the build on an unused import that eslint also flags.
	if (I18N_TEST.component.test(source)) {
		source = source.replace(I18N_TEST.component, '');
		source = source.replace(I18N_TEST.import, '');
		changed.push('removed <I18nTest /> translation-debug overlay');
	} else {
		missed.push('<I18nTest />');
	}

	if (GAME_NAME.test(source)) {
		source = source.replace(GAME_NAME, `$1"${name}"`);
		changed.push(`game name -> "${name}"`);
	} else {
		missed.push('<UiGameName name>');
	}

	// The logo slot is a real slot the art team fills; what is wrong is the
	// placeholder STRING shipping as if it were the brand. Until a logo asset
	// exists the game's own name is the honest thing to draw there.
	if (LOGO_TEXT.test(source)) {
		source = source.replace(LOGO_TEXT, `$1"${name}"`);
		changed.push(`logo placeholder -> "${name}"`);
	} else {
		missed.push('ADD YOUR LOGO');
	}

	fs.writeFileSync(gamePath, source, 'utf8');

	// Delete the component only once nothing references it. Leaving the file
	// behind is harmless but it is dead weight in the upload, and its absence is
	// the clearest signal to a reviewer that the overlay is really gone.
	const testFile = path.join(appDir, 'src', 'components', I18N_TEST.file);
	if (fs.existsSync(testFile) && !source.includes('I18nTest')) {
		fs.removeSync(testFile);
		changed.push(`deleted components/${I18N_TEST.file}`);
	}

	return { changed, missed, name };
}
