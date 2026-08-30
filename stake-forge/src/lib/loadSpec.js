import fs from 'fs-extra';
import YAML from 'yaml';
import path from 'node:path';

import { MECHANIC_IDS, getMechanic, GRID_GROWTH_MODES, GLOBAL_MULT_GROWTH_MODES } from './mechanics.js';
import { normaliseSymbol, assignOrders, sortSymbols, reachableWinSizes } from './taxonomy.js';
import { validateBehaviors } from './behaviorRecipes.js';
import { validateScreens } from './screens.js';
import { BOARD_MECHANICS } from './boardMechanics.js';
import { VOLATILITY_IDS } from './optimisation.js';
import { DEFAULT_20_LINES } from './generators.js';

// Allows a single-character name: `^[a-z][a-z0-9-]*[a-z0-9]$` required at least
// two characters, so a game called "x" was rejected as not kebab-case.
const KEBAB = /^[a-z](?:[a-z0-9-]*[a-z0-9])?$/;

export class SpecValidationError extends Error {
	constructor(errors) {
		super(`Spec validation failed:\n${errors.map((e) => ` - ${e}`).join('\n')}`);
		this.errors = errors;
	}
}

/**
 * Parse and validate a game-spec.yaml into the normalised shape every generator
 * consumes. Collects ALL problems before throwing, so one run tells you
 * everything wrong with the spec rather than one thing at a time.
 *
 * Returns the spec with `spec.symbols` normalised (role/order/special/behaviors
 * all resolved) and `spec._warnings` carrying non-fatal notes for the caller to
 * print.
 */
