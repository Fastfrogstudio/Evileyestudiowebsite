import chalk from 'chalk';

import { REFERENCE_GAMES } from '../lib/referenceGames.js';
import {
	mechanicDemand,
	opportunities,
	crowded,
	densityGrid,
	pairGaps,
} from '../lib/marketGaps.js';

const pct = (n) => `${(n * 100).toFixed(0)}%`;

/**
 * Where the market is crowded and where it is thin — crossed with what we can
 * actually build, because a gap we cannot fill is a reason and not a lead.
 */
export function market({ json = false, rareBelow = 0.1, pairs = false } = {}) {
	const demand = mechanicDemand();
	const leads = opportunities({ rareBelow });
	const busy = crowded();
	const density = densityGrid();

	if (json) {
		console.log(JSON.stringify({ demand, opportunities: leads, crowded: busy, density }, null, 2));
		return { ok: true };
	}

	const sample = Object.keys(REFERENCE_GAMES).length;
	console.log(chalk.bold(`\nThe market as we have recorded it — ${sample} games\n`));
	console.log(
		chalk.dim(
			'  A reading list, not a census. No play or revenue data sits behind any of it,\n' +
				'  so the corpus is biased toward titles that get written about. Every number\n' +
				'  below is a prompt for a decision, never evidence of demand.\n',
		),
	);

	console.log(chalk.bold('Crowded — most-used mechanics'));
	for (const m of busy.slice(0, 8)) {
		console.log(`  ${m.id.padEnd(28)} ${String(m.used).padStart(3)} games  ${pct(m.share).padStart(4)}`);
	}

	console.log(chalk.bold('\nThin, and buildable today'));
	console.log(
		chalk.dim(
			'  Excludes win types, wincap and buy menus: nobody tags those, so a zero there\n' +
				'  would mean nothing. Trademarked mechanics are excluded outright.\n',
		),
	);
	for (const m of leads) {
		const note =
			m.evidence === 'absent-from-corpus'
				? chalk.dim('no recorded game — may be our gap, not the market’s')
				: chalk.dim(`${m.used} recorded`);
		console.log(`  ${m.id.padEnd(28)} ${m.status.padEnd(7)} ${note}`);
	}

	console.log(chalk.bold('\nDensity — board type against max win'));
	const head = density.bands.map((b) => b.label.padStart(18)).join('');
	console.log(chalk.dim(`  ${''.padEnd(10)}${head}`));
	for (const w of density.winTypes) {
		const row = density.bands.map((b) => String(density.grid[w][b.id]).padStart(18)).join('');
		console.log(`  ${w.padEnd(10)}${row}`);
	}
	if (density.unrecorded) {
		console.log(chalk.dim(`  (${density.unrecorded} game(s) have no recorded cap and are not counted)`));
	}

	if (pairs) {
		const { gaps, shippable, seenPairs } = pairGaps();
		console.log(
			chalk.bold(`\nUnshipped pairings — ${gaps.length} of ${(shippable * (shippable - 1)) / 2}`),
		);
		console.log(
			chalk.dim(
				`  Both halves buildable, untrademarked, and not declared in conflict.\n` +
					`  ${seenPairs} pairings appear in the corpus. Most of the rest are unshipped\n` +
					`  because they are dull, not because nobody thought of them — this is a list\n` +
					`  to read, not a backlog.\n`,
			),
		);
		for (const g of gaps.slice(0, 20)) console.log(`  ${g.pair.join(' + ')}`);
		if (gaps.length > 20) console.log(chalk.dim(`  ... and ${gaps.length - 20} more`));
	}

	console.log(
		chalk.dim(
			'\n  Mechanics are not protectable and naming who popularised one is ordinary\n' +
				'  practice. Copying a specific game — its theme, characters, symbol set or\n' +
				'  trade dress — is a different question, and not one this file helps with.\n',
		),
	);
	return { ok: true, sample, opportunities: leads.length };
}
