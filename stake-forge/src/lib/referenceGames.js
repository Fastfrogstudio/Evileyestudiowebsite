/**
 * Reference games — the market, as data the tool can query.
 *
 * ── Why this is a module and not a document ─────────────────────────────────
 * The research behind this lived in docs/mechanics-catalogue.md, where exactly
 * nothing could read it: no command, no test, no screen in the app referenced
 * that file. Research nobody can query is research nobody uses. This is the same
 * knowledge as data, so `forge mechanics` can answer "what reaches 50,000x on a
 * cluster board, and who has shipped it" in a form the editor can also render.
 *
 * ── What is recorded, and what is deliberately NOT ──────────────────────────
 * Each entry is a plain-language description of publicly-documented game RULES,
 * plus attribution. Mechanics are not protectable and naming the title that
 * popularised one is ordinary industry practice — that is the whole content
 * here.
 *
 * What is NOT here, and must never be: any studio's assets, art, sprite sheets,
 * sound, client bundles, source, reel strips, paytables or RTP configurations.
 * None were fetched or inspected for this file and none may be added to it. The
 * boundary this studio set at the start of the project holds: we take the IDEA
 * of a mechanic in words and build it ourselves, from the engine primitives, with
 * our own art. If a client bundle or extracted asset is ever pasted into this
 * repository it must not be processed as an "inspiration" source — that is what
 * src/lib/inspirationRules.js exists to refuse.
 *
 * ── Confidence ──────────────────────────────────────────────────────────────
 * Attributions are compiled from public marketing pages, provider documentation
 * and review coverage. `maxWin` figures especially drift between jurisdictions
 * and game versions and should be treated as indicative. Spot-check anything you
 * are about to build a business case on; nothing here has been verified against
 * a provider's own certification.
 */

/**
 * Studios currently shipping on Stake Engine itself, from Stake's own
 * announcements — the direct answer to "who is actually performing on the
 * platform we are publishing to", which is a different question from "what is
 * popular in slots generally".
 *
 * Stake reports Engine-built titles at roughly $3.31bn turnover over the year to
 * mid-2026, with Jawsome (Massive), Serpentina, and Samurai Dogs Unleashed
 * (Twist) inside the platform's top 50 by total bets.
 */
export const STAKE_ENGINE_STUDIOS = [
	{ studio: 'Twist Gaming', notableTitles: ['Samurai Dogs Unleashed', 'Serpentina'] },
	{ studio: 'Massive Studios', notableTitles: ['Jawsome'] },
	{ studio: 'Titan Gaming', notableTitles: [] },
	{ studio: 'Mirror Image Gaming', notableTitles: [] },
	{ studio: 'Paperclip Gaming', notableTitles: [] },
];

/**
 * @typedef {object} ReferenceGame
 * @property {string}   id
 * @property {string}   title
 * @property {string}   studio
 * @property {string}   winType      lines | ways | cluster | scatter | hybrid
 * @property {string[]} mechanics    ids into MECHANIC_LIBRARY
 * @property {number}   [maxWin]     indicative, in multiples of bet
 * @property {string}   volatility
 * @property {string}   whyItMatters what a designer should take from it
 */

