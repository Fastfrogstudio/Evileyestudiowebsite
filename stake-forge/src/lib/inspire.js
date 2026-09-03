/**
 * Inspiration analysis — shared by `forge inspire` and the app.
 *
 * Pure: takes a plain-language feature list, returns the mapping, the inferred
 * mechanic and a draft spec. Writes nothing. Both front ends call this so the
 * CLI and the UI can never disagree about what a line means.
 *
 * ── The boundary ─────────────────────────────────────────────────────────────
 * The only accepted input is a description in words. `assertNoExtractedMaterial`
 * (inspirationRules.js) rejects anything pointing at images, archives, sprite
 * sheets, code or a client bundle, and the app surfaces that refusal rather than
 * quietly dropping the offending field.
 *
 * Naming a game you like is fine and is exactly the intended use — what you name
 * it is a note for you, not a lookup. This tool has no database of other studios'
 * games and does not try to infer mechanics from a title, because that would be
 * inventing facts. The mechanics have to come from your own description of what
 * the game DOES.
 */

import { MECHANICS } from './mechanics.js';
import { getRecipe } from './behaviorRecipes.js';
import { matchLine, INSPIRATION_RULES, assertNoExtractedMaterial } from './inspirationRules.js';

const DEFAULT_SYMBOLS = [
	{ name: 'H1', role: 'high', label: 'High 1', paytable: { 5: 20, 4: 10, 3: 5 } },
	{ name: 'H2', role: 'high', label: 'High 2', paytable: { 5: 15, 4: 5, 3: 3 } },
	{ name: 'H3', role: 'high', label: 'High 3', paytable: { 5: 10, 4: 3, 3: 2 } },
	{ name: 'H4', role: 'high', label: 'High 4', paytable: { 5: 8, 4: 2, 3: 1 } },
	{ name: 'L1', role: 'low', label: 'Low 1', paytable: { 5: 5, 4: 1, 3: 0.5 } },
	{ name: 'L2', role: 'low', label: 'Low 2', paytable: { 5: 3, 4: 0.7, 3: 0.3 } },
	{ name: 'L3', role: 'low', label: 'Low 3', paytable: { 5: 3, 4: 0.7, 3: 0.3 } },
	{ name: 'L4', role: 'low', label: 'Low 4', paytable: { 5: 2, 4: 0.5, 3: 0.2 } },
	{ name: 'L5', role: 'low', label: 'Low 5', paytable: { 5: 1, 4: 0.3, 3: 0.1 } },
	{ name: 'W', role: 'wild', label: 'Wild', paytable: { 5: 20, 4: 10, 3: 5 } },
	{ name: 'S', role: 'scatter', label: 'Scatter' },
];

function baseDraft({ name, providerName }) {
	const id = name || 'new-game';
	return {
		game: {
			name: id,
			providerName: providerName || 'your_studio',
			gameId: `0_0_${id.replace(/-/g, '_')}`,
			rtp: 0.965,
			volatility: 'medium',
			mechanic: 'lines',
			reels: { count: 5, rows: [3, 3, 3, 3, 3] },
			betModes: {
				base: { cost: 1.0, rtp: 0.965, maxWin: 5000, feature: true, buyBonus: false },
			},
		},
		paylines: 'default_20',
		symbols: DEFAULT_SYMBOLS.map((s) => ({ ...s, paytable: s.paytable ? { ...s.paytable } : undefined })),
	};
}

function deepMerge(target, source) {
	for (const [key, value] of Object.entries(source)) {
		if (value && typeof value === 'object' && !Array.isArray(value)) {
			target[key] = target[key] ?? {};
			deepMerge(target[key], value);
		} else {
			target[key] = value;
		}
	}
	return target;
}

/**
 * @param {object} input
 * @param {string[]} input.features   plain-language lines
 * @param {string} [input.name]
 * @param {string} [input.providerName]
 * @param {string[]} [input.references] games you are drawing from, by name — kept
 *   as a note on the draft, never looked up
 * @param {string} [input.raw] the original text, for the boundary check
 */
