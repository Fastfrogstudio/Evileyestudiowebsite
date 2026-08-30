/**
 * Generators for the math-sdk half of a game.
 *
 * Every shape here was read off a real math-sdk checkout and then exercised by
 * instantiating GameConfig() and running GameState.run_spin() — not inferred
 * from docs. The specific facts this file depends on:
 *
 *   paytable          dict keyed by a (kind, symbol_name) TUPLE. SymbolStorage
 *                     unpacks it as `for (kind, sym), val in config.paytable.items()`
 *                     and asserts type(tup[1]) == str, so the tuple order is
 *                     (count, name) and the name must be the string.
 *   special_symbols   dict of key -> [symbol names]. See taxonomy.js for which
 *                     keys the engine gives default values to.
 *   paylines          dict of int -> [row per reel]. Only read by
 *                     src/calculations/lines.py.
 *   freespin_triggers dict of gametype -> {scatter count: spins awarded}.
 *                     Indexed directly in src/executables/executables.py as
 *                     config.freespin_triggers[self.gametype][count], so a count
 *                     that can land but is missing raises KeyError at runtime.
 *   reels             dict of strip id -> parsed CSV, loaded via read_reels_csv.
 */

import { pyLiteral, PyRaw } from './pyPatch.js';
import { sortSymbols, buildSpecialSymbols } from './taxonomy.js';

/**
 * `self.paytable` — a dict with tuple keys.
 * Emitted in role order (wilds, highs, lows) and descending kind within each
 * symbol, matching how the sample games lay theirs out so diffs stay readable.
 */
/**
 * The blank symbol a hold-and-win strip is mostly made of.
 *
 * 0_0_expwilds' SSR.csv is 460 X and 20 P, and its game_config registers
 * `(99, "X"): 0  # only included for symbol register`. That register entry is
 * not optional: Config.validate_reel_symbols() rejects any symbol on a strip
 * the game has not declared, and a kind of 99 is high enough that no real win
 * length can reach it, so it pays nothing while still existing.
 */
export const BLANK_SYMBOL = 'X';

/** Does any bet mode run a hold-and-win respin round? */
export function hasSuperspinMode(spec) {
	return Object.values(spec.game.betModes ?? {}).some((mode) => mode.superspin);
}

export function renderPaytable(spec) {
	const entries = new Map();
	for (const s of sortSymbols(spec.symbols)) {
		if (!s.paytable) continue;
		const kinds = Object.keys(s.paytable)
			.map(Number)
			.sort((a, b) => b - a);
		for (const kind of kinds) {
			entries.set(new PyRaw(`(${kind}, "${s.name}")`), s.paytable[String(kind)]);
		}
	}
	if (hasSuperspinMode(spec)) {
		entries.set(new PyRaw(`(99, "${BLANK_SYMBOL}")`), 0);
	}
	return pyLiteral(entries, 2);
}

/** `self.special_symbols` — key -> [names]. */
export function renderSpecialSymbols(spec) {
	return pyLiteral(buildSpecialSymbols(spec.symbols), 2);
}

/** `self.paylines` — int -> [row index per reel]. Lines mechanic only. */
export function renderPaylines(spec, defaultLines) {
	const source = spec.paylines === 'default_20' ? defaultLines : spec.paylines;
	const out = new Map();
	for (const [key, rows] of Object.entries(source)) {
		out.set(new PyRaw(String(Number(key))), rows);
	}
	return pyLiteral(out, 2);
}

/**
 * `self.freespin_triggers` — gametype -> {count: spins}.
 *
 * Built from the spec's freeSpins block. Every scatter count from triggerCount
 * up to the maximum that can physically land gets an entry, because
 * executables.py indexes the dict directly: a board that lands 5 scatters when
 * only 3 and 4 are configured raises KeyError mid-simulation.
 *
 * The retrigger table (freegame) uses a lower entry count, matching 0_0_lines,
 * which retriggers from 2 scatters rather than 3.
 */
