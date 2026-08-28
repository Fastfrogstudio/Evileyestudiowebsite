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
export function renderReelCsv(spec, { length = 100, seed = 'BR0' } = {}) {
	const weights =
		spec.placeholderReelWeights || Object.fromEntries(spec.symbols.map((s) => [s.name, 10]));
	const pool = [];
	for (const [name, weight] of Object.entries(weights)) {
		for (let i = 0; i < weight; i += 1) pool.push(name);
	}
	if (!pool.length) throw new Error('placeholderReelWeights produced an empty symbol pool');

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

	// Scatters must not stack within one reel's visible window.
	// Board.force_special_board() loops until the board holds EXACTLY the
	// requested number of scatters, and its own docstring warns: "Ensure the
	// reels do not have stacked scatter symbols." Two scatters visible in the
	// same reel make an exact count unreachable, so that loop never terminates.
	const scatterNames = new Set(
		spec.symbols.filter((s) => s.special.includes('scatter')).map((s) => s.name),
	);
	const window = Math.max(...spec.game.reels.rows) + 2;
	const nonScatter = pool.filter((n) => !scatterNames.has(n));

	const columns = Array.from({ length: spec.game.reels.count }, () => []);
	const lastScatterAt = new Array(spec.game.reels.count).fill(-Infinity);

	for (let i = 0; i < length; i += 1) {
		for (let reel = 0; reel < spec.game.reels.count; reel += 1) {
			let pick = pool[Math.floor(rng() * pool.length)];
			if (scatterNames.has(pick)) {
				// Reject a scatter too close to the previous one on this reel,
				// including across the wrap, since reel strips are cyclic.
				const tooClose =
					i - lastScatterAt[reel] < window ||
					(length - i + (lastScatterAt[reel] === -Infinity ? length : lastScatterAt[reel])) < window;
				if (tooClose) {
					pick = nonScatter.length
						? nonScatter[Math.floor(rng() * nonScatter.length)]
						: pick;
				} else {
					lastScatterAt[reel] = i;
				}
			}
			columns[reel].push(pick);
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
 * `self.bet_modes` — a list of BetMode objects.
 *
 * Distributions are deliberately minimal: one `wincap`, one `freegame` and one
 * `basegame` criteria per mode, which is the smallest set the sample games use
 * and the smallest that lets create_books() run. Tuning the quotas and weights
 * is a math job, not a scaffolding job, so the generated block is marked TODO
 * rather than pretending to be balanced.
 */
export function renderBetModes(spec, { conditionKeys = [] } = {}) {
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
		lines.push(`            BetMode(
                name="${name}",
                cost=${Number(mode.cost).toFixed(1)},
                rtp=self.rtp,
                max_win=${Number(mode.maxWin).toFixed(1)},
                auto_close_disabled=False,
                is_feature=${mode.feature ? 'True' : 'False'},
                is_buybonus=${mode.buyBonus ? 'True' : 'False'},
                distributions=[
                    Distribution(
                        criteria="wincap",
                        quota=0.001,
                        win_criteria=${Number(mode.maxWin).toFixed(1)},
                        conditions={
                            "reel_weights": {
                                self.basegame_type: {"BR0": 1},
                                self.freegame_type: {"FR0": 1},
                            },
${extraConditions}                            "force_wincap": True,
                            "force_freegame": True,
                        },
                    ),
                    Distribution(
                        criteria="freegame",
                        quota=0.1,
                        conditions={
                            "reel_weights": {
                                self.basegame_type: {"BR0": 1},
                                self.freegame_type: {"FR0": 1},
                            },
${extraConditions}                            "force_wincap": False,
                            "force_freegame": True,
                        },
                    ),
                    Distribution(
                        criteria="basegame",
                        quota=0.9,
                        conditions={
                            "reel_weights": {self.basegame_type: {"BR0": 1}},
${extraConditions}                            "force_wincap": False,
                            "force_freegame": False,
                        },
                    ),
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
