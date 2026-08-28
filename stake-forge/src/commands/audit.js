import fs from 'fs-extra';
import path from 'node:path';
import chalk from 'chalk';

import { loadGameSpec, loadAssetsManifest } from '../lib/loadSpec.js';
import { defaultAnimationStates } from '../lib/taxonomy.js';
import { requiredStatesForSymbol, getRecipe } from '../lib/behaviorRecipes.js';
import { SCREEN_SLOTS, slotsForMechanic, flattenScreens } from '../lib/screens.js';
import { auditSound } from '../lib/sound.js';
import { auditSpriteFrames } from '../lib/spriteFrames.js';

/**
 * Cross-check assets-manifest.yaml against everything the spec implies, BEFORE
 * scaffold or assets:import writes anything.
 *
 * Three checks:
 *  1. Every symbol in the spec has a manifest entry.
 *  2. Every animation state that symbol's role + behaviors require is supplied.
 *  3. Every screen slot the spec declares (and every required one it does not)
 *     is accounted for.
 *
 * The animation-state check is the one that pays for itself: an expanding wild
 * needs expand_in / expand_loop / expand_out on top of the normal static / land
 * / win, and there is no way to notice those are missing from a spine export
 * until the feature fires in-game.
 */

/**
 * Which states a manifest entry actually supplies.
 *
 * Three sources, in increasing priority:
 *   1. `staticSprite`  — a flat frame, which legitimately covers the four
 *                        non-animated states. This is how the sample apps do it:
 *                        apps/lines' SYMBOL_INFO_MAP points static/spin/land/
 *                        postWinStatic at one `h1Static` sprite and only `win`
 *                        at a spine.
 *   2. `animationName` — taxonomy v1's single animation, which meant the win pose.
 *   3. `animations:`   — the explicit state -> animation map, which wins.
 */
function collectManifestStates(def) {
	const out = new Map();

	if (def.staticSprite) {
		for (const state of STATIC_SPRITE_STATES) out.set(state, def.staticSprite);
	}
	if (def.animationName) out.set('win', def.animationName);
	if (def.animations && typeof def.animations === 'object') {
		for (const [state, animation] of Object.entries(def.animations)) out.set(state, animation);
	}

	return out;
}

/** States a flat static frame legitimately covers. */
const STATIC_SPRITE_STATES = ['static', 'spin', 'land', 'postWinStatic'];

