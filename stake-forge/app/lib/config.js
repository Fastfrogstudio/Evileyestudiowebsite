/**
 * Workspace configuration — where the SDK checkouts and your games live.
 *
 * Kept in one JSON file next to the app rather than scattered across command
 * flags, because the whole point of the app is that you set these once and then
 * never think about paths again.
 */

import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';

const CONFIG_DIR = path.join(os.homedir(), '.stake-forge');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

const DEFAULTS = {
	/** Folder holding one directory per game (each with a game-spec.yaml). */
	workspace: '',
	/** Checkout of StakeEngine/web-sdk. */
	webSdk: '',
	/** Checkout of StakeEngine/math-sdk. */
	mathSdk: '',
	/** Python to verify with; blank means auto-detect <mathSdk>/.venv/bin/python. */
	python: '',
	/**
	 * Rounds to simulate per bet mode.
	 *
	 * 1000 is an iteration number, not a release number: it runs in a second or
	 * two and is enough to prove the maths executes and to see the shape of the
	 * paytable. Real RTP figures need hundreds of thousands, and the optimiser.
	 */
	sims: 1000,

	// ── image generation ────────────────────────────────────────────────────
	// The vendor contract is the one unsettled thing in the art pipeline, so all
	// three parts of it are settings rather than code. A new model version is a
	// config change; a different provider is an edit to one adapter.
	//
	// The key is stored here in the same file as the paths, which is a local-only
	// app on a local-only port — but it IS a secret sitting on disk, so the app
	// never sends it back to the browser.
	imageEndpoint: '',
	imageApiKey: '',
	imageModel: 'seedance-2.5',
};

/** Config keys that must never be sent to the browser. */
export const SECRET_KEYS = ['imageApiKey'];

/** The config with secrets replaced by whether they are set. */
export function redactConfig(config) {
	const out = { ...config };
	for (const key of SECRET_KEYS) {
		out[`${key}Set`] = Boolean(out[key]);
		delete out[key];
	}
	return out;
}

export function loadConfig() {
	if (!fs.existsSync(CONFIG_PATH)) return { ...DEFAULTS, _path: CONFIG_PATH, _exists: false };
	try {
		const stored = fs.readJsonSync(CONFIG_PATH);
		return { ...DEFAULTS, ...stored, _path: CONFIG_PATH, _exists: true };
	} catch {
		return { ...DEFAULTS, _path: CONFIG_PATH, _exists: false };
	}
}

export function saveConfig(next) {
	fs.ensureDirSync(CONFIG_DIR);
	const clean = {};
	for (const key of Object.keys(DEFAULTS)) {
		clean[key] = next[key] ?? DEFAULTS[key];
	}
	// The settings form posts every field as a string. A sims of "1000" would be
	// passed straight to --sims and parsed fine, but an empty or non-numeric one
	// would become NaN and the simulation would produce nothing at all.
	const sims = Math.floor(Number(clean.sims));
	clean.sims = Number.isFinite(sims) && sims > 0 ? sims : DEFAULTS.sims;
	fs.writeJsonSync(CONFIG_PATH, clean, { spaces: 2 });
	return loadConfig();
}

/**
 * Check each configured path actually points at what it claims to be, and say
 * precisely what is wrong when it does not — a wrong --sdk path was the single
 * most common way to waste time with the CLI.
 */
export function validateConfig(config) {
	const problems = [];

	const checkDir = (key, label, marker, markerLabel) => {
		const value = config[key];
		if (!value) {
			problems.push({ key, level: 'error', message: `${label} is not set` });
			return;
		}
		if (!fs.existsSync(value)) {
			problems.push({ key, level: 'error', message: `${label} does not exist: ${value}` });
			return;
		}
		if (marker && !fs.existsSync(path.join(value, marker))) {
			problems.push({
				key,
				level: 'error',
				message: `${value} has no ${marker} — that does not look like ${markerLabel}`,
			});
		}
	};

	checkDir('webSdk', 'web-sdk path', 'apps', 'a checkout of StakeEngine/web-sdk');
	checkDir('mathSdk', 'math-sdk path', 'games', 'a checkout of StakeEngine/math-sdk');

	if (!config.workspace) {
		problems.push({ key: 'workspace', level: 'error', message: 'Games folder is not set' });
	} else if (!fs.existsSync(config.workspace)) {
		problems.push({
			key: 'workspace',
			level: 'warn',
			message: `Games folder does not exist yet: ${config.workspace} (it will be created)`,
		});
	}

	// A freshly scaffolded app is a new pnpm workspace package with no linked
	// node_modules until pnpm install is re-run, and that produces dozens of
	// meaningless type errors. Worth flagging up front rather than at verify time.
	if (config.webSdk && fs.existsSync(config.webSdk) && !fs.existsSync(path.join(config.webSdk, 'node_modules'))) {
		problems.push({
			key: 'webSdk',
			level: 'warn',
			message: 'web-sdk has no node_modules — run `pnpm install` in it before previewing or type-checking',
		});
	}

	if (config.mathSdk && fs.existsSync(config.mathSdk)) {
		const venv = path.join(config.mathSdk, '.venv', 'bin', 'python');
		if (!config.python && !fs.existsSync(venv)) {
			problems.push({
				key: 'python',
				level: 'warn',
				message:
					'no .venv found in math-sdk and no Python set — verification will fall back to python3, ' +
					'which may be older than the 3.12 the SDK needs',
			});
		}
	}

	return problems;
}

/** Best guess at each path, so first-run setup is mostly confirming. */
export function guessPaths(from = process.cwd()) {
	const guesses = { webSdk: '', mathSdk: '', workspace: '' };
	// Look beside and above the tool, which is how the SDKs are normally laid out.
	const roots = [from, path.dirname(from), path.dirname(path.dirname(from)), os.homedir()];
	for (const root of roots) {
		for (const [key, marker] of [
			['webSdk', path.join('web-sdk', 'apps')],
			['mathSdk', path.join('math-sdk', 'games')],
		]) {
			if (guesses[key]) continue;
			const candidate = path.join(root, marker);
			if (fs.existsSync(candidate)) guesses[key] = path.dirname(candidate);
		}
	}
	if (guesses.webSdk) guesses.workspace = path.join(path.dirname(guesses.webSdk), 'games');
	return guesses;
}