export function loadGameSpec(specPath) {
	const raw = fs.readFileSync(specPath, 'utf8');
	let spec;
	try {
		spec = YAML.parse(raw);
	} catch (err) {
		throw new SpecValidationError([`${path.basename(specPath)} is not valid YAML: ${err.message}`]);
	}

	const errors = [];
	const warnings = [];

	// ── game block ──────────────────────────────────────────────────────────
	if (!spec?.game?.name) {
		errors.push('game.name is required');
	} else if (!KEBAB.test(spec.game.name)) {
		errors.push(`game.name "${spec.game.name}" must be kebab-case, e.g. "le-bandit"`);
	}

	const mechanicId = spec?.game?.mechanic;
	if (!MECHANIC_IDS.includes(mechanicId)) {
		errors.push(`game.mechanic must be one of: ${MECHANIC_IDS.join(', ')}`);
	}
	const mechanic = MECHANIC_IDS.includes(mechanicId) ? getMechanic(mechanicId) : null;

	if (spec?.game?.reels) {
		const { count, rows } = spec.game.reels;
		if (!Number.isInteger(count) || count < 1) {
			errors.push('game.reels.count must be a positive integer');
		}
		if (!Array.isArray(rows) || rows.some((r) => !Number.isInteger(r) || r < 1)) {
			errors.push('game.reels.rows must be a list of positive integers, one per reel');
		} else if (Number.isInteger(count) && rows.length !== count) {
			errors.push(
				`game.reels.rows has ${rows.length} entries but game.reels.count is ${count} — ` +
					`the math-sdk indexes config.num_rows[reel], so they must match`,
			);
		}
	} else {
		errors.push('game.reels is required (count + rows)');
	}

	if (!spec?.game?.betModes || !Object.keys(spec.game.betModes).length) {
		errors.push('game.betModes must define at least one mode');
	} else {
		for (const [name, mode] of Object.entries(spec.game.betModes)) {
			// A hold-and-win round is its own game with its own loop, reel strip
			// and criteria. A bonus buy is a purchased spin of the base game that
			// forces a free-spin trigger. A mode cannot be both, and the two
			// generate contradictory distributions if it claims to be.
			if (mode?.superspin && mode?.buyBonus) {
				errors.push(
					`bet mode "${name}" is both superspin and buyBonus. A hold-and-win round is its own ` +
						`game loop, not a purchased spin of the base one — pick one.`,
				);
			}
		}
	}

	// ── multipliers ─────────────────────────────────────────────────────────
	// src/wins/multiplier_strategy.py offers exactly these three. Symbol
	// multipliers always ADD; "combined" then applies the global multiplier on
	// top, and the global one is the only uncapped lever in the engine.
	const strategy = spec?.game?.multiplierStrategy;
	if (strategy && mechanic) {
		const allowed = mechanic.multiplierStrategies ?? [];
		if (!allowed.length) {
			errors.push(
				`game.multiplierStrategy is set, but "${mechanic.id}" has no strategy parameter — its ` +
					`evaluator sums position multipliers inline and then applies the global multiplier. ` +
					`Remove it; globalMultiplierPerSpin still works.`,
			);
		} else if (!allowed.includes(strategy)) {
			errors.push(
				`game.multiplierStrategy "${strategy}" is not valid on "${mechanic.id}" — ` +
					`${mechanic.multiplierParam} accepts ${allowed.join(', ')}. ` +
					`("combined" is lines-only; "board" is ways-only, and ways ASSERTS on its list.)`,
			);
		}
	}
	// Nothing calls update_global_mult() unless we generate the call, so a spec
	// asking for a global multiplier without a feature to grow it during would
	// silently get 1x forever.
	if (spec?.game?.globalMultiplierPerSpin && !spec?.freeSpins) {
		errors.push(
			'game.globalMultiplierPerSpin needs a freeSpins block — the multiplier climbs once per free ' +
				'spin, so with no feature it never leaves 1x.',
		);
	}
	// A ways game set to "board" or "symbol" never reads the round's global
	// multiplier: ways.py picks win_multiplier from the strategy and passes THAT
	// to apply_mult, so board_mult_count (or 1) replaces it outright. A spec
	// asking for both gets a multiplier that climbs every spin and is discarded
	// on every evaluation — worth a warning, not an error, because the value is
	// still carried in the book events the frontend renders.
	if (
		spec?.game?.globalMultiplierPerSpin &&
		mechanic?.winType === 'ways' &&
		(spec.game.multiplierStrategy ?? 'symbol') !== 'global'
	) {
		warnings.push(
			`game.globalMultiplierPerSpin has no effect on a ways game using multiplierStrategy ` +
				`"${spec.game.multiplierStrategy ?? 'symbol'}" — ways.py substitutes the strategy's own ` +
				`multiplier for the global one before applying it. Use multiplierStrategy: "global" for ` +
				`the climbing multiplier to reach the win.`,
		);
	}

	// ── global multiplier growth ────────────────────────────────────────────
	if (spec?.game?.globalMultiplier) {
		const gm = spec.game.globalMultiplier;
		if (gm.growth && !GLOBAL_MULT_GROWTH_MODES.includes(gm.growth)) {
			errors.push(
				`game.globalMultiplier.growth must be one of: ${GLOBAL_MULT_GROWTH_MODES.join(', ')} ` +
					`(got "${gm.growth}").`,
			);
		}
		for (const key of ['cap', 'freegameCap']) {
			if (gm[key] !== undefined && (!Number.isFinite(gm[key]) || gm[key] < 1)) {
				errors.push(`game.globalMultiplier.${key} must be a number of at least 1.`);
			}
		}
		if (Number.isFinite(gm.cap) && Number.isFinite(gm.freegameCap) && gm.freegameCap < gm.cap) {
			warnings.push(
				`game.globalMultiplier.freegameCap (${gm.freegameCap}) is BELOW the base cap ` +
					`(${gm.cap}). The feature would ceiling lower than the base game, which is almost ` +
					`certainly backwards — Samurai Dogs Unleashed runs 64x base and 256x free.`,
			);
		}
		// The whole thing is generated as an override of update_global_mult(), and
		// nothing calls that unless the spec asks for it.
		if (!spec?.game?.globalMultiplierPerSpin) {
			warnings.push(
				'game.globalMultiplier configures how the global multiplier GROWS, but nothing ' +
					'increments it unless game.globalMultiplierPerSpin is also true — so it would sit ' +
					'at 1x forever.',
			);
		}
	}

		// A buy tier's forceScatters must be a count the game can actually award,
	// or freespin_triggers raises KeyError on the first forced round.
	for (const [name, mode] of Object.entries(spec?.game?.betModes ?? {})) {
		if (mode?.forceScatters === undefined) continue;
		if (!spec?.freeSpins) {
			errors.push(`bet mode "${name}" sets forceScatters but the game has no freeSpins block.`);
			continue;
		}
		const min = spec.freeSpins.triggerCount ?? 3;
		const max = spec.game?.reels?.count ?? 5;
		if (!Number.isInteger(mode.forceScatters) || mode.forceScatters < min || mode.forceScatters > max) {
			errors.push(
				`bet mode "${name}" forceScatters must be between the trigger count (${min}) and ` +
					`the reel count (${max}) — freespin_triggers is indexed directly by that number, ` +
					`so a count outside the table is a KeyError on the first forced round.`,
			);
		}
	}

	// ── grid multipliers ────────────────────────────────────────────────────
	// Cluster-only, because only the cluster sample carries position_multipliers
	// and its evaluate_clusters_with_grid — 0_0_lines, 0_0_ways and 0_0_scatter
	// have no such thing. Verified by grepping every shipped sample.
	if (spec?.game?.gridMultipliers) {
		const grid = spec.game.gridMultipliers;
		if (mechanic && mechanic.winType !== 'cluster') {
			errors.push(
				`game.gridMultipliers works on the cluster mechanic only — only games/0_0_cluster ` +
					`carries position_multipliers and evaluate_clusters_with_grid. "${mechanic.id}" has ` +
					`no grid to put them on.`,
			);
		}
		if (grid.growth && !GRID_GROWTH_MODES.includes(grid.growth)) {
			errors.push(
				`game.gridMultipliers.growth must be one of: ${GRID_GROWTH_MODES.join(', ')} ` +
					`(got "${grid.growth}").`,
			);
		}
		if (grid.cap !== undefined) {
			if (!Number.isFinite(grid.cap) || grid.cap < 2) {
				errors.push('game.gridMultipliers.cap must be a number of at least 2.');
			} else if (grid.growth === 'double' && grid.cap > 4096) {
				// A doubling ladder reaches its cap in log2(cap) hits, so a high cap is
				// not the gentle knob it looks like: 4096 is twelve hits on one cell.
				warnings.push(
					`game.gridMultipliers.cap of ${grid.cap} with growth "double" is reached in ` +
						`${Math.ceil(Math.log2(grid.cap))} hits on a single cell. The shipped sample caps at ` +
						`512, and doubling makes the top of the ladder far more reachable than incrementing ` +
						`does — check math:balance before trusting it.`,
				);
			}
		}
	}

	// ── pays both ways ──────────────────────────────────────────────────────
	// Lines only. ways.py counts matching symbols per reel from reel 0 and has no
	// payline table, so there is nothing to mirror; cluster and scatter have no
	// direction at all. Silently doing nothing on those would be worse than an
	// error, because the spec would read as if the game paid both ways.
	if (spec?.game?.paysBothWays) {
		if (mechanic && mechanic.winType !== 'lines') {
			errors.push(
				`game.paysBothWays works on the lines mechanic only — it is implemented by appending ` +
					`the mirrored PAYLINES, and "${mechanic.id}" has no payline table. A both-ways ways ` +
					`game needs engine work in ways.py, which the tool does not do.`,
			);
		}

		const source =
			spec.paylines === 'default_20' ? DEFAULT_20_LINES : (spec.paylines ?? DEFAULT_20_LINES);
		const patterns = Object.values(source).filter(Array.isArray);
		const present = new Set(patterns.map((rows) => rows.join(',')));
		const mirrors = [];
		for (const rows of patterns) {
			const mirrored = [...rows].reverse();
			if (!present.has(mirrored.join(','))) mirrors.push(mirrored);
		}

		if (patterns.length && mirrors.length === 0) {
			warnings.push(
				`game.paysBothWays adds no paylines to this set — every pattern is either its own ` +
					`mirror or is already paired with its mirror, so the game pays both ways already ` +
					`and the flag changes nothing.`,
			);
		} else if (mirrors.length) {
			// The claim "both ways raises the hit rate" is only true when a mirror can
			// win on a spin no original line wins. A win needs `minKind` matching
			// symbols FROM REEL 0, so a mirror whose first `minKind` rows match some
			// existing line's first `minKind` rows can never win alone — the original
			// wins on exactly the same boards. Measured on DEFAULT_20_LINES: both
			// mirrors share their 3-reel prefix, and across 40,000 spins ZERO spins won
			// only on a mirror. Hit rate moved x1.000; EV moved x1.100, purely from
			// topping up wins that were already there.
			const minKind = Math.min(
				...(spec.symbols ?? [])
					.filter((sym) => sym?.paytable)
					.flatMap((sym) => Object.keys(sym.paytable).map(Number)),
			);
			if (Number.isFinite(minKind) && minKind > 0) {
				const prefixes = new Set(patterns.map((rows) => rows.slice(0, minKind).join(',')));
				const standalone = mirrors.filter(
					(rows) => !prefixes.has(rows.slice(0, minKind).join(',')),
				);
				if (standalone.length === 0) {
					warnings.push(
						`game.paysBothWays adds ${mirrors.length} payline(s), but every one of them shares ` +
							`its first ${minKind} reels with a line already in the table — so a mirror can ` +
							`only ever top up a win that was already paying, never create a new winning ` +
							`spin. Expect RTP to rise roughly in proportion to the line count and the HIT ` +
							`RATE not to move at all. If you turned this on as a low-volatility lever it ` +
							`will not act as one on this line set; a set that leans one direction will.`,
					);
				}
			}
		}
	}

	// Optional, and only read when generating the optimisation setup — but worth
	// catching a typo here rather than at optimise time, which is the slowest
	// step in the whole pipeline to fail in.
	if (spec?.game?.volatility && !VOLATILITY_IDS.includes(spec.game.volatility)) {
		errors.push(
			`game.volatility must be one of: ${VOLATILITY_IDS.join(', ')} (got "${spec.game.volatility}")`,
		);
	}

	// ── symbols ─────────────────────────────────────────────────────────────
	let symbols = [];
	if (!Array.isArray(spec?.symbols) || spec.symbols.length === 0) {
		errors.push('symbols[] must have at least one entry');
	} else {
		symbols = spec.symbols.map((s) => normaliseSymbol(s, { errors, warnings })).filter(Boolean);

		const names = new Set();
		for (const s of symbols) {
			if (names.has(s.name)) errors.push(`duplicate symbol name "${s.name}"`);
			names.add(s.name);
		}

		assignOrders(symbols, { errors });
		if (mechanic) {
			for (const s of symbols) {
				validateBehaviors(s, {
					mechanic: mechanic.id,
					errors,
					warnings,
					betModes: spec?.game?.betModes,
				});
			}
		}

		// Some sample apps reference a symbol by name in their own components, so
		// a game cloned from them must declare it too.
		for (const required of mechanic?.requiredSymbols ?? []) {
			const found = symbols.find((s) => s.name === required.name);
			if (!found) {
				errors.push(
					`mechanic "${mechanic.id}" requires a symbol named "${required.name}". ${required.why}`,
				);
			} else {
				for (const key of required.special ?? []) {
					if (!found.special.includes(key)) {
						warnings.push(
							`symbol ${required.name}: mechanic "${mechanic.id}" normally gives it ` +
								`special: [${key}] — ${required.why}`,
						);
					}
				}
			}
		}

			// ── paytable monotonicity ────────────────────────────────────────
			// Both range evaluators GUARD their lookup — src/calculations/cluster.py:124
			// and scatter.py:63 read `if (size, symbol) in config.paytable` — so an
			// uncovered size pays NOTHING and reports nothing.
			//
			// The invariant that matters is not "every size is covered": a lines game
			// paying only for 5-of-a-kind is perfectly normal, and the guard skipping
			// a 3 is intended there. It is that a BIGGER win may never pay LESS than a
			// smaller one. A cluster of 10 on a table that stops at 5, or a 4-of-a-kind
			// between a paying 3 and a paying 5, is a win the player watches land and
			// receives zero for.
			if (mechanic && Array.isArray(spec?.game?.reels?.rows)) {
				const { min, max } = reachableWinSizes({
					mechanic,
					reels: spec.game.reels.count,
					rows: spec.game.reels.rows,
				});
				for (const symbol of symbols) {
					if (!symbol.paytable) continue;

					const below = Object.keys(symbol.paytable).map(Number).filter((n) => n < min);
					if (below.length) {
						errors.push(
							`symbol ${symbol.name}: paytable pays for ${below.join(', ')}, but "${mechanic.id}" ` +
								`never produces a win smaller than ${min} — those entries are unreachable.`,
						);
					}

					const gaps = [];
					let paying = false;
					for (let n = min; n <= max; n += 1) {
						if (n in symbol.paytable) paying = true;
						else if (paying) gaps.push(n);
					}
					if (gaps.length) {
						const shown = gaps.length > 8
							? `${gaps.slice(0, 6).join(', ')} … ${gaps[gaps.length - 1]}`
							: gaps.join(', ');
						errors.push(
							`symbol ${symbol.name}: size(s) ${shown} pay nothing, but a smaller size does. ` +
								`On "${mechanic.id}" the board reaches ${max}, and an uncovered size pays ZERO ` +
								`with no error — a bigger win paying less than a smaller one. ` +
								`Use a range: paytable: { "${min}": 5.0, "${min + 1}-${max}": 60.0 }.`,
						);
					}
				}
			}

		if (!symbols.some((s) => s.role === 'high')) {
			warnings.push(
				'no symbol has role "high" — the web-sdk HIGH_SYMBOLS constant will be empty, ' +
					'which is legal but usually means the roles were not filled in.',
			);
		}
	}

	// ── paylines ────────────────────────────────────────────────────────────
	if (mechanic) {
		if (spec.paylines && !mechanic.supportsPaylines) {
			warnings.push(
				`paylines are set but mechanic "${mechanic.id}" does not use them — ` +
					`apps/${mechanic.webApp}/src/game/config.ts has no paylines key. It will be ignored.`,
			);
		}
		if (!spec.paylines && mechanic.supportsPaylines) {
			errors.push(`mechanic "${mechanic.id}" requires paylines (use "default_20" or a list)`);
		}
	}

	// ── free spins ──────────────────────────────────────────────────────────
	if (spec.freeSpins) {
		const trigger = spec.freeSpins.triggerSymbol;
		if (trigger && !symbols.some((s) => s.name === trigger)) {
			errors.push(`freeSpins.triggerSymbol "${trigger}" is not in symbols[]`);
		}
		const triggerSym = symbols.find((s) => s.name === trigger);
		if (triggerSym && !triggerSym.special.includes('scatter')) {
			errors.push(
				`freeSpins.triggerSymbol "${trigger}" must carry special: [scatter] — ` +
					`the engine counts triggers via count_special_symbols(scatter_key).`,
			);
		}
	}

	// ── board mechanics ─────────────────────────────────────────────────────
	// Each declares the evaluators it is meaningful on, and a mechanic on the
	// wrong one is refused rather than generated. A wild-substitution mechanic on
	// scatter-pays would generate, run, and do nothing — the worst outcome,
	// because it looks like it works.
	for (const definition of Object.values(BOARD_MECHANICS)) {
		const raw = spec?.game?.[definition.specKey];
		if (!raw) continue;
		if (mechanic && !definition.winTypes.includes(mechanic.winType)) {
			errors.push(
				`game.${definition.specKey} ("${definition.name}") works on ` +
					`${definition.winTypes.join('/')}, not "${mechanic.winType}". ` +
					(mechanic.winType === 'scatter'
						? 'Scatter-pays counts instances anywhere with no positional requirement, so a ' +
							'substituting wild has no gap to bridge.'
						: 'It would generate and run and do nothing.'),
			);
		}
		if (definition.id === 'mystery_symbol') {
			const cover = (raw === true ? {} : raw).symbol ?? 'M';
			if (!symbols.some((sym) => sym.name === cover)) {
				errors.push(
					`game.mysterySymbols needs a symbol named "${cover}" declared in symbols: — the ` +
						`reel strips can only carry symbols the game registers, so an undeclared cover ` +
						`never lands and the mechanic silently never fires.`,
				);
			}
		}
		if (!symbols.some((sym) => sym.special.includes('wild')) &&
			['random_wild', 'guaranteed_wild_per_cascade', 'wild_spawner'].includes(definition.id)) {
			errors.push(`game.${definition.specKey} needs a symbol with special: [wild].`);
		}
	}

	// ── collector / payer roles ─────────────────────────────────────────────
	// Both act ON prize values, so both are meaningless without a prize symbol —
	// the generated code would read an attribute nothing ever sets and quietly
	// sweep nothing. And both resolve on the final hold-and-win board, so they
	// need a mode with that loop.
	const roleSymbols = symbols.filter(
		(sym) => sym.special.includes('collector') || sym.special.includes('payer'),
	);
	if (roleSymbols.length) {
		if (!symbols.some((sym) => sym.special.includes('prize'))) {
			errors.push(
				`${roleSymbols.map((s) => s.name).join(', ')} carry collector/payer, but no symbol has ` +
					`special: [prize]. Both roles act on PRIZE VALUES — without one they would sweep ` +
					`nothing and pay nothing.`,
			);
		}
		if (!Object.values(spec?.game?.betModes ?? {}).some((m) => m?.superspin)) {
			errors.push(
				`${roleSymbols.map((s) => s.name).join(', ')} carry collector/payer, which resolve on ` +
					`the FINAL board of a hold-and-win round. Add a bet mode with superspin: true.`,
			);
		}
		for (const sym of roleSymbols) {
			if (!sym.special.includes('prize')) {
				warnings.push(
					`symbol ${sym.name} is a collector/payer but has no "prize" in its special list. ` +
						`It needs a prize VALUE of its own to collect into or pay out from — ` +
						`special: [prize, ${sym.special.includes('collector') ? 'collector' : 'payer'}].`,
				);
			}
		}
	}

	// ── screens ─────────────────────────────────────────────────────────────
	if (spec.screens) {
		validateScreens(spec.screens, { mechanic, errors, warnings });
	}

	if (errors.length) throw new SpecValidationError(errors);

	spec.symbols = sortSymbols(symbols);
	spec._mechanic = mechanic;
	spec._warnings = warnings;
	spec._specPath = path.resolve(specPath);
	return spec;
}