export function audit({ specPath, manifestPath, sdkDir, json }) {
	const spec = loadGameSpec(specPath);
	const mechanic = spec._mechanic;

	let manifest = null;
	let manifestError = null;
	try {
		manifest = loadAssetsManifest(manifestPath);
	} catch (err) {
		manifestError = err.message;
	}

	const findings = [];
	const add = (level, area, message, fix) => findings.push({ level, area, message, fix });

	for (const warning of spec._warnings) add('warn', 'spec', warning);

	if (manifestError) {
		add('error', 'manifest', manifestError, 'Fix the paths in assets-manifest.yaml.');
		return report({ spec, findings, json, symbolRows: [], screenRows: [] });
	}

	// ── symbols ─────────────────────────────────────────────────────────────
	const spine = manifest.spineSymbols || {};
	const sprite = manifest.spriteSymbols || {};
	const baseStates = defaultAnimationStates({ mechanic: mechanic.id });
	const symbolRows = [];

	for (const symbol of spec.symbols) {
		const required = requiredStatesForSymbol(symbol, baseStates);

		// A flat-sprite symbol covers every state with one image, plus optional
		// per-state overrides. It renders — it just does not animate — so it is
		// reported as a note rather than a gap.
		if (sprite[symbol.name]) {
			const def = sprite[symbol.name];
			const overrides = Object.keys(def.states || {});
			add(
				'info',
				`symbol ${symbol.name}`,
				`flat sprite "${def.sprite}" covers all ${required.size} state(s)` +
					(overrides.length ? `, with per-state art for ${overrides.join(', ')}` : '') +
					' — renders, but does not animate',
			);
			symbolRows.push({
				symbol: symbol.name,
				role: symbol.role,
				behaviors: symbol.behaviors,
				kind: 'sprite',
				required: [...required.keys()],
				supplied: [...required.keys()],
				missing: [],
			});
			continue;
		}

		const def = spine[symbol.name];

		if (!def) {
			add(
				'error',
				`symbol ${symbol.name}`,
				`role "${symbol.role}" but no entry in assets-manifest.yaml (spineSymbols or spriteSymbols)`,
				`Either add a spine entry, or run \`forge art:placeholder\` to generate a stand-in tile for it.`,
			);
			symbolRows.push({ symbol: symbol.name, role: symbol.role, required: [...required.keys()], supplied: [], missing: [...required.keys()] });
			continue;
		}

		const supplied = collectManifestStates(def);
		const missing = [...required.keys()].filter((s) => !supplied.has(s));

		for (const state of missing) {
			const reasons = required.get(state).join(' + ');
			add(
				'error',
				`symbol ${symbol.name}`,
				`missing animation state "${state}" (required by ${reasons})`,
				`Add it under ${symbol.name}.animations in assets-manifest.yaml, pointing at the animation name inside ${def.skeleton}.`,
			);
		}

		const extra = [...supplied.keys()].filter((s) => !required.has(s));
		for (const state of extra) {
			add(
				'info',
				`symbol ${symbol.name}`,
				`manifest supplies state "${state}" that nothing requires — harmless, but check for a typo`,
			);
		}

		symbolRows.push({
			symbol: symbol.name,
			role: symbol.role,
			behaviors: symbol.behaviors,
			required: [...required.keys()],
			supplied: [...supplied.keys()],
			missing,
		});
	}

	const orphans = [...Object.keys(spine), ...Object.keys(sprite)].filter(
		(n) => !spec.symbols.some((s) => s.name === n),
	);
	for (const name of orphans) {
		add(
			'warn',
			'manifest',
			`spineSymbols has "${name}" but game-spec.yaml has no such symbol — it will be copied but never referenced`,
		);
	}

	// ── behaviors that cannot be generated yet ──────────────────────────────
	for (const symbol of spec.symbols) {
		for (const tag of symbol.behaviors) {
			const recipe = getRecipe(tag);
			if (!recipe || recipe.status === 'verified' || recipe.tier === 2) continue;
			add(
				'warn',
				`symbol ${symbol.name}`,
				`behavior "${tag}" is status "${recipe.status}" — stake-forge will NOT generate its code`,
				recipe.referenceSample.math
					? `Build it by hand from ${recipe.referenceSample.math}, then promote the recipe to "verified".`
					: 'No sample exists in either SDK — this one is genuinely from scratch.',
			);
		}
	}

	// ── screens ─────────────────────────────────────────────────────────────
	const declared = new Map(flattenScreens(spec.screens || {}));
	const manifestScreens = manifest.screens || {};
	const screenRows = [];

	for (const [id, slot] of slotsForMechanic(mechanic.id)) {
		const inSpec = declared.has(id);
		// "Supplied" means a FILE exists for it. Declaring a slot in game-spec.yaml
		// only says the game wants one — the art still has to be in the manifest,
		// and reporting a declaration as supplied hid exactly that gap.
		const supplied =
			Object.prototype.hasOwnProperty.call(manifestScreens, id) ||
			Object.prototype.hasOwnProperty.call(manifestScreens, slot.assetKey);

		if (slot.required && !supplied) {
			// NOT an error. The sample app ships art for every required slot, so a
			// game that has not replaced it still renders — reporting that as an
			// error means a brand-new game opens with four red marks and nothing
			// actually wrong, which teaches you to ignore the audit.
			add(
				'warn',
				`screen ${id}`,
				`${slot.component} still uses the sample app's ${slot.assetKey} — fine for now, ` +
					`replace it before this ships`,
				inSpec
					? `Add a "${id}" entry under screens: in assets-manifest.yaml.`
					: `Tick "${id}" under screens: in game-spec.yaml, then supply it in assets-manifest.yaml.`,
			);
		} else if (!slot.required && !supplied) {
			add('info', `screen ${id}`, `not supplied — ${slot.component} will fall back to the sample app's art`);
		}

		screenRows.push({
			slot: id,
			assetKey: slot.assetKey,
			component: slot.component,
			assetType: slot.assetType,
			animations: slot.animations,
			declared: inSpec,
			supplied,
		});
	}

	for (const [id] of declared) {
		if (!SCREEN_SLOTS[id]) continue;
		const inManifest = Object.prototype.hasOwnProperty.call(manifestScreens, id);
		if (!inManifest) {
			add(
				'info',
				`screen ${id}`,
				'declared in game-spec.yaml but has no file in assets-manifest.yaml screens: — ' +
					`${SCREEN_SLOTS[id].component} keeps the sample app's art until you add one`,
			);
		}
	}

	// ── sound ───────────────────────────────────────────────────────────────
	// Only possible with the scaffolded app: the vocabulary and the sounds a
	// game plays both live in its own source, not in the spec.
	let soundResult = null;
	if (sdkDir) {
		const appDir = path.join(sdkDir, 'apps', spec.game.name);
		if (!fs.existsSync(appDir)) {
			add('info', 'sound', `apps/${spec.game.name} not scaffolded yet — skipped the sound check`);
		} else {
			// Sprite frames first: an invisible symbol is more obviously wrong than
			// a silent sound, and both fail the same silent way.
			const frames = auditSpriteFrames(appDir);
			for (const miss of frames.missing) {
				add(
					'error',
					`symbol ${miss.symbol}`,
					`points at sprite frame${miss.assetKeys.length > 1 ? 's' : ''} ${miss.assetKeys.join(', ')}, ` +
						`which ${miss.assetKeys.length > 1 ? 'are' : 'is'} not in any sprite sheet — ` +
						`it will render as NOTHING, with no error`,
					miss.near.length
						? `The sheet has "${miss.near[0]}". Either rename the frame or point at that one.`
						: `Supply art for ${miss.symbol} and run "forge assets:import", which rewrites ` +
							`SYMBOL_INFO_MAP to point at what you actually supplied.`,
				);
			}

			soundResult = auditSound(appDir);

			for (const name of soundResult.missing) {
				add(
					'error',
					`sound ${name}`,
					'played by this game but not in its audio sprite — it will be SILENT, with no error',
					`Add "${name}" to static/assets/audio/sounds.json and rebuild the sprite.`,
				);
			}
			for (const name of soundResult.unknown) {
				add(
					'error',
					`sound ${name}`,
					'played by this game but not declared in sound.ts — almost certainly a typo',
					'Fix the name, or add it to the MusicName / SoundEffectName union.',
				);
			}
			if (!soundResult.sprite.found) {
				add('warn', 'sound', 'no static/assets/audio/sounds.json — the game has no audio at all');
			}
			for (const file of soundResult.sprite.missingFiles ?? []) {
				add('error', 'sound', `sounds.json references ${file}, which is not on disk`);
			}
			if (soundResult.unused.length) {
				add(
					'info',
					'sound',
					`${soundResult.unused.length} sound(s) supplied but never played — harmless weight`,
				);
			}
		}
	}

	return report({ spec, findings, json, symbolRows, screenRows, soundResult });
}

