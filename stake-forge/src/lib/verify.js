/**
 * Verification harness.
 *
 * The point of this module is that "the generator produced plausible-looking
 * output" is not evidence. Three levels, cheapest first:
 *
 *   1. py_compile   — the generated Python parses.
 *   2. GameConfig() — the config actually CONSTRUCTS. This catches far more than
 *                     parsing does, because Config.__init__ does real work:
 *                     construct_paths(), read_reels_csv() (so reel files must
 *                     exist and be non-empty), and BetMode/Distribution
 *                     construction. A paytable with a malformed tuple key or a
 *                     reel referencing an unknown symbol dies here.
 *   3. run_spin()   — a real simulated round. This is the only level that proves
 *                     a behavior recipe's runtime code path executes, and it is
 *                     how the "expanding" recipe was validated.
 *
 * The TypeScript side is BASELINE-DIFFERENTIAL, and that is deliberate. Running
 * `tsc --noEmit` on a PRISTINE web-sdk sample app reports dozens of errors —
 * SvelteKit's generated `$app/*` and `$env/*` aliases don't exist outside a
 * `svelte-kit sync`, `*.svelte` module-context type exports aren't visible to
 * plain tsc, and apps/lines itself has genuine pre-existing errors in actor.ts
 * and bookEventHandlerMap.ts. Reporting those against generated code would be
 * noise that hides real regressions. So: typecheck the untouched sample, record
 * that error set, typecheck the generated app, and fail only on errors the
 * baseline did not already have.
 */

import fs from 'fs-extra';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** Locate the python interpreter to verify with. */
export function resolvePython(mathSdkDir, override) {
	if (override) return override;
	const venv = path.join(mathSdkDir, '.venv', 'bin', 'python');
	if (fs.existsSync(venv)) return venv;
	for (const candidate of ['python3.13', 'python3.12', 'python3']) {
		const probe = spawnSync(candidate, ['-c', 'import sys; print(sys.version_info[:2])'], {
			encoding: 'utf8',
		});
		if (probe.status === 0) return candidate;
	}
	return 'python3';
}

/** Level 1: every generated .py file parses. */
export function pyCompile({ gameDir, python }) {
	const files = fs
		.readdirSync(gameDir)
		.filter((f) => f.endsWith('.py'))
		.map((f) => path.join(gameDir, f));

	const result = spawnSync(python, ['-m', 'py_compile', ...files], { encoding: 'utf8' });
	return {
		name: 'py_compile',
		ok: result.status === 0,
		detail: result.status === 0 ? `${files.length} file(s) compiled` : (result.stderr || result.stdout || '').trim(),
	};
}

/**
 * Level 2: GameConfig() constructs for real, and the config it produces matches
 * the spec. Asserting the round-trip is what turns "it ran" into "it ran and
 * produced what was asked for".
 */
export function instantiateGameConfig({ mathSdkDir, gameDir, python, expect }) {
	const script = `
import sys, json, traceback
sys.path.insert(0, ${JSON.stringify(mathSdkDir)})
sys.path.insert(0, ${JSON.stringify(gameDir)})
try:
    from game_config import GameConfig
    c = GameConfig()
    out = {
        "ok": True,
        "game_id": c.game_id,
        "win_type": getattr(c, "win_type", None),
        "num_reels": c.num_reels,
        "num_rows": list(c.num_rows),
        "rtp": c.rtp,
        "wincap": c.wincap,
        "paytable_entries": len(c.paytable),
        "paytable_symbols": sorted({t[1] for t in c.paytable}),
        "special_symbols": {k: list(v) for k, v in c.special_symbols.items()},
        "freespin_triggers": {k: {str(kk): vv for kk, vv in v.items()} for k, v in c.freespin_triggers.items()},
        "bet_modes": [b.get_name() for b in c.bet_modes],
        "reel_strips": sorted(c.reels.keys()),
        "num_paylines": len(getattr(c, "paylines", {}) or {}),
    }
except Exception as exc:
    out = {"ok": False, "error": f"{type(exc).__name__}: {exc}", "traceback": traceback.format_exc()}
print("STAKE_FORGE_JSON:" + json.dumps(out))
`;
	const result = spawnSync(python, ['-c', script], { encoding: 'utf8' });
	const line = (result.stdout || '')
		.split('\n')
		.find((l) => l.startsWith('STAKE_FORGE_JSON:'));

	if (!line) {
		return {
			name: 'GameConfig()',
			ok: false,
			detail: (result.stderr || result.stdout || 'no output from python').trim(),
		};
	}

	const data = JSON.parse(line.slice('STAKE_FORGE_JSON:'.length));
	if (!data.ok) {
		return { name: 'GameConfig()', ok: false, detail: data.error, traceback: data.traceback };
	}

	const mismatches = checkAgainstSpec(data, expect);
	return {
		name: 'GameConfig()',
		ok: mismatches.length === 0,
		detail: mismatches.length
			? `constructed, but does not match the spec:\n    ${mismatches.join('\n    ')}`
			: `constructed: game_id=${data.game_id}, ${data.paytable_entries} paytable entries, ` +
				`${data.bet_modes.length} bet mode(s), ${data.reel_strips.length} reel strip(s)`,
		data,
	};
}

