/**
 * Per-mechanic facts, read off real checkouts of both SDKs rather than assumed.
 *
 * The important one is `paddingReels`. Every sample app's config.ts declares it,
 * and apps/<m>/src/game/types.ts derives `GameType = keyof typeof config.paddingReels`
 * from it — so the KEYS are load-bearing for type-checking, and the VALUE shape
 * differs per mechanic:
 *
 *   apps/lines/src/game/config.ts    paddingReels: { basegame: [[{name}...]...], freegame: [...] }
 *   apps/scatter/src/game/config.ts  paddingReels: { basegame: [[{name}...]...], freegame: [...] }
 *   apps/cluster/src/game/config.ts  paddingReels: { basegame: '', freegame: '' }
 *   apps/ways/src/game/config.ts     paddingReels: { basegame: '', freegame: '', superspingame: '' }
 *
 * cluster and ways ship empty strings because those boards do not pre-render a
 * padded strip above/below the visible area; writing reel arrays there (as
 * stake-forge <= 0.1.0 did for every mechanic) both contradicts the sample and,
 * for ways, silently drops the `superspingame` game type from the union.
 */

export const MECHANICS = {
	lines: {
		id: 'lines',
		/** GameConfig.win_type in math-sdk. Documentation-only — see note below. */
		winType: 'lines',
		/**
		 * How the paytable is indexed, and the smallest winning count.
		 *
		 * lines/ways pay by "kind" — how many matching symbols run from reel 1,
		 * minimum 3. cluster and scatter pay by SIZE and use RANGE tables:
		 * 0_0_cluster declares (5,5)/(6,8)/(9,12)/(13,36) and 0_0_scatter
		 * (8,8)/(9,10)/(11,13)/(14,36), expanded per-count by
		 * Config.convert_range_table().
		 *
		 * This matters because both evaluators GUARD the lookup —
		 * `if (size, sym) in config.paytable` — so a size with no entry pays
		 * NOTHING and says nothing. A cluster of 10 on a table that stops at 5
		 * is a win the player watches land and receives zero for.
		 */
		paytableStyle: 'kind',
		minWinSize: 3,
		/**
		 * How this evaluator is told to combine multipliers, and what it accepts.
		 *
		 * The four differ, and not cosmetically:
		 *   lines    get_lines(multiplier_method=)       symbol | global | combined
		 *   ways     get_ways_data(multiplier_strategy=) symbol | board | global
		 *            — it ASSERTS on that list, so "combined" is a crash
		 *   cluster  evaluate_clusters(...)   no parameter; sums inline, then
		 *            multiplies by global_multiplier
		 *   scatter  get_scatterpay_wins(...) same
		 *
		 * So "combined" is a lines-only word and "board" is a ways-only word. A
		 * spec asking for either on the wrong mechanic must be refused, not
		 * quietly ignored.
		 */
		multiplierParam: 'multiplier_method',
		multiplierStrategies: ['symbol', 'global', 'combined'],
		webApp: 'lines',
		mathSample: '0_0_lines',
		supportsPaylines: true,
		tumbles: false,
		gameTypes: ['basegame', 'freegame'],
		paddingReelsStyle: 'strips',
		defaultReels: { count: 5, rows: [3, 3, 3, 3, 3] },
		/**
		 * How this sample's OWN game_override.py reads the `mult_values`
		 * distribution condition. It differs between samples, and the shape has to
		 * match the reader or get_random_outcome() dies on a dict of dicts:
		 *   'nested' -> conditions["mult_values"][gametype]
		 *   'flat'   -> conditions["mult_values"]
		 * Only relevant when a symbol carries special: [multiplier], because that
		 * is what puts assign_mult_property in special_symbol_functions.
		 */
		multValuesShape: 'nested',
	},
	ways: {
		id: 'ways',
		winType: 'ways',
		paytableStyle: 'kind',
		minWinSize: 3,
		multiplierParam: 'multiplier_strategy',
		multiplierStrategies: ['symbol', 'board', 'global'],
		webApp: 'ways',
		mathSample: '0_0_ways',
		supportsPaylines: false,
		tumbles: false,
		gameTypes: ['basegame', 'freegame', 'superspingame'],
		paddingReelsStyle: 'empty',
		defaultReels: { count: 5, rows: [3, 3, 3, 3, 3] },
		// 0_0_ways reads it FLAT — see the note on lines above.
		multValuesShape: 'flat',
	},
	cluster: {
		id: 'cluster',
		winType: 'cluster',
		paytableStyle: 'range',
		minWinSize: 5,
		// No strategy parameter: sums position multipliers inline, then multiplies
		// by global_multiplier. globalMultiplierPerSpin still applies.
		multiplierParam: null,
		multiplierStrategies: [],
		webApp: 'cluster',
		mathSample: '0_0_cluster',
		supportsPaylines: false,
		tumbles: true,
		gameTypes: ['basegame', 'freegame'],
		paddingReelsStyle: 'empty',
		defaultReels: { count: 7, rows: [7, 7, 7, 7, 7, 7, 7] },
		// 0_0_cluster's assign_special_sym_function() is `pass`, so nothing reads it.
		multValuesShape: 'nested',
	},
	scatter: {
		id: 'scatter',
		winType: 'scatter',
		paytableStyle: 'range',
		minWinSize: 8,
		multiplierParam: null,
		multiplierStrategies: [],
		webApp: 'scatter',
		mathSample: '0_0_scatter',
		supportsPaylines: false,
		tumbles: true,
		// NOT ['basegame', 'freegame'] — apps/scatter really does key its second
		// game type 'freeSpins'. See the note below.
		gameTypes: ['basegame', 'freeSpins'],
		multValuesShape: 'nested',
		paddingReelsStyle: 'strips',
		defaultReels: { count: 6, rows: [5, 5, 5, 5, 5, 5] },
		requiredSymbols: [
			{
				name: 'M',
				special: ['multiplier'],
				why:
					"apps/scatter's own components compare rawSymbol.name === 'M' " +
					'(stateGame.svelte.ts and utils.ts), and games/0_0_scatter registers ' +
					'special_symbols["multiplier"] = ["M"]. A scatter game without an M symbol ' +
					'fails to typecheck on those comparisons.',
			},
		],
	},
};