export function renderFreespinTriggers(spec) {
	const fs = spec.freeSpins;
	if (!fs) return null;

	const maxScatters = spec.game.reels.count;
	const base = {};
	const step = fs.spinsPerExtraScatter ?? 2;
	for (let count = fs.triggerCount; count <= maxScatters; count += 1) {
		base[count] = fs.awardedSpins + (count - fs.triggerCount) * step;
	}

	const parts = [`self.basegame_type: ${pyLiteral(numericKeys(base), 3)}`];

	if (fs.retrigger) {
		const retriggerFrom = fs.retriggerCount ?? Math.max(2, fs.triggerCount - 1);
		const free = {};
		const retriggerSpins = fs.retriggerSpins ?? Math.ceil(fs.awardedSpins / 2);
		for (let count = retriggerFrom; count <= maxScatters; count += 1) {
			free[count] = retriggerSpins + (count - retriggerFrom) * step;
		}
		parts.push(`self.freegame_type: ${pyLiteral(numericKeys(free), 3)}`);
	}

	return `{\n            ${parts.join(',\n            ')},\n        }`;
}

/** Keys of a JS object are strings; the engine compares them against ints. */
function numericKeys(obj) {
	const out = new Map();
	for (const [k, v] of Object.entries(obj)) out.set(new PyRaw(String(Number(k))), v);
	return out;
}

/**
 * `self.anticipation_triggers` — one below the minimum free-spin trigger, which
 * is exactly what both 0_0_lines and 0_0_expwilds compute.
 */
export function renderAnticipationTriggers(spec) {
	if (!spec.freeSpins) return null;
	const parts = [
		'self.basegame_type: min(self.freespin_triggers[self.basegame_type].keys()) - 1',
	];
	if (spec.freeSpins.retrigger) {
		parts.push('self.freegame_type: min(self.freespin_triggers[self.freegame_type].keys()) - 1');
	}
	return `{\n            ${parts.join(',\n            ')},\n        }`;
}

/**
 * Strip length and scatter density, both taken from the real sample games
 * rather than picked.
 *
 * Measured across math-sdk's own BR0.csv files:
 *   games/0_0_lines     219 rows, 0.5%-2.3% scatters per reel
 *   games/0_0_ways      251 rows, 0.8%-2.4%
 *   games/0_0_expwilds  628 rows, 0.2%-1.3%
 *
 * Density is not cosmetic. At 6% every free spin re-triggers (three scatters
 * across five reels becomes the common case), `tot_fs` grows faster than `fs`,
 * and run_freespin()'s `while self.fs < self.tot_fs` never terminates — the
 * simulation hangs rather than failing. 1.4% sits mid-range of the real games,
 * with a floor of 2 per reel so force_special_board() can always place its
 * exact count.
 */
export const REEL_STRIP_LENGTH = 220;
export const SCATTER_DENSITY = 0.014;

/**
 * A placeholder reel CSV per strip.
 *
 * Same caveat as the web side: this is NOT real math. It exists so the game can
 * be simulated at all — GameConfig.read_reels_csv() runs at construction time,
 * so a game with no reel files cannot even be instantiated, let alone audited.
 * Real strips come from the math-sdk optimisation run.
 *
 * validate_reel_symbols() checks every symbol on a strip is a known symbol, so
 * the placeholder only ever emits names from the spec.
 */
