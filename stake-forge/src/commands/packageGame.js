import fs from 'fs-extra';
import path from 'node:path';
import zlib from 'node:zlib';
import chalk from 'chalk';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

import { loadGameSpec } from '../lib/loadSpec.js';
import { mathGameId } from './mathScaffold.js';

/**
 * Assemble everything Stake Engine wants uploaded, in one folder.
 *
 * A game is published in two halves, from two different places:
 *
 *   frontend/  the built web app — index.html plus _app, assets and the loader
 *              images beside it
 *   math/      library/publish_files — the compressed books, the optimised
 *              lookup tables and index.json
 *
 * Neither half is much use without the other, and each has a way of looking
 * finished while being quietly broken. This checks for both.
 */

/**
 * The frontend build DOES NOT EXIT.
 *
 * vite writes everything, the adapter prints "✔ done", and then the process
 * sits there forever. This is not something the generated app does — a pristine
 * apps/lines build behaves identically here — so it is treated as a fact about
 * the toolchain rather than a bug to fix.
 *
 * That makes exit code useless as a completion signal. Instead the output is
 * watched for the adapter's own "done" marker, and once seen and the output has
 * gone quiet the process is killed. A build that genuinely fails never prints
 * the marker and is caught by the timeout.
 */
const BUILD_DONE = /Wrote site to|✔ done|✓ built in/;
const QUIET_MS = 4000;

/**
 * Kill a detached child and everything it spawned.
 *
 * A negative pid signals the whole PROCESS GROUP, which is the only way to
 * reach the vite process npx spawned. Falls back to the plain kill if the group
 * is already gone, so a race at exit is not an error.
 */
function killGroup(child) {
	if (!child.pid) return;
	try {
		process.kill(-child.pid, 'SIGKILL');
	} catch {
		try {
			child.kill('SIGKILL');
		} catch {
			// Already gone — nothing to do.
		}
	}
}

export function buildFrontend({ appDir, timeoutMs = 600000, onLine = () => {} }) {
	return new Promise((resolve) => {
		// `detached: true` puts the build in its own PROCESS GROUP, so it can be
		// killed as a group below.
		//
		// Without it this leaked a build on every run. `npx vite build` is npx
		// spawning vite as a CHILD, and since the build never exits on its own,
		// child.kill() killed npx and left vite running forever. One orphan per
		// package run, each holding the workspace and competing for CPU: a build
		// that takes 14 seconds alone was still going after thirteen minutes with
		// two orphans present, which reads exactly like a hang.
		const child = spawn('npx', ['vite', 'build'], {
			cwd: appDir,
			detached: true,
			env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', CI: '1' },
		});

		let sawDone = false;
		let settled = false;
		let quietTimer = null;
		const errors = [];

		const finish = (result) => {
			if (settled) return;
			settled = true;
			clearTimeout(quietTimer);
			clearTimeout(hardTimer);
			killGroup(child);
			resolve(result);
		};

		const hardTimer = setTimeout(
			() => finish({ ok: false, reason: `the build produced no completion marker in ${timeoutMs / 1000}s`, errors }),
			timeoutMs,
		);

		const pump = (stream) => {
			let buffer = '';
			return (chunk) => {
				buffer += chunk.toString();
				const lines = buffer.split('\n');
				buffer = lines.pop() ?? '';
				for (const text of lines) {
					if (!text.trim()) continue;
					// vite writes its normal progress to stderr, so stderr alone is not
					// an error signal. Only lines that name a failure are collected.
					if (/^\s*(error|Error:|\[vite\]:? *error|failed)/i.test(text)) errors.push(text.trim());
					onLine(text);
					if (BUILD_DONE.test(text)) sawDone = true;
				}
				// Restart the quiet clock on every chunk: the build is still talking,
				// so it is not finished yet even if the marker has gone past.
				if (sawDone) {
					clearTimeout(quietTimer);
					quietTimer = setTimeout(() => finish({ ok: true, errors }), QUIET_MS);
				}
			};
		};

		child.stdout.on('data', pump('out'));
		child.stderr.on('data', pump('err'));

		child.on('error', (err) => finish({ ok: false, reason: `could not start the build: ${err.message}`, errors }));
		// If it ever DOES exit — a different toolchain version might — that is the
		// authoritative answer and beats the quiet timer.
		child.on('close', (code) =>
			finish(code === 0 || sawDone ? { ok: true, errors } : { ok: false, reason: `the build exited ${code}`, errors }),
		);
	});
}

