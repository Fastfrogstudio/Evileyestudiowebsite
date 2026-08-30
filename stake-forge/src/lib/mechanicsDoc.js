import { MECHANIC_LIBRARY, libraryStats } from './mechanicsLibrary.js';
import { REFERENCE_GAMES, STAKE_ENGINE_STUDIOS } from './referenceGames.js';

/**
 * Render docs/mechanics-library.md from the library itself.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The committed doc claimed, in its own first line, to be "generated from
 * src/lib/mechanicsLibrary.js by forge mechanics". Nothing generated it. It was
 * hand-written once and then drifted: by the time anyone checked it advertised
 * 54 mechanics and 27 reference games against a library holding 56 and 29, and
 * said 17 worked when 24 did.
 *
 * A stale count is a small error with a large consequence for this tool
 * specifically. The whole proposition is that the art team can read what is
 * available and commit to producing for it. A doc that undercounts what works
 * makes them scope around mechanics that are already built; one that overcounts
 * makes them draw for mechanics that do not exist. Both are expensive in the
 * one resource the factory is actually short of.
 *
 * So the doc is generated, and a test regenerates it and fails if the committed
 * file differs. It cannot drift again without the suite going red.
 */

/** Doc sections, in reading order, mapped to the family key each holds. */
const SECTIONS = [
	['evaluator', 'Win evaluators'],
	['round', 'Round structure'],
	['wild', 'Wilds'],
	['multiplier', 'Multipliers — the volatility dial'],
	['holdwin', 'Hold-and-win family'],
	['symbol', 'Symbol behaviour'],
	['bet', 'Bet level'],
	['blocked', 'Blocked — engine limit or licence'],
	['excluded', 'Deliberately not building'],
];

/** Markdown table cells cannot hold a raw pipe or a newline. */
const cell = (text) =>
	String(text ?? '')
		.replace(/\|/g, '\\|')
		.replace(/\s*\n\s*/g, ' ')
		.trim();

/**
 * Which reference games are indexed under a mechanic.
 *
 * The link lives on the GAME (`mechanics: [...]`), not on the mechanic, so this
 * is a reverse lookup rather than a field read. Doing it the other way would
 * mean maintaining the same relationship twice and letting the two disagree.
 */
function gamesFor(id) {
	return Object.values(REFERENCE_GAMES)
		.filter((g) => (g.mechanics ?? []).includes(id))
		.map((g) => `${g.title} (${g.studio})`);
}

function mechanicRow(m) {
	const games = gamesFor(m.id).join('; ') || '—';
	const on = (m.winTypes ?? []).join(', ') || 'any';
	return `| **${cell(m.name)}**<br>\`${m.id}\` | \`${m.status}\` ${m.difficulty} | ${cell(on)} | ${cell(games)} | ${cell(m.rule)} |`;
}

export function renderMechanicsDoc() {
	const stats = libraryStats();
	const by = stats.byStatus;
	const out = [];

	out.push('# Mechanics library — what is in it, and where each came from');
	out.push('');
	out.push(
		`Generated from \`src/lib/mechanicsLibrary.js\` by \`forge mechanics --doc\`. ` +
			`**${stats.usableToday} of ${stats.total}** work today ` +
			`(${by.built ?? 0} generate code, ${by.config ?? 0} from a spec setting); ` +
			`${by.sample ?? 0} adaptable from a shipped math-sdk sample; ` +
			`${by.roadmap ?? 0} would have to be built; ${by.blocked ?? 0} blocked. ` +
			`${stats.referenceGames} reference games indexed.`,
	);
	out.push('');
	out.push(
		'**Status** — `built` generates code today · `config` works from a spec setting · ' +
			'`sample` adaptable from a shipped math-sdk sample · `roadmap` would be built from ' +
			'primitives · `blocked` engine limit or licence.',
	);
	out.push('');
	out.push(
		'Everything here is a plain-language **rule** plus attribution. No studio\'s assets, ' +
			'bundles, source, sprite data, reel strips or RTP configuration were fetched or ' +
			'inspected. Max-win figures are indicative.',
	);
	out.push('');
	out.push(
		'*This file is generated. Edit `src/lib/mechanicsLibrary.js` and re-run ' +
			'`forge mechanics --doc`; a test fails if the two disagree.*',
	);
	out.push('');

	const seen = new Set();
	for (const [family, title] of SECTIONS) {
		const entries = Object.values(MECHANIC_LIBRARY).filter((m) => m.family === family);
		if (!entries.length) continue;
		out.push('');
		out.push(`## ${title}`);
		out.push('');
		out.push('| Mechanic | Status | Works on | From these games | What it does |');
		out.push('|---|---|---|---|---|');
		for (const m of entries) {
			out.push(mechanicRow(m));
			seen.add(m.id);
		}
		out.push('');
	}

	// A family nobody added a section for would silently vanish from the doc,
	// which is the exact failure this generator exists to stop.
	const orphans = Object.values(MECHANIC_LIBRARY).filter((m) => !seen.has(m.id));
	if (orphans.length) {
		out.push('');
		out.push('## Uncategorised');
		out.push('');
		out.push(
			`These carry a \`family\` with no section in mechanicsDoc.js — add one rather than ` +
				`leaving them here.`,
		);
		out.push('');
		out.push('| Mechanic | Status | Works on | From these games | What it does |');
		out.push('|---|---|---|---|---|');
		for (const m of orphans) out.push(mechanicRow(m));
		out.push('');
	}

	out.push('');
	out.push('## Reference games indexed');
	out.push('');
	out.push('| Game | Studio | Max win | Mechanics it is indexed under |');
	out.push('|---|---|---|---|');
	for (const g of Object.values(REFERENCE_GAMES)) {
		const win = g.maxWin ? `${g.maxWin.toLocaleString('en-GB')}x` : '—';
		out.push(
			`| ${cell(g.title)} | ${cell(g.studio)} | ${win} | ${cell((g.mechanics ?? []).join(', '))} |`,
		);
	}
	out.push('');

	if (STAKE_ENGINE_STUDIOS?.length) {
		out.push('');
		out.push('## Studios shipping on Stake Engine itself');
		out.push('');
		out.push('These ship on the Engine itself, so their titles are the closest thing to a');
		out.push('reference for what it actually supports.');
		out.push('');
		for (const s of STAKE_ENGINE_STUDIOS) {
			const titles = (s.notableTitles ?? []).join(', ');
			out.push(`- **${cell(s.studio)}**${titles ? ` — ${cell(titles)}` : ''}`);
		}
		out.push('');
	}

	return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}