export function renderReelCsv(spec, { length = REEL_STRIP_LENGTH, seed = 'BR0' } = {}) {
	const weights =
		spec.placeholderReelWeights || Object.fromEntries(spec.symbols.map((s) => [s.name, 10]));

	const scatterNames = new Set(
		spec.symbols.filter((s) => s.special.includes('scatter')).map((s) => s.name),
	);

	// A PRIZE symbol belongs only on a hold-and-win strip. 0_0_expwilds' BR0 and
	// FR0 carry no P at all, and rightly: nothing in an ordinary spin collects a
	// prize, so one landing there is a symbol that looks valuable and pays
	// nothing.
	const prizeNames = new Set(
		spec.symbols.filter((s) => s.special.includes('prize')).map((s) => s.name),
	);

	const pool = [];
	for (const [name, weight] of Object.entries(weights)) {
		if (scatterNames.has(name)) continue; // scatters are placed deliberately, below
		if (prizeNames.has(name)) continue;
		for (let i = 0; i < weight; i += 1) pool.push(name);
	}
	if (!pool.length) {
		throw new Error(
			'placeholderReelWeights produced an empty non-scatter pool — every symbol cannot be a scatter',
		);
	}

	// Deterministic per (game, strip) so re-running produces no spurious diff.
	let h = 2166136261;
	for (const ch of `${spec.game.name}:${seed}`) {
		h ^= ch.charCodeAt(0);
		h = Math.imul(h, 16777619);
	}
	const rng = () => {
		h ^= h << 13;
		h ^= h >>> 17;
		h ^= h << 5;
		return ((h >>> 0) % 100000) / 100000;
	};

	const reels = spec.game.reels.count;
	const columns = Array.from({ length: reels }, () =>
		Array.from({ length }, () => pool[Math.floor(rng() * pool.length)]),
	);

	// ── Scatters are PLACED, not rolled ──────────────────────────────────────
	// Two hard requirements from Board.force_special_board(), which loops until
	// the board holds EXACTLY the requested number of trigger symbols:
	//
	//   1. Every reel must carry at least one scatter. Rolling them from a
	//      weighted pool leaves that to chance — at a weight of 3 in ~120 over a
	//      100-row strip a reel drawing zero is entirely likely, and then the
	//      loop can never reach its target and hangs forever.
	//   2. No two scatters may fall within one reel's visible window, or two
	//      appear at once and an exact count is again unreachable. The method's
	//      own docstring says: "Ensure the reels do not have stacked scatter
	//      symbols."
	//
	// So each reel gets a fixed number of scatters at evenly spaced positions,
	// jittered within their slot to avoid a visible lattice across reels.
	const window = Math.max(...spec.game.reels.rows) + 2;
	if (scatterNames.size) {
		const perReel = Math.max(2, Math.round(length * SCATTER_DENSITY));
		const slot = Math.floor(length / perReel);
		if (slot <= window) {
			throw new Error(
				`reel strip of ${length} rows is too short to hold ${perReel} spaced scatters ` +
					`for a board ${window - 2} rows tall — raise the strip length`,
			);
		}
		const names = [...scatterNames];
		for (let reel = 0; reel < reels; reel += 1) {
			for (let n = 0; n < perReel; n += 1) {
				// Keep the jitter inside the slot so neighbours stay >= window apart.
				const jitter = Math.floor(rng() * (slot - window));
				const at = (n * slot + jitter) % length;
				columns[reel][at] = names[Math.floor(rng() * names.length)];
			}
		}
	}

	const rows = [];
	for (let i = 0; i < length; i += 1) {
		rows.push(columns.map((col) => col[i]).join(','));
	}
	return `${rows.join('\n')}\n`;
}

/** `self.num_rows` — one entry per reel. Never `[n] * self.num_reels`. */
export function renderNumRows(spec) {
	return pyLiteral(spec.game.reels.rows);
}

/**
 * The distribution criteria a bet mode simulates, in order.
 *
 * A BUY-BONUS mode gets `freegame` only. It is what the player paid for: every
 * round of a bonus buy must trigger the feature, and 0_0_lines' own bonus mode
 * has no basegame distribution for exactly that reason. Emitting one meant 90%
 * of bonus rounds were plain base-game spins — a 100x purchase that usually
 * bought nothing, and a bonus lookup table indistinguishable from the base one.
 *
 * Every other mode gets three: freegame, ZERO-WIN, and basegame.
 *
 * The zero-win one is not optional decoration. `win_criteria=0.0` makes
 * check_repeat() re-roll until the round pays exactly nothing, so the simulated
 * set contains losing rounds. Without it every round in the lookup table is a
 * winner, and the optimiser — which can only reweight rounds that exist — has
 * no way to bring the RTP down or to hit a hit-rate target at all. Measured:
 * without it the base mode optimised to 331.94% against a 96.5% target, with a
 * hit rate of 1 in 1.0.
 *
 * Unlike a wincap criteria, this one is trivially satisfiable, so it cannot
 * cause the runaway re-roll that wincap does on placeholder reels.
 *
 * Quotas follow 0_0_lines (0.1 / 0.4 / 0.5, less its 0.001 wincap). They are a
 * starting point; balancing them is a maths job, not a scaffolding job.
 */
