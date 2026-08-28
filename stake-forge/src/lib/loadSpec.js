import fs from 'fs-extra';
import YAML from 'yaml';
import path from 'node:path';

import { MECHANIC_IDS, getMechanic } from './mechanics.js';
import { normaliseSymbol, assignOrders, sortSymbols } from './taxonomy.js';
import { validateBehaviors } from './behaviorRecipes.js';
import { validateScreens } from './screens.js';

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
				validateBehaviors(s, { mechanic: mechanic.id, errors, warnings });
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

	if (missing.length) {
		throw new SpecValidationError([
			'Referenced asset files were not found:',
			...missing.map((m) => `  - ${m}`),
		]);
	}

	manifest._manifestPath = path.resolve(manifestPath);
	return manifest;
}