/**
 * Volatility, read from how somebody describes the game.
 *
 * Ordered most specific first and matched in that order, because the phrases
 * overlap: "very high volatility" contains "high volatility", and a
 * first-match-wins scan over a list sorted the other way answers `high` to a
 * sentence that plainly says otherwise.
 *
 * A description that says nothing about volatility leaves the field alone
 * rather than guessing — `medium` is then the default, and it is the default
 * because it was not mentioned, not because anyone chose it.
 */
const VOLATILITY_PHRASES = [
	{ id: 'extreme', pattern: /\b(extreme|insane|brutal|max(imum)?)[- ]?(volatilit|varian|swing)/i },
	{ id: 'extreme', pattern: /\bvolatilit\w*\s+(is\s+)?(extreme|insane|brutal)/i },
	{ id: 'very_high', pattern: /\b(very|super|ultra|extremely)[- ]?high[- ]?(volatilit|varian)/i },
	{ id: 'very_high', pattern: /\bvolatilit\w*\s+(is\s+)?(very|super|ultra)\s+high/i },
	{ id: 'high', pattern: /\bhigh[- ]?(volatilit|varian|swing)/i },
	{ id: 'high', pattern: /\bvolatilit\w*\s+(is\s+)?high\b/i },
	{ id: 'low', pattern: /\blow[- ]?(volatilit|varian)/i },
	{ id: 'low', pattern: /\bvolatilit\w*\s+(is\s+)?low\b/i },
	{ id: 'medium', pattern: /\b(medium|moderate|balanced)[- ]?(volatilit|varian)/i },
];

/** The tier a description asks for, or null when it does not mention one. */
export function volatilityFrom(text) {
	for (const entry of VOLATILITY_PHRASES) {
		if (entry.pattern.test(text)) return entry.id;
	}
	return null;
}