export function betModeCriteria(mode) {
	// A SUPERSPIN mode is a hold-and-win respin round, not a spin of the base
	// game: it never triggers free spins and never draws from the base strips.
	// Its zero-win criteria carries win_criteria=0.0 like any other, and the
	// recipe's run_superspin() forces a prize-free board for it.
	if (mode.superspin) {
		return [
			{ criteria: '0', quota: 0.1, forceFreegame: false, winCriteria: 0.0, reels: 'SSR' },
			{ criteria: 'basegame', quota: 0.9, forceFreegame: false, reels: 'SSR' },
		];
	}
	// The WINCAP criteria is back.
	//
	// It was removed because check_repeat() re-rolls until the round pays EXACTLY
	// max_win, and uniform-random placeholder strips could never produce that
	// board — the simulation span forever with only a warning. Designed cap
	// strips carry wild stacks tall enough to fill a reel, so the board is
	// reachable and the loop terminates. See reelDesign.js STRIP_PROFILES.
	//
	// Its quota is tiny because its RTP allocation is tiny: the optimiser derives
	// hit_rate = max_win / rtp_allocated, so 0.1% of RTP at 5000x is 1-in-5M.
	// force_freegame is TRUE, and that is not incidental. assign_mult_property
	// gates on `gametype != basegame`, so wild multipliers only exist in the free
	// game — a base-game board tops out at the raw paytable and can never reach a
	// five-figure cap. 0_0_lines' own wincap_condition forces the free game and
	// weights the cap strip there (FR0:1, WCAP:5), which is what is copied here.
	const wincap = {
		criteria: 'wincap',
		quota: 0.001,
		forceWincap: true,
		forceFreegame: true,
		winCriteria: 'wincap',
		capReels: true,
	};

	return mode.buyBonus
		? [wincap, { criteria: 'freegame', quota: 0.999, forceFreegame: true }]
		: [
				wincap,
				{ criteria: 'freegame', quota: 0.1, forceFreegame: true },
				{ criteria: '0', quota: 0.4, forceFreegame: false, winCriteria: 0.0 },
				{ criteria: 'basegame', quota: 0.5, forceFreegame: false },
			];
}

/**
 * `self.bet_modes` — a list of BetMode objects.
 *
 * Criteria come from betModeCriteria(), so the optimisation setup and the
 * simulation cannot disagree about which criteria exist — the SDK asserts they
 * match, and a mismatch is an AssertionError before a single round is run.
 */
