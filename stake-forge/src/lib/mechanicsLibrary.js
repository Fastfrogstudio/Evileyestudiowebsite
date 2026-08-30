/**
 * The mechanics library — every researched mechanic as queryable data.
 *
 * ── What this is for ────────────────────────────────────────────────────────
 * This studio's plan is to be the art and animation team and let the tool carry
 * the maths and the wiring. That only works if picking a mechanic also tells you
 * WHAT TO DRAW. So every entry here carries three things a prose catalogue never
 * did:
 *
 *   art       the symbols, states, animations and screens the mechanic needs —
 *             the input to `forge brief`, so choosing a mechanic produces an
 *             art brief rather than a conversation about one
 *   frontend  the book events and components the web-sdk side needs
 *   math      where the engine already does it, or what has to be built
 *
 * ── Status is not a marketing word ──────────────────────────────────────────
 *   built     generates code today, proven by running the generated game
 *   config    works through spec settings; the SDK already implements it
 *   sample    a math-sdk sample implements it, so it is adaptable at Tier A
 *   roadmap   no sample; would be built from primitives and proven by execution
 *   blocked   cannot be built without engine work, a licence, or both
 *
 * Anything not `built` or `config` is a plan. The library says so on every row,
 * because the failure mode of a document like this is that it reads as a feature
 * list, and six weeks later someone has promised a client a mechanic nobody
 * wrote.
 *
 * ── Sourcing ────────────────────────────────────────────────────────────────
 * Same boundary as referenceGames.js and it is not negotiable: plain-language
 * rules and attribution only. No studio's assets, bundles, source, sprite data,
 * reel strips or RTP configuration were fetched, inspected, or are permitted
 * here. We build the mechanic ourselves, with our own art.
 */

import { gamesUsing, REFERENCE_GAMES } from './referenceGames.js';

/** Difficulty, in the same vocabulary the behavior recipes already use. */
export const DIFFICULTY = {
	T0: 'config only — a spec setting, no code',
	T1: 'board post-processor — one function that mutates the board',
	T2: 'round-loop orchestration — changes how the round is sequenced',
	T3: 'needs a new win-evaluation engine or a variable board',
};

/**
 * @typedef {object} Mechanic
 * @property {string}   id
 * @property {string}   name
 * @property {string}   family
 * @property {string}   rule          what actually happens, in one paragraph
 * @property {string}   status        built | config | sample | roadmap | blocked
 * @property {string}   difficulty    T0..T3
 * @property {string[]} winTypes      evaluators it works on
 * @property {string[]} volatility    tiers it serves
 * @property {object}   art           what the art team must produce
 * @property {object}   frontend      what the web-sdk needs
 * @property {object}   math          what the math-sdk needs
 * @property {string[]} combinesWith
 * @property {Array<{id:string,why:string}>} conflictsWith
 * @property {?object}  trademark
 * @property {?string}  recipe        behaviorRecipes id, when one generates it
 */

