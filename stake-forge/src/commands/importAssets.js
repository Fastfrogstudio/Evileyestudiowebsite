import fs from 'fs-extra';
import path from 'node:path';
import chalk from 'chalk';

import { loadAssetsManifest, loadGameSpec } from '../lib/loadSpec.js';
import { typeRequiredStates } from '../lib/taxonomy.js';
import { requiredStatesForSymbol } from '../lib/behaviorRecipes.js';
import { SCREEN_SLOTS } from '../lib/screens.js';
import { tsStringify, RawExpr } from '../lib/tsSerialize.js';
import { replaceExportConst } from '../lib/patchExport.js';

function copyOnce(seen, srcDir, destDir, filename) {
	if (!filename || seen.has(filename)) return;
	seen.add(filename);
	fs.ensureDirSync(destDir);
	fs.copySync(path.join(srcDir, filename), path.join(destDir, filename));
}

/**
 * Which animation each symbol state should play.
 *
 * A manifest entry may declare `animations: { state: animationName }` (the shape
 * `forge audit` checks), or the older flat `animationName` + `staticSprite`.
 * Both are supported; the map form is what a symbol with behaviors needs, since
 * an expanding wild has to name expand_in / expand_loop / expand_out separately.
 */
function statesFor(def) {
	if (def.animations && typeof def.animations === 'object') return { ...def.animations };
	const out = {};
	if (def.animationName) out.win = def.animationName;
	return out;
}