export function renderBetModes(spec, { conditionKeys = [], multValuesShape = 'nested' } = {}) {
	// Any Distribution with force_freegame: True MUST also carry scatter_triggers:
	// Board.draw_board() indexes it directly
	//   get_random_outcome(self.get_current_distribution_conditions()["scatter_triggers"])
	// whenever force_freegame is set and we are in the basegame. Omitting it is a
	// KeyError on the first simulated round, which is exactly what `forge verify`
	// caught the first time this generator ran.
	const scatterTriggers = renderScatterTriggers(spec);
	const lines = ['['];
	for (const [name, mode] of Object.entries(spec.game.betModes)) {
		const allConditions = [...conditionKeys];
		if (scatterTriggers) allConditions.unshift(`"scatter_triggers": ${scatterTriggers},`);
		const extraConditions = allConditions.length
			? allConditions.map((k) => `                            ${k}`).join('\n') + '\n'
			: '';
		const distributions = betModeCriteria(mode)
			.map(({ criteria, quota, forceFreegame, forceWincap, winCriteria, reels, capReels }) => {
				// The wincap round needs its OWN conditions, not the shared ones.
				//
				// evaluate_wincap fires on running_bet_win >= wincap, which
				// ACCUMULATES across the whole free-spin round — so reaching the cap
				// is about a rich ROUND, not one maximal board. 0_0_lines does two
				// things to make that happen, and both are copied here:
				//
				//   mult_values are INVERTED. Its normal freegame weights favour
				//   small multipliers ({2:60, 3:80 ... 50:5}); its wincap weights
				//   favour large ones ({2:10, 3:20 ... 10:100, 20:90, 50:50}).
				//
				//   scatter_triggers favour HIGH counts ({4:1, 5:2}), so the forced
				//   round is awarded more free spins to accumulate over.
				//
				// Without these the re-roll never reaches the cap and the simulation
				// spins forever with only a warning.
				//
				// The mult_values SHAPE must match whoever reads it, exactly as the
				// shared conditions do. 0_0_ways' game_override.py reads it FLAT;
				// everything else indexes by gametype. Hardcoding the lines shape
				// here put a dict where the ways reader expected a number and the
				// simulation died with `unsupported operand type(s) for +: int and dict`.
				const capMultValues =
					multValuesShape === 'flat'
						? '"mult_values": {1: 5, 2: 10, 3: 20, 5: 60, 10: 100, 20: 90, 50: 50},'
						: '"mult_values": {self.basegame_type: {1: 1}, self.freegame_type: {2: 10, 3: 20, 5: 60, 10: 100, 20: 90, 50: 50}},';
				const capConditions = forceWincap
					? ['"scatter_triggers": {4: 1, 5: 2},', capMultValues]
					: null;
				// A freegame distribution has to weight the free-game reel set too;
				// a basegame one must not, or the board is drawn from strips the
				// base game never uses. A superspin mode names its own strip: it
				// draws from the respin reels under the BASE gametype, because that
				// is the gametype run_superspin() runs in.
				const reelWeights = capReels
					? `{
                                self.basegame_type: {"BR0": 1},
                                self.freegame_type: {"FR0": 1, "WCAP": 5},
                            }`
					: reels
					? `{self.basegame_type: {"${reels}": 1}}`
					: forceFreegame
						? `{
                                self.basegame_type: {"BR0": 1},
                                self.freegame_type: {"FR0": 1},
                            }`
						: `{self.basegame_type: {"BR0": 1}}`;
				// win_criteria pins what the round must pay. Only the zero-win
				// distribution sets it here; a wincap one would too, and is left out
				// for the reason spelled out above the distributions.
				const win =
					winCriteria === undefined
						? ''
						: winCriteria === 'wincap'
							? `\n                        win_criteria=self.wincap,`
							: `\n                        win_criteria=${winCriteria.toFixed(1)},`;
				return `                    Distribution(
                        criteria="${criteria}",
                        quota=${quota},${win}
                        conditions={
                            "reel_weights": ${reelWeights},
${capConditions ? capConditions.map((k) => `                            ${k}`).join('\n') + '\n' : extraConditions}                            "force_wincap": ${forceWincap ? 'True' : 'False'},
                            "force_freegame": ${forceFreegame ? 'True' : 'False'},
                        },
                    ),`;
			})
			.join('\n');

		lines.push(`            BetMode(
                name="${name}",
                cost=${Number(mode.cost).toFixed(1)},
                rtp=self.rtp,
                max_win=${Number(mode.maxWin).toFixed(1)},
                auto_close_disabled=False,
                is_feature=${mode.feature ? 'True' : 'False'},
                is_buybonus=${mode.buyBonus ? 'True' : 'False'},
                distributions=[
                    # NOTE: no "wincap" distribution here, deliberately.
                    #
                    # A wincap criteria sets win_criteria = max_win, and check_repeat()
                    # re-rolls the round until final_win equals it EXACTLY. Placeholder
                    # reel strips cannot reach a 5000x round, so that loop never
                    # terminates — the SDK only warns ("High repeat count") and keeps
                    # spinning. Add one once your reels are real:
                    #
                    #   Distribution(criteria="wincap", quota=0.001,
                    #                win_criteria=self.wincap, conditions={...})
${distributions}
                ],
            ),`);
	}
	lines.push('        ]');
	return lines.join('\n');
}

