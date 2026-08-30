/**
 * Symbol taxonomy v2.
 *
 * Every field here maps onto something the Stake Engine math-sdk actually
 * reads. Verified against a real checkout, not assumed:
 *
 *  - `role`     -> drives paytable ordering + web-sdk HIGH_SYMBOLS, and implies
 *                  the engine `special_symbols` key for wild/scatter.
 *  - `special`  -> keys of `GameConfig.special_symbols`. Four of them get real
 *                  default slot values from the engine, in
 *                  src/calculations/symbol.py `Symbol.assign_default_attribute()`:
 *                      wild       -> sym.wild = True
 *                      scatter    -> sym.scatter = True
 *                      multiplier -> sym.has_multiplier = True; sym.multiplier = 1
 *                      prize      -> sym.has_prize = True;      sym.prize = 0
 *                  Any OTHER key is still legal — SymbolDefinition collects every
 *                  key into `special_flags`, and `Symbol.check_attribute()` reports
 *                  it as truthy — but the engine gives it no default value, so a
 *                  behavior recipe has to populate it. The SDK's own tests use a
 *                  "blank" key this way (tests/win_calculations/test_linespay.py).
 *  - `behaviors`-> free-form tags resolved against src/lib/behaviorRecipes.js.
 */

/** special_symbols keys the engine gives a real default slot value to. */
export const ENGINE_SPECIAL_KEYS = ['wild', 'scatter', 'multiplier', 'prize'];

/** Valid `role` values. */
export const ROLES = ['low', 'high', 'wild', 'scatter'];

/**
 * Which special_symbols key each role implies. The user's chosen semantics:
 * role is the source of truth, and an explicit `special:` overrides it entirely
 * (with a warning if the override drops the implied key, since that almost
 * always silently breaks wild substitution or free-spin triggering).
 */
const ROLE_IMPLIED_SPECIAL = {
	low: [],
	high: [],
	wild: ['wild'],
	scatter: ['scatter'],
};

/**
 * Sort rank of each role when writing the paytable out. Purely cosmetic for the
 * engine (paytable is a dict) but it keeps generated game_config.py diffable and
 * matches the ordering the sample games use: wilds first, then high, then low.
 */
const ROLE_SORT_RANK = { wild: 0, high: 1, low: 2, scatter: 3 };

/**
 * Animation states every symbol needs regardless of behavior. These are the
 * web-sdk's own SYMBOL_STATES union (apps/<mechanic>/src/game/types.ts),
 * intersected with what SYMBOL_INFO_MAP entries actually populate.
 *
 * `explosion` is only required where the board tumbles — cluster/scatter win
 * types assign explode=True to winning symbols (docs/math_docs/source_section/
 * tumble_info.md), so a lines/ways game never plays it.
 */
export const BASE_ANIMATION_STATES = ['static', 'spin', 'land', 'win', 'postWinStatic'];
export const TUMBLE_ANIMATION_STATE = 'explosion';

/**
 * States SYMBOL_INFO_MAP must carry for TypeScript, for EVERY mechanic.
 *
 * This is deliberately NOT mechanic-conditional. apps/<m>/src/game/utils.ts does
 *     SYMBOL_INFO_MAP[rawSymbol.name][state]
 * where `state: SymbolState`, and SymbolState (types.ts) is the full union
 * including 'explosion' regardless of mechanic. Omitting `explosion` from a
 * lines game's map is a TS7053 "expression of type SymbolState can't be used to
 * index..." error — which is exactly what the tsc baseline diff caught the first
 * time this generator ran against a real checkout.
 *
 * Whether the explosion ever PLAYS is a separate question — only cluster and
 * scatter set explode=True — and that is what `requiredArtStates` answers.
 */
export function typeRequiredStates() {
	return [...BASE_ANIMATION_STATES, TUMBLE_ANIMATION_STATE];
}