export const MECHANIC_IDS = Object.keys(MECHANICS);

export function getMechanic(id) {
	const m = MECHANICS[id];
	if (!m) throw new Error(`Unknown mechanic "${id}". Valid: ${MECHANIC_IDS.join(', ')}`);
	return m;
}

/**
 * NOTE on win_type, for anyone extending this file.
 *
 * `GameConfig.win_type` is NOT validated by the engine. Grepping a real math-sdk
 * checkout, it is only ever ASSIGNED (in each game's own game_config.py) and never read
 * by any code under src/ — games/fifty_fifty sets it to "other". What actually
 * decides how wins are evaluated is which calculator your gamestate.py calls:
 * src/calculations/{lines,ways,cluster,scatter}.py. The four ids above are the
 * four that have both a math-sdk sample game AND a web-sdk sample app, which is
 * what stake-forge needs in order to clone from something real.
 */

/**
 * NOTE on scatter's game types, for anyone tempted to "fix" the list above.
 *
 * apps/scatter/src/game/config.ts really does declare
 *     paddingReels: { basegame: [...], freeSpins: [...] }
 * — camelCase `freeSpins`, not `freegame` — and its bookEventHandlerMap sets
 * `stateGame.gameType = 'freeSpins'` on the freeSpinTrigger event. Since
 * `GameType = keyof typeof config.paddingReels`, emitting `freegame` there is a
 * type error, so stake-forge matches the sample.
 *
 * Worth knowing: the MATH side of the same sample emits `gameType: "freegame"`
 * (src/events/events.py passes gamestate.gametype, and Config sets
 * freegame_type = "freegame"). So the shipped scatter sample's reveal handler
 * looks up `config.paddingReels['freegame']`, which is undefined. That is a
 * pre-existing inconsistency in the SDK, not something stake-forge introduces —
 * but if you build a scatter game and the free-game padding board looks wrong,
 * that is where to look.
 */
