/**
 * Behavior recipe registry.
 *
 * One entry per `symbols[].behaviors` tag. A recipe is DATA describing what a
 * behavior costs to build, plus (for tier-3 behaviors) the generators that emit
 * the real code.
 *
 * ── The discipline this registry enforces ────────────────────────────────────
 * `status` is the honesty field, and `forge` treats it as load-bearing:
 *
 *   'verified'   The generated code is adapted from a real sample that was read
 *                AND executed. `verifiedAgainst` names the sample and what was
 *                run to prove it. Only these emit code.
 *   'documented' A real, cited pattern exists in the SDKs, but stake-forge does
 *                not generate it yet. `forge audit` reports the animation states
 *                and hook sites; codegen refuses and points you at the sample.
 *   'builtin'    Tier 2. Already wired end-to-end in BOTH SDKs; needs config,
 *                not code. No codegen because none is needed.
 *
 * There is deliberately no 'planned' status that emits anything. If a behavior
 * has not been checked against something real, it does not produce math-sdk
 * logic — a generator that invents plausible-looking Python is worse than one
 * that says "not built yet, here is the sample to copy".
 *
 * `tier` mirrors the studio's own vocabulary:
 *   2 = built-in, config only.
 *   3 = bespoke; needs a special_symbol_functions hook + custom bookEvents.
 */

import { ENGINE_SPECIAL_KEYS } from './taxonomy.js';
import { renderExpandingMath, renderExpandingWeb } from './recipes/expanding.js';

/**
 * @typedef {object} BehaviorRecipe
 * @property {string}   id
 * @property {string}   title
 * @property {'verified'|'documented'|'builtin'} status
 * @property {2|3}      tier
 * @property {string[]} appliesToRoles      roles the tag is meaningful on ([] = game-level)
 * @property {string[]} requiredAnimationStates  extra states beyond the role default
 * @property {string[]} requiredSpecialKeys  special_symbols keys the behavior needs
 * @property {string[]} suggestedSpecialKeys keys it commonly pairs with
 * @property {object}   referenceSample     { math, web } repo-relative paths or null
 * @property {string}   verifiedAgainst     what was read/run to prove it
 * @property {object}   mathHooks           what lands in the math-sdk game
 * @property {object}   webHooks            what lands in the web-sdk app
 * @property {Function} [emitMath]          (ctx) => [{ path, contents, mode }]
 * @property {Function} [emitWeb]           (ctx) => [{ path, contents, mode }]
 */