/**
 * States a symbol needs real ARTWORK for, which is mechanic-dependent: asking a
 * lines game to supply an explosion animation would be noise, since nothing ever
 * triggers it. Used by `forge audit`.
 *
 * Scatters do get a `win` state in the sample apps (the scatter animates on
 * trigger), so the base set applies to every role. Roles differ only in sizing
 * defaults, which live in the web-sdk constants rather than here.
 */
export function defaultAnimationStates({ mechanic }) {
	const states = [...BASE_ANIMATION_STATES];
	if (mechanicTumbles(mechanic)) states.push(TUMBLE_ANIMATION_STATE);
	return states;
}

/** cluster + scatter are the win types whose evaluators set explode=True. */
export function mechanicTumbles(mechanic) {
	return mechanic === 'cluster' || mechanic === 'scatter';
}

/**
 * Highest payout a symbol offers, used to derive `order` when it isn't given.
 * Returns -1 for symbols with no paytable (scatters), so they sort last.
 */
function topPayout(symbol) {
	if (!symbol.paytable) return -1;
	const values = Object.values(symbol.paytable).filter((v) => typeof v === 'number');
	return values.length ? Math.max(...values) : -1;
}

/**
 * Normalise one raw spec symbol into the shape every generator consumes.
 * Pushes human-readable strings onto `errors` / `warnings` rather than throwing,
 * so `loadGameSpec` can report every problem in the spec at once.
 */
export function normaliseSymbol(raw, { errors, warnings }) {
	const name = raw?.name;
	if (!name) {
		errors.push('every symbol needs a name');
		return null;
	}

	// --- role -------------------------------------------------------------
	let role = raw.role;
	if (role === undefined && raw.tier !== undefined) {
		// taxonomy v1 compatibility: `tier: high|low|special`.
		if (raw.tier === 'high' || raw.tier === 'low') {
			role = raw.tier;
		} else if (raw.tier === 'special') {
			// v1 leaned on `special:` to disambiguate wild vs scatter.
			if (raw.special?.includes('scatter')) role = 'scatter';
			else if (raw.special?.includes('wild')) role = 'wild';
		}
		if (role) {
			warnings.push(
				`symbol ${name}: \`tier: ${raw.tier}\` is taxonomy v1 — migrated to \`role: ${role}\`. ` +
					`Update the spec; \`tier\` will stop being read in a future version.`,
			);
		}
	}
	if (!role) {
		errors.push(`symbol ${name}: role is required, one of: ${ROLES.join(', ')}`);
		return null;
	}
	if (!ROLES.includes(role)) {
		errors.push(`symbol ${name}: role "${role}" is invalid, must be one of: ${ROLES.join(', ')}`);
		return null;
	}

	// --- special ----------------------------------------------------------
	const implied = ROLE_IMPLIED_SPECIAL[role];
	let special;
	if (raw.special === undefined) {
		special = [...implied];
	} else {
		if (!Array.isArray(raw.special)) {
			errors.push(`symbol ${name}: special must be a list, e.g. special: [wild, multiplier]`);
			return null;
		}
		special = [...new Set(raw.special)];
		for (const key of implied) {
			if (!special.includes(key)) {
				warnings.push(
					`symbol ${name}: role "${role}" implies special: [${key}], but the explicit ` +
						`special: [${special.join(', ')}] drops it. The engine will not treat ${name} as a ${key} ` +
						`— free-spin triggering / wild substitution will not work unless that is deliberate.`,
				);
			}
		}
		for (const key of special) {
			if (!ENGINE_SPECIAL_KEYS.includes(key)) {
				warnings.push(
					`symbol ${name}: special key "${key}" has no engine default. ` +
						`Symbol.assign_default_attribute() only initialises ${ENGINE_SPECIAL_KEYS.join('/')}; ` +
						`"${key}" will exist in special_flags (readable via check_attribute) but stays unset ` +
						`until a behavior recipe or your own game_override.py assigns it.`,
				);
			}
		}
	}

	// --- order ------------------------------------------------------------
	let order = raw.order;
	if (order !== undefined && (!Number.isInteger(order) || order < 1)) {
		errors.push(`symbol ${name}: order must be a positive integer (1 = strongest within its role)`);
		order = undefined;
	}

	// --- behaviors --------------------------------------------------------
	const behaviors = raw.behaviors === undefined ? [] : raw.behaviors;
	if (!Array.isArray(behaviors)) {
		errors.push(`symbol ${name}: behaviors must be a list, e.g. behaviors: [expanding]`);
		return null;
	}

	// --- paytable ---------------------------------------------------------
	// Two kinds of symbol pay by a route other than the paytable, and requiring
	// one of them would be requiring a payout they should not have:
	//   scatter  pays via freespin_triggers
	//   prize    carries its value as an attribute rolled on landing, which is
	//            how 0_0_expwilds' "P" works — it has no paytable entry at all
	// Everything else must pay something or it can never win.
	const paysWithoutPaytable = role === 'scatter' || special.includes('prize');
	if (!raw.paytable && !paysWithoutPaytable) {
		errors.push(`symbol ${name}: paytable is required for role "${role}"`);
	}
	// Ranges are expanded once, here, so nothing downstream has to know they exist.
	const paytable = expandPaytable(raw.paytable);
	if (raw.paytable) {
		for (const [kind, value] of Object.entries(raw.paytable)) {
			// A key is either a count ("5") or a closed range ("6-8"). cluster and
			// scatter paytables are written as ranges — 0_0_cluster declares
			// (5,5)/(6,8)/(9,12)/(13,36) — and Config.convert_range_table()
			// expands them per count, exactly as expandPaytable does above.
			if (!/^\d+$/.test(String(kind)) && !/^\d+\s*-\s*\d+$/.test(String(kind))) {
				errors.push(
					`symbol ${name}: paytable key "${kind}" must be a count ("5") or a range ("6-8")`,
				);
			}
			if (typeof value !== 'number') {
				errors.push(`symbol ${name}: paytable["${kind}"] must be a number, got ${typeof value}`);
			}
		}
	}

	return {
		name,
		role,
		order,
		label: raw.label ?? name,
		special,
		behaviors: [...new Set(behaviors)],
		paytable: paytable ?? null,
	};
}

