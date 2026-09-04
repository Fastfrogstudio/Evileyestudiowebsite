import fs from 'fs-extra';
import path from 'node:path';
import chalk from 'chalk';
import { declaredHandlers, eventsImpliedBy } from '../lib/eventCoverage.js';
import { addWebEventHandlers } from '../lib/webEventPatch.js';
import { WEB_EVENT_HANDLERS } from '../lib/webEventHandlers.js';

import { loadGameSpec } from '../lib/loadSpec.js';
import { renderConfigTs, buildSymbolInfoMap, buildInitialBoard } from '../lib/generators.js';
import { readSpriteFrames } from '../lib/spriteFrames.js';
import { symbolSizeFor } from '../lib/layout.js';
import { highSymbolNames } from '../lib/taxonomy.js';
import { tsStringify } from '../lib/tsSerialize.js';
import { replaceExportConst } from '../lib/patchExport.js';
import { getRecipe, isGenerable } from '../lib/behaviorRecipes.js';
import { applyWebRecipe } from '../lib/webRecipePatch.js';

const SKIP_DIRS = new Set(['node_modules', '.svelte-kit', '.turbo', 'dist', 'storybook-static']);

function copyApp(sdkDir, mechanicApp, targetName, { force }) {
	const src = path.join(sdkDir, 'apps', mechanicApp);
	const dest = path.join(sdkDir, 'apps', targetName);
	if (!fs.existsSync(src)) {
		throw new Error(
			`Sample app "${mechanicApp}" not found at ${src}. Is --sdk pointing at a checkout of StakeEngine/web-sdk?`,
		);
	}
	// node_modules survives a --force re-scaffold.
	//
	// It is a pnpm symlink farm, not source, and the re-clone comes from the same
	// sample with the same dependencies — so removing it only forces another
	// `pnpm install` in the whole workspace. Without this, every re-scaffold
	// silently broke the preview and the type-check until that install was run
	// again, which is a slow and completely avoidable round trip.
	const modules = path.join(dest, 'node_modules');
	const stashed = path.join(sdkDir, 'apps', `.${targetName}-node_modules`);
	let restore = false;

	if (fs.existsSync(dest)) {
		if (!force) {
			throw new Error(`apps/${targetName} already exists. Re-run with --force to overwrite it.`);
		}
		if (fs.existsSync(modules)) {
			fs.removeSync(stashed);
			fs.renameSync(modules, stashed);
			restore = true;
		}
		fs.removeSync(dest);
	}
	fs.copySync(src, dest, { filter: (p) => !SKIP_DIRS.has(path.basename(p)) });
	if (restore) fs.renameSync(stashed, modules);
	return dest;
}

function patchPackageJson(appDir, spec) {
	const pkgPath = path.join(appDir, 'package.json');
	const pkg = fs.readJsonSync(pkgPath);
	pkg.name = spec.game.name;
	fs.writeJsonSync(pkgPath, pkg, { spaces: '\t' });
}

function patchConstantsTs(appDir, spec) {
	const constantsPath = path.join(appDir, 'src', 'game', 'constants.ts');
	let source = fs.readFileSync(constantsPath, 'utf8');
	const missed = [];

	const patch = (name, value) => {
		const result = replaceExportConst(source, name, value);
		if (result.replaced) source = result.source;
		else missed.push(name);
	};

	// The app was just cloned from a sample, so its sprite sheets are on disk and
	// the placeholder frame names can be matched against what they actually hold
	// instead of guessed. A guess of "s.webp" against a sheet holding "s.png"
	// renders the symbol as nothing, silently.
	const { frames } = readSpriteFrames(appDir);
	patch('SYMBOL_INFO_MAP', tsStringify(buildSymbolInfoMap(spec, { availableFrames: frames.keys() })));
	patch('HIGH_SYMBOLS', tsStringify(highSymbolNames(spec.symbols)));
	patch('INITIAL_BOARD', tsStringify(buildInitialBoard(spec)));
	// How big the board is drawn, as a fraction of the SDK's logical stages.
	// The sample's 120 leaves a 5-reel board at 42% of the desktop stage; see
	// src/lib/layout.js for why the default is what it is.
	patch('SYMBOL_SIZE', String(symbolSizeFor(spec).size));

	fs.writeFileSync(constantsPath, source, 'utf8');
	return missed;
}