/** @type {Record<string, Mechanic>} */
export const MECHANIC_LIBRARY = {
	// ═══════════════════════════════════════════════════════════════════════
	// Win evaluators — the four the engine ships
	// ═══════════════════════════════════════════════════════════════════════
	cluster_pays: {
		id: 'cluster_pays',
		name: 'Cluster pays',
		family: 'evaluator',
		rule:
			'Wins are groups of five or more of the same symbol connected orthogonally, anywhere on ' +
			'the grid. Payout scales with GROUP SIZE rather than a count per reel, so the paytable ' +
			'is a range table (5, 6-9, 10-13, 14+) rather than a 3/4/5-of-a-kind row.',
		status: 'config',
		difficulty: 'T0',
		winTypes: ['cluster'],
		volatility: ['low', 'medium', 'high'],
		art: {
			symbols: 'Square-ish symbols that read at small size and tessellate — cluster grids are ' +
				'7x7, so a symbol is roughly a third the pixel area of a 5x3 game.',
			states: ['idle', 'win'],
			animations: ['per-symbol win pop, short enough to fire 8 times in a cascade sequence'],
			screens: [],
			note: 'Cluster games show many more symbols at once. Silhouette separation matters more ' +
				'than detail; adjacent same-symbols must read as one connected shape.',
		},
		frontend: { bookEvents: [], components: [], notes: 'Sample app: apps/cluster.' },
		math: { sample: 'games/0_0_cluster', notes: 'src/calculations/cluster.py. Paytable is a range table.' },
		combinesWith: ['tumble', 'grid_multipliers', 'wild_spawner', 'symbol_transform', 'freespins'],
		conflictsWith: [
			{ id: 'ways_pays', why: 'Orthogonal adjacency and reel adjacency would double-pay the same overlapping sets of symbols.' },
			{ id: 'megaways', why: 'Cluster adjacency needs a regular lattice, and variable reel heights break it every spin.' },
		],
		trademark: null,
		recipe: null,
	},
	scatter_pays: {
		id: 'scatter_pays',
		name: 'Scatter pays (pay anywhere)',
		family: 'evaluator',
		rule:
			'Position is irrelevant: eight or more of a symbol anywhere on the grid pays, by count. ' +
			'The highest hit-rate evaluator in the engine, which makes it the natural choice for the ' +
			'low end of the volatility range.',
		status: 'config',
		difficulty: 'T0',
		winTypes: ['scatter'],
		volatility: ['low', 'medium', 'high'],
		art: {
			symbols: 'Reads at any position, no directional bias — symbols are never in a line.',
			states: ['idle', 'win'],
			animations: ['win pop that works when scattered across the whole grid, not a left-to-right sweep'],
			screens: [],
			note: 'Win presentation is the hard part: eight symbols lighting up in unrelated positions ' +
				'has no natural reading order. Budget for a board-wide effect rather than per-symbol.',
		},
		frontend: { bookEvents: [], components: [], notes: 'Sample app: apps/scatter.' },
		math: { sample: 'games/0_0_scatter', notes: 'src/calculations/scatter.py. Range paytable, min 8.' },
		combinesWith: ['tumble', 'multiplier_orbs', 'freespins', 'progressive_global_multiplier'],
		conflictsWith: [
			{ id: 'expanding_wild', why: 'Scatter-pays counts instances with no positional requirement, so a substituting wild has nothing to bridge.' },
			{ id: 'sticky_wild', why: 'Same reason — a wild that cannot bridge anything is decoration.' },
		],
		trademark: null,
		recipe: null,
	},
	ways_pays: {
		id: 'ways_pays',
		name: 'Ways (243/1024/…)',
		family: 'evaluator',
		rule:
			'Adjacent from the leftmost reel, any row. Ways are the PRODUCT of matching symbols per ' +
			'reel, so a 5x4 board is 1024 ways where a 5x3 is 243. Payouts are per way, which is why ' +
			'a ways paytable must be scaled to the geometry — a 5x3 paytable on a 5x4 board pays 4.2x ' +
			'too much before anything else is considered.',
		status: 'config',
		difficulty: 'T0',
		winTypes: ['ways'],
		volatility: ['medium', 'high', 'extreme'],
		art: {
			symbols: 'Standard 200x200. Stacked symbols are common, so a symbol must tile vertically ' +
				'without an obvious seam.',
			states: ['idle', 'win'],
			animations: ['win highlight per reel, since a win is a contiguous run of reels'],
			screens: [],
		},
		frontend: { bookEvents: [], components: [], notes: 'Sample app: apps/ways.' },
		math: {
			sample: 'games/0_0_ways',
			notes:
				'src/calculations/ways.py. Its multiplier_strategy parameter is the one place in the ' +
				'engine where symbol multipliers COMPOUND rather than sum — but only under "symbol". ' +
				'Under "board" they add, exactly like a lines game.',
		},
		combinesWith: ['xways', 'xsplit', 'colossal_symbol', 'sticky_wild', 'expanding_wild', 'freespins'],
		conflictsWith: [{ id: 'cluster_pays', why: 'Orthogonal adjacency and reel adjacency would double-pay the same overlapping sets of symbols.' }],
		trademark: null,
		recipe: null,
	},
	lines_pays: {
		id: 'lines_pays',
		name: 'Paylines',
		family: 'evaluator',
		rule:
			'Wins run left-to-right along fixed patterns across the reels. The most legible evaluator ' +
			'for a player and the easiest to present, which is why it still carries most hold-and-win ' +
			'and money-symbol games.',
		status: 'config',
		difficulty: 'T0',
		winTypes: ['lines'],
		volatility: ['low', 'medium', 'high', 'extreme'],
		art: {
			symbols: 'Standard 200x200.',
			states: ['idle', 'win'],
			animations: ['win line draw', 'per-symbol win pop'],
			screens: ['paytable screen showing the line patterns'],
		},
		frontend: { bookEvents: [], components: [], notes: 'Sample app: apps/lines.' },
		math: { sample: 'games/0_0_lines', notes: 'src/calculations/lines.py.' },
		combinesWith: ['expanding_wild', 'sticky_wild', 'hold_and_win', 'money_symbol', 'collector_symbol', 'freespins'],
		conflictsWith: [],
		trademark: null,
		recipe: null,
	},

	// ═══════════════════════════════════════════════════════════════════════
	// Round structure
	// ═══════════════════════════════════════════════════════════════════════
	tumble: {
		id: 'tumble',
		name: 'Tumble / cascade',
		family: 'round',
		rule:
			'Winning symbols are removed, the remainder falls, new symbols drop in, and the board is ' +
			're-evaluated until no win remains. One round becomes a SEQUENCE of boards, and the win ' +
			'cap is tested against the running round total rather than any single board.',
		status: 'built',
		difficulty: 'T2',
		winTypes: ['cluster', 'scatter', 'lines', 'ways'],
		volatility: ['low', 'medium', 'high'],
		art: {
			symbols: 'Every symbol needs an explosion or dissolve state.',
			states: ['idle', 'win', 'explode'],
			animations: ['explosion (~200ms — it fires up to a dozen times in one round)', 'fall-in with settle'],
			screens: [],
			note: 'Cascade timing is the single biggest driver of round length. Keep the explosion and ' +
				'the drop short; a 400ms explosion makes an eight-cascade round feel broken.',
		},
		frontend: { bookEvents: ['tumbleBoard'], components: [], notes: 'Both tumbling sample apps implement it.' },
		math: {
			sample: 'games/0_0_cluster, games/0_0_scatter',
			notes:
				'src/calculations/tumble.py references no win type, so it is engine-agnostic — but no ' +
				'shipped sample pairs it with lines or ways, so that combination is build-and-verify. ' +
				'Scatters do NOT explode, so they accumulate across a cascade sequence, which raises ' +
				'the effective retrigger rate well above a single board\'s.',
		},
		combinesWith: ['cluster_pays', 'scatter_pays', 'grid_multipliers', 'progressive_cascade_multiplier', 'multiplier_orbs'],
		conflictsWith: [
			// expanding_wild used to be here. It was resolved rather than removed:
			// every board-writing recipe now declares a boardLifetime, and the
			// scaffolder restores anything that outlives one evaluation after each
			// cascade refill. Proven by running the combination end to end.
			{ id: 'walking_wild', why: '"One step per spin" is undefined inside a multi-step cascade.' },
			{ id: 'hold_and_win', why: 'Both own the disposal step and give opposite instructions — lock what landed vs remove what won. Fine as separate PHASES.' },
		],
		trademark: null,
		recipe: 'tumble',
	},
	freespins: {
		id: 'freespins',
		name: 'Free spins',
		family: 'round',
		rule:
			'Scatters trigger a bounded run of spins on a richer reel set, usually with a mechanic the ' +
			'base game does not have. The default home for every multiplier in the library.',
		status: 'built',
		difficulty: 'T0',
		winTypes: ['lines', 'ways', 'cluster', 'scatter'],
		volatility: ['low', 'medium', 'high', 'extreme'],
		art: {
			symbols: 'A scatter symbol with an anticipation state.',
			states: ['idle', 'win', 'anticipation'],
			animations: ['scatter land', 'scatter anticipation loop (reels 3+)'],
			screens: [
				'free-spins intro ("N free spins")',
				'free-spins outro ("you won X")',
				'spin counter',
				'BOTH IN ALL 16 LANGUAGES — the web-sdk asset contract bakes text into art',
			],
		},
		frontend: { bookEvents: ['freeSpinTrigger', 'updateFreeSpin', 'freeSpinEnd'], components: [] },
		math: { sample: 'every sample', notes: 'freespin_triggers keyed by gametype.' },
		combinesWith: ['*'],
		conflictsWith: [],
		trademark: null,
		recipe: 'freespins',
	},
	freespin_reset: {
		id: 'freespin_reset',
		name: 'Free spins that reset on a symbol',
		family: 'round',
		rule:
			'The free-spin counter resets whenever a qualifying symbol lands, so the round ends only ' +
			'after N consecutive spins without one. The hold-and-win respin-reset rule applied to a ' +
			'FREE-SPIN round rather than a separate bet mode — the player watches a countdown that ' +
			'keeps being pushed back rather than ticking down.',
		status: 'built',
		difficulty: 'T2',
		winTypes: ['lines', 'ways', 'cluster', 'scatter'],
		volatility: ['medium', 'high'],
		art: {
			symbols: [],
			states: [],
			animations: ['the counter RESETTING — it must read as a reset, not a decrement'],
			screens: ['a spin counter prominent enough that pushing it back is the beat'],
			note: 'The reset is the whole mechanic. If the counter animation does not sell it, the ' +
				'game just looks like it has a lot of free spins.',
		},
		frontend: { bookEvents: ['updateFreeSpin'], components: [] },
		math: {
			sample: null,
			notes:
				'Generated from freeSpins.resetOnSymbol as an override plus two splices into ' +
				'run_freespin. The reset COUNT is bounded and the assignment uses max(), never a bare ' +
				'tot_fs = fs + N: measured before that fix, rounds awarded 12 spins were finishing in ' +
				'4 because an early wild TRUNCATED them. A reset must extend a feature or leave it ' +
				'alone. Bounded because tot_fs growing on a common board event is a branching ' +
				'process, and an unbounded one does not reliably terminate.',
		},
		combinesWith: ['freespins', 'sticky_wild', 'expanding_wild', 'tumble'],
		conflictsWith: [],
		trademark: null,
		recipe: null,
		// A third provenance beside "behavior recipe" and "math-sdk sample": some
		// mechanics are generated straight by the scaffolder because they are a
		// game-level setting rather than a symbol behaviour. Named so "built" can
		// still be checked — a status nobody can trace is a claim, not a fact.
		generator: 'mathScaffold.applyFreeSpinReset',
	},
	guaranteed_wild_per_cascade: {
		id: 'guaranteed_wild_per_cascade',
		name: 'Guaranteed wild on every cascade',
		family: 'wild',
		rule:
			'At least one of the symbols dropped in by each cascade is a wild. Sustains a cascade ' +
			'sequence without making the strips richer, which keeps the base board honest while the ' +
			'sequence itself becomes the feature.',
		status: 'roadmap',
		difficulty: 'T1',
		winTypes: ['cluster', 'scatter'],
		volatility: ['high'],
		art: {
			symbols: 'A wild that reads as ARRIVING rather than landing — it is injected, not drawn.',
			states: ['idle', 'win', 'spawn'],
			animations: ['spawn-in, distinct from a normal fall'],
			screens: [],
		},
		frontend: { bookEvents: ['tumbleBoard'], components: [] },
		math: {
			sample: null,
			notes:
				'A post-processor on the refill: after tumble_game_board(), rewrite one of the newly ' +
				'dropped cells to the wild. Cheap, and it needs the cascade-safety check — a ' +
				'guaranteed wild raises the chance the next board also wins, which is exactly the ' +
				'quantity that has to stay under 1 for a round to terminate.',
		},
		combinesWith: ['tumble', 'cluster_pays', 'progressive_global_multiplier'],
		conflictsWith: [
			{ id: 'scatter_pays', why: 'Scatter-pays counts instances anywhere, so an injected wild has no gap to bridge.' },
		],
		trademark: null,
		recipe: null,
	},
	retrigger_upgrade: {
		id: 'retrigger_upgrade',
		name: 'Upgrade on retrigger',
		family: 'round',
		rule:
			'Each retrigger not only adds spins but improves the feature — the collector multiplier ' +
			'steps up, a symbol is promoted, a meter advances. The Big Bass pattern, and the reason ' +
			'that game feels progressive without any cross-round state.',
		status: 'roadmap',
		difficulty: 'T1',
		winTypes: ['lines', 'ways', 'cluster', 'scatter'],
		volatility: ['medium', 'high'],
		art: {
			symbols: 'The upgraded symbol needs a visibly different tier — colour or frame, not detail.',
			states: ['idle', 'win', 'upgraded'],
			animations: ['upgrade transition', 'tier badge'],
			screens: ['retrigger banner showing the new tier, in all 16 languages'],
		},
		frontend: { bookEvents: ['featureUpgrade'], components: ['UpgradeBadge'] },
		math: {
			sample: null,
			notes:
				'freespin_triggers already indexes awarded spins by scatter count, so the hook exists. ' +
				'The upgrade is a counter on the gamestate read by the feature.',
		},
		combinesWith: ['freespins', 'collector_symbol', 'money_symbol'],
		conflictsWith: [],
		trademark: null,
		recipe: null,
	},
	multi_mode_feature: {
		id: 'multi_mode_feature',
		name: 'Selectable feature modes',
		family: 'round',
		rule:
			'The trigger picks between two or more free-spin variants — more spins with a lower ' +
			'multiplier, or fewer with a higher one, or an entirely different mechanic per mode. One ' +
			'game with three feature identities.',
		status: 'roadmap',
		difficulty: 'T2',
		winTypes: ['lines', 'ways', 'cluster', 'scatter'],
		volatility: ['high', 'extreme'],
		art: {
			symbols: [],
			states: [],
			animations: ['mode-select reveal'],
			screens: [
				'a mode-select screen, one panel per mode',
				'a distinct intro banner per mode',
				'all in 16 languages — this multiplies the localisation cost by the number of modes',
			],
			note: 'The cheapest way to make a game feel deep, and the most expensive per mode in ' +
				'localised art. Cost it before committing to three modes.',
		},
		frontend: { bookEvents: ['featureModeSelected'], components: ['ModeSelect'] },
		math: {
			sample: null,
			notes:
				'Expressible today as separate distributions within one bet mode, each with its own ' +
				'reel weights and conditions. No new engine work — this is orchestration.',
		},
		combinesWith: ['freespins', 'sticky_wild', 'walking_wild', 'buy_bonus'],
		conflictsWith: [],
		trademark: null,
		recipe: null,
	},
	respin: {
		id: 'respin',
		name: 'Respin',
		family: 'round',
		rule: 'A qualifying event holds part of the board and re-spins the rest, without consuming a new bet.',
		status: 'sample',
		difficulty: 'T2',
		winTypes: ['lines', 'ways'],
		volatility: ['low', 'medium'],
		art: {
			symbols: [],
			states: ['locked'],
			animations: ['lock-in', 'respin counter tick'],
			screens: ['respin counter'],
		},
		frontend: { bookEvents: ['respinStart', 'respinEnd'], components: [] },
		math: { sample: 'games/0_0_expwilds superspin mode', notes: 'The superspin loop is a respin loop.' },
		combinesWith: ['expanding_wild', 'hold_and_win', 'walking_wild'],
		conflictsWith: [],
		trademark: null,
		recipe: null,
	},

	// ═══════════════════════════════════════════════════════════════════════
	// Wilds
	// ═══════════════════════════════════════════════════════════════════════
	expanding_wild: {
		id: 'expanding_wild',
		name: 'Expanding wild',
		family: 'wild',
		rule:
			'A wild lands and expands to fill its entire reel, staying for the rest of the free-spin ' +
			'round. A fresh multiplier is rolled onto it on each reveal — the wild is sticky, its ' +
			'multiplier is not.',
		status: 'built',
		difficulty: 'T3',
		winTypes: ['lines', 'ways'],
		volatility: ['medium', 'high'],
		art: {
			symbols: 'A wild that reads both as a single cell and as a full-reel column.',
			states: ['idle', 'win', 'expand_in', 'expand_loop', 'expand_out'],
			animations: [
				'expand_in — one cell growing to fill the reel',
				'expand_loop — the held state, looping for the rest of the round',
				'expand_out',
				'a multiplier badge that re-rolls each spin without re-playing expand_in',
			],
			screens: [],
			note: 'The full-reel art is a different aspect ratio from a symbol tile — it is a separate ' +
				'export, not a scaled one.',
		},
		frontend: {
			bookEvents: ['newExpandingWilds', 'updateExpandingWilds'],
			components: ['ExpandingWilds.svelte'],
			notes: 'web-sdk has NO matching sample app — follow "Steps to Add a New BookEvent".',
		},
		math: { sample: 'games/0_0_expwilds', notes: 'Generated today by the `expanding` recipe.' },
		combinesWith: ['lines_pays', 'ways_pays', 'cluster_pays', 'tumble', 'freespins', 'sticky_multiplier'],
		combinesNote:
			'Combined with tumble as of the boardLifetime work, and proven by running it: a generated ' +
			'7x7 cluster game with expanding wilds reached 96.50% RTP against 96.50%, hit its 10,000x ' +
			'cap at 1-in-20,000,000, and kept 28 of 49 cells wild on the final board. The wild ladder ' +
			'is mechanic-aware — a full-column wild is far stronger on cluster, where it joins every ' +
			'group it touches, than on a payline.',
		conflictsWith: [
			{ id: 'scatter_pays', why: 'Scatter-pays counts instances anywhere, so there is no gap for a substituting wild to bridge.' },
		],
		trademark: null,
		recipe: 'expanding',
	},
	sticky_wild: {
		id: 'sticky_wild',
		name: 'Sticky wild',
		family: 'wild',
		rule:
			'A wild stays in place for the rest of the round. Coverage accumulates, so late spins are ' +
			'worth far more than early ones — the accumulation IS the mechanic, and it is what lets a ' +
			'plain 5x3 payline game reach six figures.',
		status: 'built',
		difficulty: 'T3',
		winTypes: ['lines', 'ways'],
		volatility: ['medium', 'high', 'extreme'],
		art: {
			symbols: 'A wild with a clearly "held" treatment distinct from its landing state.',
			states: ['idle', 'win', 'lock_in', 'locked_loop'],
			animations: ['lock_in', 'locked_loop (subtle — it may be on screen for 20 spins)'],
			screens: [],
			note: 'The locked loop must survive being on screen a long time next to many others. ' +
				'Quiet beats spectacular here.',
		},
		frontend: { bookEvents: ['stickySymbolAdd', 'stickySymbolClear'], components: ['StickySymbols.svelte'] },
		math: { sample: 'games/0_0_expwilds', notes: 'Generated today by the `sticky` recipe.' },
		combinesWith: ['freespins', 'sticky_multiplier', 'multi_mode_feature', 'ways_pays', 'lines_pays'],
		conflictsWith: [
			{ id: 'tumble', why: 'Needs sequencing: falling symbols must stack ABOVE a sticky cell, not through it.' },
			{ id: 'scatter_pays', why: 'Scatter-pays counts instances anywhere, so a substituting wild has no gap to bridge.' },
		],
		trademark: null,
		recipe: 'sticky',
	},
	walking_wild: {
		id: 'walking_wild',
		name: 'Walking wild',
		family: 'wild',
		rule:
			'A wild moves one position per spin and grants a respin each time, until it walks off the ' +
			'board. On a cluster board it can move in any direction and carry a multiplier that grows ' +
			'each time it takes part in a win.',
		status: 'roadmap',
		difficulty: 'T2',
		winTypes: ['lines', 'ways', 'cluster'],
		volatility: ['medium', 'high'],
		art: {
			symbols: 'A wild with directional movement — it must read as travelling, not teleporting.',
			states: ['idle', 'win', 'walk'],
			animations: ['walk transition between cells', 'multiplier increment tick'],
			screens: [],
		},
		frontend: { bookEvents: ['wildWalk'], components: ['WalkingWilds.svelte'] },
		math: { sample: null, notes: 'A board post-processor plus a respin loop. Needs a declared board lifetime.' },
		combinesWith: ['respin', 'freespins', 'cluster_pays', 'progressive_cascade_multiplier'],
		conflictsWith: [
			{ id: 'tumble', why: '"One step per spin" is undefined when a spin contains eight cascade steps.' },
		],
		trademark: null,
		recipe: null,
	},
	random_wild: {
		id: 'random_wild',
		name: 'Random / mystery wild',
		family: 'wild',
		rule: 'Wilds injected at random positions after the spin resolves.',
		status: 'roadmap',
		difficulty: 'T1',
		winTypes: ['lines', 'ways', 'cluster'],
		volatility: ['low', 'medium'],
		art: {
			symbols: 'A wild plus an arrival effect that reads as "added", not "landed".',
			states: ['idle', 'win', 'spawn'],
			animations: ['spawn-in'],
			screens: [],
		},
		frontend: { bookEvents: ['randomWilds'], components: [] },
		math: { sample: null, notes: 'A board post-processor. Cheap.' },
		combinesWith: ['lines_pays', 'ways_pays', 'freespins'],
		conflictsWith: [{ id: 'scatter_pays', why: 'Scatter-pays counts instances anywhere, so a substituting wild has no gap to bridge.' }],
		trademark: null,
		recipe: null,
		note: 'LOWERS volatility and raises hit rate — a lever for the low end, counterproductive above 10,000x.',
	},
	wild_spawner: {
		id: 'wild_spawner',
		name: 'Wild spawner',
		family: 'wild',
		rule: 'A trigger condition fires extra wilds onto the grid — a charged meter, a symbol landing, a cascade count.',
		status: 'roadmap',
		difficulty: 'T1',
		winTypes: ['cluster', 'lines', 'ways'],
		volatility: ['medium', 'high'],
		art: {
			symbols: 'The spawner source plus the spawned wild.',
			states: ['idle', 'win', 'spawn'],
			animations: ['spawner fire', 'projectile or burst to each spawned cell'],
			screens: [],
		},
		frontend: { bookEvents: ['wildsSpawned'], components: [] },
		math: { sample: null, notes: 'Board post-processor keyed off a round-scoped counter.' },
		combinesWith: ['cluster_pays', 'charge_meter', 'tumble'],
		conflictsWith: [{ id: 'scatter_pays', why: 'Scatter-pays counts instances anywhere, so a substituting wild has no gap to bridge.' }],
		trademark: null,
		recipe: null,
	},
	expanding_special_symbol: {
		id: 'expanding_special_symbol',
		name: 'Book-style expanding symbol',
		family: 'wild',
		rule:
			'One symbol is chosen at the start of the feature. Whenever it lands it expands to fill ' +
			'its reel and pays as both wild and scatter — position stops mattering for that symbol.',
		status: 'roadmap',
		difficulty: 'T2',
		winTypes: ['lines'],
		volatility: ['high'],
		art: {
			symbols: 'Every payable symbol needs a full-reel expanded export, not just the wild.',
			states: ['idle', 'win', 'expand_in', 'expand_loop'],
			animations: ['the selection reveal at feature start', 'expand per symbol'],
			screens: ['"your special symbol is…" reveal, in all 16 languages'],
			note: 'The art cost is the catch: a full-reel version of EVERY symbol, not one.',
		},
		frontend: { bookEvents: ['specialSymbolChosen', 'specialSymbolExpand'], components: [] },
		math: { sample: null, notes: 'Symbol choice is round-scoped state; the expansion is the expanding-wild post-processor.' },
		combinesWith: ['lines_pays', 'freespins'],
		conflictsWith: [{ id: 'tumble', why: 'Same lifetime problem as the expanding wild — the expansion is written at mutate time and the cascade redraws the board.' }],
		trademark: null,
		recipe: null,
	},

	// ═══════════════════════════════════════════════════════════════════════
	// Multipliers — the volatility dial
	// ═══════════════════════════════════════════════════════════════════════
	multiplier_composition: {
		id: 'multiplier_composition',
		name: 'Multiplier composition (add vs compound)',
		family: 'multiplier',
		rule:
			'Not a mechanic so much as a RULE: do two 5x multipliers make 10x or 25x? The engine ' +
			'offers three strategies, and symbol multipliers ALWAYS SUM except on a ways board under ' +
			'the "symbol" strategy, where a multiplier adds its VALUE to that reel\'s ways count and ' +
			'ways multiply across reels.',
		status: 'built',
		difficulty: 'T0',
		winTypes: ['lines', 'ways', 'cluster', 'scatter'],
		volatility: ['low', 'medium', 'high', 'extreme'],
		art: { symbols: [], states: [], animations: [], screens: [] },
		math: {
			sample: 'games/0_0_lines (sums) and games/0_0_ways (compounds)',
			notes:
				'src/wins/multiplier_strategy.py. Parameter names differ per evaluator: lines takes ' +
				'multiplier_method, ways takes multiplier_strategy and ASSERTS on its list, and ' +
				'cluster/scatter have no parameter at all — they sum inline.',
		},
		frontend: { bookEvents: [], components: [] },
		combinesWith: ['*'],
		conflictsWith: [
			{ id: 'wincap', why: 'If the compounding tail routinely exceeds the cap, the cap silently truncates RTP. Model it inside the simulation.' },
		],
		trademark: null,
		recipe: null,
		note: 'The single highest-leverage dial in the library and it costs nothing — both patterns ' +
			'already exist in the samples. Additive for low and medium, compounding for high and extreme.',
	},
	progressive_global_multiplier: {
		id: 'progressive_global_multiplier',
		name: 'Progressive global multiplier',
		family: 'multiplier',
		rule:
			'One number multiplying every win, growing on a trigger — per free spin, per cascade, or ' +
			'per qualifying symbol — and never resetting within the round. Two growth modes: ' +
			'INCREMENT (+1, what the engine does) and DOUBLE (x2), with separate caps for the base ' +
			'game and the feature. Eight winning spins is 8x one way and 256x the other, so the mode ' +
			'is one of the largest volatility dials available.',
		status: 'built',
		difficulty: 'T0',
		winTypes: ['lines', 'ways', 'cluster', 'scatter'],
		volatility: ['high', 'extreme'],
		art: {
			symbols: [],
			states: [],
			animations: ['meter increment', 'a distinct beat at milestone values'],
			screens: ['a persistent multiplier meter, legible at a glance mid-cascade'],
		},
		frontend: { bookEvents: ['updateGlobalMult'], components: ['MultiplierMeter'] },
		math: {
			sample: 'games/0_0_scatter',
			notes:
				'executables.py update_global_mult() is `+= 1` with NO ceiling — the only uncapped ' +
				'lever in the engine. Nothing calls it by default; the spec flag generates the call. ' +
				'Note it is ignored entirely on a ways board unless multiplierStrategy is "global". ' +
				'The growth rule and its caps are generated as an override of update_global_mult().',
		},
		generator: 'mathScaffold.applyGlobalMultiplierGrowth',
		combinesWith: ['freespins', 'tumble', 'scatter_pays', 'mystery_stack'],
		conflictsWith: [],
		trademark: null,
		recipe: 'global_multiplier',
		note: 'The most effective single mechanic for reaching the top of the max-win range.',
	},
	progressive_cascade_multiplier: {
		id: 'progressive_cascade_multiplier',
		name: 'Per-cascade multiplier ladder',
		family: 'multiplier',
		rule:
			'A meter steps up with each successive cascade in one sequence (1x, 2x, 3x, 5x…) and ' +
			'applies to subsequent wins. Resets when the sequence ends.',
		status: 'built',
		difficulty: 'T1',
		// Needs a cascading board — a ladder with no second cascade never leaves
		// the first rung.
		winTypes: ['cluster', 'scatter'],
		volatility: ['medium', 'high'],
		art: {
			symbols: [],
			states: [],
			animations: ['ladder step, one rung per cascade'],
			screens: ['a ladder or step meter beside the grid'],
		},
		frontend: { bookEvents: ['updateGlobalMult'], components: ['CascadeLadder'] },
		math: {
			sample: null,
			notes:
				'boardMechanics.cascadeMultiplier, spliced after the cascade. The ladder is an explicit ' +
				'list of rungs, not a formula, so the spec states the values rather than implying them. ' +
				'Note the off-by-one that reads wrong until you trace it: the counter is stepped as the ' +
				'cascade happens, so the FIRST cascade already reads ladder[1] — ladder[0] is the value ' +
				'in force for the initial (uncascaded) evaluation. Sequence length is bounded by the ' +
				'cascade drop rate, so the top rung is reached far less often than the ladder suggests: ' +
				'verified on a generated game, longest observed sequence 5 against a 4-rung ladder, and ' +
				'the value never exceeded the top rung.',
		},
		generator: 'boardMechanics.cascadeMultiplier',
		combinesWith: ['tumble', 'cluster_pays', 'scatter_pays'],
		conflictsWith: [],
		trademark: null,
		recipe: null,
	},
	grid_multipliers: {
		id: 'grid_multipliers',
		name: 'Persistent position multipliers',
		family: 'multiplier',
		rule:
			'Grid POSITIONS activate when a win lands on them and grow on each subsequent hit, ' +
			'capped. Sticky for the round, summed and applied at sequence end. The player reads the ' +
			'board as a heat map rather than a set of symbols. Two growth modes: INCREMENT (+1 per ' +
			'hit, what the shipped sample does) and DOUBLE (x2 per hit, the pattern the mechanic is ' +
			'known for). Nine hits on one cell is 9x one way and 256x the other, so the mode is a ' +
			'large volatility dial in its own right.',
		status: 'built',
		difficulty: 'T2',
		// Cluster ONLY. 0_0_scatter has no position_multipliers and no
		// evaluate_clusters_with_grid — grepped every shipped sample to check,
		// after this entry claimed both.
		winTypes: ['cluster'],
		volatility: ['high', 'extreme'],
		art: {
			symbols: 'A multiplier badge per cell, legible over any symbol beneath it.',
			states: [],
			animations: ['badge appear', 'badge double (must read as doubling, not incrementing)', 'end-of-sequence collect sweep'],
			screens: [],
			note: 'Needs a value treatment that stays readable from 2x to 512x — four digits in a cell ' +
				'a third the size of a 5x3 symbol.',
		},
		frontend: { bookEvents: ['updateGridMult'], components: ['GridMultipliers.svelte'] },
		math: {
			sample: 'games/0_0_cluster',
			notes:
				'Already in the shipped CLUSTER sample — every cluster game the tool generates has had ' +
				'these all along (1,066 updateGrid events with a live cell in a 500-round run). ' +
				'Corrected twice: an earlier note cited games/0_0_gold_rush, which is a game this tool ' +
				'GENERATED, not a shipped sample; and the sample docstring says "double the grid value" ' +
				'while the code beneath it does `+= 1`. Measured top cell 110 — not a power of two. ' +
				'game.gridMultipliers now controls the cap (was a hardcoded 512) and the growth mode.',
		},
		generator: 'mathScaffold.applyGridMultipliers',
		combinesWith: ['tumble', 'cluster_pays', 'freespins'],
		conflictsWith: [{ id: 'lines_pays', why: 'Position multipliers only accumulate through repeat visits to the same cell, which needs cascades that a plain payline round does not have.' }],
		trademark: null,
		recipe: null,
	},
	multiplier_orbs: {
		id: 'multiplier_orbs',
		name: 'Multiplier orbs (pooled)',
		family: 'multiplier',
		rule:
			'Multiplier symbols land anywhere and are POOLED, then applied once at the end of a ' +
			'cascade sequence rather than per cascade. That ordering is the mechanic: applying them ' +
			'per-cascade instead produces a materially different RTP.',
		status: 'roadmap',
		difficulty: 'T1',
		winTypes: ['scatter', 'cluster'],
		volatility: ['high', 'extreme'],
		art: {
			symbols: 'An orb symbol carrying a readable value.',
			states: ['idle', 'collect'],
			animations: ['orb land', 'orbs flying to a total at sequence end', 'the total applying to the win'],
			screens: [],
		},
		frontend: { bookEvents: ['multiplierOrbs', 'applyOrbTotal'], components: ['MultiplierOrbs'] },
		math: {
			sample: null,
			notes:
				'Symbol multipliers already sum; what is new is DEFERRING them to sequence end. Pick ' +
				'the order of operations, document it, and golden-master test it.',
		},
		combinesWith: ['tumble', 'scatter_pays', 'freespins'],
		conflictsWith: [
			{ id: 'progressive_global_multiplier', why: '(win x Σorbs) x global and win x (Σorbs x global) give very different RTPs. Pick one and pin it with a test.' },
		],
		trademark: null,
		recipe: null,
	},
	sticky_multiplier: {
		id: 'sticky_multiplier',
		name: 'Sticky multiplier',
		family: 'multiplier',
		rule: 'A multiplier value locks to a cell or to a wild and persists for the round, often growing.',
		status: 'roadmap',
		difficulty: 'T1',
		winTypes: ['lines', 'ways', 'cluster'],
		volatility: ['high', 'extreme'],
		art: {
			symbols: 'A multiplier badge attachable to any symbol.',
			states: ['locked'],
			animations: ['lock-in', 'value increment'],
			screens: [],
		},
		frontend: { bookEvents: ['stickyMultiplierAdd', 'stickyMultiplierUpdate'], components: [] },
		math: { sample: null, notes: 'Extends the sticky recipe with a value that survives the spin.' },
		combinesWith: ['sticky_wild', 'walking_wild', 'freespins', 'expanding_wild'],
		conflictsWith: [],
		trademark: null,
		recipe: null,
	},
	random_multiplier: {
		id: 'random_multiplier',
		name: 'Random multiplier drop',
		family: 'multiplier',
		rule: 'A multiplier lands on a random cell after the spin resolves, applying to any win it touches.',
		status: 'roadmap',
		difficulty: 'T1',
		winTypes: ['cluster', 'lines', 'ways'],
		volatility: ['medium', 'high'],
		art: { symbols: 'A multiplier token.', states: [], animations: ['drop-in', 'apply'], screens: [] },
		frontend: { bookEvents: ['randomMultiplier'], components: [] },
		math: { sample: null, notes: 'Board post-processor.' },
		combinesWith: ['tumble', 'cluster_pays', 'freespins'],
		conflictsWith: [],
		trademark: null,
		recipe: null,
	},

	// ═══════════════════════════════════════════════════════════════════════
	// Hold-and-win family — the cheapest route to the top of the range
	// ═══════════════════════════════════════════════════════════════════════
	hold_and_win: {
		id: 'hold_and_win',
		name: 'Hold and win (resetting respins)',
		family: 'holdwin',
		rule:
			'Its own round with its own loop. A prize symbol lands, locks to its cell, and RESETS the ' +
			'respin counter — that reset is the mechanic. When respins run out, every locked prize on ' +
			'the board pays.',
		status: 'built',
		difficulty: 'T3',
		winTypes: ['lines', 'ways', 'cluster'],
		volatility: ['medium', 'high', 'extreme'],
		art: {
			symbols: 'A prize symbol carrying a value, plus a blank/inert cell treatment.',
			states: ['idle', 'lock_in', 'locked_loop', 'value_reveal'],
			animations: ['lock-in', 'respin counter reset (must read as a reset, not a decrement)', 'final collect sweep'],
			screens: ['respin counter', 'a grid-fill progress indicator if there is a full-board award'],
		},
		frontend: { bookEvents: ['prizeLock', 'respinReset', 'prizeCollect'], components: ['HoldAndWin'] },
		math: { sample: 'games/0_0_expwilds superspin mode', notes: 'Generated today by the `prize` recipe, verified on lines.' },
		combinesWith: ['money_symbol', 'prize_tiers', 'collector_symbol', 'payer_symbol', 'grid_expansion'],
		conflictsWith: [
			{ id: 'tumble', why: 'Both own disposal with opposite instructions. Fine as separate phases.' },
		],
		trademark: null,
		recipe: 'prize',
	},
	money_symbol: {
		id: 'money_symbol',
		name: 'Money / cash symbol',
		family: 'holdwin',
		rule: 'A symbol carrying a cash value that pays directly rather than through the paytable.',
		status: 'built',
		difficulty: 'T1',
		winTypes: ['lines', 'ways', 'cluster'],
		volatility: ['medium', 'high'],
		art: {
			symbols: 'A value-bearing symbol. The VALUE is dynamic text over a static frame — do not ' +
				'bake values into art, the ladder changes with tuning.',
			states: ['idle', 'value_reveal'],
			animations: ['value reveal'],
			screens: [],
		},
		frontend: { bookEvents: ['moneySymbolReveal'], components: [] },
		math: { sample: 'games/0_0_expwilds, games/0_0_le_bandit', notes: 'prize_values as a weighted ladder.' },
		combinesWith: ['hold_and_win', 'collector_symbol', 'payer_symbol', 'freespins', 'prize_tiers'],
		conflictsWith: [],
		trademark: null,
		recipe: 'prize',
	},
	collector_symbol: {
		id: 'collector_symbol',
		name: 'Collector',
		family: 'holdwin',
		rule: 'A symbol that sweeps every visible money value into itself and pays the total.',
		status: 'built',
		difficulty: 'T1',
		winTypes: ['lines', 'ways', 'cluster'],
		volatility: ['high', 'extreme'],
		art: {
			symbols: 'A collector distinct enough from money symbols to read instantly at a glance.',
			states: ['idle', 'collect'],
			animations: ['collect sweep — a path from every money cell to the collector', 'total tally'],
			screens: [],
			note: 'The sweep is the signature moment of the whole genre. Budget for it properly; it ' +
				'has to work with anything from 2 to 30 source cells.',
		},
		frontend: { bookEvents: ['collectorFire'], components: ['Collector'] },
		math: {
			sample: null,
			notes:
				'Generated from special: [prize, collector], resolved on the FINAL board of a ' +
				'hold-and-win round. ORDER IS FIXED and not configurable: payers resolve first, so a ' +
				'collector sweeps values the payers have already raised. An ordering the spec could ' +
				'flip is an RTP the spec could flip by accident. Swept cells are ZEROED rather than ' +
				'left alone, because get_final_board_prize() sums the board and would otherwise pay ' +
				'the same money twice. Verified by hand: a payer worth 5 and three prizes of 10/20/30 ' +
				'went from a board total of 66 to 86, all of it on the collector.',
		},
		generator: 'mathScaffold.applyCollectorPayer',
		combinesWith: ['money_symbol', 'hold_and_win', 'payer_symbol', 'freespins', 'retrigger_upgrade'],
		conflictsWith: [],
		trademark: null,
		recipe: null,
	},
	payer_symbol: {
		id: 'payer_symbol',
		name: 'Payer',
		family: 'holdwin',
		rule: 'A symbol that ADDS its value to every other money value on screen — the inverse of a collector.',
		status: 'built',
		difficulty: 'T1',
		winTypes: ['lines', 'ways', 'cluster'],
		volatility: ['extreme'],
		art: {
			symbols: 'A payer, visually opposite to the collector.',
			states: ['idle', 'pay'],
			animations: ['broadcast to every money cell', 'per-cell value increment'],
			screens: [],
		},
		frontend: { bookEvents: ['payerFire'], components: [] },
		math: {
			sample: null,
			notes:
				'Generated from special: [prize, payer]. Resolves BEFORE collectors — see ' +
				'collector_symbol for why that ordering is fixed rather than configurable.',
		},
		generator: 'mathScaffold.applyCollectorPayer',
		combinesWith: ['money_symbol', 'collector_symbol', 'hold_and_win'],
		conflictsWith: [],
		trademark: null,
		recipe: null,
	},
	special_symbol_roles: {
		id: 'special_symbol_roles',
		name: 'Special symbol taxonomy',
		family: 'holdwin',
		rule:
			'Not one mechanic but a PATTERN: define a set of symbol roles (collector, payer, sniper, ' +
			'reviver, multiplier) each with a small rule, and let the interactions carry the game. ' +
			'The Money Train school.',
		status: 'roadmap',
		difficulty: 'T2',
		winTypes: ['lines', 'ways', 'cluster'],
		volatility: ['extreme'],
		art: {
			symbols: 'One distinct symbol per role — six to ten of them, each instantly distinguishable.',
			states: ['idle', 'fire'],
			animations: ['a signature action per role'],
			screens: ['an in-game legend explaining the roles, in all 16 languages'],
			note: 'The largest art commitment in the library, and the reason these games feel premium. ' +
				'Budget one full character animation set per role.',
		},
		frontend: { bookEvents: ['specialSymbolFire'], components: ['SpecialSymbols'] },
		math: {
			sample: null,
			notes:
				'The cheapest known route to 50,000x+: no new evaluator, just well-chosen roles and a ' +
				'FIXED, documented order of operations.',
		},
		combinesWith: ['hold_and_win', 'money_symbol', 'collector_symbol', 'payer_symbol', 'grid_expansion'],
		conflictsWith: [],
		trademark: null,
		recipe: null,
	},
	prize_tiers: {
		id: 'prize_tiers',
		name: 'Fixed prize tiers (Mini / Minor / Major / Grand)',
		family: 'holdwin',
		rule: 'A fixed ladder of named awards, typically around 20x / 50x / 200x / 500x.',
		status: 'config',
		difficulty: 'T0',
		winTypes: ['lines', 'ways', 'cluster'],
		volatility: ['low', 'medium'],
		art: {
			symbols: 'Four tier badges.',
			states: [],
			animations: ['tier award reveal'],
			screens: ['a tier ladder panel, in all 16 languages'],
		},
		frontend: { bookEvents: ['prizeTierAwarded'], components: [] },
		math: { sample: null, notes: 'Just values in the prize ladder. Genuinely cheap.' },
		combinesWith: ['hold_and_win', 'money_symbol'],
		conflictsWith: [],
		trademark: null,
		recipe: null,
		note: 'Puts a FLOOR under the feature — the standard way to hold a hold-and-win at medium volatility.',
	},
	grid_expansion: {
		id: 'grid_expansion',
		name: 'In-round grid growth',
		family: 'holdwin',
		rule: 'Filling a column or hitting a trigger opens more rows or reels, mid-round.',
		status: 'roadmap',
		difficulty: 'T3',
		winTypes: ['lines', 'ways', 'cluster'],
		volatility: ['extreme'],
		art: {
			symbols: [],
			states: [],
			animations: ['the grid growing — frame, background and grid lines all reflow'],
			screens: ['background art at every grid size the game can reach'],
			note: 'Costly: the background and frame need a version per grid size, not a stretch.',
		},
		frontend: { bookEvents: ['gridExpand'], components: [] },
		math: {
			sample: null,
			notes:
				'BLOCKED as generic growth — num_rows is a static array read at board creation ' +
				'(board.py:26,41,89). A fixed set of pre-declared sizes may be workable; open-ended ' +
				'growth is not. Also: adding rows shifts every locked cell index, so lock by identity, ' +
				'never by position.',
		},
		combinesWith: ['hold_and_win', 'special_symbol_roles', 'tumble'],
		conflictsWith: [],
		trademark: null,
		recipe: null,
	},

	// ═══════════════════════════════════════════════════════════════════════
	// Symbol behaviour
	// ═══════════════════════════════════════════════════════════════════════
	mystery_symbol: {
		id: 'mystery_symbol',
		name: 'Mystery symbol',
		family: 'symbol',
		rule: 'Placeholder symbols land, then all reveal simultaneously as one randomly chosen type.',
		status: 'roadmap',
		difficulty: 'T1',
		winTypes: ['lines', 'ways', 'cluster'],
		volatility: ['medium', 'high'],
		art: {
			symbols: 'A mystery cover symbol.',
			states: ['idle', 'reveal'],
			animations: ['a simultaneous reveal across every mystery cell — one beat, not a stagger'],
			screens: [],
		},
		frontend: { bookEvents: ['mysteryReveal'], components: [] },
		math: { sample: null, notes: 'Board post-processor: pick one type, rewrite every mystery cell.' },
		combinesWith: ['lines_pays', 'ways_pays', 'freespins', 'sticky_wild'],
		conflictsWith: [],
		trademark: null,
		recipe: null,
	},
	mystery_stack: {
		id: 'mystery_stack',
		name: 'Mystery stack',
		family: 'symbol',
		rule: 'A full or partial reel of covered symbols revealing as one type — the stacked form of a mystery symbol.',
		status: 'roadmap',
		difficulty: 'T1',
		winTypes: ['ways', 'lines'],
		volatility: ['high', 'extreme'],
		art: {
			symbols: 'A stack cover that tiles vertically.',
			states: ['idle', 'reveal'],
			animations: ['stack reveal'],
			screens: [],
		},
		frontend: { bookEvents: ['mysteryStackReveal'], components: [] },
		math: { sample: null, notes: 'As mystery_symbol, applied to a contiguous run.' },
		combinesWith: ['nudging_reel', 'progressive_global_multiplier', 'ways_pays'],
		conflictsWith: [],
		trademark: null,
		recipe: null,
	},
	nudging_reel: {
		id: 'nudging_reel',
		name: 'Nudging reel',
		family: 'symbol',
		rule: 'A partially visible stack nudges up or down until it is fully in view, often granting a respin.',
		status: 'roadmap',
		difficulty: 'T2',
		winTypes: ['ways', 'lines'],
		volatility: ['high', 'extreme'],
		art: { symbols: [], states: [], animations: ['reel nudge, one row at a time'], screens: [] },
		frontend: { bookEvents: ['reelNudge'], components: [] },
		math: { sample: null, notes: 'Reel-position manipulation after the draw. Padding rows already exist in the board model.' },
		combinesWith: ['mystery_stack', 'respin', 'ways_pays'],
		conflictsWith: [{ id: 'tumble', why: 'Nudging assumes a stable reel position, and the cascade rewrites reel positions on every drop.' }],
		trademark: { name: 'xNudge', owner: 'Nolimit City', note: 'The mechanic is buildable; the NAME is not ours.' },
		recipe: null,
	},
	symbol_upgrade: {
		id: 'symbol_upgrade',
		name: 'Symbol upgrade',
		family: 'symbol',
		rule: 'Low-paying symbols are promoted to high-paying ones, permanently for the round or for one spin.',
		status: 'roadmap',
		difficulty: 'T1',
		winTypes: ['lines', 'ways', 'cluster'],
		volatility: ['medium', 'high'],
		art: {
			symbols: 'Each low symbol needs a promotion transition into its target.',
			states: ['idle', 'upgrade'],
			animations: ['upgrade transition per symbol pair'],
			screens: [],
		},
		frontend: { bookEvents: ['symbolUpgrade'], components: [] },
		math: { sample: null, notes: 'Board post-processor plus round-scoped state for which tier is active.' },
		combinesWith: ['freespins', 'retrigger_upgrade'],
		conflictsWith: [],
		trademark: null,
		recipe: null,
	},
	symbol_transform: {
		id: 'symbol_transform',
		name: 'Symbol conversion',
		family: 'symbol',
		rule: 'Every instance of one symbol type becomes another, manufacturing a win that was not there.',
		status: 'roadmap',
		difficulty: 'T1',
		winTypes: ['cluster', 'scatter', 'lines', 'ways'],
		volatility: ['low', 'medium'],
		art: {
			symbols: [],
			states: ['transform'],
			animations: ['a transform that reads as "these became those", simultaneous across the board'],
			screens: [],
		},
		frontend: { bookEvents: ['symbolTransform'], components: [] },
		math: { sample: null, notes: 'Board post-processor.' },
		combinesWith: ['cluster_pays', 'tumble', 'charge_meter'],
		conflictsWith: [],
		trademark: null,
		recipe: null,
		note: 'LOWERS volatility — a lever for the low end of the range.',
	},
	colossal_symbol: {
		id: 'colossal_symbol',
		name: 'Colossal symbol',
		family: 'symbol',
		rule: 'A symbol occupying an NxN block, counting as N separate symbols in each cell it covers.',
		status: 'built',
		difficulty: 'T3',
		winTypes: ['ways', 'lines'],
		volatility: ['high'],
		art: {
			symbols: 'A 2x2 or 3x3 export per colossal-capable symbol — a separate asset, not a scale.',
			states: ['idle', 'colossal_in', 'colossal_idle'],
			animations: ['colossal_in', 'colossal_idle'],
			screens: [],
		},
		frontend: { bookEvents: ['colossalSymbol'], components: [] },
		math: { sample: null, notes: 'Generated today by the `colossal` recipe.' },
		combinesWith: ['ways_pays', 'freespins'],
		conflictsWith: [{ id: 'cluster_pays', why: 'A block symbol spanning several cells breaks the orthogonal group counting cluster pays depends on.' }],
		trademark: null,
		recipe: 'colossal',
	},
	split_symbol: {
		id: 'split_symbol',
		name: 'Split symbol',
		family: 'symbol',
		rule:
			'A symbol splits every other symbol it touches into two, doubling the effective ways count ' +
			'per split reel. A very cheap route to enormous ways counts without variable reel heights.',
		status: 'roadmap',
		difficulty: 'T2',
		winTypes: ['ways'],
		volatility: ['extreme'],
		art: {
			symbols: 'Every symbol needs a half-height variant.',
			states: ['idle', 'split'],
			animations: ['the split itself, per symbol'],
			screens: [],
			note: 'Art cost is a half-height export of EVERY symbol, like the book mechanic.',
		},
		frontend: { bookEvents: ['symbolSplit'], components: [] },
		math: { sample: null, notes: 'Ways counting already multiplies per-reel counts, so a split reel is a count change, not an engine change.' },
		combinesWith: ['ways_pays', 'freespins'],
		conflictsWith: [{ id: 'cluster_pays', why: 'Splitting a cell breaks the regular lattice orthogonal group counting depends on.' }],
		trademark: { name: 'xSplit', owner: 'Nolimit City', note: 'Mechanic buildable; name is not ours.' },
		recipe: null,
	},
	paying_scatter: {
		id: 'paying_scatter',
		name: 'Paying scatter',
		family: 'symbol',
		rule: 'The trigger scatter also awards an instant prize when it lands in sufficient numbers.',
		status: 'config',
		difficulty: 'T0',
		winTypes: ['lines', 'ways', 'cluster', 'scatter'],
		volatility: ['medium', 'high'],
		art: { symbols: [], states: ['win'], animations: ['scatter pay reveal'], screens: [] },
		frontend: { bookEvents: [], components: [] },
		math: { sample: null, notes: 'A paytable row on the scatter symbol.' },
		combinesWith: ['freespins'],
		conflictsWith: [],
		trademark: null,
		recipe: null,
	},
	blocker_cell: {
		id: 'blocker_cell',
		name: 'Blocker cells',
		family: 'symbol',
		rule: 'Inert cells that pay nothing and are removable only by an adjacent win, opening space as the round goes.',
		status: 'roadmap',
		difficulty: 'T1',
		winTypes: ['cluster', 'scatter'],
		volatility: ['high'],
		art: {
			symbols: 'A blocker that reads as an obstacle, not a symbol.',
			states: ['idle', 'crack', 'destroy'],
			animations: ['damage stages', 'destruction'],
			screens: [],
		},
		frontend: { bookEvents: ['blockerDestroyed'], components: [] },
		math: { sample: null, notes: 'A non-paying symbol plus an adjacency check in the disposal step.' },
		combinesWith: ['cluster_pays', 'tumble'],
		conflictsWith: [],
		trademark: null,
		recipe: null,
		note: 'Delays the payoff, raising volatility.',
	},
	charge_meter: {
		id: 'charge_meter',
		name: 'Charge meter',
		family: 'symbol',
		rule:
			'A meter fills from qualifying wins and fires escalating board-wide effects at thresholds. ' +
			'Resets at round end, so it holds no cross-round state.',
		status: 'roadmap',
		difficulty: 'T2',
		winTypes: ['cluster', 'scatter'],
		volatility: ['high'],
		art: {
			symbols: [],
			states: [],
			animations: ['meter fill', 'a distinct discharge effect per threshold'],
			screens: ['a charge meter with visible thresholds'],
		},
		frontend: { bookEvents: ['chargeUpdate', 'chargeFire'], components: ['ChargeMeter'] },
		math: { sample: null, notes: 'Round-scoped counter in the gamestate; effects are board post-processors.' },
		combinesWith: ['cluster_pays', 'tumble', 'wild_spawner', 'symbol_transform'],
		conflictsWith: [],
		trademark: null,
		recipe: null,
		note: 'Gives the round a second progress axis the player plays toward, with no cross-round state — ' +
			'which is what keeps it compatible with a stateless RGS.',
	},
	symbol_collect: {
		id: 'symbol_collect',
		name: 'Symbol collection',
		family: 'symbol',
		rule: 'Collecting N instances of a symbol within the round awards a feature or a prize.',
		status: 'roadmap',
		difficulty: 'T1',
		winTypes: ['cluster', 'scatter', 'lines', 'ways'],
		volatility: ['low', 'medium'],
		art: {
			symbols: 'A collectible token.',
			states: ['idle', 'collect'],
			animations: ['fly-to-meter'],
			screens: ['a collection meter'],
		},
		frontend: { bookEvents: ['collectUpdate'], components: [] },
		math: { sample: null, notes: 'Round-scoped counter.' },
		combinesWith: ['freespins', 'cluster_pays'],
		conflictsWith: [],
		trademark: null,
		recipe: null,
	},
	persistent_symbol: {
		id: 'persistent_symbol',
		name: 'Persistent symbol',
		family: 'symbol',
		rule: 'A symbol that survives cascades or spins within a round while everything around it is replaced.',
		status: 'roadmap',
		difficulty: 'T2',
		winTypes: ['cluster', 'scatter', 'ways', 'lines'],
		volatility: ['high', 'extreme'],
		art: { symbols: [], states: ['persisted'], animations: ['persist loop'], screens: [] },
		frontend: { bookEvents: ['symbolPersist'], components: [] },
		math: {
			sample: null,
			notes:
				'The general case of the expanding-wild-on-a-cascade bug. Needs the boardLifetime ' +
				'abstraction: every board-writing mechanic declares this-evaluation, ' +
				'this-cascade-sequence, this-round or until-consumed, and disposal honours it.',
		},
		combinesWith: ['tumble', 'hold_and_win'],
		conflictsWith: [],
		trademark: null,
		recipe: null,
	},

	// ═══════════════════════════════════════════════════════════════════════
	// Bet level — nearly free, and first-class on Stake
	// ═══════════════════════════════════════════════════════════════════════
	buy_bonus: {
		id: 'buy_bonus',
		name: 'Bonus buy',
		family: 'bet',
		rule: 'Pay a multiple of the stake to enter the feature immediately.',
		status: 'built',
		difficulty: 'T0',
		winTypes: ['lines', 'ways', 'cluster', 'scatter'],
		volatility: ['medium', 'high', 'extreme'],
		art: {
			symbols: [],
			states: [],
			animations: [],
			screens: ['a buy button with its price', 'a confirmation dialog — in all 16 languages'],
		},
		frontend: { bookEvents: [], components: ['BuyBonus'] },
		math: {
			sample: 'games/0_0_lines bonus mode',
			notes:
				'Its own bet mode with its own cost and distributions. Note the cap frequency is ' +
				'judged per unit STAKED, so a 100x buy hitting its cap once in 200,000 rounds is the ' +
				'same frequency as the base mode.',
		},
		combinesWith: ['freespins', 'multi_mode_feature'],
		conflictsWith: [],
		trademark: null,
		recipe: null,
	},
	tiered_buy_menu: {
		id: 'tiered_buy_menu',
		name: 'Tiered buy menu',
		family: 'bet',
		rule: 'Several priced entry points, each configuring the feature differently.',
		status: 'roadmap',
		difficulty: 'T0',
		winTypes: ['lines', 'ways', 'cluster', 'scatter'],
		volatility: ['high', 'extreme'],
		art: { symbols: [], states: [], animations: [], screens: ['a buy menu, one panel per tier, in all 16 languages'] },
		frontend: { bookEvents: [], components: ['BuyMenu'] },
		math: { sample: null, notes: 'One bet mode per tier. No engine work — every mode must land within 0.5pp of base RTP.' },
		combinesWith: ['buy_bonus', 'multi_mode_feature'],
		conflictsWith: [],
		trademark: null,
		recipe: null,
	},
	ante_bet: {
		id: 'ante_bet',
		name: 'Ante bet',
		family: 'bet',
		rule: 'Pay roughly 1.25x the stake for roughly double the feature trigger frequency.',
		status: 'roadmap',
		difficulty: 'T0',
		winTypes: ['lines', 'ways', 'cluster', 'scatter'],
		volatility: ['medium', 'high'],
		art: { symbols: [], states: [], animations: [], screens: ['an ante toggle, in all 16 languages'] },
		frontend: { bookEvents: [], components: ['AnteToggle'] },
		math: { sample: null, notes: 'A bet mode with a richer scatter strip and a cost multiplier. Must hold the same RTP.' },
		combinesWith: ['freespins'],
		conflictsWith: [],
		trademark: null,
		recipe: null,
	},
	wincap: {
		id: 'wincap',
		name: 'Win cap',
		family: 'bet',
		rule:
			'A ceiling on what one round can pay. Also re-bands the win-level presentation tiers, so ' +
			'raising it changes which banner a given win shows.',
		status: 'built',
		difficulty: 'T0',
		winTypes: ['lines', 'ways', 'cluster', 'scatter'],
		volatility: ['low', 'medium', 'high', 'extreme'],
		art: { symbols: [], states: [], animations: ['max win celebration'], screens: ['a max-win banner, in all 16 languages'] },
		frontend: { bookEvents: ['wincapTriggered'], components: [] },
		math: {
			sample: 'every sample',
			notes:
				'Max-win rounds are MANUFACTURED, not sampled: force_wincap re-rolls until the round ' +
				'pays the cap, and the optimiser then weights them down. The frequency is chosen — ' +
				'hit_rate = max_win / rtp_allocated.',
		},
		combinesWith: ['*'],
		conflictsWith: [
			{ id: 'multiplier_composition', why: 'A compounding tail that routinely exceeds the cap makes it silently truncate RTP.' },
		],
		trademark: null,
		recipe: 'wincap',
	},
	both_ways: {
		id: 'both_ways',
		name: 'Pays both ways',
		family: 'bet',
		rule:
			'Lines pay from the leftmost reel AND from the rightmost. Costs no engine change: a ' +
			'right-to-left win on a pattern IS a left-to-right win on that pattern reversed, so the ' +
			'mirrored patterns are simply appended to the payline table. How much it is worth depends ' +
			'entirely on how asymmetric the existing line set is — see math.notes before treating it ' +
			'as a hit-rate lever.',
		status: 'built',
		difficulty: 'T1',
		// Lines only. ways.py counts matching symbols per reel from reel 0 and has
		// no payline table to mirror — both-ways ways needs engine work, so the
		// entry does not claim it.
		winTypes: ['lines'],
		// NOT 'low' — see math.notes. On a symmetric line set this adds EV without
		// adding hit rate, which is a volatility increase once RTP is held.
		volatility: ['low', 'medium'],
		art: { symbols: [], states: [], animations: ['a win line drawn in either direction'], screens: [] },
		frontend: { bookEvents: [], components: [] },
		math: {
			sample: null,
			notes:
				'Set `game.paysBothWays: true`. effectivePaylines() appends each mirrored pattern that ' +
				'is not ALREADY in the table — both self-symmetric patterns and mirror PAIRS are ' +
				'skipped, or the line pays its win twice and RTP inflates with nothing in the report ' +
				'to show it. On DEFAULT_20_LINES only 2 mirrors are new (10 patterns are ' +
				'self-symmetric, 8 more form 4 pairs already present), so the table goes to 22, not 30. ' +
				'\n\nDO NOT ASSUME THIS IS A HIT-RATE LEVER. It is usually reputed to be one and on the ' +
				'default line set it measurably is not: a win needs 3 matching symbols FROM REEL 0, and ' +
				'both new mirrors share their 3-reel prefix with a line already in the table, so the ' +
				'original wins on exactly the same boards. Measured over 40,000 seeded spins against ' +
				'one strip set: ZERO spins won only on a mirror, hit rate x1.000, EV x1.100 — the extra ' +
				'money is entirely 4- and 5-of-a-kind top-ups on wins that were already paying. Hold ' +
				'RTP by scaling the paytable down and you have the same hit rate with the extra value ' +
				'concentrated on longer combinations, which nudges volatility UP, not down. loadSpec ' +
				'warns when every mirror shares a prefix like this. A line set that genuinely leans one ' +
				'direction is the case where both-ways does buy hit rate; the symmetric fan is not.',
		},
		generator: 'generators.effectivePaylines (spec.game.paysBothWays)',
		combinesWith: ['lines_pays', 'expanding_wild', 'respin'],
		conflictsWith: [
			{
				id: 'ways_pays',
				why: 'ways.py counts matching symbols per reel starting from reel 0 and has no payline table to mirror, so there is nothing for this generator to append to.',
			},
		],
		trademark: null,
		recipe: null,
	},

	// ═══════════════════════════════════════════════════════════════════════
	// Blocked — recorded so nobody scopes them by accident
	// ═══════════════════════════════════════════════════════════════════════
	megaways: {
		id: 'megaways',
		name: 'Variable reel heights',
		family: 'blocked',
		rule: 'Each reel draws a random number of rows every spin, so the ways count changes spin to spin.',
		status: 'blocked',
		difficulty: 'T3',
		winTypes: ['ways'],
		volatility: ['high', 'extreme'],
		art: {
			symbols: 'Symbols must read at every row height the reel can take — typically 2 to 7.',
			states: ['idle', 'win'],
			animations: [],
			screens: ['a ways counter'],
			note: 'Each symbol needs to work at several aspect ratios, which is a real multiplier on art cost.',
		},
		frontend: { bookEvents: ['reelHeights'], components: [] },
		math: {
			sample: null,
			notes:
				'BLOCKED TWICE OVER. num_rows is a static array read at board creation ' +
				'(board.py:26,41,89), so this needs engine work in BOTH SDKs. And Big Time Gaming ' +
				'holds a US PATENT on Megaways, not merely a trademark — this is the one item where ' +
				'the underlying mechanic itself may be unavailable. Legal review before any ' +
				'engineering. This is not legal advice.',
		},
		combinesWith: ['tumble', 'ways_pays'],
		conflictsWith: [{ id: 'cluster_pays', why: 'Cluster adjacency needs a regular lattice, which variable reel heights do not provide.' }],
		trademark: {
			name: 'Megaways / Megaclusters / Megaquads / Megapays',
			owner: 'Big Time Gaming',
			note: 'US PATENT, not just a trademark. The mechanic itself may be blocked.',
		},
		recipe: null,
	},
	infinity_reels: {
		id: 'infinity_reels',
		name: 'Reels added while wins continue',
		family: 'blocked',
		rule: 'Each win adds a reel to the right, extending the board until a spin fails to win.',
		status: 'blocked',
		difficulty: 'T3',
		winTypes: ['ways'],
		volatility: ['extreme'],
		art: {
			symbols: [],
			states: [],
			animations: ['the board reflowing as it widens'],
			screens: ['background art that works at every width'],
		},
		frontend: { bookEvents: ['reelAdded'], components: [] },
		math: { sample: null, notes: 'Same static-board limitation as variable heights, on the other axis.' },
		combinesWith: ['progressive_global_multiplier'],
		conflictsWith: [],
		trademark: { name: 'Infinity Reels', owner: 'ReelPlay', note: 'Trademarked name.' },
		recipe: null,
	},
	xways: {
		id: 'xways',
		name: 'Symbol revealing a variable stack',
		family: 'blocked',
		rule: 'A special symbol reveals as a stack of 2 to 12 of one type, changing the ways count that spin.',
		status: 'blocked',
		difficulty: 'T3',
		winTypes: ['ways'],
		volatility: ['extreme'],
		art: { symbols: 'Stack covers at every height the reveal can take.', states: ['reveal'], animations: ['stack reveal'], screens: [] },
		frontend: { bookEvents: ['xwaysReveal'], components: [] },
		math: { sample: null, notes: 'Needs a variable board — the same static num_rows limitation.' },
		combinesWith: ['ways_pays'],
		conflictsWith: [],
		trademark: { name: 'xWays', owner: 'Nolimit City', note: 'Trademarked name.' },
		recipe: null,
	},
	xbomb: {
		id: 'xbomb',
		name: 'Bomb symbol raising a multiplier',
		family: 'multiplier',
		rule: 'A bomb symbol destroys its neighbours and raises the round multiplier — a wild and a multiplier trigger in one.',
		status: 'roadmap',
		difficulty: 'T1',
		winTypes: ['ways', 'cluster'],
		volatility: ['extreme'],
		art: {
			symbols: 'A bomb symbol.',
			states: ['idle', 'detonate'],
			animations: ['detonation affecting neighbouring cells', 'multiplier step'],
			screens: [],
		},
		frontend: { bookEvents: ['bombDetonate'], components: [] },
		math: { sample: null, notes: 'Board post-processor plus the existing global multiplier hook. Buildable today.' },
		combinesWith: ['tumble', 'progressive_global_multiplier', 'ways_pays', 'cluster_pays'],
		conflictsWith: [],
		trademark: { name: 'xBomb', owner: 'Nolimit City', note: 'The mechanic is buildable; the name is not ours.' },
		recipe: null,
	},
	xnudge: {
		id: 'xnudge',
		name: 'Nudging wild raising a multiplier',
		family: 'multiplier',
		rule: 'An oversized wild nudges fully into view, adding +1 to the round multiplier per row nudged.',
		status: 'roadmap',
		difficulty: 'T2',
		winTypes: ['ways', 'lines'],
		volatility: ['extreme'],
		art: {
			symbols: 'An oversized wild spanning several rows.',
			states: ['idle', 'nudge'],
			animations: ['nudge, one row at a time, each with a multiplier tick'],
			screens: [],
		},
		frontend: { bookEvents: ['wildNudge'], components: [] },
		math: { sample: null, notes: 'Reel-position manipulation plus the global multiplier hook.' },
		combinesWith: ['ways_pays', 'progressive_global_multiplier'],
		conflictsWith: [{ id: 'tumble', why: 'Nudging assumes a stable reel position, and the cascade rewrites reel positions on every drop.' }],
		trademark: { name: 'xNudge', owner: 'Nolimit City', note: 'Mechanic buildable; name is not ours.' },
		recipe: null,
	},
	xsplit: {
		id: 'xsplit',
		name: 'Splitting symbol',
		family: 'symbol',
		rule: 'See split_symbol — recorded here so the trademarked name resolves to the generic mechanic.',
		status: 'roadmap',
		difficulty: 'T2',
		winTypes: ['ways'],
		volatility: ['extreme'],
		art: { symbols: [], states: [], animations: [], screens: [] },
		frontend: { bookEvents: [], components: [] },
		math: { sample: null, notes: 'Alias of split_symbol.' },
		combinesWith: ['ways_pays'],
		conflictsWith: [],
		trademark: { name: 'xSplit', owner: 'Nolimit City', note: 'Use split_symbol.' },
		recipe: null,
		aliasOf: 'split_symbol',
	},

	// ═══════════════════════════════════════════════════════════════════════
	// Deliberately not building
	// ═══════════════════════════════════════════════════════════════════════
	network_jackpot: {
		id: 'network_jackpot',
		name: 'Network progressive jackpot',
		family: 'excluded',
		rule: 'A prize pool accumulating across players and games.',
		status: 'blocked',
		difficulty: 'T3',
		winTypes: [],
		volatility: ['extreme'],
		art: { symbols: [], states: [], animations: [], screens: [] },
		frontend: { bookEvents: [], components: [] },
		math: {
			sample: null,
			notes:
				'Needs cross-player state. The books plus lookup-table contract has nowhere to hold ' +
				'it — a Stake Engine round is stateless, and every meter must live inside one round.',
		},
		combinesWith: [],
		conflictsWith: [],
		trademark: null,
		recipe: null,
	},
	gamble: {
		id: 'gamble',
		name: 'Gamble / double-up',
		family: 'excluded',
		rule: 'Stake a win on a coin flip or card draw to double it.',
		status: 'blocked',
		difficulty: 'T2',
		winTypes: [],
		volatility: [],
		art: { symbols: [], states: [], animations: [], screens: [] },
		frontend: { bookEvents: [], components: [] },
		math: {
			sample: null,
			notes:
				'Cross-round by nature, and reportedly prohibited on Stake. CONFIRM DIRECTLY — that ' +
				'comes from secondary sources, not from documentation we hold.',
		},
		combinesWith: [],
		conflictsWith: [],
		trademark: null,
		recipe: null,
	},
};