function report({ spec, findings, json, symbolRows, screenRows, soundResult }) {
	const errors = findings.filter((f) => f.level === 'error');
	const warns = findings.filter((f) => f.level === 'warn');
	const infos = findings.filter((f) => f.level === 'info');

	if (json) {
		console.log(JSON.stringify({ game: spec.game.name, findings, symbolRows, screenRows, sound: soundResult }, null, 2));
		return { ok: errors.length === 0, findings };
	}

	console.log(chalk.bold(`\nAudit — ${spec.game.name} (${spec._mechanic.id})\n`));

	console.log(chalk.bold('Symbols'));
	for (const row of symbolRows) {
		const tag = row.missing.length ? chalk.red('✗') : row.kind === 'sprite' ? chalk.cyan('◐') : chalk.green('✓');
		const behaviors = row.behaviors?.length ? chalk.dim(` [${row.behaviors.join(', ')}]`) : '';
		const note = row.missing.length
			? chalk.red(`  missing: ${row.missing.join(', ')}`)
			: row.kind === 'sprite'
				? chalk.cyan(`  ${row.required.length} states via placeholder sprite`)
				: chalk.dim(`  ${row.required.length} states ok`);
		console.log(`  ${tag} ${row.symbol.padEnd(4)} ${chalk.dim(row.role.padEnd(8))}${behaviors}${note}`);
	}

	console.log(chalk.bold('\nScreens'));
	for (const row of screenRows) {
		// ✓ art supplied · ◐ wanted, but still on the sample's art · · not wanted
		const tag = row.supplied ? chalk.green('✓') : row.declared ? chalk.cyan('◐') : chalk.dim('·');
		const note = !row.supplied && row.declared ? chalk.cyan('  using sample art') : '';
		console.log(
			`  ${tag} ${row.slot.padEnd(24)} ${chalk.dim(`${row.assetKey} -> ${row.component}`)}${note}`,
		);
	}

	if (soundResult) {
		console.log(chalk.bold('\nSound'));
		const tag = soundResult.missing.length || soundResult.unknown.length
			? chalk.red('✗')
			: soundResult.sprite.found
				? chalk.green('✓')
				: chalk.yellow('·');
		console.log(
			`  ${tag} ${String(soundResult.used.length).padStart(3)} played by this game · ` +
				chalk.dim(
					`${soundResult.sprite.supplied.length} supplied · ` +
						`${soundResult.vocabulary.music.length + soundResult.vocabulary.effects.length} declared in sound.ts`,
				),
		);
		if (soundResult.sprite.formats.length) {
			console.log(chalk.dim(`      formats: ${soundResult.sprite.formats.join(', ')}`));
		}
	}

	if (findings.length) console.log('');
	for (const f of [...errors, ...warns, ...infos]) {
		const colour = f.level === 'error' ? chalk.red : f.level === 'warn' ? chalk.yellow : chalk.dim;
		const label = f.level === 'error' ? 'ERROR' : f.level === 'warn' ? 'WARN ' : 'INFO ';
		console.log(`${colour(label)} ${chalk.bold(f.area)}: ${f.message}`);
		if (f.fix) console.log(`      ${chalk.dim(f.fix)}`);
	}

	console.log(
		`\n${errors.length} error(s), ${warns.length} warning(s), ${infos.length} note(s)\n`,
	);
	return { ok: errors.length === 0, findings };
}