/** Compare what the engine actually built against what the spec asked for. */
function checkAgainstSpec(data, expect) {
	if (!expect) return [];
	const out = [];
	const eq = (label, actual, wanted) => {
		if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
			out.push(`${label}: engine has ${JSON.stringify(actual)}, spec says ${JSON.stringify(wanted)}`);
		}
	};

	eq('game_id', data.game_id, expect.gameId);
	eq('win_type', data.win_type, expect.winType);
	eq('num_reels', data.num_reels, expect.numReels);
	eq('num_rows', data.num_rows, expect.numRows);
	eq('paying symbols', data.paytable_symbols, expect.payingSymbols);

	for (const [key, names] of Object.entries(expect.specialSymbols ?? {})) {
		eq(`special_symbols.${key}`, (data.special_symbols[key] ?? []).sort(), [...names].sort());
	}
	if (expect.betModes) eq('bet modes', data.bet_modes.sort(), [...expect.betModes].sort());
	if (expect.numPaylines !== undefined) eq('payline count', data.num_paylines, expect.numPaylines);

	return out;
}

/**
 * Level 3: run a real simulated round and report the bookEvent types it emitted.
 * `expectEvents` names event types the caller requires to appear — this is how a
 * behavior recipe proves its runtime path is reachable, not just importable.
 */
export function runSpin({ mathSdkDir, gameDir, python, betmode = 'base', criteria = 'freegame', sims = 12, expectEvents = [] }) {
	const script = `
import sys, json, collections, traceback
sys.path.insert(0, ${JSON.stringify(mathSdkDir)})
sys.path.insert(0, ${JSON.stringify(gameDir)})
try:
    from gamestate import GameState
    from game_config import GameConfig
    cfg = GameConfig()
    gs = GameState(cfg)
    gs.betmode = ${JSON.stringify(betmode)}
    gs.criteria = ${JSON.stringify(criteria)}
    counter = collections.Counter()
    rounds = 0
    for sim in range(1, ${sims} + 1):
        gs.run_spin(sim)
        rounds += 1
        for e in gs.book.events:
            counter[e["type"]] += 1
    out = {"ok": True, "rounds": rounds, "events": dict(counter)}
except Exception as exc:
    out = {"ok": False, "error": f"{type(exc).__name__}: {exc}", "traceback": traceback.format_exc()}
print("STAKE_FORGE_JSON:" + json.dumps(out))
`;
	const result = spawnSync(python, ['-c', script], { encoding: 'utf8', timeout: 300000 });
	const line = (result.stdout || '').split('\n').find((l) => l.startsWith('STAKE_FORGE_JSON:'));

	if (!line) {
		return {
			name: `run_spin(${betmode}/${criteria})`,
			ok: false,
			detail: (result.stderr || result.stdout || 'no output from python').trim().slice(0, 2000),
		};
	}

	const data = JSON.parse(line.slice('STAKE_FORGE_JSON:'.length));
	if (!data.ok) {
		return {
			name: `run_spin(${betmode}/${criteria})`,
			ok: false,
			detail: data.error,
			traceback: data.traceback,
		};
	}

	const missing = expectEvents.filter((t) => !data.events[t]);
	return {
		name: `run_spin(${betmode}/${criteria})`,
		ok: missing.length === 0,
		detail: missing.length
			? `ran ${data.rounds} rounds but never emitted: ${missing.join(', ')}\n    saw: ${Object.keys(data.events).join(', ')}`
			: `${data.rounds} rounds, events: ${Object.entries(data.events).map(([k, v]) => `${k}×${v}`).join(', ')}`,
		data,
	};
}