/**
 * Collect the built frontend into one folder.
 *
 * The README describes assembling this by hand: take index.html out of
 * .svelte-kit/output/prerendered/pages/ and copy .svelte-kit/output/client/
 * beside it. With adapter-static configured, vite already writes exactly that
 * layout to build/ — so that is used when it is there, and the manual assembly
 * is the fallback for an app configured the other way.
 */
export function collectFrontend({ appDir, outDir }) {
	const built = path.join(appDir, 'build');
	fs.removeSync(outDir);
	fs.ensureDirSync(outDir);

	if (fs.existsSync(path.join(built, 'index.html'))) {
		fs.copySync(built, outDir);
		return { from: 'build/', assembled: false };
	}

	const indexHtml = path.join(appDir, '.svelte-kit', 'output', 'prerendered', 'pages', 'index.html');
	const client = path.join(appDir, '.svelte-kit', 'output', 'client');
	if (!fs.existsSync(indexHtml) || !fs.existsSync(client)) {
		throw new Error(
			`The build produced no index.html. Looked in build/ and in ` +
				`.svelte-kit/output/prerendered/pages/. Nothing to package.`,
		);
	}
	fs.copySync(client, outDir);
	fs.copySync(indexHtml, path.join(outDir, 'index.html'));
	return { from: '.svelte-kit/output/', assembled: true };
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/**
 * Check the math half is actually publishable, rather than merely present.
 *
 * Three ways it looks finished and is not, each of which produces a folder that
 * uploads cleanly and then does the wrong thing:
 *
 *   1. index.json names books_<mode>.jsonl.zst, which only exist when the
 *      simulation was run WITH compression. Without it the index points at
 *      files that are not there.
 *   2. config.json records a sha256 of the compressed books. With no compressed
 *      books it records "" — the SDK only warns — and the upload carries a
 *      checksum of nothing.
 *   3. The lookup tables in publish_files are a byte-for-byte copy of the raw
 *      ones until the optimiser has run. Uploading those publishes a game with
 *      whatever RTP the raw simulation happened to have, which is not the
 *      target and is usually wildly above it.
 */
/**
 * Are these two lookup tables from the same simulation?
 *
 * The optimiser rewrites the WEIGHT column and nothing else — verified against a
 * live optimised game, where the id and payout columns were identical in both
 * files and only the weights differed. So the id+payout pair is an exact
 * fingerprint of the simulation that produced them.
 *
 * Returns null when they match, or a human description of the first divergence.
 */
export function staleAgainst(rawFile, publishedFile) {
	const read = (file) =>
		fs
			.readFileSync(file, 'utf8')
			.split('\n')
			.map((l) => l.trim())
			.filter(Boolean)
			.map((l) => l.split(','));

	const raw = read(rawFile);
	const published = read(publishedFile);

	if (raw.length !== published.length) {
		return `${published.length} rows against the simulation's ${raw.length}`;
	}
	for (let i = 0; i < raw.length; i += 1) {
		// Column 0 is the simulation id, column 2 the payout. Column 1 is the
		// weight, which the optimiser is supposed to change.
		if (raw[i][0] !== published[i][0]) {
			return `row ${i + 1} is simulation ${published[i][0]}, the books have ${raw[i][0]}`;
		}
		if (raw[i][2] !== published[i][2]) {
			return `simulation ${raw[i][0]} pays ${raw[i][2]} in the books and ${published[i][2]} in the published table`;
		}
	}
	return null;
}

export async function inspectMathPublish({ gameDir, gameId, onProgress = null }) {
	const publish = path.join(gameDir, 'library', 'publish_files');
	const problems = [];
	const files = [];

	if (!fs.existsSync(publish)) {
		return { ok: false, publish, files, problems: ['no library/publish_files — run "forge math:run" first'] };
	}

	const indexFile = path.join(publish, 'index.json');
	if (!fs.existsSync(indexFile)) {
		problems.push('publish_files/index.json is missing — the RGS reads this first');
		return { ok: false, publish, files, problems };
	}

	const index = fs.readJsonSync(indexFile);
	for (const mode of index.modes ?? []) {
		for (const key of ['events', 'weights']) {
			const named = mode[key];
			if (!named) {
				problems.push(`index.json mode "${mode.name}" has no ${key} entry`);
				continue;
			}
			const file = path.join(publish, named);
			if (!fs.existsSync(file)) {
				problems.push(
					key === 'events'
						? `${named} is missing — index.json names the COMPRESSED books, which only exist ` +
							`when the simulation ran with compression. Re-run: forge math:run --compress`
						: `${named} is missing — the optimiser writes it. Run "forge math:optimise".`,
				);
				continue;
			}
			files.push({ name: named, bytes: fs.statSync(file).size });
		}
	}

	// The optimiser check: publish_files' table is a copy of the raw one until it
	// has run, so its presence proves nothing and it has to be compared.
	const rawDir = path.join(gameDir, 'library', 'lookup_tables');
	const rows = (file) => fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).length;
	let optimised = false;
	for (const mode of index.modes ?? []) {
		const raw = path.join(rawDir, `lookUpTable_${mode.name}.csv`);
		const published = path.join(publish, mode.weights ?? '');
		if (!fs.existsSync(raw) || !fs.existsSync(published)) continue;
		if (fs.readFileSync(raw, 'utf8') !== fs.readFileSync(published, 'utf8')) optimised = true;

		// A STALE optimisation: simulate, optimise, then re-simulate, and the
		// published table still describes the OLD set of rounds. It looks
		// optimised — it genuinely differs from the raw table — but its weights
		// index rounds that are no longer the rounds the books serve, so the RGS
		// would pay a distribution nobody computed. Nothing else in the pipeline
		// catches this: every file is present, well-formed and internally
		// consistent.
		//
		// The first version of this check compared ROW COUNTS, on the reasoning
		// that the optimiser only reweights rows so a count difference is the
		// only way they can diverge. That is wrong in the case that actually
		// happens: re-running math:run at the SAME sims count produces the same
		// number of rows and completely different rounds.
		//
		// The payout column is the real fingerprint. Verified against a live
		// optimised game: the optimiser preserves the id and payout columns
		// exactly and rewrites only the weight. So if the payouts differ at all,
		// the two files came from different simulations.
		const stale = staleAgainst(raw, published);
		if (stale) {
			problems.push(
				`${path.basename(published)} was optimised against a DIFFERENT simulation than the ` +
					`books beside it (${stale}). Its weights index rounds the books no longer contain, ` +
					`so the game would pay a distribution nobody computed. Re-run ` +
					`"forge math:optimise" against the current simulation.`,
			);
		}
	}
	if (!optimised && (index.modes ?? []).length) {
		problems.push(
			'the lookup tables are the RAW simulation, not the optimised ones — this game would ' +
				'publish at whatever RTP the simulation happened to produce. Run "forge math:optimise".',
		);
	}

	// The empty-hash check. config.json lives in configs/, not publish_files.
	const configFile = path.join(gameDir, 'library', 'configs', 'config.json');
	if (fs.existsSync(configFile)) {
		try {
			const config = fs.readJsonSync(configFile);
			for (const mode of config.bookShelfConfig ?? config.modes ?? []) {
				const declared = mode.booksFile?.sha256;
				if (declared === '') {
					problems.push(
						`config.json records an EMPTY sha256 for "${mode.name ?? '?'}" — it is hashing a ` +
							`compressed books file that does not exist. Re-run: forge math:run --compress`,
					);
				} else if (declared) {
					const booksFile = path.join(publish, mode.booksFile.file ?? '');
					if (fs.existsSync(booksFile) && sha256(booksFile) !== declared) {
						problems.push(
							`config.json's sha256 for "${mode.name}" does not match the file in publish_files — ` +
								`the books were rebuilt after the config was written. Re-run "forge math:run".`,
						);
					}
				}
			}
		} catch {
			problems.push('library/configs/config.json could not be parsed');
		}
	}

	// ── the RGS contract, from docs/rgs_docs/data_format.md ─────────────────
	// Everything above asks whether the pipeline finished. This asks whether the
	// bundle satisfies the format Stake Engine actually validates on upload —
	// which is a different question, and the one nobody can answer by looking at
	// the folder.
	//
	// The doc calls index.json's form "strictly enforced" and requires the CSV to
	// hold "rows of uint64 values". The check that matters most is the last one:
	//
	//   "We require the payoutMuliplier value in the third column to exactly match
	//    those provided in the game-logic file. These values are extracted and
	//    hashed to ensure identical payoutMultiplier values."
	//
	// So a bundle where the CSV and the books disagree by one row is rejected on
	// upload, and nothing local would have told you. The books are zstd-compressed
	// jsonl, so that comparison needs a decompressor — when one is not available
	// the check says so rather than passing silently.
	for (const mode of index.modes ?? []) {
		if (typeof mode.name !== 'string' || !mode.name) {
			problems.push('index.json has a mode with no "name" — the form is strictly enforced');
		}
		// A JSON integer parses as a JS number either way, so this reads the raw
		// text: `"cost": 1` is an int on the wire and the doc asks for a float.
		if (typeof mode.cost !== 'number') {
			problems.push(`index.json mode "${mode.name}" has no numeric "cost"`);
		}
		if (mode.events && !String(mode.events).endsWith('.jsonl.zst')) {
			problems.push(
				`index.json mode "${mode.name}" names "${mode.events}" — the RGS requires ` +
					`zStandard-compressed jsonl (.jsonl.zst)`,
			);
		}

		const weightsFile = path.join(publish, mode.weights ?? '');
		if (!fs.existsSync(weightsFile)) continue;
		const rows = fs
			.readFileSync(weightsFile, 'utf8')
			.split('\n')
			.map((l) => l.trim())
			.filter(Boolean);
		const malformed = rows.findIndex(
			(line) => !/^\d+,\d+,\d+$/.test(line),
		);
		if (malformed !== -1) {
			problems.push(
				`${mode.weights} line ${malformed + 1} is not three unsigned integers ` +
					`("${rows[malformed].slice(0, 60)}"). The RGS reads these as uint64 to avoid ` +
					`floating-point ambiguity, so a decimal or a negative is rejected.`,
			);
			continue;
		}

		// The hashed comparison. This is the check that decides an upload, and the
		// only one here that reads inside the compressed books.
		const booksFile = path.join(publish, mode.events ?? '');
		if (!fs.existsSync(booksFile)) continue;

		// ── read the books as a STREAM, not as a string ─────────────────────
		// zstdDecompressSync(...).toString() worked on every test game and fails
		// on every real one. A 40MB compressed bonus mode expands past V8's
		// maximum string length (about 512MB), and the error it throws —
		// "Cannot create a string longer than 0x1fffffe8 characters" — was
		// reported as the FILE being undecompressable: "the RGS reads it as
		// zStandard, so if this fails here it fails there". Exactly backwards.
		// The file is fine; the check could not hold it.
		//
		// A bundle blocked from upload by its own verifier, with a message
		// blaming the file, is the worst failure this command has. So the books
		// are decompressed through a stream and consumed a line at a time, which
		// is also how the RGS reads them.
		const bookPayouts = new Map();
		let round = 0;
		let readError = null;
		// ── say something during a check that takes minutes ──────────────────
		// Measured throughput is about 5 MB/s of compressed books, because every
		// round is decompressed and parsed. On this tool's own two-mode sample
		// that is 9 seconds; on a real production game — 8 modes and 3.6 GB, from
		// a shipped title — it is closer to twelve minutes. Silent for twelve
		// minutes is indistinguishable from hung, and a user who kills it never
		// finds out their bundle was fine.
		const totalBytes = fs.statSync(booksFile).size;
		let seenBytes = 0;
		let nextReport = 0;
		try {
			await new Promise((resolve, reject) => {
				const source = fs.createReadStream(booksFile).pipe(zlib.createZstdDecompress());
				let carry = '';
				const consume = (line) => {
					if (!line.trim()) return;
					round += 1;
					let parsed;
					try {
						parsed = JSON.parse(line);
					} catch {
						problems.push(`${mode.events} round ${round} is not valid JSON — the RGS reads jsonl`);
						return;
					}
					// "The three JSON key fields: id, events, payoutMultipler are
					// required for every round returned."
					for (const key of ['id', 'events', 'payoutMultiplier']) {
						if (!(key in parsed)) {
							problems.push(
								`${mode.events} round ${round} has no "${key}" — the RGS requires id, events ` +
									`and payoutMultiplier on every round`,
							);
							return;
						}
					}
					bookPayouts.set(parsed.id, parsed.payoutMultiplier);
				};

				source.on('data', (chunk) => {
					seenBytes += chunk.length;
					if (onProgress && seenBytes >= nextReport) {
						// By decompressed bytes against the compressed size, so the
						// percentage overshoots rather than stalling near the end — a
						// progress bar that sticks at 90% reads as hung too.
						onProgress({
							mode: mode.name,
							file: mode.events,
							rounds: round,
							bytes: seenBytes,
							totalBytes,
						});
						nextReport = seenBytes + 64 * 1024 * 1024;
					}
					carry += chunk.toString('utf8');
					let cut = carry.indexOf('\n');
					while (cut !== -1) {
						consume(carry.slice(0, cut));
						carry = carry.slice(cut + 1);
						cut = carry.indexOf('\n');
					}
				});
				source.on('end', () => {
					consume(carry);
					resolve();
				});
				source.on('error', reject);
			});
		} catch (err) {
			readError = err;
		}
		if (readError) {
			problems.push(
				`${mode.events} could not be decompressed (${readError.message}). The RGS reads it as ` +
					`zStandard, so if this fails here it fails there.`,
			);
			continue;
		}

		let mismatched = 0;
		let orphaned = 0;
		let firstMismatch = null;
		for (const line of rows) {
			const [id, , payout] = line.split(',').map(Number);
			if (!bookPayouts.has(id)) {
				orphaned += 1;
				continue;
			}
			if (bookPayouts.get(id) !== payout) {
				mismatched += 1;
				if (!firstMismatch) {
					firstMismatch = `id ${id}: table says ${payout}, books say ${bookPayouts.get(id)}`;
				}
			}
		}
		if (orphaned) {
			problems.push(
				`${mode.weights} names ${orphaned} simulation id(s) the books do not contain. The RGS ` +
					`reads a round by id, so those rows point at nothing.`,
			);
		}
		if (mismatched) {
			problems.push(
				`${mode.weights} disagrees with ${mode.events} on ${mismatched} payout(s) ` +
					`(${firstMismatch}). The RGS extracts and HASHES the third column against the ` +
					`books' payoutMultiplier, so this bundle is rejected on upload.`,
			);
		}
	}

	return { ok: problems.length === 0, publish, files, problems, optimised, index };
}