/**
 * `scatter_triggers` — a weight per scatter count that a forced free-game board
 * may be built with. The counts MUST be keys of freespin_triggers[basegame],
 * because executables.py looks the awarded spin count up by exactly this number:
 *     self.tot_fs = config.freespin_triggers[self.gametype][count_special_symbols(...)]
 * A count present here but missing there is a KeyError mid-simulation.
 *
 * Weights fall off with count so the common trigger is the minimum one, matching
 * the shape 0_0_lines uses ({3: 50, 4: 20, 5: 5}).
 */
export function renderScatterTriggers(spec) {
	const fs = spec.freeSpins;
	if (!fs) return null;

	const out = new Map();
	let weight = 50;
	for (let count = fs.triggerCount; count <= spec.game.reels.count; count += 1) {
		out.set(new PyRaw(String(count)), Math.max(1, Math.round(weight)));
		weight /= 2.5;
	}
	return pyLiteral(out, 0).replace(/\n\s*/g, ' ').replace(/\{ /, '{').replace(/, \}/, '}');
}

/**
 * A placeholder HOLD-AND-WIN strip: blanks with a scattering of prize symbols.
 *
 * Not the ordinary strip generator with a different seed. A superspin board is
 * blanks plus prizes and nothing else — 0_0_expwilds' SSR.csv is 460 X to 20 P
 * — because every non-blank cell locks and pays. Putting the game's ordinary
 * symbols on it produces a board where most cells are decorative, and
 * reveal_prize_event then trips over the first one that carries no prize.
 *
 * Density matters in both directions here. Too sparse and a "basegame" round
 * lands nothing, which check_repeat() re-rolls forever; too dense and every
 * respin lands a prize, so the counter never runs down and the round never
 * ends. 1 in 24 matches the sample and leaves both loops terminating.
 */
export const SUPERSPIN_PRIZE_DENSITY = 1 / 24;

export function renderSuperspinReelCsv(spec, { length = REEL_STRIP_LENGTH, seed = 'SSR', density = SUPERSPIN_PRIZE_DENSITY } = {}) {
	const prizeSymbols = spec.symbols.filter((s) => s.special.includes('prize')).map((s) => s.name);
	if (!prizeSymbols.length) {
		throw new Error(
			'a superspin bet mode needs a symbol with special: [prize] — its strip is blanks and prizes, ' +
				'and with no prize symbol every round would pay nothing.',
		);
	}

	let h = 2166136261;
	for (const ch of `${spec.game.name}:${seed}`) {
		h ^= ch.charCodeAt(0);
		h = Math.imul(h, 16777619);
	}
	const rng = () => {
		h ^= h << 13;
		h ^= h >>> 17;
		h ^= h << 5;
		return ((h >>> 0) % 100000) / 100000;
	};

	const reels = spec.game.reels.count;
	const columns = Array.from({ length: reels }, () => Array.from({ length }, () => BLANK_SYMBOL));

	// Placed on a stride rather than rolled per cell, so every reel carries the
	// same count and a short strip cannot come out empty by chance.
	const perReel = Math.max(2, Math.round(length * density));
	for (let reel = 0; reel < reels; reel += 1) {
		const stride = Math.floor(length / perReel);
		for (let n = 0; n < perReel; n += 1) {
			const at = (n * stride + Math.floor(rng() * stride)) % length;
			columns[reel][at] = prizeSymbols[Math.floor(rng() * prizeSymbols.length)];
		}
	}

	const rows = [];
	for (let i = 0; i < length; i += 1) rows.push(columns.map((col) => col[i]).join(','));
	return `${rows.join('\n')}\n`;
}