export function analyseInspiration(input) {
	assertNoExtractedMaterial(input.raw ?? JSON.stringify(input), input);

	const features = (input.features ?? []).map((f) => String(f).trim()).filter(Boolean);
	if (!features.length) {
		throw new Error('Describe at least one mechanic, in plain language.');
	}

	const draft = baseDraft(input);
	const lines = [];
	// Read across the whole description rather than per feature line: volatility
	// is a property of the game, and people state it in a sentence of its own.
	const askedVolatility = volatilityFrom(features.join(' \n '));
	if (askedVolatility) draft.game.volatility = askedVolatility;
	const winTypeVotes = new Map();
	const unmatched = [];
	const extracted = [];

	for (const text of features) {
		const rules = matchLine(text);
		if (!rules.length) {
			unmatched.push(text);
			lines.push({ text, rules: [], tier: null });
			continue;
		}
		for (const rule of rules) {
			for (const wt of rule.winTypes ?? []) {
				winTypeVotes.set(wt, (winTypeVotes.get(wt) ?? 0) + 1);
			}
			if (rule.spec) deepMerge(draft, structuredClone(rule.spec));
			for (const extractor of rule.extract ?? []) {
				const match = extractor.pattern.exec(text);
				if (match) {
					extractor.apply(draft, match);
					extracted.push(`${rule.id}: ${extractor.describe(match)}`);
				}
			}
		}
		lines.push({
			text,
			tier: Math.max(...rules.map((r) => r.tier)),
			rules: rules.map((r) => ({
				id: r.id,
				tier: r.tier,
				implies: r.implies,
				reference: r.reference,
				note: r.note ?? null,
				behavior: r.behavior ?? null,
				status: r.behavior ? (getRecipe(r.behavior)?.status ?? null) : null,
				generates: r.behavior ? Boolean(getRecipe(r.behavior)?.emitMath) : false,
			})),
		});
	}

	// ── mechanic ────────────────────────────────────────────────────────────
	const mechanic = winTypeVotes.size
		? [...winTypeVotes.entries()].sort((a, b) => b[1] - a[1])[0][0]
		: 'lines';
	const profile = MECHANICS[mechanic];
	draft.game.mechanic = mechanic;
	draft.game.reels = { ...profile.defaultReels };
	if (!profile.supportsPaylines) delete draft.paylines;

	// ── behaviors onto symbols ──────────────────────────────────────────────
	const attached = [];
	const refused = [];
	for (const { rules } of lines) {
		for (const rule of rules) {
			if (!rule.behavior && !rule.special) continue;
			const recipe = rule.behavior ? getRecipe(rule.behavior) : null;
			if (recipe && recipe.tier === 2 && !rule.role) continue;

			const target = draft.symbols.find((s) => s.role === (rule.role ?? 'wild'));
			if (!target) continue;

			if (rule.behavior && recipe && recipe.tier === 3) {
				// A behavior the chosen mechanic is not verified for must not be
				// attached — it would make the draft fail validation on save, with
				// no explanation of why.
				const blocked =
					(recipe.verifiedForMechanics && !recipe.verifiedForMechanics.includes(mechanic)) ||
					(recipe.requiresMechanic && !recipe.requiresMechanic.includes(mechanic));
				if (blocked) {
					refused.push({
						behavior: rule.behavior,
						mechanic,
						reason: recipe.verifiedForMechanics
							? `only verified on ${recipe.verifiedForMechanics.join('/')}`
							: `requires ${recipe.requiresMechanic.join(' or ')}`,
					});
					continue;
				}
				target.behaviors = [...new Set([...(target.behaviors ?? []), rule.behavior])];
				attached.push({ symbol: target.name, behavior: rule.behavior });
			}
			if (rule.special) {
				target.special = [...new Set([...(target.special ?? []), ...rule.special])];
			}
		}
	}

	// Some sample apps reference a symbol by name in their own components.
	for (const required of profile.requiredSymbols ?? []) {
		if (draft.symbols.some((s) => s.name === required.name)) continue;
		draft.symbols.push({
			name: required.name,
			role: 'low',
			label: required.name,
			special: required.special ?? [],
			paytable: { 5: 2, 4: 1, 3: 0.5 },
		});
	}

	// Rank within role, and drop paytable kinds the board can never produce.
	const counters = {};
	for (const symbol of draft.symbols) {
		counters[symbol.role] = (counters[symbol.role] ?? 0) + 1;
		symbol.order = counters[symbol.role];
		if (!symbol.paytable) continue;
		for (const kind of Object.keys(symbol.paytable)) {
			if (Number(kind) > profile.defaultReels.count) delete symbol.paytable[kind];
		}
	}

	draft.placeholderReelWeights = Object.fromEntries(
		draft.symbols.map((s) => [
			s.name,
			s.role === 'wild' ? 2 : s.role === 'scatter' ? 3 : s.role === 'high' ? 6 : 14,
		]),
	);

	// Ordered for readability, since this is written straight out as YAML.
	draft.symbols = draft.symbols.map((s) => {
		const out = { name: s.name, role: s.role, order: s.order, label: s.label };
		if (s.special?.length) out.special = s.special;
		if (s.behaviors?.length) out.behaviors = s.behaviors;
		if (s.paytable) {
			out.paytable = Object.fromEntries(
				Object.keys(s.paytable)
					.map(Number)
					.sort((a, b) => b - a)
					.map((k) => [String(k), s.paytable[k]]),
			);
		}
		return out;
	});

	const allRules = lines.flatMap((l) => l.rules);
	return {
		draft,
		lines,
		mechanic,
		mechanicProfile: {
			id: mechanic,
			mathSample: profile.mathSample,
			webApp: profile.webApp,
			winType: profile.winType,
		},
		tier2: allRules.filter((r) => r.tier === 2),
		tier3: allRules.filter((r) => r.tier === 3),
		attached,
		refused,
		unmatched,
		extracted,
		notes: [...new Set(allRules.map((r) => r.note).filter(Boolean))],
		references: (input.references ?? []).filter(Boolean),
		vocabulary: INSPIRATION_RULES.map((r) => r.id),
	};
}
