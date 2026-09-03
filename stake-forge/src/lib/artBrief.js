/**
 * The art brief.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 * `forge audit` compares a manifest of supplied art against what the spec needs,
 * and reports the difference. That is useful once art exists and useless before
 * it does — which is the state an art studio is in for most of a project. The
 * question this answers is the earlier one: given a spec and nothing else, WHAT
 * DO WE DRAW?
 *
 * The two are deliberate mirror images. audit reports gaps; this enumerates the
 * whole set. A brief fulfilled in full is an audit that passes with zero errors,
 * and there is a test asserting exactly that, because the alternative is a brief
 * that drifts from the checker and quietly stops being true.
 *
 * ── Where every number comes from ───────────────────────────────────────────
 * Nothing here is a house style or a guess. Each figure was read out of the
 * shipped web-sdk sample apps:
 *
 *   40 asset keys        all four sample apps declare an identical set
 *   200x200 symbols      the symbol sheets' own frame dimensions
 *   16 languages         freeSpins.json, MM_pressanywhere.json and
 *                        MM_Localisation_winsmall.json each carry exactly 16
 *                        locale variants of their text as BAKED ART, not as
 *                        strings a font renders. Verified by reading the frame
 *                        names out of those three sheets — no other sheet in the
 *                        sample carries them, so the localisation cost lands on
 *                        three assets, not forty.
 *   banner levels 6-10   winLevelMap.ts gives levels 1-5 a count-up and no
 *                        banner art, so a game needs five banner sets, not ten
 *
 * ── What it deliberately does not do ────────────────────────────────────────
 * It does not invent an art direction, a palette or a symbol list. It states
 * what the ENGINE requires, at what dimensions, in what states, with what
 * animation names — the contract, not the design. What goes in the frame is the
 * studio's job and the whole reason the tool exists.
 */

import { winLevelBands as generatedBands, featureWinLevelBands as featureBands } from './winLevels.js';
import { getMechanic } from './mechanics.js';
import { defaultAnimationStates, typeRequiredStates } from './taxonomy.js';
import { requiredStatesForSymbol, getRecipe } from './behaviorRecipes.js';
import {
	SCREEN_SLOTS,
	BANNER_WIN_LEVELS,
	WIN_LEVEL_ANIMATIONS,
	WIN_LEVEL_ALIASES,
	slotsForMechanic,
} from './screens.js';
import { artRequirementsFor } from './mechanicsLibrary.js';

/**
 * The locales the sample apps bake text art for.
 *
 * Read from the frame names in apps/lines/static/assets/sprites/freeSpins/
 * freeSpins.json. This is baked ART: sixteen renderings of the same words, not
 * sixteen strings. It is the single most under-estimated line in a slot art
 * budget, so the brief itemises every one rather than writing "localised".
 */
export const LOCALES = [
	'ar', 'de', 'en', 'es', 'fi', 'fr', 'hi', 'id',
	'ja', 'ko', 'pl', 'pt', 'ru', 'tr', 'vi', 'zh',
];

/**
 * The three sheets that actually carry localised text, and what each says.
 *
 * Named individually because "everything needs 16 languages" is both wrong and
 * expensive — it is these three, and nothing else in the sample.
 */
export const LOCALISED_SHEETS = [
	{
		sheet: 'freeSpins.json',
		assetKey: 'freeSpins',
		content: 'the words "FREE SPINS" on the intro/outro screens',
		extraFrames: ['freespins.png (base, unlocalised)', 'totalwin.png'],
	},
	{
		sheet: 'MM_pressanywhere.json',
		assetKey: 'pressToContinueText',
		content: 'the words "PRESS ANYWHERE TO CONTINUE"',
		extraFrames: [],
	},
	{
		sheet: 'MM_Localisation_winsmall.json',
		assetKey: 'winSmallText',
		content: 'the win-banner wording (BIG WIN / SUPER WIN / …)',
		extraFrames: [],
	},
];

/** Symbol art dimensions, read off the sample sheets rather than chosen. */
export const SYMBOL_SIZE = { width: 200, height: 200 };

/**
 * Which win-level banners this game needs, and what each actually fires at.
 *
 * ── Corrected twice, and the second correction reverses the first ────────────
 * The first version banded these as FRACTIONS of the cap. That was wrong against
 * the STOCK engine: Config.get_win_level() bands on fixed multiples of the bet,
 * and only level 9's ceiling and level 10's floor track wincap — so the note
 * here used to say a "big win" fires at 15x on a 500x game and a 100,000x game
 * alike.
 *
 * That fixed table is anchored to the SDK's own 5,000x default, and it stops
 * working at any other cap. Measured on a 20,000x game over 400,000 weighted
 * rounds: level 9 spanned 100x-20,000x — 278 rounds from 100x to 6,062x all
 * getting one banner — and level 10 needed an exact max-win round, so the top
 * celebration never played. The escalation flattened where it should peak.
 *
 * So stake-forge now GENERATES a get_win_level override per game (see
 * src/lib/winLevels.js) and the banners do scale with the cap after all. This
 * function reads from that same generator, because a brief describing bands the
 * shipped game does not use is worse than no brief.
 *
 * There are still TWO scales, which matters as much as the numbers:
 *
 *   standard    used for setWin — a single win during a spin
 *   endFeature  used for freeSpinEnd — the total of a whole feature
 *
 * The same banner art plays for level 7 in both cases, but a whole free-spin
 * round pays far more than one spin — on a measured 20,000x game the base median
 * round pays 0x against a bought-feature median near 30x — so the feature ladder
 * starts higher. An artist told only "super win" cannot know that; an artist
 * told both bands can pitch the animation to cover them.
 */
