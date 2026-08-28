/**
 * Build the audio sprite from individual sound files.
 *
 * ── The format, read off a real one ──────────────────────────────────────────
 * apps/lines ships static/assets/audio/sounds.{ogg,m4a,mp3,ac3} plus a
 * sounds.json of millisecond offsets into that one timeline:
 *
 *   { "sprite": { "bgm_main": [71000, 132452.83, true], "sfx_btn_spin": [...] },
 *     "src":    ["./assets/audio/sounds.ogg", ".m4a", ".mp3", ".ac3"],
 *     "config": { "bgm_main": { "volume": 1 } } }
 *
 * Everything below matches what that file actually does, measured rather than
 * assumed:
 *   * every clip starts on a WHOLE SECOND
 *   * with at least a 1s gap after the previous clip ends — the observed gaps
 *     run from ~1000ms to 1999ms, which is exactly what "round the second up
 *     after a 1s pad" produces
 *   * the third element is the loop flag, present only on the 8 clips that loop
 *   * every entry has {volume: 1}
 *
 * The padding is not decoration. A sprite is one long file seeked into, and
 * browsers seek imprecisely; without the gap a clip bleeds into the next one.
 */

import fs from 'fs-extra';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** Formats the web-sdk ships, in the order sounds.json lists them. */
export const SPRITE_FORMATS = [
	{ ext: 'ogg', codec: 'libvorbis', args: ['-q:a', '5'] },
	{ ext: 'm4a', codec: 'aac', args: ['-b:a', '128k'] },
	{ ext: 'mp3', codec: 'libmp3lame', args: ['-q:a', '4'] },
	// AC-3 is the Safari fallback. It has a fixed set of legal bitrates, so this
	// is a real value rather than a rounded-looking one.
	{ ext: 'ac3', codec: 'ac3', args: ['-b:a', '192k'] },
];

/** Anything ffmpeg will decode that anyone actually hands you. */
const AUDIO_EXTENSIONS = ['.wav', '.mp3', '.ogg', '.m4a', '.aac', '.flac', '.aiff', '.aif', '.opus', '.wma'];

/** Padding between clips, before rounding up to the next whole second. */
export const CLIP_GAP_MS = 1000;

export function findFfmpeg() {
	for (const tool of ['ffmpeg', 'ffprobe']) {
		const probe = spawnSync(tool, ['-version'], { encoding: 'utf8' });
		if (probe.error || probe.status !== 0) {
			return {
				ok: false,
				missing: tool,
				why:
					`${tool} is not on PATH. Building an audio sprite means decoding, padding and ` +
					`re-encoding audio into four formats, which is what ffmpeg is for.\n\n` +
					`  macOS    brew install ffmpeg\n` +
					`  Debian   sudo apt-get install ffmpeg\n` +
					`  Windows  winget install Gyan.FFmpeg`,
			};
		}
	}
	return { ok: true };
}

/** Every audio file in a folder, as { name, file } — the filename IS the name. */
export function readSoundSources(dir) {
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir, { withFileTypes: true })
		.filter((e) => e.isFile() && AUDIO_EXTENSIONS.includes(path.extname(e.name).toLowerCase()))
		.map((e) => ({ name: path.basename(e.name, path.extname(e.name)), file: path.join(dir, e.name) }))
		.sort((a, b) => a.name.localeCompare(b.name));
}