/** @type {Record<string, BehaviorRecipe>} */
export const BEHAVIOR_RECIPES = {
	// ───────────────────────────── tier 3, verified ─────────────────────────
	expanding: {
		id: 'expanding',
		title: 'Expanding wild (sticky for the rest of the free-spin round)',
		status: 'verified',
		tier: 3,
		appliesToRoles: ['wild'],
		/**
		 * Mechanics this recipe is PROVEN on, by running the generated game.
		 *
		 * cluster and scatter are deliberately excluded, and not merely untested:
		 * on a tumbling board the round re-draws mid-spin via tumble_game_board(),
		 * which this recipe's splice into run_freespin() never sees — so the
		 * expanded wilds would be wiped by the first cascade. 0_0_expwilds is a
		 * lines game and never exercises that interaction, so there is no verified
		 * pattern to copy. Making it work needs a tumble-aware variant that
		 * re-applies update_with_existing_wilds() after each refill, which is real
		 * design work, not scaffolding.
		 */
		verifiedForMechanics: ['lines', 'ways'],
		summary:
			'A wild lands on a reel, expands to fill every row of that reel, and stays for the ' +
			'remaining free spins. A fresh random multiplier is rolled onto it on each reveal.',
		requiredAnimationStates: ['expand_in', 'expand_loop', 'expand_out'],
		requiredSpecialKeys: ['wild'],
		suggestedSpecialKeys: ['multiplier'],
		referenceSample: { math: 'games/0_0_expwilds', web: null },
		verifiedAgainst:
			'math-sdk games/0_0_expwilds — read game_override.py, game_executables.py, ' +
			'game_events.py and gamestate.py, then instantiated GameConfig() and ran ' +
			'GameState.run_spin() under criteria="freegame", which emitted 1 newExpandingWilds ' +
			'and 10 updateExpandingWilds events with payload {reel,row,mult}. ' +
			'web-sdk has NO matching sample app, so the frontend half follows the ' +
			'"Steps to Add a New BookEvent" recipe in web-sdk/README.md instead.',
		mathHooks: {
			resetBook: ['self.expanding_wilds = []', 'self.avaliable_reels = [...range(num_reels)]'],
			specialSymbolFunctions: ['<wild> -> assign_mult_property'],
			executables: ['assign_new_wilds(max_num_new_wilds)', 'update_with_existing_wilds()'],
			events: ['new_expanding_wild_event()', 'update_expanding_wild_event()'],
			gamestate: ['run_freespin() calls assign_new_wilds -> update_with_existing_wilds each spin'],
			distributionConditions: ['landing_wilds', 'mult_values[freegame]'],
		},
		webHooks: {
			bookEvents: ['newExpandingWilds', 'updateExpandingWilds'],
			typesBookEvent: 'add both event types + extend the BookEvent union',
			bookEventHandlerMap: 'add a handler per event, broadcasting to the new component',
			component: 'ExpandingWilds.svelte',
			emitterEvents: [
				'expandingWildsAdd',
				'expandingWildsUpdate',
				'expandingWildsClear',
			],
			typesEmitterEvent: 'import EmitterEventExpandingWilds and add it to the EmitterEventGame union',
			stories: ['<mode>_events.ts', '<mode>_books.ts', 'Mode<Mode>BookEvent.stories.svelte'],
		},
		emitMath: renderExpandingMath,
		emitWeb: renderExpandingWeb,
	},

	// ─────────────────────────── tier 3, documented ─────────────────────────
	sticky: {
		id: 'sticky',
		title: 'Sticky symbol (locks in place across respins)',
		status: 'documented',
		tier: 3,
		appliesToRoles: ['wild', 'high', 'low', 'scatter'],
		summary:
			'A landed symbol locks to its cell and persists across subsequent spins of the ' +
			'round, typically resetting a respin counter each time a new one lands.',
		requiredAnimationStates: ['lock_in', 'locked_loop'],
		requiredSpecialKeys: [],
		suggestedSpecialKeys: ['prize'],
		referenceSample: { math: 'games/0_0_expwilds', web: null },
		verifiedAgainst:
			'READ, NOT YET RUN AS A GENERATOR. The real pattern is the "superspin" mode of ' +
			'games/0_0_expwilds: game_executables.py check_for_new_prize() / ' +
			'replace_board_with_stickys(), game_override.py reset_superspin(), and the ' +
			'newStickySymbols event in game_events.py. Symbol.__slots__ already carries a ' +
			'`locked` field (src/calculations/symbol.py) that nothing in the engine sets — ' +
			'it exists precisely for this. Not emitted until it has been run end-to-end.',
		mathHooks: {
			resetBook: ['self.sticky_symbols = []', 'self.existing_sticky_symbols = []'],
			executables: ['check_for_new_prize()', 'replace_board_with_stickys()'],
			events: ['new_sticky_event()'],
			gamestate: ['respin loop resets self.fs to 0 when a new sticky lands'],
		},
		webHooks: {
			bookEvents: ['newStickySymbols'],
			component: 'StickySymbols.svelte',
			emitterEvents: ['stickySymbolsAdd', 'stickySymbolsClear'],
		},
	},

	prize: {
		id: 'prize',
		title: 'Prize / cash-value symbol',
		status: 'documented',
		tier: 3,
		appliesToRoles: ['high', 'low', 'wild', 'scatter'],
		summary:
			'A symbol carrying a cash value read off the board at the end of a round rather ' +
			'than paying through the paytable.',
		requiredAnimationStates: ['value_reveal'],
		requiredSpecialKeys: ['prize'],
		suggestedSpecialKeys: [],
		referenceSample: { math: 'games/0_0_expwilds', web: null },
		verifiedAgainst:
			'READ, NOT YET RUN AS A GENERATOR. games/0_0_expwilds registers "P" under ' +
			'special_symbols["prize"] and hooks assign_prize_value via ' +
			'special_symbol_functions; get_final_board_prize() sums check_attribute("prize") ' +
			'across the board. The engine initialises has_prize/prize in ' +
			'Symbol.assign_default_attribute(), so the flag itself is native. ' +
			'NOTE the web side needs a `prize` field added to RawSymbol in types.ts — the ' +
			'sample apps only declare name/multiplier/scatter/wild.',
		mathHooks: {
			specialSymbolFunctions: ['<symbol> -> assign_prize_value'],
			executables: ['get_final_board_prize()'],
			events: ['win_info_prize_event()', 'reveal_prize_event()'],
			distributionConditions: ['prize_values'],
		},
		webHooks: {
			bookEvents: ['prizeWinInfo'],
			types: 'add `prize?: number` to RawSymbol in types.ts',
			component: 'PrizeSymbols.svelte',
		},
	},

	colossal: {
		id: 'colossal',
		title: 'Colossal / oversized symbol block',
		status: 'documented',
		tier: 3,
		appliesToRoles: ['high', 'wild'],
		summary: 'A symbol occupying an NxN block of cells, evaluated as N*N individual symbols.',
		requiredAnimationStates: ['colossal_in', 'colossal_idle'],
		requiredSpecialKeys: [],
		suggestedSpecialKeys: [],
		referenceSample: { math: null, web: null },
		verifiedAgainst:
			'NO SAMPLE FOUND in either SDK. Neither math-sdk games/ nor web-sdk apps/ ships a ' +
			'colossal-symbol game, and no doc under docs/math_docs describes one. Listed here ' +
			'so `forge audit` can still tell you which animation states it needs, but there is ' +
			'no verified pattern to generate from — this one is genuinely from-scratch, and the ' +
			'board-level override lives in your own draw_board/create_board_reelstrips.',
		mathHooks: {
			executables: ['post-draw board rewrite replacing an NxN region with one symbol'],
		},
		webHooks: {
			bookEvents: ['(game-specific)'],
			component: 'ColossalSymbol.svelte',
		},
	},

	// ────────────────────────────── tier 2, builtin ─────────────────────────
	freespins: {
		id: 'freespins',
		title: 'Free spins (trigger / counter / intro / outro)',
		status: 'builtin',
		tier: 2,
		appliesToRoles: ['scatter'],
		summary: 'Scatter-triggered free-spin round with an on-screen counter and intro/outro screens.',
		requiredAnimationStates: [],
		requiredSpecialKeys: ['scatter'],
		suggestedSpecialKeys: [],
		referenceSample: { math: 'games/0_0_lines', web: 'apps/lines' },
		verifiedAgainst:
			'math: src/executables/executables.py drives it off config.freespin_triggers, and ' +
			'games/0_0_lines gamestate.py calls check_fs_condition()/run_freespin_from_base(). ' +
			'Ran GameState.run_spin() on 0_0_lines under criteria="freegame" and got the ' +
			'freeSpinTrigger / updateFreeSpin / freeSpinEnd events. ' +
			'web: apps/lines bookEventHandlerMap.ts already handles all three, driving ' +
			'FreeSpinIntro.svelte, FreeSpinCounter.svelte and FreeSpinOutro.svelte.',
		config: 'game-spec.yaml `freeSpins:` — trigger symbol, counts, awarded spins, retrigger',
	},

	global_multiplier: {
		id: 'global_multiplier',
		title: 'Global multiplier',
		status: 'builtin',
		tier: 2,
		appliesToRoles: [],
		summary: 'A round-level multiplier applied to every win, shown in its own HUD element.',
		requiredAnimationStates: [],
		requiredSpecialKeys: [],
		suggestedSpecialKeys: [],
		referenceSample: { math: 'src/wins/multiplier_strategy.py', web: 'apps/lines' },
		verifiedAgainst:
			'math: every sample gamestate threads global_multiplier= into its win calculator. ' +
			'web: web-sdk README uses updateGlobalMult as its worked example for adding a ' +
			'bookEvent, and apps/lines ships GlobalMultiplier.svelte plus a `globalMultiplier` ' +
			'spine asset key. NOTE the shipped apps/lines does NOT wire GlobalMultiplier into ' +
			'typesEmitterEvent.ts — the component exists but the union entry is missing, so ' +
			'enabling this still needs that one-line import added.',
		config: 'game-spec.yaml `features.globalMultiplier:`',
	},

	tumble: {
		id: 'tumble',
		title: 'Tumble / cascade',
		status: 'builtin',
		tier: 2,
		appliesToRoles: [],
		summary: 'Winning symbols explode and are replaced by symbols falling from above, chaining wins.',
		requiredAnimationStates: ['explosion'],
		requiredSpecialKeys: [],
		suggestedSpecialKeys: [],
		referenceSample: { math: 'games/0_0_cluster', web: 'apps/cluster' },
		verifiedAgainst:
			'math: src/calculations/tumble.py, documented in ' +
			'docs/math_docs/source_section/tumble_info.md — the cluster and scatter win ' +
			'evaluators set explode=True on winning symbols and Tumble refills from ' +
			'reel_positions. Only available on cluster/scatter win types; it is NOT a fifth ' +
			'win_type. web: apps/cluster ships the TumbleBoard* event handlers.',
		config: 'implied by mechanic: cluster | scatter',
		requiresMechanic: ['cluster', 'scatter'],
	},

	wincap: {
		id: 'wincap',
		title: 'Win cap (max-win stop)',
		status: 'builtin',
		tier: 2,
		appliesToRoles: [],
		summary: 'Round ends immediately once the configured max win is reached.',
		requiredAnimationStates: [],
		requiredSpecialKeys: [],
		suggestedSpecialKeys: [],
		referenceSample: { math: 'src/config/config.py', web: 'apps/lines' },
		verifiedAgainst:
			'math: Config.wincap, with evaluate_wincap() / wincap_triggered checked in the ' +
			'sample free-spin loops (games/0_0_expwilds gamestate.py run_freespin guards on ' +
			'`not self.wincap_triggered`). Config.get_win_level() tops out at level 10 for ' +
			'>= wincap on both the "standard" and "endFeature" scales. ' +
			'web: winLevelMap.ts level 10 is alias "max".',
		config: 'game-spec.yaml `game.betModes.<mode>.maxWin`',
	},
};