/**
 * What each scale measures. The BANDS are no longer written here: they are
 * generated per game from its max win by src/lib/winLevels.js, and the brief has
 * to state the thresholds the shipped game actually uses. Two copies drifting
 * would have the art team building banners for bands the game does not have.
 */
export const WIN_LEVEL_SCALES = {
	standard: { use: 'a single win during a spin (setWin)' },
	endFeature: { use: 'the total of a whole free-spin round (freeSpinEnd)' },
};

export function winLevelBands(maxWin) {
	// Read from the same generator the game's own get_win_level override is built
	// from, so the brief always states the thresholds that shipped.
	const standard = generatedBands(maxWin);
	const feature = featureBands(maxWin);
	const resolve = ([from, to]) => [from, to === null ? Infinity : to];

	return BANNER_WIN_LEVELS.map((level) => {
		const [stdFrom, stdTo] = resolve(standard[level - 1]);
		const [feFrom, feTo] = resolve(feature[level - 1]);
		return {
			level,
			alias: WIN_LEVEL_ALIASES[level],
			animations: WIN_LEVEL_ANIMATIONS[level],
			standard: { from: stdFrom, to: stdTo },
			endFeature: { from: feFrom, to: feTo },
			// Flagged so the brief can call out a banner covering an absurd range.
			widestRatio: Math.max(stdTo / Math.max(stdFrom, 0.01), feTo / Math.max(feFrom, 0.01)),
		};
	});
}

/**
 * Build the complete brief for a spec.
 *
 * Returns plain data so it can be rendered as Markdown for the art team, CSV for
 * a tracker, or JSON for anything else — and tested without parsing prose.
 */
export function buildArtBrief(spec) {
	const mechanic = spec._mechanic ?? getMechanic(spec.game.mechanic);
	const defaultStates = defaultAnimationStates({ mechanic: mechanic.id });
	const maxWin = Math.max(
		...Object.values(spec.game.betModes).map((m) => Number(m.maxWin) || 0),
		0,
	);

	// ── symbols ──────────────────────────────────────────────────────────────
	const symbols = spec.symbols.map((symbol) => {
		const states = requiredStatesForSymbol(symbol, defaultStates);
		const behaviours = symbol.behaviors.map((tag) => {
			const recipe = getRecipe(tag);
			return {
				id: tag,
				title: recipe?.title ?? tag,
				addsStates: recipe?.requiredAnimationStates ?? [],
			};
		});
		return {
			name: symbol.name,
			label: symbol.label ?? symbol.name,
			role: symbol.role,
			special: symbol.special,
			// A spine skeleton per symbol, sharing one atlas — the sample's own
			// arrangement, and the reason the atlas is listed once and the skeleton
			// per symbol.
			format: 'spine skeleton, sharing one symbols.atlas + symbols.png',
			size: SYMBOL_SIZE,
			states: [...states.entries()].map(([state, reasons]) => ({
				state,
				animationName: `${symbol.name.toLowerCase()}_${state}`,
				requiredBy: reasons,
			})),
			behaviours,
			staticSprite: `${symbol.name.toLowerCase()}_static.webp`,
			note:
				symbol.special.includes('scatter')
					? 'Also needs an anticipation treatment — the sample apps animate the scatter on reels 3+ before it lands.'
					: symbol.special.includes('prize')
						? 'Carries a VALUE. Draw the frame; the number is dynamic text over it. Never bake values into art — the prize ladder changes with every tuning pass.'
						: null,
		};
	});

	// ── screens ──────────────────────────────────────────────────────────────
	// slotsForMechanic returns [id, slot] ENTRIES, not ids — the name reads like
	// it returns ids and does not.
	const screens = slotsForMechanic(mechanic.id).map(([id, slot]) => {
		return {
			id,
			assetKey: slot.assetKey,
			component: slot.component,
			assetType: slot.assetType,
			animations: slot.animations,
			required: slot.required,
			preload: Boolean(slot.preload),
			note: slot.note ?? null,
			reusableAcrossGames: REUSABLE_KEYS.has(slot.assetKey),
		};
	});

	// ── win banners, banded against THIS game's cap ──────────────────────────
	const banners = winLevelBands(maxWin);

	// ── localised text ───────────────────────────────────────────────────────
	const localised = LOCALISED_SHEETS.map((sheet) => ({
		...sheet,
		frames: LOCALES.map((locale) => `${sheet.assetKey.toLowerCase()}_${locale}.png`),
		count: LOCALES.length,
	}));

	// ── what the chosen mechanics add ────────────────────────────────────────
	// The join built by the mechanics library: picking a mechanic tells the art
	// team what it costs them. Behaviours on symbols already contribute states
	// above; this catches the round-level mechanics that have no symbol.
	const mechanicIds = collectMechanicIds(spec, mechanic);
	const fromMechanics = artRequirementsFor(mechanicIds);

	// ── sound ────────────────────────────────────────────────────────────────
	const sounds = soundRequirements(spec, mechanic);

	const totals = {
		symbols: symbols.length,
		symbolStates: symbols.reduce((sum, s) => sum + s.states.length, 0),
		screens: screens.length,
		requiredScreens: screens.filter((s) => s.required).length,
		banners: banners.length,
		bannerAnimations: banners.reduce((sum, b) => sum + b.animations.length, 0),
		localisedFrames: localised.reduce((sum, l) => sum + l.count, 0),
		sounds: sounds.length,
	};

	return {
		game: {
			name: spec.game.name,
			mechanic: mechanic.id,
			winType: mechanic.winType,
			reels: spec.game.reels,
			rtp: spec.game.rtp,
			volatility: spec.game.volatility ?? 'medium',
			maxWin,
		},
		symbols,
		screens,
		banners,
		localised,
		locales: LOCALES,
		fromMechanics: { mechanics: mechanicIds, ...fromMechanics },
		sounds,
		totals,
	};
}