export function loadAssetsManifest(manifestPath) {
	const raw = fs.readFileSync(manifestPath, 'utf8');
	const manifest = YAML.parse(raw);
	const baseDir = path.dirname(path.resolve(manifestPath));

	if (!manifest?.assetsSourceDir) throw new SpecValidationError(['assetsSourceDir is required']);
	manifest._resolvedSourceDir = path.resolve(baseDir, manifest.assetsSourceDir);

	if (!fs.existsSync(manifest._resolvedSourceDir)) {
		throw new SpecValidationError([`assetsSourceDir does not exist: ${manifest._resolvedSourceDir}`]);
	}

	const missing = [];
	const check = (label, relPath) => {
		if (!relPath) return;
		const p = path.join(manifest._resolvedSourceDir, relPath);
		if (!fs.existsSync(p)) missing.push(`${label}: ${relPath} (looked in ${p})`);
	};

	for (const [symbol, def] of Object.entries(manifest.spineSymbols || {})) {
		for (const field of ['atlas', 'png', 'skeleton']) {
			if (!def[field]) {
				missing.push(`${symbol}.${field}: missing from the manifest`);
				continue;
			}
			check(`${symbol}.${field}`, def[field]);
		}
		check(`${symbol}.staticSprite`, def.staticSprite);
	}
	// Flat-sprite symbols: one image for every state, optionally overridden per
	// state. This is the shape `forge art:placeholder` writes, and the shape a
	// real game uses for symbols that never animate.
	for (const [symbol, def] of Object.entries(manifest.spriteSymbols || {})) {
		if (!def?.sprite) {
			missing.push(`${symbol}.sprite: missing from the manifest`);
			continue;
		}
		check(`${symbol}.sprite`, def.sprite);
		for (const [state, file] of Object.entries(def.states || {})) {
			check(`${symbol}.states.${state}`, file);
		}
	}

	for (const [key, file] of Object.entries(manifest.sprites || {})) {
		check(`sprites.${key}`, file);
	}
	for (const [key, def] of Object.entries(manifest.screens || {})) {
		if (typeof def === 'string') {
			check(`screens.${key}`, def);
			continue;
		}
		for (const field of ['atlas', 'png', 'skeleton', 'sprite']) {
			check(`screens.${key}.${field}`, def[field]);
		}
	}

	const overlap = Object.keys(manifest.spriteSymbols || {}).filter((name) =>
		Object.prototype.hasOwnProperty.call(manifest.spineSymbols || {}, name),
	);
	if (overlap.length) {
		throw new SpecValidationError([
			`These symbols appear in BOTH spineSymbols and spriteSymbols: ${overlap.join(', ')}.`,
			'Pick one per symbol — the two would register conflicting assets under the same key.',
			'Replacing placeholder art means deleting the spriteSymbols entry as you add the spine one.',
		]);
	}

	if (missing.length) {
		throw new SpecValidationError([
			'Referenced asset files were not found:',
			...missing.map((m) => `  - ${m}`),
		]);
	}

	manifest._manifestPath = path.resolve(manifestPath);
	return manifest;
}
