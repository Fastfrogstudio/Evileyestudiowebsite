import fs from 'fs-extra';
import path from 'node:path';
import chalk from 'chalk';
import YAML from 'yaml';

import { loadGameSpec } from '../lib/loadSpec.js';
import { readSoundVocabulary, readSoundsUsed } from '../lib/sound.js';
import {
	findFfmpeg,
	readSoundSources,
	probeDuration,
	looksLooping,
	planSprite,
	buildSprite,
} from '../lib/soundSprite.js';

/**
 * Turn a folder of individual sound files into the app's audio sprite.
 *
 * The web-sdk does not load loose audio files. It loads ONE sprite plus a JSON
 * of offsets, so until now supplying your own audio meant hand-authoring that
 * timeline — measuring every clip, picking non-overlapping offsets, encoding
 * four formats and keeping the JSON in step with all of them. This does it.
 *
 * The filename is the sound name: `bgm_main.wav` becomes `bgm_main`. That is
 * the whole naming convention, and it means the names in the folder can be
 * checked against the names the game's own code plays — which is the check that
 * matters, because a missing sound is SILENT rather than an error.
 */

/** An optional sounds.yaml beside the audio, for the two things filenames cannot say. */
export function readSoundManifest(dir) {
	const file = path.join(dir, 'sounds.yaml');
	if (!fs.existsSync(file)) return {};
	const data = YAML.parse(fs.readFileSync(file, 'utf8')) ?? {};
	return data.sounds ?? data;
}

export function soundBuild({ specPath, sdkDir, sourceDir, gameName, dryRun }) {
	const spec = specPath ? loadGameSpec(specPath) : null;
	const name = gameName ?? spec?.game?.name;
	if (!name) throw new Error('Need --game or --spec to know which app to build into.');

	const appDir = path.join(sdkDir, 'apps', name);
	if (!fs.existsSync(appDir)) {
		throw new Error(`apps/${name} does not exist — run "forge scaffold" first.`);
	}

	const sources = readSoundSources(sourceDir);
	if (!sources.length) {
		throw new Error(
			`No audio files in ${sourceDir}.\n\n` +
				`Name each file after the sound it is: bgm_main.wav, sfx_btn_spin.wav.\n` +
				`The filename becomes the sprite key, and that is what the game plays by.`,
		);
	}

	const manifest = readSoundManifest(sourceDir);

	// ── measure ───────────────────────────────────────────────────────────────
	const ffmpeg = findFfmpeg();
	if (!ffmpeg.ok) throw new Error(ffmpeg.why);

	const clips = [];
	const unreadable = [];
	for (const source of sources) {
		const durationMs = probeDuration(source.file);
		if (durationMs === null || durationMs <= 0) {
			unreadable.push(source);
			continue;
		}
		const override = manifest[source.name] ?? {};
		clips.push({
			...source,
			durationMs,
			loop: override.loop ?? looksLooping(source.name),
			volume: override.volume ?? 1,
		});
	}

	const plan = planSprite(clips);

	// ── reconcile against what this game actually plays ────────────────────────
	// The point of doing this here rather than at audit time is that it is
	// actionable NOW: you are holding the folder the missing file goes in.
	const vocabulary = readSoundVocabulary(appDir);
	const allowed = new Set([...vocabulary.music, ...vocabulary.effects]);
	const used = readSoundsUsed(appDir);
	const supplied = new Set(clips.map((c) => c.name));

	const missing = [...used.keys()].filter((n) => allowed.has(n) && !supplied.has(n)).sort();
	const unknown = clips.filter((c) => allowed.size && !allowed.has(c.name)).map((c) => c.name);
	const unused = clips.filter((c) => !used.has(c.name)).map((c) => c.name);

	console.log(chalk.bold(`\nAudio sprite — ${name}\n`));
	console.log(`  ${clips.length} clip(s) · ${(plan.totalMs / 1000).toFixed(0)}s timeline`);
	const looping = clips.filter((c) => c.loop);
	if (looping.length) console.log(chalk.dim(`  looping: ${looping.map((c) => c.name).join(', ')}`));
	console.log('');

	for (const source of unreadable) {
		console.log(chalk.red('ERROR'), `${path.basename(source.file)} — ffmpeg could not read it`);
	}
	for (const missed of missing) {
		console.log(
			chalk.red('ERROR'),
			`${missed} is played by this game but has no file here — it will be SILENT, with no error`,
		);
	}
	for (const extra of unknown) {
		console.log(
			chalk.yellow('WARN '),
			`${extra} is not in src/game/sound.ts's names — a typo, or a sound nothing can play yet`,
		);
	}
	if (unused.length) {
		console.log(chalk.dim(`  ${unused.length} supplied but never played: ${unused.join(', ')}`));
	}
	if (missing.length || unreadable.length || unknown.length || unused.length) console.log('');

	if (dryRun) {
		console.log(chalk.dim('  --dry-run: nothing written. Planned layout:\n'));
		for (const entry of plan.entries) {
			console.log(
				chalk.dim(
					`    ${entry.name.padEnd(28)} ${String(entry.start).padStart(7)}ms  ` +
						`${entry.durationMs.toFixed(0).padStart(7)}ms${entry.loop ? '  loop' : ''}`,
				),
			);
		}
		console.log('');
		return { ok: missing.length === 0 && unreadable.length === 0, plan, written: false };
	}

	if (unreadable.length) {
		throw new Error('Some files could not be read. Fix or remove them and run again.');
	}

	const outDir = path.join(appDir, 'static', 'assets', 'audio');
	const result = buildSprite({ plan, outDir, onLine: (line) => console.log(chalk.dim(line)) });

	console.log('');
	console.log(chalk.green('✓'), `wrote ${path.relative(sdkDir, result.jsonFile)}`);
	console.log(
		chalk.green('✓'),
		`${result.written.length} format(s): ${result.written.map((w) => w.ext).join(', ')}`,
	);

	if (missing.length) {
		console.log(
			chalk.yellow(
				`\n${missing.length} sound(s) the game plays are still missing from the sprite. ` +
					`They will play nothing.\n`,
			),
		);
	} else {
		console.log(chalk.green('\nEvery sound this game plays is in the sprite.\n'));
	}

	return { ok: missing.length === 0, plan, written: true, ...result, missing, unknown, unused };
}