/**
 * Fill in any `order` the spec left out, and reject duplicates. Symbols without
 * an explicit order are ranked by their top payout, descending, and slotted into
 * the gaps left by the explicit ones so both styles can be mixed in one spec.
 */
export function assignOrders(symbols, { errors }) {
	for (const role of ROLES) {
		const inRole = symbols.filter((s) => s.role === role);
		if (!inRole.length) continue;

		const taken = new Map();
		for (const s of inRole.filter((s) => s.order !== undefined)) {
			if (taken.has(s.order)) {
				errors.push(
					`symbols ${taken.get(s.order)} and ${s.name} both declare order: ${s.order} within role "${role}" — order must be unique per role`,
				);
			}
			taken.set(s.order, s.name);
		}

		const unordered = inRole.filter((s) => s.order === undefined);
		unordered.sort((a, b) => topPayout(b) - topPayout(a) || a.name.localeCompare(b.name));

		let next = 1;
		for (const s of unordered) {
			while (taken.has(next)) next += 1;
			s.order = next;
			taken.set(next, s.name);
		}
	}
	return symbols;
}

/** Stable paytable / config ordering: role rank first, then order within role. */
export function sortSymbols(symbols) {
	return [...symbols].sort(
		(a, b) => ROLE_SORT_RANK[a.role] - ROLE_SORT_RANK[b.role] || a.order - b.order,
	);
}

/** Symbols the web-sdk's HIGH_SYMBOLS constant should list, in rank order. */
export function highSymbolNames(symbols) {
	return symbols
		.filter((s) => s.role === 'high')
		.sort((a, b) => a.order - b.order)
		.map((s) => s.name);
}

/**
 * Build the engine's `special_symbols` dict: key -> [symbol names].
 * Every key any symbol declares gets an entry, so custom keys survive.
 * The four engine keys are always present (possibly empty) because
 * game_override.py and the win calculations index into them directly —
 * e.g. src/calculations/scatter.py does config.special_symbols[wild_key].
 */