function folderSize(dir) {
	let total = 0;
	const walk = (d) => {
		for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
			const full = path.join(d, entry.name);
			if (entry.isDirectory()) walk(full);
			else total += fs.statSync(full).size;
		}
	};
	if (fs.existsSync(dir)) walk(dir);
	return total;
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export async function packageGame({ specPath, sdkDir, mathSdkDir, outDir, skipBuild, onLine }) {
	const spec = loadGameSpec(specPath);
	const log = onLine ?? ((...parts) => console.log(...parts));
	const gameId = mathGameId(spec);

	const appDir = path.join(sdkDir, 'apps', spec.game.name);
	if (!fs.existsSync(appDir)) {
		throw new Error(`apps/${spec.game.name} does not exist — run "forge scaffold" first.`);
	}

	const target = outDir ?? path.join(path.dirname(specPath), 'upload');
	log(chalk.bold(`\nPackaging "${spec.game.name}" for upload\n`));

	// ── frontend ──────────────────────────────────────────────────────────────
	if (skipBuild) {
		log(chalk.yellow('·'), 'skipping the build — packaging whatever is already built');
	} else {
		log(chalk.dim('  Building the frontend. This does not exit on its own; see the note in'));
		log(chalk.dim('  packageGame.js — completion is detected from the output.\n'));
		const build = await buildFrontend({ appDir, onLine: (text) => log(chalk.dim(`  ${text}`)) });
		if (!build.ok) {
			log(chalk.red(`\n✗ ${build.reason}`));
			for (const error of build.errors.slice(0, 12)) log(chalk.red(`    ${error}`));
			if (!build.errors.length) {
				log(
					chalk.dim(
						'\n  No error line was printed either. The usual cause is a web-sdk without\n' +
							'  node_modules — run `pnpm install` in the checkout and try again.\n',
					),
				);
			}
			return { ok: false, error: build.reason };
		}
	}

	const frontendOut = path.join(target, 'frontend');
	const collected = collectFrontend({ appDir, outDir: frontendOut });
	const frontendBytes = folderSize(frontendOut);

	log(chalk.green('\n✓'), `frontend/ — ${mb(frontendBytes)} from ${collected.from}`);
	if (collected.assembled) {
		log(chalk.dim('    assembled by hand from prerendered + client, as the README describes'));
	}

	// A frontend without index.html at its ROOT is the one mistake that makes the
	// upload silently serve nothing.
	if (!fs.existsSync(path.join(frontendOut, 'index.html'))) {
		log(chalk.red('ERROR'), 'frontend/index.html is missing — this would upload and serve nothing');
	}

	// ── math ──────────────────────────────────────────────────────────────────
	const mathGameDir = path.join(mathSdkDir, 'games', gameId);
	// A terminal can have a line rewritten; a captured stream cannot.
	const interactive = Boolean(process.stdout.isTTY);
	const inspection = await inspectMathPublish({
		gameDir: mathGameDir,
		gameId,
		// Rounds read, not a percentage: the compressed size says nothing about how
		// many rounds are inside, and a number that only goes up is honest where a
		// percentage derived from the wrong denominator is not.
		//
		// Rewritten in place on a terminal, appended as ordinary lines when it is
		// not. The app's Build tab captures this stream and renders it line by
		// line, so a carriage return there produces one enormous line that grows —
		// which is worse than no progress at all.
		onProgress: interactive
			? ({ mode, rounds }) => {
					process.stdout.write(`\r  reading ${mode} — ${rounds.toLocaleString()} rounds checked`);
				}
			: ({ mode, rounds }) => {
					if (rounds) console.log(`  reading ${mode} — ${rounds.toLocaleString()} rounds checked`);
				},
	});
	if (interactive) process.stdout.write(`\r${' '.repeat(58)}\r`);

	const mathOut = path.join(target, 'math');
	fs.removeSync(mathOut);
	if (fs.existsSync(inspection.publish)) {
		fs.copySync(inspection.publish, mathOut);
		log(chalk.green('✓'), `math/ — ${mb(folderSize(mathOut))}, ${inspection.files.length} file(s)`);
		for (const file of inspection.files) {
			log(chalk.dim(`    ${file.name.padEnd(30)} ${mb(file.bytes)}`));
		}
	}

	for (const problem of inspection.problems) {
		log(chalk.red('ERROR'), problem);
	}

	// A short note next to the folder, because the two halves are uploaded in
	// different places and it is easy to upload one and think you are done.
	fs.writeFileSync(
		path.join(target, 'README.txt'),
		`${spec.game.name} — built by stake-forge on ${new Date().toISOString()}\n\n` +
			`Two uploads, in two different places on engine.stake.com:\n\n` +
			`  frontend/   Files page → import the whole folder → Publish Game → Front End\n` +
			`  math/       the RGS files: books, lookup tables and index.json\n\n` +
			`Both halves have to come from the same run. If you re-simulate the maths,\n` +
			`re-package and upload both — a frontend built against different books will\n` +
			`play events the RGS never sends.\n`,
		'utf8',
	);

	const ok = inspection.ok && fs.existsSync(path.join(frontendOut, 'index.html'));
	log('');
	if (ok) {
		log(chalk.green(`Ready to upload: ${target}`));
		log(
			chalk.dim(
				'\n  Both halves go up separately on engine.stake.com — the frontend on the\n' +
					'  Files page, the math as the RGS files. README.txt in the folder says so too.\n',
			),
		);
	} else {
		log(chalk.red(`Not ready to upload. ${inspection.problems.length} problem(s) above.\n`));
	}

	return { ok, target, frontendBytes, inspection };
}