/** @type {Record<string, ReferenceGame>} */
export const REFERENCE_GAMES = {
	// ── Tumbling scatter-pays: the dominant shape of the last five years ─────
	sweet_bonanza: {
		id: 'sweet_bonanza',
		title: 'Sweet Bonanza',
		studio: 'Pragmatic Play',
		winType: 'scatter',
		mechanics: ['tumble', 'scatter_pays', 'multiplier_orbs', 'freespins', 'buy_bonus', 'ante_bet'],
		maxWin: 21100,
		volatility: 'high',
		whyItMatters:
			'The reference implementation of pay-anywhere plus tumbling. Multiplier orbs only ' +
			'appear in free spins and are SUMMED at the end of a cascade sequence, not applied per ' +
			'cascade — that single ordering choice is most of the difference between its base game ' +
			'and its feature. Still among the most played titles on Stake.',
	},
	gates_of_olympus: {
		id: 'gates_of_olympus',
		title: 'Gates of Olympus',
		studio: 'Pragmatic Play',
		winType: 'scatter',
		mechanics: ['tumble', 'scatter_pays', 'multiplier_orbs', 'freespins', 'buy_bonus', 'ante_bet'],
		maxWin: 5000,
		volatility: 'high',
		whyItMatters:
			'The same skeleton as Sweet Bonanza with a much wider orb ladder. Worth studying as a ' +
			'pair: identical mechanics, very different feel, and the difference is almost entirely ' +
			'the multiplier distribution.',
	},
	sugar_rush: {
		id: 'sugar_rush',
		title: 'Sugar Rush',
		studio: 'Pragmatic Play',
		winType: 'cluster',
		mechanics: ['tumble', 'cluster_pays', 'grid_multipliers', 'freespins', 'buy_bonus'],
		maxWin: 5000,
		volatility: 'high',
		whyItMatters:
			'Position multipliers that DOUBLE each time a win lands on the same cell. The player ' +
			'reads the board as a heat map rather than a set of symbols. math-sdk\'s own 0_0_cluster ' +
			'sample carries position multipliers already, but they INCREMENT rather than double — ' +
			'despite the sample docstring claiming otherwise. The tool now generates both modes.',
	},
	fruit_party: {
		id: 'fruit_party',
		title: 'Fruit Party',
		studio: 'Pragmatic Play',
		winType: 'cluster',
		mechanics: ['tumble', 'cluster_pays', 'random_multiplier', 'freespins'],
		maxWin: 5000,
		volatility: 'high',
		whyItMatters: 'Random multipliers dropped onto the grid rather than earned by position.',
	},
	reactoonz: {
		id: 'reactoonz',
		title: 'Reactoonz',
		studio: "Play'n GO",
		winType: 'cluster',
		mechanics: ['tumble', 'cluster_pays', 'charge_meter', 'symbol_transform', 'wild_spawner'],
		maxWin: 4570,
		volatility: 'high',
		whyItMatters:
			'A charge meter that fills from cascade wins and fires escalating board-wide effects. ' +
			'The template for "the round has a second progress axis the player is playing toward" ' +
			'without any cross-round state — everything resets at round end, which is what keeps it ' +
			'compatible with a stateless RGS.',
	},
	aloha_cluster_pays: {
		id: 'aloha_cluster_pays',
		title: 'Aloha! Cluster Pays',
		studio: 'NetEnt',
		winType: 'cluster',
		mechanics: ['tumble', 'cluster_pays', 'symbol_collect', 'sticky_wild', 'freespins'],
		maxWin: 1000,
		volatility: 'medium',
		whyItMatters: 'The title that made cluster pays mainstream. A useful low-volatility shape.',
	},
	jammin_jars: {
		id: 'jammin_jars',
		title: "Jammin' Jars",
		studio: 'Push Gaming',
		winType: 'cluster',
		mechanics: ['tumble', 'cluster_pays', 'walking_wild', 'progressive_cascade_multiplier'],
		maxWin: 20000,
		volatility: 'high',
		whyItMatters:
			'Wilds that MOVE one cell per cascade and carry a multiplier that increments every time ' +
			'they take part in a win. The multiplier lives on the wild, not the board — a different ' +
			'ownership model from Sugar Rush and worth having both.',
	},
	gonzos_quest: {
		id: 'gonzos_quest',
		title: "Gonzo's Quest",
		studio: 'NetEnt',
		winType: 'lines',
		mechanics: ['tumble', 'progressive_cascade_multiplier', 'freespins'],
		maxWin: 2500,
		volatility: 'medium',
		whyItMatters:
			'The original cascade, and the clearest example of a per-cascade multiplier ladder ' +
			'(1x, 2x, 3x, 5x). Also the counter-example to a belief worth correcting: cascading with ' +
			'PAYLINES is well established commercially even though no math-sdk sample pairs them.',
	},

	// ── Hold-and-win: the other dominant shape ───────────────────────────────
	money_train_2: {
		id: 'money_train_2',
		title: 'Money Train 2',
		studio: 'Relax Gaming',
		winType: 'lines',
		mechanics: [
			'hold_and_win',
			'special_symbol_roles',
			'collector_symbol',
			'payer_symbol',
			'persistent_symbol',
			'buy_bonus',
		],
		maxWin: 50000,
		volatility: 'extreme',
		whyItMatters:
			'The most influential hold-and-win of the modern era and still heavily played on Stake. ' +
			'Its whole design is a TAXONOMY of special symbols — collector, payer, sniper, ' +
			'necromancer, persistent — each a small rule, with the interest coming from their ' +
			'interactions. That is the cheapest known route to a 50,000x game: no new evaluator, ' +
			'just a well-chosen set of symbol roles and a fixed order of operations.',
	},
	money_train_4: {
		id: 'money_train_4',
		title: 'Money Train 4',
		studio: 'Relax Gaming',
		winType: 'lines',
		mechanics: ['hold_and_win', 'special_symbol_roles', 'collector_symbol', 'payer_symbol', 'grid_expansion', 'buy_bonus'],
		maxWin: 150000,
		volatility: 'extreme',
		whyItMatters:
			'The same skeleton pushed to 150,000x, largely by adding grid expansion during the ' +
			'respin phase and more aggressive collector interactions. Evidence that the range this ' +
			'studio wants (10,000x–100,000x) is reachable without a new win evaluator.',
	},
	big_bass_bonanza: {
		id: 'big_bass_bonanza',
		title: 'Big Bass Bonanza',
		studio: 'Reel Kingdom / Pragmatic Play',
		winType: 'lines',
		mechanics: ['collector_symbol', 'money_symbol', 'freespins', 'retrigger_upgrade', 'buy_bonus'],
		maxWin: 4000,
		volatility: 'high',
		whyItMatters:
			'A collector that sweeps money symbols during free spins, with the collector\'s ' +
			'multiplier UPGRADING on each retrigger. The most-copied feature in the market and one ' +
			'of the simplest — a single symbol role plus a retrigger-indexed multiplier.',
	},
	lightning_link: {
		id: 'lightning_link',
		title: 'Lightning Link',
		studio: 'Aristocrat',
		winType: 'lines',
		mechanics: ['hold_and_win', 'money_symbol', 'prize_tiers'],
		maxWin: 2000,
		volatility: 'medium',
		whyItMatters:
			'The origin of the resetting-respin hold-and-win, and of the Mini/Minor/Major/Grand ' +
			'prize ladder. The fixed tiers matter mathematically: they put a FLOOR under the ' +
			'feature, which is the standard way to hold a hold-and-win game at medium volatility.',
	},

	// ── Nolimit City: the mechanic-density school ────────────────────────────
	mental: {
		id: 'mental',
		title: 'Mental',
		studio: 'Nolimit City',
		winType: 'ways',
		mechanics: ['xways', 'xnudge', 'sticky_wild', 'symbol_transform', 'buy_bonus'],
		maxWin: 66666,
		volatility: 'extreme',
		whyItMatters:
			'The house style: four or five interacting mechanics on one board, each individually ' +
			'simple. Note the trademarked names — the mechanics are buildable, the names are not ours.',
	},
	fire_in_the_hole: {
		id: 'fire_in_the_hole',
		title: 'Fire in the Hole xBomb',
		studio: 'Nolimit City',
		winType: 'ways',
		mechanics: ['xbomb', 'tumble', 'grid_expansion', 'persistent_symbol', 'buy_bonus'],
		maxWin: 60000,
		volatility: 'extreme',
		whyItMatters:
			'Collapsing wins expand the grid downward while a bomb symbol raises a global ' +
			'multiplier. Two growth axes at once — grid AND multiplier — which is the standard ' +
			'recipe for the 50,000x+ band.',
	},
	san_quentin: {
		id: 'san_quentin',
		title: 'San Quentin xWays',
		studio: 'Nolimit City',
		winType: 'ways',
		mechanics: ['xways', 'xnudge', 'xsplit', 'sticky_wild'],
		maxWin: 150000,
		volatility: 'extreme',
		whyItMatters:
			'xSplit: a symbol that splits every other symbol it touches, doubling the ways count. ' +
			'A very cheap route to enormous ways counts without variable reel heights.',
	},

	// ── Hacksaw: the Stake-native school ─────────────────────────────────────
	wanted_dead_or_a_wild: {
		id: 'wanted_dead_or_a_wild',
		title: 'Wanted Dead or a Wild',
		studio: 'Hacksaw Gaming',
		winType: 'lines',
		mechanics: ['multi_mode_feature', 'sticky_wild', 'walking_wild', 'sticky_multiplier', 'buy_bonus'],
		maxWin: 12500,
		volatility: 'extreme',
		whyItMatters:
			'THREE distinct free-spin modes chosen at trigger, each with a different mechanic. One ' +
			'game, three feature identities — the cheapest way to make a title feel deep without ' +
			'building three games. Directly expressible as three bet-mode distributions.',
	},
	chaos_crew: {
		id: 'chaos_crew',
		title: 'Chaos Crew',
		studio: 'Hacksaw Gaming',
		winType: 'lines',
		mechanics: ['sticky_multiplier', 'random_multiplier', 'freespins', 'buy_bonus'],
		maxWin: 10000,
		volatility: 'high',
		whyItMatters: 'Consistently among the top Hacksaw titles on Stake. Multiplier-led, not symbol-led.',
	},
	le_bandit: {
		id: 'le_bandit',
		title: 'Le Bandit',
		studio: 'Hacksaw Gaming',
		winType: 'lines',
		mechanics: ['money_symbol', 'collector_symbol', 'sticky_multiplier', 'buy_bonus'],
		maxWin: 10000,
		volatility: 'high',
		whyItMatters:
			'Worth naming because math-sdk ships a sample called 0_0_le_bandit — the closest thing ' +
			'in the SDK to a commercial money-symbol collector, and the first place to look when ' +
			'building one.',
	},
	razor_shark: {
		id: 'razor_shark',
		title: 'Razor Shark',
		studio: 'Push Gaming',
		winType: 'ways',
		mechanics: ['mystery_stack', 'nudging_reel', 'progressive_global_multiplier', 'freespins'],
		maxWin: 50000,
		volatility: 'extreme',
		whyItMatters:
			'Mystery stacks that nudge into view and reveal as one symbol type, feeding a global ' +
			'multiplier that never resets within the round. The clearest example of an uncapped ' +
			'in-round meter — the single most effective lever for the top of the max-win range.',
	},

	// ── Classic shapes still worth having in the library ─────────────────────
	book_of_dead: {
		id: 'book_of_dead',
		title: 'Book of Dead',
		studio: "Play'n GO",
		winType: 'lines',
		mechanics: ['expanding_special_symbol', 'freespins'],
		maxWin: 5000,
		volatility: 'high',
		whyItMatters:
			'The "book" format: one symbol chosen at the start of the feature, expanding to fill its ' +
			'reel and paying as both wild and scatter. An entire sub-genre from one rule, and one of ' +
			'the cheapest features in the market to implement.',
	},
	dead_or_alive_2: {
		id: 'dead_or_alive_2',
		title: 'Dead or Alive 2',
		studio: 'NetEnt',
		winType: 'lines',
		mechanics: ['sticky_wild', 'multi_mode_feature', 'sticky_multiplier', 'freespins'],
		maxWin: 111111,
		volatility: 'extreme',
		whyItMatters:
			'Sticky wilds accumulating across a feature, with three selectable modes. Proof that ' +
			'100,000x+ is reachable on plain 5x3 PAYLINES with no exotic evaluator — the whole tail ' +
			'comes from accumulation across spins.',
	},
	starburst: {
		id: 'starburst',
		title: 'Starburst',
		studio: 'NetEnt',
		winType: 'lines',
		mechanics: ['expanding_wild', 'respin', 'both_ways'],
		maxWin: 500,
		volatility: 'low',
		whyItMatters:
			'The canonical LOW volatility design, and the studio wants that end of the range covered ' +
			'too: pays both directions, expanding wild grants a respin, no free-spin round at all. ' +
			'A useful reminder that a game does not need a feature to be commercially successful.',
	},
	bonanza: {
		id: 'bonanza',
		title: 'Bonanza',
		studio: 'Big Time Gaming',
		winType: 'ways',
		mechanics: ['megaways', 'tumble', 'progressive_cascade_multiplier', 'freespins'],
		maxWin: 12000,
		volatility: 'high',
		whyItMatters:
			'The origin of variable reel heights. Recorded here so the constraint is visible: this ' +
			'is the one mechanic in the library BLOCKED on both a patent and an engine limitation ' +
			'(num_rows is a static array in math-sdk). Do not scope it without legal review.',
	},
	jack_and_the_beanstalk: {
		id: 'jack_and_the_beanstalk',
		title: 'Jack and the Beanstalk',
		studio: 'NetEnt',
		winType: 'lines',
		mechanics: ['walking_wild', 'freespins', 'symbol_upgrade'],
		maxWin: 600,
		volatility: 'medium',
		whyItMatters: 'The reference walking wild: moves one reel per spin and grants a respin as it goes.',
	},
	mystery_museum: {
		id: 'mystery_museum',
		title: 'Mystery Museum',
		studio: 'Push Gaming',
		winType: 'lines',
		mechanics: ['mystery_symbol', 'sticky_wild', 'freespins'],
		maxWin: 10000,
		volatility: 'high',
		whyItMatters: 'Mystery symbols revealing simultaneously as one type — a strong tension beat, cheap to build.',
	},
	el_dorado_infinity_reels: {
		id: 'el_dorado_infinity_reels',
		title: 'El Dorado Infinity Reels',
		studio: 'ReelPlay',
		winType: 'ways',
		mechanics: ['infinity_reels', 'progressive_global_multiplier'],
		volatility: 'extreme',
		whyItMatters:
			'Reels ADDED to the right while wins continue. Like Megaways it needs a variable board, ' +
			'so it is blocked on the same math-sdk limitation — and the name is a ReelPlay trademark.',
	},
	big_bass_rock_and_roll: {
		id: 'big_bass_rock_and_roll',
		title: 'Big Bass Rock and Roll Enhanced',
		studio: 'Pragmatic Play',
		winType: 'lines',
		mechanics: ['collector_symbol', 'money_symbol', 'freespins', 'retrigger_upgrade'],
		maxWin: 5000,
		volatility: 'high',
		whyItMatters:
			'Named because it is currently cited among Stake\'s highest-RTP slots at 98.00% on only ' +
			'10 fixed paylines — a reminder that a high advertised RTP is a marketing lever ' +
			'available at any volatility, and that few paylines is not the same as low volatility.',
	},
};

export const REFERENCE_GAME_IDS = Object.keys(REFERENCE_GAMES);

/** Every game that uses a given mechanic. */
export function gamesUsing(mechanicId) {
	return Object.values(REFERENCE_GAMES).filter((g) => g.mechanics.includes(mechanicId));
}

/** Free-text search over titles, studios and rationale. */
export function searchGames(query) {
	const q = query.toLowerCase();
	return Object.values(REFERENCE_GAMES).filter(
		(g) =>
			g.title.toLowerCase().includes(q) ||
			g.studio.toLowerCase().includes(q) ||
			g.whyItMatters.toLowerCase().includes(q) ||
			g.mechanics.some((m) => m.includes(q)),
	);
}

/**
 * Games in a max-win band, for answering "what does a 50,000x game look like".
 * Games with no recorded maxWin are excluded rather than guessed at.
 */
export function gamesByMaxWin(min, max = Infinity) {
	return Object.values(REFERENCE_GAMES)
		.filter((g) => typeof g.maxWin === 'number' && g.maxWin >= min && g.maxWin <= max)
		.sort((a, b) => b.maxWin - a.maxWin);
}
