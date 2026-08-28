/**
 * Game discovery and spec read/write.
 *
 * A "game" is a folder in the workspace holding a game-spec.yaml. Everything
 * else (manifest, assets-source, generated output) hangs off that, exactly as
 * it does for the CLI — so a game created in the app is a game the CLI can
 * drive, and vice versa.
 */

import fs from 'fs-extra';
import path from 'node:path';
import YAML from 'yaml';

import { loadGameSpec, SpecValidationError } from '../../src/lib/loadSpec.js';
import { MECHANICS } from '../../src/lib/mechanics.js';

const SPEC_FILE = 'game-spec.yaml';
const MANIFEST_FILE = 'assets-manifest.yaml';

/** Every game in the workspace, with just enough loaded to render a list. */
export function listGames(workspace) {
	if (!workspace || !fs.existsSync(workspace)) return [];

	const games = [];
	for (const entry of fs.readdirSync(workspace, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const dir = path.join(workspace, entry.name);
		const specPath = path.join(dir, SPEC_FILE);
		if (!fs.existsSync(specPath)) continue;

		const summary = { id: entry.name, dir, specPath };
		try {
			const spec = loadGameSpec(specPath);
			Object.assign(summary, {
				name: spec.game.name,
				mechanic: spec.game.mechanic,
				gameId: spec.game.gameId,
				rtp: spec.game.rtp,
				symbolCount: spec.symbols.length,
				behaviors: [...new Set(spec.symbols.flatMap((s) => s.behaviors))],
				warnings: spec._warnings.length,
				valid: true,
			});
		} catch (err) {
			// A game that will not parse still belongs in the list — hiding it is
			// how you end up with a folder nobody can explain.
			Object.assign(summary, {
				name: entry.name,
				valid: false,
				errors: err instanceof SpecValidationError ? err.errors : [err.message],
			});
		}
		games.push(summary);
	}
	return games.sort((a, b) => a.name.localeCompare(b.name));
}

export function gameDir(workspace, id) {
	const dir = path.join(workspace, id);
	// Refuse anything that escapes the workspace, so a crafted id cannot reach
	// arbitrary files even though this only ever listens on localhost.
	if (path.relative(workspace, dir).startsWith('..') || path.isAbsolute(path.relative(workspace, dir))) {
		throw new Error(`Invalid game id: ${id}`);
	}
	return dir;
}

/**
 * Load a game for editing.
 *
 * Returns BOTH the raw parsed YAML and the normalised spec: the editor needs
 * the raw form so it round-trips what you wrote, and the normalised form so it
 * can show derived values (resolved order, implied special keys) without
 * silently writing them back.
 */
export function readGame(workspace, id) {
	const dir = gameDir(workspace, id);
	const specPath = path.join(dir, SPEC_FILE);
	if (!fs.existsSync(specPath)) throw new Error(`No ${SPEC_FILE} in ${dir}`);

	const rawText = fs.readFileSync(specPath, 'utf8');
	const raw = YAML.parse(rawText);

	const result = { id, dir, raw, rawText, valid: true, errors: [], warnings: [], normalised: null };
	try {
		const spec = loadGameSpec(specPath);
		result.normalised = {
			symbols: spec.symbols,
			mechanic: spec._mechanic,
		};
		result.warnings = spec._warnings;
	} catch (err) {
		result.valid = false;
		result.errors = err instanceof SpecValidationError ? err.errors : [err.message];
	}

	const manifestPath = path.join(dir, MANIFEST_FILE);
	result.manifest = fs.existsSync(manifestPath)
		? YAML.parse(fs.readFileSync(manifestPath, 'utf8'))
		: null;
	result.hasManifest = Boolean(result.manifest);

	return result;
}

/**
 * Validate a spec WITHOUT writing it, so the editor can show errors as you
 * type. Writes to a scratch file because loadGameSpec reads from disk — the
 * validation rules live there and duplicating them here is exactly how the two
 * would drift apart.
 */
export function validateSpecObject(specObject, dir) {
	const scratch = path.join(dir, `.forge-validate-${process.pid}.yaml`);
	try {
		fs.writeFileSync(scratch, YAML.stringify(specObject, { lineWidth: 0 }), 'utf8');
		const spec = loadGameSpec(scratch);
		return {
			valid: true,
			errors: [],
			warnings: spec._warnings,
			normalised: { symbols: spec.symbols, mechanic: spec._mechanic },
		};
	} catch (err) {
		return {
			valid: false,
			errors: err instanceof SpecValidationError ? err.errors : [err.message],
			warnings: [],
			normalised: null,
		};
	} finally {
		fs.removeSync(scratch);
	}
}

/** Write a spec, refusing to save one that does not validate. */
export function writeGame(workspace, id, specObject, { allowInvalid = false } = {}) {
	const dir = gameDir(workspace, id);
	fs.ensureDirSync(dir);

	const check = validateSpecObject(specObject, dir);
	if (!check.valid && !allowInvalid) {
		const error = new Error('Spec did not validate');
		error.details = check.errors;
		throw error;
	}

	const header =
		`# game-spec.yaml — edited in stake-forge.\n` +
		`# This is the only description of how the game plays; both SDKs are\n` +
		`# generated from it. Safe to hand-edit — the app reads it back.\n\n`;

	fs.writeFileSync(
		path.join(dir, SPEC_FILE),
		header + YAML.stringify(specObject, { lineWidth: 0 }),
		'utf8',
	);
	return check;
}

/** Create a new game folder from a starter spec. */
export function createGame(workspace, { id, name, mechanic, providerName }) {
	if (!/^[a-z](?:[a-z0-9-]*[a-z0-9])?$/.test(id)) {
		throw new Error(`"${id}" must be kebab-case, e.g. "le-bandit"`);
	}
	fs.ensureDirSync(workspace);
	const dir = gameDir(workspace, id);
	if (fs.existsSync(path.join(dir, SPEC_FILE))) {
		throw new Error(`A game called "${id}" already exists`);
	}
	fs.ensureDirSync(path.join(dir, 'assets-source'));

	const profile = MECHANICS[mechanic];
	if (!profile) throw new Error(`Unknown mechanic "${mechanic}"`);

	const spec = starterSpec({ id, name, mechanic, providerName, profile });
	writeGame(workspace, id, spec);
	return { id, dir };
}

/**
 * A starter spec that is valid on creation, so a new game can be scaffolded and
 * previewed before you have typed anything into it.
 */
function starterSpec({ id, name, mechanic, providerName, profile }) {
	const reelCount = profile.defaultReels.count;
	const spec = {
		game: {
			name: id,
			providerName: providerName || 'your_studio',
			gameId: `0_0_${id.replace(/-/g, '_')}`,
			workingName: name || id,
			rtp: 0.965,
			mechanic,
			reels: { ...profile.defaultReels },
			betModes: {
				base: { cost: 1.0, rtp: 0.965, maxWin: 5000, feature: true, buyBonus: false },
				bonus: { cost: 100.0, rtp: 0.965, maxWin: 5000, feature: false, buyBonus: true },
			},
		},
	};

	if (profile.supportsPaylines) spec.paylines = 'default_20';

	spec.symbols = [
		{ name: 'H1', role: 'high', order: 1, label: 'High 1', paytable: { 5: 20, 4: 10, 3: 5 } },
		{ name: 'H2', role: 'high', order: 2, label: 'High 2', paytable: { 5: 15, 4: 5, 3: 3 } },
		{ name: 'H3', role: 'high', order: 3, label: 'High 3', paytable: { 5: 10, 4: 3, 3: 2 } },
		{ name: 'H4', role: 'high', order: 4, label: 'High 4', paytable: { 5: 8, 4: 2, 3: 1 } },
		{ name: 'L1', role: 'low', order: 1, label: 'Low 1', paytable: { 5: 5, 4: 1, 3: 0.5 } },
		{ name: 'L2', role: 'low', order: 2, label: 'Low 2', paytable: { 5: 3, 4: 0.7, 3: 0.3 } },
		{ name: 'L3', role: 'low', order: 3, label: 'Low 3', paytable: { 5: 3, 4: 0.7, 3: 0.3 } },
		{ name: 'L4', role: 'low', order: 4, label: 'Low 4', paytable: { 5: 2, 4: 0.5, 3: 0.2 } },
		{ name: 'L5', role: 'low', order: 5, label: 'Low 5', paytable: { 5: 1, 4: 0.3, 3: 0.1 } },
		{ name: 'W', role: 'wild', order: 1, label: 'Wild', special: ['wild', 'multiplier'], paytable: { 5: 20, 4: 10, 3: 5 } },
		{ name: 'S', role: 'scatter', order: 1, label: 'Scatter' },
	];

	// Some sample apps reference a symbol by name in their own components.
	for (const required of profile.requiredSymbols ?? []) {
		spec.symbols.push({
			name: required.name,
			role: 'low',
			order: spec.symbols.filter((s) => s.role === 'low').length + 1,
			label: required.name,
			special: required.special ?? [],
			paytable: { 5: 2, 4: 1, 3: 0.5 },
		});
	}

	spec.freeSpins = {
		triggerSymbol: 'S',
		triggerCount: 3,
		awardedSpins: 10,
		spinsPerExtraScatter: 2,
		retrigger: true,
	};

	spec.placeholderReelWeights = Object.fromEntries(
		spec.symbols.map((s) => [s.name, s.role === 'wild' ? 2 : s.role === 'scatter' ? 3 : s.role === 'high' ? 6 : 14]),
	);

	// Trim any paytable kind above the reel count — a 5-of-a-kind entry on a
	// 3-reel game can never pay, and the validator would rightly complain.
	for (const symbol of spec.symbols) {
		if (!symbol.paytable) continue;
		for (const kind of Object.keys(symbol.paytable)) {
			if (Number(kind) > reelCount) delete symbol.paytable[kind];
		}
	}

	return spec;
}
