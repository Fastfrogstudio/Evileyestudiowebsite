/**
 * Screens / game-mode asset mapping.
 *
 * Every slot below names a REAL asset key consumed by a REAL component in the
 * web-sdk sample apps. The keys were read out of apps/lines (assets.ts plus the
 * component that references them), not guessed:
 *
 *   foregroundAnimation          Background.svelte  — basegame, animations idle + dust
 *   foregroundFeatureAnimation   Background.svelte  — freegame, animations idle + dust
 *   fsIntro / fsIntroNumber      FreeSpinIntro.svelte
 *   fsOutroNumber                FreeSpinOutro.svelte
 *   transition                   TransitionAnimation.svelte (driven by Transition.svelte)
 *   bigwin                       WinAnimation.svelte — animation names come from winLevelMap.ts
 *   coins                        WinCoins.svelte    — a spriteSheet, not a spine
 *   loader + progressBar         LoadingScreen.svelte
 *   globalMultiplier             GlobalMultiplier.svelte
 *   tumble_win / tumble_multiplier  the tumble handlers (cluster/scatter only)
 *   reelhouse / reelsFrame / anticipation  board chrome
 *
 * Win-tier banners map onto math-sdk's Config.get_win_level(), which returns
 * 1..10 on two scales: "standard" (used for setWin) and "endFeature" (used for
 * freeSpinEnd). The web side keys the same 1..10 into winLevelMap.ts, where only
 * levels 6-10 carry an `animation` triple (intro/idle/outro) — levels 1-5 are
 * count-ups with no banner. So a game only needs banner art for 6..10.
 */

/** Levels that actually render a banner animation, per apps/lines winLevelMap.ts. */
export const BANNER_WIN_LEVELS = [6, 7, 8, 9, 10];

export const WIN_LEVEL_ALIASES = {
	1: 'zero',
	2: 'standard',
	3: 'small',
	4: 'nice',
	5: 'substantial',
	6: 'big',
	7: 'superwin',
	8: 'mega',
	9: 'epic',
	10: 'max',
};

/** Animation names WinAnimation.svelte plays for each banner level. */
export const WIN_LEVEL_ANIMATIONS = {
	6: ['big_win_intro', 'big_win_idle', 'big_win_exit'],
	7: ['super_win_intro', 'super_win_idle', 'super_win_exit'],
	8: ['mega_win_intro', 'mega_win_idle', 'mega_win_exit'],
	9: ['epic_win_intro', 'epic_win_idle', 'epic_win_exit'],
	10: ['max_win_intro', 'max_win_idle', 'max_win_exit'],
};

/**
 * @typedef {object} ScreenSlot
 * @property {string}   assetKey      key the component looks up in assets.ts
 * @property {string}   component     the web-sdk component it drives
 * @property {'spine'|'sprites'|'spriteSheet'|'sprite'} assetType
 * @property {string[]} animations    animation names the component plays
 * @property {boolean}  required
 * @property {string}   [onlyMechanics] restrict to certain mechanics
 */