export function buildSpecialSymbols(symbols) {
	const out = {};
	for (const key of ENGINE_SPECIAL_KEYS) out[key] = [];
	for (const s of sortSymbols(symbols)) {
		for (const key of s.special) {
			if (!out[key]) out[key] = [];
			out[key].push(s.name);
		}
	}
	return out;
}

/**
 * Expand a paytable that may use RANGE keys into one entry per count.
 *
 * cluster and scatter games pay by cluster SIZE, and their paytables are written
 * as ranges — 0_0_cluster declares (5,5)/(6,8)/(9,12)/(13,36), which
 * Config.convert_range_table() expands to one entry per size. A spec may
 * therefore write either form:
 *
 *     paytable: { "5": 5.0, "6-8": 12.5, "9-12": 25.0, "13-36": 60.0 }
 *
 * Expanding here rather than in the Python generator means every consumer — the
 * ceiling analysis, the audit, the art brief — sees the same fully-expanded
 * table and none of them has to understand ranges.
 */
export function expandPaytable(paytable) {
	if (!paytable) return null;
	const out = {};
	for (const [key, value] of Object.entries(paytable)) {
		const range = /^(\d+)\s*-\s*(\d+)$/.exec(String(key).trim());
		if (range) {
			const from = Number(range[1]);
			const to = Number(range[2]);
			for (let n = from; n <= to; n += 1) out[n] = value;
			continue;
		}
		const single = Number(key);
		if (Number.isFinite(single)) out[single] = value;
	}
	return out;
}

/**
 * Every winning size a board can physically produce, for coverage checking.
 *
 * lines/ways top out at the reel count — you cannot have six of a kind on five
 * reels. cluster and scatter count cells, so they top out at the whole board.
 */
export function reachableWinSizes({ mechanic, reels, rows }) {
	const min = mechanic?.minWinSize ?? 3;
	const max =
		mechanic?.paytableStyle === 'range'
			? rows.reduce((sum, r) => sum + r, 0)
			: reels;
	return { min, max };
}

/**
 * A default paytable of the right SHAPE for a mechanic.
 *
 * The shapes are taken from the shipped samples, because the four evaluators
 * count completely differently and a table of the wrong shape is silently broken
 * rather than merely unbalanced:
 *
 *   lines/ways  by "kind" — 3, 4, 5 matching from reel 1 (0_0_lines, 0_0_ways)
 *   cluster     by SIZE, as ranges — 0_0_cluster uses (5,5)(6,8)(9,12)(13,36)
 *   scatter     by SIZE, as ranges — 0_0_scatter uses (8,8)(9,10)(11,13)(14,36)
 *
 * `rank` is 0 for the top-paying symbol and rises for weaker ones, so a caller
 * can lay out a whole symbol set by index. Values follow the samples' curve:
 * roughly x2.5 per tier, with the top tier jumping harder.
 */
export function defaultPaytable({ mechanic, rank = 0, boardCells = 36 }) {
	// Each rank is worth ~55% of the one above, matching the sample spread from
	// H1 down to L5 without ever reaching zero.
	const scale = Math.pow(0.55, rank);
	const round = (n) => Math.max(0.1, Math.round(n * 10) / 10);

	if (mechanic?.paytableStyle !== 'range') {
		return {
			3: round(5 * scale),
			4: round(12.5 * scale),
			5: round(50 * scale),
		};
	}

	const min = mechanic.minWinSize;
	const top = Math.max(min + 3, boardCells);
	// Four tiers, matching the samples: exact-minimum, then three widening bands.
	const b1 = min;
	const b2 = min + 1;
	const b3 = Math.min(min + 4, top - 1);
	const b4 = Math.min(min + 8, top - 1);

	return {
		[`${b1}`]: round(5 * scale),
		[`${b2}-${b3}`]: round(12.5 * scale),
		[`${b3 + 1}-${b4}`]: round(25 * scale),
		[`${b4 + 1}-${top}`]: round(60 * scale),
	};
}
