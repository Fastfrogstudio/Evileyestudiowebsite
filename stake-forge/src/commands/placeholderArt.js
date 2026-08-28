import fs from 'fs-extra';
import path from 'node:path';
import YAML from 'yaml';
import chalk from 'chalk';

import { loadGameSpec } from '../lib/loadSpec.js';
import { typeRequiredStates } from '../lib/taxonomy.js';
import { requiredStatesForSymbol } from '../lib/behaviorRecipes.js';
import { renderSymbolTile, topPayoutOf, TILE_SIZE } from '../lib/placeholderArt.js';

/**
 * Generate stand-in symbol art so the game can be looked at before any real art
 * exists, and write a manifest that wires it up.
 *
 * The output is deliberately ugly-but-legible: a role-coloured tile with the
 * symbol name on it. The point is to see the reels spin, tell the symbols apart,
 * and watch a feature fire — then replace the files one at a time as real art
 * lands, without touching the spec.
 */
export function placeholderArt({ specPath, outDir, manifestPath, force, size }) {
	const spec = loadGameSpec(specPath);
	fs.ensureDirSync(outDir);

	const tileSize = size ?? TILE_SIZE;
	const baseStates = typeRequiredStates();

	// Rank within role drives the hue, so symbols stay distinguishable.
	const roleCounts = {};
	for (const symbol of spec.symbols) {
		roleCounts[symbol.role] = (roleCounts[symbol.role] ?? 0) + 1;
	}

	const spriteSymbols = {};
	let files = 0;
	let variants = 0;

	for (const symbol of spec.symbols) {
		const base = `${symbol.name.toLowerCase()}.png`;
		fs.writeFileSync(
			path.join(outDir, base),
			renderSymbolTile({
				name: symbol.name,
				role: symbol.role,
				order: symbol.order,
				roleCount: roleCounts[symbol.role],
				topPayout: topPayoutOf(symbol),
				size: tileSize,
			}),
		);
		files += 1;

		const entry = { sprite: base };

		// Any state a behavior adds beyond the defaults gets its own tile, so a
		// feature firing is visible on the board rather than only in the event log.
		const required = [...requiredStatesForSymbol(symbol, baseStates).keys()];
		const extra = required.filter((state) => !baseStates.includes(state));
		if (extra.length) {
			entry.states = {};
			for (const state of extra) {
				const file = `${symbol.name.toLowerCase()}_${state}.png`;
				fs.writeFileSync(
					path.join(outDir, file),
					renderSymbolTile({
						name: symbol.name,
						role: symbol.role,
						order: symbol.order,
						roleCount: roleCounts[symbol.role],
						topPayout: topPayoutOf(symbol),
						variant: state,
						size: tileSize,
					}),
				);
				entry.states[state] = file;
				files += 1;
				variants += 1;
			}
		}

		spriteSymbols[symbol.name] = entry;
	}

	console.log(chalk.bold(`\nPlaceholder art for "${spec.game.name}"\n`));
	console.log(
		chalk.green('✓'),
		`wrote ${files} tile(s) (${tileSize}x${tileSize} PNG) into ${path.relative(process.cwd(), outDir) || '.'}`,
	);
	if (variants) {
		console.log(
			chalk.green('✓'),
			`${variants} of them are behavior-state variants, so you can see the feature fire`,
		);
	}

	// ── manifest ────────────────────────────────────────────────────────────
	// Merge rather than overwrite: assets-manifest.yaml may already carry real
	// spine entries for symbols whose art has landed, and those must survive.
	let manifest = {};
	if (fs.existsSync(manifestPath)) {
		manifest = YAML.parse(fs.readFileSync(manifestPath, 'utf8')) ?? {};
	}
	manifest.assetsSourceDir =
		manifest.assetsSourceDir ?? `./${path.relative(path.dirname(manifestPath), outDir) || '.'}`;

	const alreadySpine = Object.keys(manifest.spineSymbols ?? {});
	const kept = [];
	manifest.spriteSymbols = manifest.spriteSymbols ?? {};
	for (const [name, entry] of Object.entries(spriteSymbols)) {
		if (alreadySpine.includes(name)) {
			if (!force) {
				kept.push(name);
				continue;
			}
			delete manifest.spineSymbols[name];
		}
		manifest.spriteSymbols[name] = entry;
	}
	if (manifest.spineSymbols && !Object.keys(manifest.spineSymbols).length) {
		delete manifest.spineSymbols;
	}

	const header =
		`# assets-manifest.yaml — updated by \`forge art:placeholder\`.\n` +
		`#\n` +
		`# spriteSymbols entries are STAND-IN tiles, not art. Replace a symbol by\n` +
		`# moving it into spineSymbols with your real atlas/skeleton and deleting its\n` +
		`# spriteSymbols entry — one symbol at a time, no spec changes needed.\n` +
		`#\n` +
		`# Screens are NOT covered: Background.svelte, FreeSpinIntro.svelte and the\n` +
		`# other screen components require spines and named animation tracks, so a flat\n` +
		`# PNG cannot stand in for one. Those keep the sample app's art until yours\n` +
		`# arrives.\n\n`;

	fs.writeFileSync(manifestPath, header + YAML.stringify(manifest, { lineWidth: 0 }), 'utf8');
	console.log(chalk.green('✓'), `updated ${path.basename(manifestPath)} with ${Object.keys(spriteSymbols).length} spriteSymbols entr(ies)`);

	if (kept.length) {
		console.log(
			chalk.cyan('  ·'),
			`left existing spineSymbols entries alone for: ${kept.join(', ')} (use --force to replace them)`,
		);
	}

	console.log(chalk.bold.cyan('\nNext:'));
	console.log(`  forge audit         --spec ${path.basename(specPath)} --manifest ${path.basename(manifestPath)}`);
	console.log(`  forge assets:import --manifest ${path.basename(manifestPath)} --sdk ./web-sdk --game ${spec.game.name} --spec ${path.basename(specPath)}`);
	console.log(`  cd ./web-sdk && pnpm run storybook --filter=${spec.game.name}\n`);

	return { ok: true, files, spriteSymbols };
}