export const BEHAVIOR_IDS = Object.keys(BEHAVIOR_RECIPES);

export function getRecipe(id) {
	return BEHAVIOR_RECIPES[id] ?? null;
}

/** Recipes that can actually emit code today. */
export function isGenerable(recipe) {
	return recipe?.status === 'verified' && (recipe.emitMath || recipe.emitWeb);
}

/**
 * Every animation state a symbol needs: its role/mechanic defaults plus whatever
 * its behaviors add. Returned as { state -> [reasons] } so `forge audit` can say
 * WHY a state is required, not just that it is.
 */
export function requiredStatesForSymbol(symbol, defaultStates) {
	const out = new Map();
	for (const state of defaultStates) {
		out.set(state, ['role default']);
	}
	for (const tag of symbol.behaviors) {
		const recipe = getRecipe(tag);
		if (!recipe) continue;
		for (const state of recipe.requiredAnimationStates) {
			if (!out.has(state)) out.set(state, []);
			out.get(state).push(`behavior "${tag}"`);
		}
	}
	return out;
}

/** Validate `behaviors:` tags against the registry and the symbol's role. */
export function validateBehaviors(symbol, { mechanic, errors, warnings }) {
	for (const tag of symbol.behaviors) {
		const recipe = getRecipe(tag);
		if (!recipe) {
			errors.push(
				`symbol ${symbol.name}: unknown behavior "${tag}". Known behaviors: ${BEHAVIOR_IDS.join(', ')}. ` +
					`Add a new one to src/lib/behaviorRecipes.js — but find a real sample first.`,
			);
			continue;
		}
		if (recipe.appliesToRoles.length && !recipe.appliesToRoles.includes(symbol.role)) {
			warnings.push(
				`symbol ${symbol.name}: behavior "${tag}" is normally used on role ` +
					`${recipe.appliesToRoles.join('/')}, not "${symbol.role}".`,
			);
		}
		if (recipe.verifiedForMechanics && !recipe.verifiedForMechanics.includes(mechanic)) {
			errors.push(
				`symbol ${symbol.name}: behavior "${tag}" is only verified on mechanic ` +
					`${recipe.verifiedForMechanics.join('/')}, not "${mechanic}". ` +
					`stake-forge will not generate unverified math — see the verifiedForMechanics ` +
					`note in src/lib/behaviorRecipes.js for why.`,
			);
		}
		if (recipe.requiresMechanic && !recipe.requiresMechanic.includes(mechanic)) {
			errors.push(
				`symbol ${symbol.name}: behavior "${tag}" requires mechanic ` +
					`${recipe.requiresMechanic.join(' or ')}, but this spec uses "${mechanic}".`,
			);
		}
		for (const key of recipe.requiredSpecialKeys) {
			if (!symbol.special.includes(key)) {
				errors.push(
					`symbol ${symbol.name}: behavior "${tag}" requires special: [${key}] — ` +
						`its generated math reads that flag off the symbol.`,
				);
			}
		}
		for (const key of recipe.suggestedSpecialKeys) {
			if (!symbol.special.includes(key)) {
				warnings.push(
					`symbol ${symbol.name}: behavior "${tag}" normally pairs with special: [${key}]. ` +
						`Without it the ${key} half of the behavior is inert.`,
				);
			}
		}
		for (const key of [...recipe.requiredSpecialKeys, ...recipe.suggestedSpecialKeys]) {
			if (!ENGINE_SPECIAL_KEYS.includes(key)) {
				warnings.push(`recipe "${tag}" references non-engine special key "${key}"`);
			}
		}
	}
}
