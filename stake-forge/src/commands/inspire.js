import fs from 'fs-extra';
import path from 'node:path';
import YAML from 'yaml';
import chalk from 'chalk';

import { assertNoExtractedMaterial, matchLine, INSPIRATION_RULES } from '../lib/inspirationRules.js';
import { getRecipe } from '../lib/behaviorRecipes.js';
import { MECHANICS } from '../lib/mechanics.js';

/**
 * Turn a plain-language feature checklist into a draft game-spec.yaml plus a
 * report of what is off-the-shelf versus what needs custom code.
 *
 * The draft is explicitly a STARTING POINT: paytable values, reel weights and
 * RTP are placeholders, because none of those can be derived from a description
 * of mechanics. What the draft does get right is the taxonomy — role, order,
 * special and behaviors — and the mechanic, which is the part that is tedious
 * and error-prone to fill in by hand.
 */

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

function baseDraft(input) {
	const name = input.name ?? 'new-game';
	return {
		game: {
			name,
			providerName: input.providerName ?? 'your_studio_name',
			gameId: name.replace(/-/g, '_'),
			rtp: 0.965,
			mechanic: 'lines',
			reels: { count: 5, rows: [3, 3, 3, 3, 3] },
			betModes: {
				base: { cost: 1.0, rtp: 0.965, maxWin: 5000, feature: true, buyBonus: false },
			},
		},
		paylines: 'default_20',
		symbols: DEFAULT_SYMBOLS.map((s) => ({ ...s })),
	};
}

/** Merge a rule's `spec:` fragment into the draft without clobbering siblings. */
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

export function inspire({ inputPath, outPath, reportPath, force }) {
	const raw = fs.readFileSync(inputPath, 'utf8');
	let input;
	try {
		input = YAML.parse(raw);
	} catch (err) {
		throw new Error(`${path.basename(inputPath)} is not valid YAML: ${err.message}`);
	}

	// The boundary, enforced before anything else happens.
	assertNoExtractedMaterial(raw, input);

	const features = input.features ?? input.mechanics ?? [];
	if (!Array.isArray(features) || !features.length) {
		throw new Error(
			'inspiration.yaml needs a `features:` list of plain-language lines, e.g.\n' +
				'  features:\n' +
				'    - "sticky wilds during free spins"\n' +
				'    - "buy-bonus at 100x"',
		);
	}

	const draft = baseDraft(input);
	const lines = [];
	const winTypeVotes = new Map();
	const unmatched = [];
	const notes = [];

	for (const feature of features) {
		const text = String(feature);
		const rules = matchLine(text);
		if (!rules.length) {
			unmatched.push(text);
			lines.push({ text, rules: [] });
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
					notes.push(`${rule.id}: ${extractor.describe(match)}`);
				}
			}
		}
		lines.push({ text, rules });
	}

	// ── mechanic ────────────────────────────────────────────────────────────
	let mechanic = 'lines';
	if (winTypeVotes.size) {
		mechanic = [...winTypeVotes.entries()].sort((a, b) => b[1] - a[1])[0][0];
	}
	draft.game.mechanic = mechanic;
	const mechanicProfile = MECHANICS[mechanic];
	if (!mechanicProfile.supportsPaylines) delete draft.paylines;
	draft.game.reels = { ...mechanicProfile.defaultReels };

	// ── behaviors onto symbols ──────────────────────────────────────────────
	const attached = [];
	for (const { rules } of lines) {
		for (const rule of rules) {
			if (!rule.behavior && !rule.special) continue;
			const recipe = rule.behavior ? getRecipe(rule.behavior) : null;
			// tier-2 behaviors are game-level config, not symbol tags.
			if (recipe && recipe.tier === 2 && !rule.role) continue;

			const target = draft.symbols.find((s) => s.role === (rule.role ?? 'wild'));
			if (!target) continue;
			if (rule.behavior && recipe && recipe.tier === 3) {
				target.behaviors = [...new Set([...(target.behaviors ?? []), rule.behavior])];
				attached.push({ symbol: target.name, behavior: rule.behavior });
			}
			if (rule.special) {
				target.special = [...new Set([...(target.special ?? []), ...rule.special])];
			}
		}
	}

	// Order within role, so the draft is complete rather than half-filled.
	const counters = {};
	for (const symbol of draft.symbols) {
		counters[symbol.role] = (counters[symbol.role] ?? 0) + 1;
		symbol.order = counters[symbol.role];
	}

	// Emit each symbol with a stable, readable key order: identity first, then
	// the taxonomy fields, then the paytable. YAML.stringify preserves insertion
	// order, so this is the only place that controls how the draft reads.
	draft.symbols = draft.symbols.map((s) => {
		const out = { name: s.name, role: s.role, order: s.order, label: s.label };
		if (s.special?.length) out.special = s.special;
		if (s.behaviors?.length) out.behaviors = s.behaviors;
		if (s.paytable) {
			// Descending kind, matching how a paytable is normally read.
			out.paytable = Object.fromEntries(
				Object.keys(s.paytable)
					.map(Number)
					.sort((a, b) => b - a)
					.map((k) => [String(k), s.paytable[k]]),
			);
		}
		return out;
	});

	// ── write ───────────────────────────────────────────────────────────────
	if (fs.existsSync(outPath) && !force) {
		throw new Error(`${path.basename(outPath)} already exists. Re-run with --force to overwrite it.`);
	}

	const header =
		`# DRAFT game-spec.yaml, generated by \`forge inspire\` from a plain-language checklist.\n` +
		`#\n` +
		`# What is trustworthy here: mechanic, symbol roles, order, special keys and behaviors.\n` +
		`# What is NOT: paytable values, rtp, reel weights and maxWin are placeholders. Nothing\n` +
		`# about payout maths can be derived from a description of mechanics — that comes from a\n` +
		`# math-sdk optimisation run.\n` +
		`#\n` +
		`# Review it, then:  forge audit --spec ${path.basename(outPath)} --manifest assets-manifest.yaml\n\n`;

	fs.writeFileSync(outPath, header + YAML.stringify(draft, { lineWidth: 0 }), 'utf8');

	const report = renderReport({ input, lines, draft, mechanic, attached, unmatched, notes, outPath });
	fs.writeFileSync(reportPath, report, 'utf8');

	// ── console ─────────────────────────────────────────────────────────────
	console.log(chalk.bold(`\nInspiration intake — ${features.length} feature line(s)\n`));
	console.log(`  mechanic: ${chalk.bold(mechanic)}  ${chalk.dim(`(${mechanicProfile.mathSample} / apps/${mechanicProfile.webApp})`)}\n`);

	for (const { text, rules } of lines) {
		if (!rules.length) {
			console.log(`  ${chalk.yellow('?')} ${text}`);
			console.log(`      ${chalk.dim('no rule matched — decide this one by hand')}`);
			continue;
		}
		const worstTier = Math.max(...rules.map((r) => r.tier));
		const tag = worstTier === 2 ? chalk.green('T2') : chalk.magenta('T3');
		console.log(`  ${tag} ${text}`);
		for (const rule of rules) {
			console.log(`      ${chalk.dim(`${rule.implies} — ${rule.reference}`)}`);
		}
	}

	const t3 = lines.flatMap((l) => l.rules).filter((r) => r.tier === 3);
	console.log(
		`\n  ${chalk.green('T2')} built-in, config only · ${chalk.magenta('T3')} bespoke, needs a behavior recipe\n` +
			`  ${t3.length} bespoke item(s), ${unmatched.length} undecided\n`,
	);
	console.log(chalk.green('✓'), `wrote ${path.basename(outPath)}`);
	console.log(chalk.green('✓'), `wrote ${path.basename(reportPath)}\n`);

	return { ok: true, draft, mechanic };
}