/** Apply the web half of every generable behavior recipe. */
function applyRecipes(appDir, spec) {
	const results = [];
	for (const symbol of spec.symbols) {
		for (const tag of symbol.behaviors) {
			const recipe = getRecipe(tag);
			if (!recipe) continue;
			if (recipe.tier === 2) {
				results.push({ tag, symbol: symbol.name, action: 'builtin', recipe });
				continue;
			}
			if (!isGenerable(recipe) || !recipe.emitWeb) {
				results.push({ tag, symbol: symbol.name, action: 'not-generated', recipe });
				continue;
			}
			const emitted = recipe.emitWeb({
				wildSymbol: symbol.name,
				colossalSymbol: symbol.name,
				gameName: spec.game.name,
			});
			applyWebRecipe(appDir, emitted);
			results.push({ tag, symbol: symbol.name, action: 'generated', recipe });
		}
	}
	return results;
}

export function scaffoldGame({ specPath, sdkDir, force }) {
	const spec = loadGameSpec(specPath);
	const mechanic = spec._mechanic;

	console.log(
		chalk.bold(
			`\nScaffolding "${spec.game.name}" (${mechanic.id}) into ${sdkDir}/apps/${spec.game.name}\n`,
		),
	);
	for (const warning of spec._warnings) console.log(chalk.yellow('  !'), warning);
	if (spec._warnings.length) console.log('');

	const appDir = copyApp(sdkDir, mechanic.webApp, spec.game.name, { force });
	console.log(chalk.green('✓'), `copied apps/${mechanic.webApp} -> apps/${spec.game.name}`);

	patchPackageJson(appDir, spec);
	console.log(chalk.green('✓'), 'set package.json name');

	fs.writeFileSync(path.join(appDir, 'src', 'game', 'config.ts'), renderConfigTs(spec), 'utf8');
	console.log(
		chalk.green('✓'),
		`wrote src/game/config.ts (paytable, betModes, paddingReels as "${mechanic.paddingReelsStyle}" — matching apps/${mechanic.webApp})`,
	);

	const missed = patchConstantsTs(appDir, spec);
	console.log(chalk.green('✓'), 'patched src/game/constants.ts (SYMBOL_INFO_MAP, HIGH_SYMBOLS, INITIAL_BOARD)');
	for (const name of missed) {
		console.log(chalk.yellow('  !'), `could not find ${name} in constants.ts — patch it by hand`);
	}

	for (const r of applyRecipes(appDir, spec)) {
		if (r.action === 'generated') {
			console.log(chalk.green('✓'), `behavior "${r.tag}" on ${r.symbol}: added bookEvents + component`);
		} else if (r.action === 'builtin') {
			console.log(chalk.cyan('·'), `behavior "${r.tag}": built-in (tier 2), already wired in apps/${mechanic.webApp}`);
		} else {
			console.log(
				chalk.yellow('  !'),
				`behavior "${r.tag}" on ${r.symbol} is status "${r.recipe.status}" — web side NOT generated.`,
			);
		}
	}

	// ── events the sample app cannot draw ───────────────────────────────────
	// The sample apps each handle only their own sample's events: lines and ways
	// know 9, and none of the four handles `wincap`. A generated game adds
	// mechanics to the MATHS, so it emits events the app has never heard of — and
	// an unhandled event is a console.error nobody reads while the feature
	// silently never reaches the player. See src/lib/eventCoverage.js.
	const implied = eventsImpliedBy(spec);
	const handled = declaredHandlers(appDir);
	const missing = handled ? implied.filter((type) => !handled.has(type)) : [];
	if (missing.length) {
		const result = addWebEventHandlers(appDir, missing);
		for (const type of result.added) {
			console.log(
				chalk.green('✓'),
				`bookEvent "${type}": added type + handler${WEB_EVENT_HANDLERS[type]?.component ? ` + mounted ${WEB_EVENT_HANDLERS[type].component}` : ''}`,
			);
		}
		for (const problem of result.problems) {
			console.log(chalk.yellow('  !'), problem);
		}
		const ungeneratable = missing.filter((type) => !WEB_EVENT_HANDLERS[type]);
		for (const type of ungeneratable) {
			console.log(
				chalk.yellow('  !'),
				`bookEvent "${type}" has no generator — add it by hand (docs/fe_docs/steps.md) or the ` +
					`feature will not reach the player.`,
			);
		}
	}

	console.log(chalk.bold.cyan('\nNext:'));
	console.log(`  forge audit --spec ${path.basename(specPath)} --manifest assets-manifest.yaml`);
	console.log(`  forge assets:import --manifest assets-manifest.yaml --sdk ${sdkDir} --game ${spec.game.name}`);
	console.log(`  cd ${sdkDir} && pnpm install && pnpm run storybook --filter=${spec.game.name}\n`);

	return appDir;
}
