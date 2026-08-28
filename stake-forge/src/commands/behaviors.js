import chalk from 'chalk';
import { BEHAVIOR_RECIPES } from '../lib/behaviorRecipes.js';

/** Print the recipe registry — what is built, what needs custom code, from which sample. */
export function behaviors({ json }) {
	if (json) {
		console.log(
			JSON.stringify(
				Object.fromEntries(
					Object.entries(BEHAVIOR_RECIPES).map(([id, r]) => [
						id,
						{
							title: r.title,
							status: r.status,
							tier: r.tier,
							appliesToRoles: r.appliesToRoles,
							requiredAnimationStates: r.requiredAnimationStates,
							requiredSpecialKeys: r.requiredSpecialKeys,
							suggestedSpecialKeys: r.suggestedSpecialKeys,
							referenceSample: r.referenceSample,
							verifiedAgainst: r.verifiedAgainst,
							generatesCode: Boolean(r.emitMath || r.emitWeb),
						},
					]),
				),
				null,
				2,
			),
		);
		return { ok: true };
	}

	const groups = {
		2: Object.values(BEHAVIOR_RECIPES).filter((r) => r.tier === 2),
		3: Object.values(BEHAVIOR_RECIPES).filter((r) => r.tier === 3),
	};

	console.log(chalk.bold('\nBehavior recipes\n'));

	console.log(chalk.bold.green('Tier 2 — built in to BOTH SDKs, config only'));
	for (const r of groups[2]) {
		console.log(`  ${chalk.bold(r.id.padEnd(20))} ${r.title}`);
		console.log(`  ${' '.repeat(20)} ${chalk.dim(r.config ?? '')}`);
	}

	console.log(chalk.bold.magenta('\nTier 3 — bespoke, needs a special_symbol_functions hook + custom bookEvents'));
	for (const r of groups[3]) {
		const badge =
			r.status === 'verified'
				? chalk.green('[generated]')
				: chalk.yellow(`[${r.status}]`);
		console.log(`  ${chalk.bold(r.id.padEnd(20))} ${r.title} ${badge}`);
		console.log(
			`  ${' '.repeat(20)} ${chalk.dim(`states: ${r.requiredAnimationStates.join(', ') || '—'}`)}`,
		);
		console.log(
			`  ${' '.repeat(20)} ${chalk.dim(`sample: ${r.referenceSample.math ?? 'none in either SDK'}`)}`,
		);
	}

	console.log(
		chalk.dim(
			'\n[generated] = stake-forge writes the code, adapted from a sample it has actually run.\n' +
				'Anything else = the pattern is real and cited, but you build it by hand.\n' +
				'Run `forge behaviors --json` for the full provenance of each recipe.\n',
		),
	);
	return { ok: true };
}