/**
 * Asset keys that are the same in every game we ship, so they are drawn once and
 * reused. Worth separating: it is roughly a third of the set, and a studio
 * planning its second game should not re-budget for them.
 */
const REUSABLE_KEYS = new Set([
	'progressBar',
	'pressToContinueText',
	'coins',
	'transition',
]);

/** Which library mechanics this spec actually uses, for the art join. */
function collectMechanicIds(spec, mechanic) {
	const ids = new Set();
	const evaluator = {
		lines: 'lines_pays',
		ways: 'ways_pays',
		cluster: 'cluster_pays',
		scatter: 'scatter_pays',
	}[mechanic.winType];
	if (evaluator) ids.add(evaluator);
	if (mechanic.tumbles) ids.add('tumble');
	if (spec.freeSpins) ids.add('freespins');
	if (spec.game.globalMultiplierPerSpin) ids.add('progressive_global_multiplier');
	if (Object.values(spec.game.betModes).some((m) => m.buyBonus)) ids.add('buy_bonus');
	if (Object.values(spec.game.betModes).some((m) => m.superspin)) ids.add('hold_and_win');
	if (Object.values(spec.game.betModes).some((m) => m.maxWin)) ids.add('wincap');
	// Symbol behaviours map onto library ids where one exists.
	const byBehaviour = { expanding: 'expanding_wild', sticky: 'sticky_wild', prize: 'money_symbol', colossal: 'colossal_symbol' };
	for (const symbol of spec.symbols) {
		for (const tag of symbol.behaviors) {
			if (byBehaviour[tag]) ids.add(byBehaviour[tag]);
		}
	}
	return [...ids];
}

/**
 * The sound list, from the same vocabulary `forge sound:build` consumes.
 *
 * Included because a brief that covers art and forgets audio sends the team
 * back for a second pass, and the sound sprite is a build step that fails
 * loudly when a clip is missing.
 */
function soundRequirements(spec, mechanic) {
	const sounds = [
		{ name: 'bgm_main', kind: 'music', loops: true, note: 'Base-game loop.' },
		{ name: 'sfx_btn_spin', kind: 'ui', loops: false, note: null },
		{ name: 'sfx_reel_stop_1', kind: 'reel', loops: false, note: 'One per reel — the sample uses five.' },
		{ name: 'sfx_win', kind: 'win', loops: false, note: null },
	];
	if (spec.freeSpins) {
		sounds.push(
			{ name: 'bgm_freegame', kind: 'music', loops: true, note: 'The feature needs its own loop, or the round has no lift.' },
			{ name: 'sfx_scatter', kind: 'win', loops: false, note: null },
			{ name: 'sfx_anticipation', kind: 'reel', loops: true, note: 'Plays while a trigger is still possible.' },
		);
	}
	if (mechanic.tumbles) {
		sounds.push({
			name: 'tumble_win_1',
			kind: 'win',
			loops: false,
			note: 'A PITCH LADDER, not one clip: successive cascades step up the scale. The sample ships five.',
		});
	}
	for (const band of BANNER_WIN_LEVELS) {
		sounds.push({ name: `sfx_${WIN_LEVEL_ALIASES[band]}_win`, kind: 'win', loops: false, note: null });
	}
	return sounds;
}