export function importAssets({ manifestPath, sdkDir, gameName, specPath }) {
	const manifest = loadAssetsManifest(manifestPath);
	const spec = specPath ? loadGameSpec(specPath) : null;
	const appDir = path.join(sdkDir, 'apps', gameName);
	if (!fs.existsSync(appDir)) {
		throw new Error(`apps/${gameName} not found — run "forge scaffold" first.`);
	}

	console.log(chalk.bold(`\nImporting assets into apps/${gameName}\n`));

	const spineDestDir = path.join(appDir, 'static', 'assets', 'spines', 'symbols');
	const staticSpriteDestDir = path.join(appDir, 'static', 'assets', 'sprites', 'symbolsStatic');
	const customSpriteDestDir = path.join(appDir, 'static', 'assets', 'sprites', 'custom');
	const screenDestDir = path.join(appDir, 'static', 'assets', 'spines', 'screens');
	const seen = new Set();

	const spriteSymbolEntries = Object.entries(manifest.spriteSymbols || {});
	for (const [, def] of spriteSymbolEntries) {
		copyOnce(seen, manifest._resolvedSourceDir, staticSpriteDestDir, def.sprite);
		for (const file of Object.values(def.states || {})) {
			copyOnce(seen, manifest._resolvedSourceDir, staticSpriteDestDir, file);
		}
	}
	if (spriteSymbolEntries.length) {
		console.log(
			chalk.green('✓'),
			`copied ${spriteSymbolEntries.length} flat-sprite symbol(s) into static/assets/sprites/symbolsStatic`,
		);
	}

	const spineEntries = Object.entries(manifest.spineSymbols || {});
	for (const [, def] of spineEntries) {
		copyOnce(seen, manifest._resolvedSourceDir, spineDestDir, def.atlas);
		copyOnce(seen, manifest._resolvedSourceDir, spineDestDir, def.png);
		copyOnce(seen, manifest._resolvedSourceDir, spineDestDir, def.skeleton);
		copyOnce(seen, manifest._resolvedSourceDir, staticSpriteDestDir, def.staticSprite);
	}
	if (spineEntries.length) {
		console.log(
			chalk.green('✓'),
			`copied ${spineEntries.length} spine skeleton(s) + shared atlas/png into static/assets/spines/symbols`,
		);
	}

	const spriteEntries = Object.entries(manifest.sprites || {});
	for (const [, file] of spriteEntries) {
		copyOnce(seen, manifest._resolvedSourceDir, customSpriteDestDir, file);
	}
	if (spriteEntries.length) {
		console.log(chalk.green('✓'), `copied ${spriteEntries.length} custom sprite(s)`);
	}

	const screenEntries = Object.entries(manifest.screens || {});
	for (const [, def] of screenEntries) {
		if (typeof def === 'string') {
			copyOnce(seen, manifest._resolvedSourceDir, customSpriteDestDir, def);
			continue;
		}
		for (const field of ['atlas', 'png', 'skeleton']) {
			copyOnce(seen, manifest._resolvedSourceDir, screenDestDir, def[field]);
		}
		copyOnce(seen, manifest._resolvedSourceDir, customSpriteDestDir, def.sprite);
	}
	if (screenEntries.length) {
		console.log(chalk.green('✓'), `copied ${screenEntries.length} screen asset(s)`);
	}

	// ── src/game/assets.ts ──────────────────────────────────────────────────
	// Targeted key injection rather than a rewrite: this file also holds
	// hand-written loader/font/sound entries that must survive untouched.
	const assetsPath = path.join(appDir, 'src', 'game', 'assets.ts');
	let assetsSource = fs.readFileSync(assetsPath, 'utf8');

	const newEntries = {};
	for (const [symbol, def] of spineEntries) {
		newEntries[symbol] = {
			type: 'spine',
			src: {
				atlas: new RawExpr(`new URL('../../assets/spines/symbols/${def.atlas}', import.meta.url).href`),
				skeleton: new RawExpr(`new URL('../../assets/spines/symbols/${def.skeleton}', import.meta.url).href`),
				scale: 2,
			},
		};
		if (def.staticSprite) {
			newEntries[`${symbol}_static`] = {
				type: 'sprite',
				src: new RawExpr(
					`new URL('../../assets/sprites/symbolsStatic/${def.staticSprite}', import.meta.url).href`,
				),
			};
		}
	}
	for (const [key, file] of spriteEntries) {
		newEntries[key] = {
			type: 'sprite',
			src: new RawExpr(`new URL('../../assets/sprites/custom/${file}', import.meta.url).href`),
		};
	}
	// Flat-sprite symbols register one asset per distinct image. pixi-svelte's
	// loader puts a `sprite` under its own key (assetLoad.ts PROCESS_METHOD_MAP),
	// so SYMBOL_INFO_MAP can point straight at these with no spine involved.
	for (const [symbol, def] of spriteSymbolEntries) {
		newEntries[`${symbol}_static`] = {
			type: 'sprite',
			src: new RawExpr(
				`new URL('../../assets/sprites/symbolsStatic/${def.sprite}', import.meta.url).href`,
			),
		};
		for (const [state, file] of Object.entries(def.states || {})) {
			newEntries[`${symbol}_${state}`] = {
				type: 'sprite',
				src: new RawExpr(
					`new URL('../../assets/sprites/symbolsStatic/${file}', import.meta.url).href`,
				),
			};
		}
	}


	// Screen slots register under the asset key the component actually looks up,
	// not under the slot id — Background.svelte asks for "foregroundAnimation".
	for (const [slotId, def] of screenEntries) {
		const slot = SCREEN_SLOTS[slotId];
		const key = slot?.assetKey ?? slotId;
		if (typeof def === 'string') {
			newEntries[key] = {
				type: 'sprite',
				src: new RawExpr(`new URL('../../assets/sprites/custom/${def}', import.meta.url).href`),
			};
			continue;
		}
		const entry = {
			type: def.type ?? slot?.assetType ?? 'spine',
			src:
				def.skeleton && def.atlas
					? {
							atlas: new RawExpr(`new URL('../../assets/spines/screens/${def.atlas}', import.meta.url).href`),
							skeleton: new RawExpr(`new URL('../../assets/spines/screens/${def.skeleton}', import.meta.url).href`),
							scale: 2,
						}
					: new RawExpr(`new URL('../../assets/sprites/custom/${def.sprite}', import.meta.url).href`),
		};
		if (slot?.preload) entry.preload = true;
		newEntries[key] = entry;
	}

	assetsSource = injectAssetKeys(assetsSource, newEntries);
	fs.writeFileSync(assetsPath, assetsSource, 'utf8');
	console.log(chalk.green('✓'), `patched src/game/assets.ts with ${Object.keys(newEntries).length} asset key(s)`);

	// ── src/game/constants.ts (SYMBOL_INFO_MAP) ─────────────────────────────
	const constantsPath = path.join(appDir, 'src', 'game', 'constants.ts');
	const constantsSource = fs.readFileSync(constantsPath, 'utf8');

	const { map, unmapped } = buildRealSymbolInfoMap(spineEntries, spriteSymbolEntries, spec);
	const { source: withMap, replaced } = replaceExportConst(
		constantsSource,
		'SYMBOL_INFO_MAP',
		tsStringify(map),
	);
	if (replaced) {
		fs.writeFileSync(constantsPath, withMap, 'utf8');
		console.log(chalk.green('✓'), 'patched src/game/constants.ts SYMBOL_INFO_MAP with real spine/sprite references');
	} else {
		console.warn(chalk.yellow('  !'), 'SYMBOL_INFO_MAP not found in constants.ts — wire assets by hand');
	}

	for (const { symbol, state } of unmapped) {
		console.warn(
			chalk.yellow('  !'),
			`${symbol}.${state} has no animation in the manifest — it falls back to the static frame. ` +
				`Run \`forge audit\` to see every gap at once.`,
		);
	}

	console.log(chalk.bold.cyan('\nDone. Sanity-check in storybook:'));
	console.log(`  pnpm run storybook --filter=${gameName}  ->  COMPONENTS/Symbol/symbols\n`);
}