export const MECHANIC_IDS = Object.keys(MECHANIC_LIBRARY);

export const STATUS_ORDER = ['built', 'config', 'sample', 'roadmap', 'blocked'];

/** How many are actually usable today, so the headline number is never inflated. */
export function libraryStats() {
	const byStatus = {};
	for (const id of STATUS_ORDER) byStatus[id] = 0;
	for (const m of Object.values(MECHANIC_LIBRARY)) byStatus[m.status] = (byStatus[m.status] ?? 0) + 1;
	return {
		total: MECHANIC_IDS.length,
		byStatus,
		usableToday: byStatus.built + byStatus.config,
		referenceGames: Object.keys(REFERENCE_GAMES).length,
	};
}

export function getMechanicEntry(id) {
	const entry = MECHANIC_LIBRARY[id];
	if (!entry) return null;
	return { ...entry, seenIn: gamesUsing(id) };
}

/** Mechanics that work on a given evaluator. */
export function mechanicsForWinType(winType) {
	return Object.values(MECHANIC_LIBRARY).filter((m) => m.winTypes.includes(winType));
}

/** Mechanics that serve a volatility tier. */
export function mechanicsForVolatility(tier) {
	return Object.values(MECHANIC_LIBRARY).filter((m) => m.volatility.includes(tier));
}

