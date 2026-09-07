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

	// ── which symbols are already real, decided BEFORE anything is written ──
	//
	// This has to happen up here, not at the manifest merge below. The tile for
	// "L1" is written to `l1.png` in the SAME directory the art team delivers
	// into, so a symbol whose art has landed gets its file overwritten by the
	// write loop long before the merge decides to keep its manifest entry. The
	// result is the worst possible outcome: the manifest still points at the
	// delivered filename, and that file is now a placeholder tile. Found by
	// running this command on a game with five delivered symbols and watching
	// their checksums change.
	//
	// A manifest entry without the `placeholder` marker is the art team's.
	const existingManifest = fs.existsSync(manifestPath)
		? (YAML.parse(fs.readFileSync(manifestPath, 'utf8')) ?? {})
		: {};
	const delivered = new Set(
		Object.entries(existingManifest.spriteSymbols ?? {})
			.filter(([, entry]) => entry && !entry.placeholder)
			.map(([name]) => name),
	);
	for (const name of Object.keys(existingManifest.spineSymbols ?? {})) delivered.add(name);

	const spriteSymbols = {};
	const protectedSymbols = [];
	let files = 0;
	let variants = 0;

	for (const symbol of spec.symbols) {
		if (delivered.has(symbol.name) && !force) {
			protectedSymbols.push(symbol.name);
			continue;
		}
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

	// Manifest paths are relative to assetsSourceDir, NOT to --out.
	//
	// When a manifest already exists its assetsSourceDir wins, and --out can sit
	// anywhere underneath it (`assets-source` vs `assets-source/symbols` is the
	// normal case once real art has landed in a subfolder). Writing the bare
	// filename then produces an entry that resolves to the wrong path and an
	// audit failure for a file that is sitting right there. Prefix by the actual
	// offset between the two.
	const sourceRoot = path.resolve(path.dirname(manifestPath), manifest.assetsSourceDir);
	const prefix = path.relative(sourceRoot, path.resolve(outDir)).split(path.sep).filter(Boolean);
	const withPrefix = (file) => [...prefix, file].join('/');

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
		// Marked so a later run can tell its own tiles from delivered art. The
		// skip itself already happened in the write loop above.
		manifest.spriteSymbols[name] = {
			...entry,
			sprite: withPrefix(entry.sprite),
			...(entry.states
				? { states: Object.fromEntries(Object.entries(entry.states).map(([k, v]) => [k, withPrefix(v)])) }
				: {}),
			placeholder: true,
		};
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

	const untouched = [...new Set([...protectedSymbols, ...kept])];
	if (untouched.length) {
		console.log(
			chalk.cyan('  ·'),
			`left delivered art alone for: ${untouched.join(', ')} (use --force to overwrite it with tiles)`,
		);
	}

	console.log(chalk.bold.cyan('\nNext:'));
	console.log(`  forge audit         --spec ${path.basename(specPath)} --manifest ${path.basename(manifestPath)}`);
	console.log(`  forge assets:import --manifest ${path.basename(manifestPath)} --sdk ./web-sdk --game ${spec.game.name} --spec ${path.basename(specPath)}`);
	console.log(`  cd ./web-sdk && pnpm run storybook --filter=${spec.game.name}\n`);

	return { ok: true, files, spriteSymbols };
}