/**
 * Point each symbol's states at real assets.
 *
 * When a spec is supplied, the state list comes from the symbol's role and
 * behaviors — so an expanding wild gets expand_in/expand_loop/expand_out wired
 * alongside the usual states, instead of the fixed five the v1 tool assumed.
 */
function buildRealSymbolInfoMap(spineEntries, spriteSymbolEntries, spec) {
	const map = {};
	const unmapped = [];
	const specSymbols = new Map((spec?.symbols ?? []).map((s) => [s.name, s]));
	const baseStates = typeRequiredStates();

	// Flat-sprite symbols first: every state points at the base tile, with any
	// per-state override swapped in. No animationName, because there is no spine.
	for (const [symbol, def] of spriteSymbolEntries) {
		const specSymbol = specSymbols.get(symbol);
		const states = specSymbol
			? [...requiredStatesForSymbol(specSymbol, baseStates).keys()]
			: baseStates;
		const ref = (key) => ({ type: 'sprite', assetKey: key, sizeRatios: { width: 1, height: 1 } });

		map[symbol] = {};
		for (const state of states) {
			map[symbol][state] = def.states?.[state]
				? ref(`${symbol}_${state}`)
				: ref(`${symbol}_static`);
		}
	}

	for (const [symbol, def] of spineEntries) {
		const animations = statesFor(def);
		const staticRef = def.staticSprite
			? { type: 'sprite', assetKey: `${symbol}_static`, sizeRatios: { width: 1, height: 1 } }
			: {
					type: 'spine',
					assetKey: symbol,
					animationName: animations.static ?? animations.win ?? 'idle',
					sizeRatios: { width: 1, height: 1 },
				};

		// Always cover the full SymbolState union (baseStates), plus whatever
		// extra states this symbol's behaviors add.
		const specSymbol = specSymbols.get(symbol);
		const states = specSymbol
			? [...requiredStatesForSymbol(specSymbol, baseStates).keys()]
			: baseStates;

		map[symbol] = {};
		for (const state of states) {
			if (animations[state]) {
				map[symbol][state] = {
					type: 'spine',
					assetKey: symbol,
					animationName: animations[state],
					sizeRatios: { width: 1, height: 1 },
				};
			} else if (state === 'win' && animations.win) {
				map[symbol][state] = {
					type: 'spine',
					assetKey: symbol,
					animationName: animations.win,
					sizeRatios: { width: 1, height: 1 },
				};
			} else {
				map[symbol][state] = staticRef;
				if (!['static', 'spin', 'land', 'postWinStatic', 'explosion'].includes(state)) {
					unmapped.push({ symbol, state });
				}
			}
		}
	}
	return { map, unmapped };
}

/**
 * Remove an existing top-level `KEY: { ... },` from an object-literal body.
 * Needed because the sample apps ship placeholder entries for the exact symbol
 * names we are about to add — without this, tsc flags duplicate object keys.
 */
function removeTopLevelKey(body, key) {
	const re = new RegExp(`\\n\\t${key}:\\s`);
	const m = body.match(re);
	if (!m) return body;
	const keyStart = m.index + 1;
	const valueStart = m.index + m[0].length;

	let i = valueStart;
	if (body[i] === '{') {
		let depth = 0;
		for (; i < body.length; i++) {
			if (body[i] === '{') depth++;
			else if (body[i] === '}') {
				depth--;
				if (depth === 0) {
					i++;
					break;
				}
			}
		}
	} else {
		while (i < body.length && body[i] !== ',') i++;
	}
	if (body[i] === ',') i++;

	return body.slice(0, keyStart) + body.slice(i);
}

/** Insert/overwrite top-level keys in assets.ts's `export default { ... }`. */
function injectAssetKeys(source, newEntries) {
	const startMarker = 'export default {';
	const startIdx = source.indexOf(startMarker);
	if (startIdx === -1) throw new Error('assets.ts: could not find `export default {`');

	let depth = 0;
	let i = startIdx + 'export default '.length;
	for (; i < source.length; i++) {
		if (source[i] === '{') depth++;
		else if (source[i] === '}') {
			depth--;
			if (depth === 0) break;
		}
	}

	const openIdx = startIdx + 'export default '.length;
	let body = source.slice(openIdx + 1, i);
	for (const key of Object.keys(newEntries)) body = removeTopLevelKey(body, key);

	const before = source.slice(0, openIdx + 1);
	const after = source.slice(i);
	const lines = Object.entries(newEntries)
		.map(([key, value]) => `\t${/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : `'${key}'`}: ${tsStringify(value, 1)},`)
		.join('\n');

	const bodyTrimmed = body.replace(/\s*$/, '');
	const needsComma = bodyTrimmed.length > 0 && !bodyTrimmed.endsWith(',');
	return `${before}${bodyTrimmed}${needsComma ? ',' : ''}\n${lines}\n${after}`;
}