/** @type {Record<string, ScreenSlot>} */
export const SCREEN_SLOTS = {
	'background.basegame': {
		assetKey: 'foregroundAnimation',
		component: 'Background.svelte',
		assetType: 'spine',
		animations: ['idle', 'dust'],
		required: true,
		note: 'Rendered while stateGame.gameType === "basegame".',
	},
	'background.freegame': {
		assetKey: 'foregroundFeatureAnimation',
		component: 'Background.svelte',
		assetType: 'spine',
		animations: ['idle', 'dust'],
		required: true,
		note: 'Rendered while stateGame.gameType === "freegame".',
	},
	'freeSpins.intro': {
		assetKey: 'fsIntro',
		component: 'FreeSpinIntro.svelte',
		assetType: 'spine',
		animations: ['intro', 'idle', 'outro'],
		required: false,
		note: 'Shown by the freeSpinTrigger bookEvent handler.',
	},
	'freeSpins.introNumber': {
		assetKey: 'fsIntroNumber',
		component: 'FreeSpinIntro.svelte',
		assetType: 'spine',
		animations: ['intro', 'idle'],
		required: false,
		note: 'The awarded-spin-count digits on the intro screen.',
	},
	'freeSpins.outroNumber': {
		assetKey: 'fsOutroNumber',
		component: 'FreeSpinOutro.svelte',
		assetType: 'spine',
		animations: ['intro', 'idle'],
		required: false,
		note: 'The total-win digits on the outro screen, driven by freeSpinEnd.',
	},
	transition: {
		assetKey: 'transition',
		component: 'TransitionAnimation.svelte',
		assetType: 'spine',
		animations: ['transition'],
		required: false,
		note: 'Played between basegame and freegame by the "transition" emitterEvent.',
	},
	loading: {
		assetKey: 'loader',
		component: 'LoadingScreen.svelte',
		assetType: 'spine',
		animations: ['title_screen'],
		required: true,
		preload: true,
		note: 'Preloaded — this is the first thing the player sees.',
	},
	progressBar: {
		assetKey: 'progressBar',
		component: 'LoadingScreen.svelte',
		assetType: 'sprites',
		animations: [],
		frames: ['progressBar.png', 'progressBarBackground.png', 'progressBarFrame.png'],
		required: true,
		preload: true,
		note: 'A `sprites` atlas — its frame names are looked up directly as Sprite keys.',
	},
	winBanner: {
		assetKey: 'bigwin',
		component: 'WinAnimation.svelte',
		assetType: 'spine',
		animations: Object.values(WIN_LEVEL_ANIMATIONS).flat(),
		required: false,
		note:
			'One spine carrying every banner tier. Only win levels 6-10 have banners; ' +
			'levels 1-5 in winLevelMap.ts are silent count-ups.',
	},
	winCoins: {
		assetKey: 'coins',
		component: 'WinCoins.svelte',
		assetType: 'spriteSheet',
		animations: [],
		required: false,
		note: 'A spriteSheet fed to ParticleEmitter, NOT a spine.',
	},
	globalMultiplier: {
		assetKey: 'globalMultiplier',
		component: 'GlobalMultiplier.svelte',
		assetType: 'spine',
		animations: ['idle'],
		required: false,
		note:
			'apps/lines ships this component and asset key but does NOT add ' +
			'EmitterEventGlobalMultiplier to typesEmitterEvent.ts — wire that import ' +
			'yourself when enabling it.',
	},
	tumbleWin: {
		assetKey: 'tumble_win',
		component: 'TumbleBoard handlers',
		assetType: 'spine',
		animations: ['tumble_win'],
		required: false,
		onlyMechanics: ['cluster', 'scatter'],
	},
	tumbleMultiplier: {
		assetKey: 'tumble_multiplier',
		component: 'TumbleBoard handlers',
		assetType: 'spine',
		animations: ['tumble_multiplier'],
		required: false,
		onlyMechanics: ['cluster', 'scatter'],
	},
	boardFrame: {
		assetKey: 'reelhouse',
		component: 'BoardFrame.svelte',
		assetType: 'spine',
		animations: ['idle', 'glow'],
		required: false,
		note: 'The glow shown while in freegame (boardFrameGlowShow emitterEvent).',
	},
	anticipation: {
		assetKey: 'anticipation',
		component: 'Anticipation.svelte',
		assetType: 'spine',
		animations: ['idle'],
		required: false,
		note: 'Driven by the `anticipation` array on the reveal bookEvent.',
	},
};

export const SCREEN_SLOT_IDS = Object.keys(SCREEN_SLOTS);

/** Slots that apply to a given mechanic. */
export function slotsForMechanic(mechanicId) {
	return Object.entries(SCREEN_SLOTS).filter(
		([, slot]) => !slot.onlyMechanics || slot.onlyMechanics.includes(mechanicId),
	);
}

/**
 * Validate the spec's `screens:` block. Unknown slot ids are an error (almost
 * always a typo, and a typo'd screen is invisible until runtime); slots that do
 * not apply to the mechanic are a warning.
 */
export function validateScreens(screens, { mechanic, errors, warnings }) {
	const flat = flattenScreens(screens);
	for (const [id] of flat) {
		const slot = SCREEN_SLOTS[id];
		if (!slot) {
			errors.push(
				`screens.${id} is not a known screen slot. Valid slots: ${SCREEN_SLOT_IDS.join(', ')}`,
			);
			continue;
		}
		if (mechanic && slot.onlyMechanics && !slot.onlyMechanics.includes(mechanic.id)) {
			warnings.push(
				`screens.${id} only applies to mechanic ${slot.onlyMechanics.join('/')}, ` +
					`but this spec uses "${mechanic.id}" — it will be ignored.`,
			);
		}
	}
}

/**
 * Turn the nested `screens:` YAML into [slotId, value] pairs, so both
 * `background: { basegame: x }` and `background.basegame: x` are accepted.
 */
export function flattenScreens(screens, prefix = '') {
	const out = [];
	for (const [key, value] of Object.entries(screens || {})) {
		const id = prefix ? `${prefix}.${key}` : key;
		if (value && typeof value === 'object' && !Array.isArray(value) && !SCREEN_SLOTS[id]) {
			out.push(...flattenScreens(value, id));
		} else {
			out.push([id, value]);
		}
	}
	return out;
}