/** Free-text search across name, rule and family. */
export function searchMechanics(query) {
	const q = query.toLowerCase();
	return Object.values(MECHANIC_LIBRARY).filter(
		(m) =>
			m.id.includes(q) ||
			m.name.toLowerCase().includes(q) ||
			m.rule.toLowerCase().includes(q) ||
			m.family.includes(q),
	);
}

/**
 * Check a proposed set of mechanics for conflicts.
 *
 * The point of holding conflicts as data: the editor can refuse an incoherent
 * combination at spec-validation time rather than at runtime, which is where we
 * found the expanding-wild-on-a-tumbling-board bug the expensive way.
 */
export function checkCombination(ids) {
	const conflicts = [];
	const unknown = ids.filter((id) => !MECHANIC_LIBRARY[id]);
	for (const id of ids) {
		const mechanic = MECHANIC_LIBRARY[id];
		if (!mechanic) continue;
		for (const conflict of mechanic.conflictsWith) {
			if (!ids.includes(conflict.id)) continue;
			// One pairing, reported once, in a stable order.
			const key = [id, conflict.id].sort().join('+');
			if (conflicts.some((c) => c.key === key)) continue;
			conflicts.push({ key, a: id, b: conflict.id, why: conflict.why });
		}
	}
	const blocked = ids.filter((id) => MECHANIC_LIBRARY[id]?.status === 'blocked');
	const notBuilt = ids.filter((id) => {
		const s = MECHANIC_LIBRARY[id]?.status;
		return s && s !== 'built' && s !== 'config';
	});
	return { ok: conflicts.length === 0 && blocked.length === 0, conflicts, blocked, notBuilt, unknown };
}

/**
 * Everything the art team must produce for a chosen set of mechanics.
 *
 * This is the join that makes the library worth having for THIS studio: pick
 * mechanics, get the asset list. `forge brief` builds on it.
 */
export function artRequirementsFor(ids) {
	const symbols = [];
	const states = new Set();
	const animations = new Set();
	const screens = new Set();
	const notes = [];
	for (const id of ids) {
		const m = MECHANIC_LIBRARY[id];
		if (!m) continue;
		const art = m.art ?? {};
		if (typeof art.symbols === 'string' && art.symbols) symbols.push({ mechanic: id, requirement: art.symbols });
		for (const s of art.states ?? []) states.add(s);
		for (const a of art.animations ?? []) animations.add(`${a}  [${m.name}]`);
		for (const s of art.screens ?? []) screens.add(`${s}  [${m.name}]`);
		if (art.note) notes.push({ mechanic: id, note: art.note });
	}
	return {
		symbols,
		states: [...states],
		animations: [...animations],
		screens: [...screens],
		notes,
	};
}