function renderReport({ input, lines, draft, mechanic, attached, unmatched, notes, outPath }) {
	const profile = MECHANICS[mechanic];
	const out = [];

	out.push(`# Inspiration report — ${input.name ?? 'new game'}`);
	out.push('');
	out.push(
		`Generated by \`forge inspire\` from a plain-language feature checklist. ` +
			`No asset files, source, or client bundle from any other game was read to produce this.`,
	);
	out.push('');
	out.push(`**Mechanic:** \`${mechanic}\` — clone from math \`games/${profile.mathSample}\`, web \`apps/${profile.webApp}\`.`);
	out.push('');

	const tier2 = [];
	const tier3 = [];
	for (const { text, rules } of lines) {
		for (const rule of rules) {
			(rule.tier === 2 ? tier2 : tier3).push({ text, rule });
		}
	}

	out.push('## Off the shelf (tier 2 — config only)');
	out.push('');
	if (!tier2.length) out.push('_Nothing._');
	else {
		out.push('| Feature | What it maps to | Already wired in |');
		out.push('|---|---|---|');
		for (const { text, rule } of tier2) {
			out.push(`| ${text} | ${rule.implies} | ${rule.reference} |`);
		}
	}
	out.push('');

	out.push('## Needs custom code (tier 3 — bespoke)');
	out.push('');
	if (!tier3.length) out.push('_Nothing._');
	else {
		out.push('| Feature | Behavior tag | Status | Closest reference sample |');
		out.push('|---|---|---|---|');
		for (const { text, rule } of tier3) {
			const recipe = rule.behavior ? getRecipe(rule.behavior) : null;
			const status = recipe
				? recipe.status === 'verified'
					? '**generated** by `forge math:scaffold`'
					: `\`${recipe.status}\` — build by hand`
				: 'no recipe';
			out.push(`| ${text} | ${rule.behavior ? `\`${rule.behavior}\`` : '—'} | ${status} | ${rule.reference} |`);
		}
	}
	out.push('');

	if (attached.length) {
		out.push('## Behaviors attached in the draft');
		out.push('');
		for (const a of attached) out.push(`- \`${a.symbol}\` -> \`behaviors: [${a.behavior}]\``);
		out.push('');
	}

	const ruleNotes = [...new Set(lines.flatMap((l) => l.rules).map((r) => r.note).filter(Boolean))];
	if (ruleNotes.length) {
		out.push('## Things to know before you build these');
		out.push('');
		for (const note of ruleNotes) out.push(`- ${note}`);
		out.push('');
	}

	if (notes.length) {
		out.push('## Values read out of the checklist');
		out.push('');
		for (const note of notes) out.push(`- ${note}`);
		out.push('');
	}

	if (unmatched.length) {
		out.push('## Undecided — no rule matched');
		out.push('');
		out.push('These need a human decision. Either reword them using vocabulary the rules know, or');
		out.push('add a rule to `src/lib/inspirationRules.js` — after finding a real sample for it.');
		out.push('');
		for (const text of unmatched) out.push(`- ${text}`);
		out.push('');
		out.push(`Known vocabulary: ${INSPIRATION_RULES.map((r) => `\`${r.id}\``).join(', ')}.`);
		out.push('');
	}

	out.push('## What the draft does NOT contain');
	out.push('');
	out.push('- **Real paytable values.** Placeholders only.');
	out.push('- **Real RTP or reel weights.** These come from a math-sdk optimisation run.');
	out.push('- **Art direction.** Symbol labels are generic; rename them in the draft.');
	out.push('');
	out.push(`Next: review \`${path.basename(outPath)}\`, rename it to \`game-spec.yaml\`, then run \`forge audit\`.`);
	out.push('');

	return out.join('\n');
}
