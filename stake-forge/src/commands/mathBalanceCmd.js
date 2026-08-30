import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

import { loadGameSpec } from '../lib/loadSpec.js';
import { balanceSpec, scalePaytable } from '../lib/mathBalance.js';
import { formatMultiplier as fmt } from '../lib/reelDesign.js';

/**
 * `forge math:balance` — is this paytable payable at this RTP, on this board?
 *
 * Runs before any simulation. A game that fails here will simulate for an hour
 * and then fail in the Rust optimiser with a message about pig counts; this says
 * the same thing in a second, in numbers, with the fix.
 */
export async function mathBalance({ specPath, volatility, apply = false, json = false }) {
	const spec = loadGameSpec(specPath);
	const report = balanceSpec(spec, { volatility });

	if (json) {
		console.log(JSON.stringify(report, null, 2));
		return { report, applied: false };
	}

	const heading = `${spec.game.name} — ${report.mechanic}, ${report.volatility} volatility, ` +
		`${report.geometry.count} ${report.geometry.unit}`;
	console.log(heading);
	console.log('─'.repeat(heading.length));
	console.log(`  base game should pay      ${fmt(report.target.baseEv)}x per spin (${(report.target.baseRtp * 100).toFixed(2)}% of RTP)`);
	console.log(`  as designed it pays       ${fmt(report.asDesigned.ev)}x per spin, winning 1 in ${fmt(report.asDesigned.hitRate)}`);
	console.log(`  best reel calibration     ${fmt(report.calibrated.ev)}x per spin at alpha ${report.calibrated.alpha}, winning 1 in ${fmt(report.calibrated.hitRate)}`);
	console.log(`  target hit rate           1 in ${report.target.baseHitRate}`);

	// Always shown, not only when they fail. Both of these hung a simulation
	// before they were checked, and a number you can see beats a rule you trip.
	if (report.tumbles) {
		const worst = report.cascade.reduce((a, b) => (b.hitProbability > a.hitProbability ? b : a));
		console.log(
			`  longest cascade           ${fmt(worst.expectedDrops)} drops on ${worst.strip} ` +
				`(${(worst.hitProbability * 100).toFixed(0)}% of boards win, limit ${(worst.limit * 100).toFixed(0)}%)`,
		);
	}
	if (report.retrigger) {
		console.log(
			`  retrigger expansion       ${fmt(report.retrigger.roundMultiplier)}x the ` +
				`${report.retrigger.awarded} spins awarded ` +
				`(${(report.retrigger.triggerProbability * 100).toFixed(1)}% of ${report.retrigger.strip} boards retrigger)`,
		);
	}
	console.log('');

	if (report.inBand) {
		console.log(`  OK — within ${fmt(report.ratio)}x of target, which the optimiser can reweight.`);
	} else {
		console.log(`  OUT OF BAND — ${fmt(report.ratio)}x off target.`);
	}
	for (const finding of report.findings) console.log(`  · ${finding}`);

	// Modelled without multipliers or features, and said so rather than left to
	// be inferred: a reader who takes this for the game's RTP will be wrong.
	console.log('');
	console.log('  Modelled on the base board only — no multipliers, no cascades, no free spins.');
	console.log('  The simulation is the ground truth; this is the pre-flight check.');

	let applied = false;
	if (apply && !report.inBand) {
		const scaled = scalePaytable(spec, report.paytableScale);
		writeSpecPaytable(specPath, scaled);
		applied = true;
		const after = balanceSpec(scaled, { volatility });
		console.log('');
		console.log(`  Applied x${report.paytableScale} to every payout in ${path.basename(specPath)}.`);
		console.log(`  Now models ${fmt(after.calibrated.ev)}x per spin against ${fmt(after.target.baseEv)}x — ${fmt(after.ratio)}x off, ${after.inBand ? 'in band' : 'STILL out of band'}.`);
	} else if (apply) {
		console.log('');
		console.log('  Nothing to apply — already in band.');
	}

	return { report, applied };
}

/**
 * Rewrite only the paytable values, in place.
 *
 * Re-serialising the whole document would reformat the file and lose comments,
 * which for a spec the art team hand-edits is a real cost. YAML's document API
 * edits the nodes and leaves everything else byte-identical.
 */
function writeSpecPaytable(specPath, scaled) {
	const doc = YAML.parseDocument(fs.readFileSync(specPath, 'utf8'));
	const symbols = doc.get('symbols');
	if (!symbols) throw new Error(`${specPath} has no symbols block to rescale`);

	for (const symbol of scaled.symbols) {
		if (!symbol.paytable) continue;
		const node = symbols.items.find((item) => String(item.get?.('name')) === symbol.name);
		if (!node) continue;
		const paytable = node.get('paytable');
		if (!paytable) continue;
		for (const [key, value] of Object.entries(symbol.paytable)) {
			paytable.set(key, value);
		}
	}
	fs.writeFileSync(specPath, doc.toString());
}