// ── TypeScript ──────────────────────────────────────────────────────────────

/** Find the web-sdk's own pinned tsc rather than whatever npx would fetch. */
export function resolveTsc(webSdkDir) {
	const direct = path.join(webSdkDir, 'node_modules', 'typescript', 'bin', 'tsc');
	if (fs.existsSync(direct)) return direct;

	const pnpmDir = path.join(webSdkDir, 'node_modules', '.pnpm');
	if (fs.existsSync(pnpmDir)) {
		const match = fs
			.readdirSync(pnpmDir)
			.filter((d) => d.startsWith('typescript@'))
			.sort()
			.pop();
		if (match) {
			const p = path.join(pnpmDir, match, 'node_modules', 'typescript', 'bin', 'tsc');
			if (fs.existsSync(p)) return p;
		}
	}
	return null;
}

/** Parse `file(line,col): error TSxxxx: message` into comparable keys. */
function parseTscOutput(output, appName) {
	const errors = new Map();
	for (const raw of output.split('\n')) {
		const line = raw.trimEnd();
		const match = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/.exec(line);
		if (!match) continue;
		const [, file, , , , code, message] = match;
		// Drop the app name so apps/lines and apps/le-bandit compare equal, and
		// drop line/col so an inserted block does not look like a new error.
		const normalisedFile = file.split(path.sep).join('/').replace(new RegExp(`\\b${appName}\\b`, 'g'), '<app>');
		const key = `${normalisedFile}|${code}|${message.replace(/'[^']*'/g, "'…'")}`;
		errors.set(key, { file: normalisedFile, code, message });
	}
	return errors;
}

/**
 * Typecheck `appName` and report only errors absent from `baselineApp`.
 *
 * Both apps are compiled with the same tsc and tsconfig, so anything shared is
 * environmental (missing $app aliases, .svelte type exports) or pre-existing in
 * the sample — neither is caused by generated code.
 */
export function tscDiff({ webSdkDir, appName, baselineApp, tsc }) {
	const run = (app) => {
		const appDir = path.join(webSdkDir, 'apps', app);
		if (!fs.existsSync(appDir)) return null;
		const result = spawnSync(process.execPath, [tsc, '--noEmit', '-p', 'tsconfig.json'], {
			cwd: appDir,
			encoding: 'utf8',
			timeout: 900000,
		});
		return parseTscOutput(`${result.stdout || ''}\n${result.stderr || ''}`, app);
	};

	// A freshly scaffolded app is a NEW pnpm workspace package, so until
	// `pnpm install` is re-run at the web-sdk root it has no node_modules and
	// every workspace import resolves to nothing. That produces dozens of
	// TS2307s that say nothing about the generated code, so detect it and say
	// what to do instead of reporting the noise.
	const appModules = path.join(webSdkDir, 'apps', appName, 'node_modules');
	if (fs.existsSync(path.join(webSdkDir, 'apps', appName)) && !fs.existsSync(appModules)) {
		return {
			name: 'tsc --noEmit',
			ok: false,
			detail:
				`apps/${appName}/node_modules is missing — it is a new workspace package.\n` +
				`    Run:  cd ${webSdkDir} && pnpm install\n` +
				`    then re-run this command. (Without it every workspace import fails to\n` +
				`    resolve and tsc reports dozens of errors unrelated to the generated code.)`,
		};
	}

	const baseline = run(baselineApp);
	if (!baseline) {
		return { name: 'tsc --noEmit', ok: false, detail: `baseline app apps/${baselineApp} not found` };
	}
	const actual = run(appName);
	if (!actual) {
		return { name: 'tsc --noEmit', ok: false, detail: `apps/${appName} not found — run "forge scaffold" first` };
	}

	const introduced = [...actual.entries()].filter(([key]) => !baseline.has(key)).map(([, v]) => v);
	const fixed = [...baseline.keys()].filter((key) => !actual.has(key)).length;

	return {
		name: 'tsc --noEmit',
		ok: introduced.length === 0,
		detail: introduced.length
			? `${introduced.length} NEW error(s) vs the apps/${baselineApp} baseline:\n    ` +
				introduced.slice(0, 25).map((e) => `${e.file}: ${e.code} ${e.message}`).join('\n    ')
			: `no new errors vs apps/${baselineApp} (baseline ${baseline.size} pre-existing, ` +
				`${fixed} not reproduced in the generated app)`,
		introduced,
	};
}