/** Clip length in milliseconds, from ffprobe. */
export function probeDuration(file) {
	const probe = spawnSync(
		'ffprobe',
		['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file],
		{ encoding: 'utf8' },
	);
	if (probe.status !== 0) return null;
	const seconds = Number(String(probe.stdout).trim());
	return Number.isFinite(seconds) ? seconds * 1000 : null;
}

/**
 * Should this clip loop?
 *
 * Matches the 8 looping clips in apps/lines exactly: the `bgm_` music beds, and
 * `sfx_bigwin_coinloop`. It is a default, not a rule — an explicit `loop:` in
 * the manifest always wins.
 */
export function looksLooping(name) {
	return /^bgm_/.test(name) || /loop/i.test(name);
}

/**
 * Lay the clips out along one timeline.
 *
 * Whole-second starts with a 1s minimum pad, which is what the shipped sprite
 * does. Order is by name so a rebuild with the same inputs produces byte-stable
 * offsets — a sprite whose offsets shuffle on every build is unreviewable.
 */
export function planSprite(clips, { gapMs = CLIP_GAP_MS } = {}) {
	const entries = [];
	let cursor = 0;

	for (const clip of clips) {
		const start = Math.ceil(cursor / 1000) * 1000;
		entries.push({ ...clip, start });
		cursor = start + clip.durationMs + gapMs;
	}

	return { entries, totalMs: Math.ceil(cursor / 1000) * 1000 };
}

/** The sounds.json a plan produces. */
export function spriteJson(plan, { formats = SPRITE_FORMATS } = {}) {
	const sprite = {};
	const config = {};
	for (const entry of plan.entries) {
		sprite[entry.name] = entry.loop
			? [entry.start, entry.durationMs, true]
			: [entry.start, entry.durationMs];
		config[entry.name] = { volume: entry.volume ?? 1 };
	}
	return {
		sprite,
		// Paths are relative to the app's static/ directory, which is what the
		// loader resolves against — not to the JSON file's own location.
		src: formats.map((f) => `./assets/audio/sounds.${f.ext}`),
		config,
	};
}

/**
 * The ffmpeg filter graph that places each clip at its offset.
 *
 * Every input is resampled and re-laid-out first: mixing a 48kHz mono clip with
 * a 44.1kHz stereo one without that produces a silent or mangled track, and
 * ffmpeg does not warn about it. `adelay` then shifts each clip to its start,
 * and `amix` with normalize=0 sums them — the clips never overlap, so summing
 * is a concatenation, but without normalize=0 amix would divide every sample by
 * the input count and the whole sprite would come out near-silent.
 */
export function buildFilterGraph(entries, { sampleRate = 44100 } = {}) {
	const parts = entries.map(
		(entry, i) =>
			`[${i}:a]aresample=${sampleRate},aformat=sample_fmts=fltp:channel_layouts=stereo,` +
			`adelay=${Math.round(entry.start)}|${Math.round(entry.start)}[a${i}]`,
	);
	const labels = entries.map((_, i) => `[a${i}]`).join('');
	parts.push(`${labels}amix=inputs=${entries.length}:normalize=0:dropout_transition=0[out]`);
	return parts.join(';');
}

/**
 * Build the master timeline as a WAV, then transcode once per format.
 *
 * Two passes rather than four filter-graph runs: the graph is the expensive and
 * fragile part, and running it once means all four formats are guaranteed to
 * describe the same timeline. A per-format graph run that silently differed
 * would put the offsets in sounds.json out of step with one of the files, and
 * that failure is inaudible until the wrong sound plays.
 */
export function buildSprite({ plan, outDir, sampleRate = 44100, onLine = () => {} }) {
	const entries = plan.entries;
	if (!entries.length) throw new Error('No audio files to build a sprite from.');

	fs.ensureDirSync(outDir);
	const master = path.join(outDir, '.sounds-master.wav');

	const inputs = entries.flatMap((entry) => ['-i', entry.file]);
	const graph = buildFilterGraph(entries, { sampleRate });

	onLine(`  mixing ${entries.length} clip(s) into a ${(plan.totalMs / 1000).toFixed(0)}s timeline`);
	const mix = spawnSync(
		'ffmpeg',
		['-y', '-hide_banner', '-loglevel', 'error', ...inputs, '-filter_complex', graph, '-map', '[out]', master],
		{ encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
	);
	if (mix.status !== 0) {
		fs.removeSync(master);
		throw new Error(`ffmpeg could not build the timeline:\n${(mix.stderr || '').trim()}`);
	}

	const written = [];
	for (const format of SPRITE_FORMATS) {
		const out = path.join(outDir, `sounds.${format.ext}`);
		const run = spawnSync(
			'ffmpeg',
			['-y', '-hide_banner', '-loglevel', 'error', '-i', master, '-c:a', format.codec, ...format.args, out],
			{ encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
		);
		if (run.status !== 0) {
			fs.removeSync(master);
			throw new Error(`ffmpeg could not encode ${format.ext}:\n${(run.stderr || '').trim()}`);
		}
		written.push({ ext: format.ext, file: out, bytes: fs.statSync(out).size });
		onLine(`  encoded sounds.${format.ext} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
	}

	fs.removeSync(master);

	const json = spriteJson(plan);
	const jsonFile = path.join(outDir, 'sounds.json');
	fs.writeJsonSync(jsonFile, json, { spaces: 2 });

	return { written, jsonFile, json };
}
