/**
 * Pipeline view — run the build steps and watch the output.
 *
 * Each step shells out to the same `forge` CLI a terminal would run, and the
 * exact command is echoed into the log, so anything seen here can be pasted
 * into a shell and reproduced.
 */

import { h, mount, clear, toast } from '../lib.js';

export function renderPipeline(ctx) {
	const { game, registry, config } = ctx;
	const state = ctx.pipeline;

	const log = h('div.log', state.lines.map(logLine));
	const stepsEl = h('div');

	const scrollLog = () => { log.scrollTop = log.scrollHeight; };

	function blockedReason(step) {
		for (const need of step.needs) {
			if (need === 'mathSdk' && !config.mathSdk) return 'math-sdk path not set (Settings)';
			if (need === 'webSdk' && !config.webSdk) return 'web-sdk path not set (Settings)';
			if (need === 'manifest' && !game.hasManifest) {
				return 'no assets-manifest.yaml yet — run "Generate placeholder art" first';
			}
			if (need === 'scaffolded' && !game.scaffolded?.web) return 'web app not scaffolded yet';
		}
		if (!game.valid) return 'the spec has errors — fix those first';
		return null;
	}

	async function run(stepId) {
		if (state.running) return toast('A step is already running', 'err');
		state.running = stepId;
		state.results[stepId] = 'running';
		renderSteps();

		state.lines.push({ stream: 'meta', text: `\n── ${registry.steps.find((s) => s.id === stepId).title} ──` });
		mount(log, state.lines.map(logLine));
		scrollLog();

		await new Promise((resolve) => {
			const source = new EventSource(`/api/games/${game.id}/run/${encodeURIComponent(stepId)}`);
			source.addEventListener('line', (e) => {
				state.lines.push(JSON.parse(e.data));
				if (state.lines.length > 4000) state.lines.splice(0, state.lines.length - 4000);
				mount(log, state.lines.map(logLine));
				scrollLog();
			});
			source.addEventListener('done', (e) => {
				const { code } = JSON.parse(e.data);
				state.results[stepId] = code === 0 ? 'done' : 'failed';
				source.close();
				resolve();
			});
			source.onerror = () => {
				state.results[stepId] = 'failed';
				state.lines.push({ stream: 'err', text: 'connection to the server was lost' });
				source.close();
				resolve();
			};
		});

		state.running = null;
		renderSteps();
		ctx.refreshGame();

		const result = state.results[stepId];
		toast(
			`${registry.steps.find((s) => s.id === stepId).title}: ${result === 'done' ? 'done' : 'failed'}`,
			result === 'done' ? 'ok' : 'err',
		);
	}

	async function runAll() {
		for (const step of registry.steps) {
			if (blockedReason(step)) continue;
			await run(step.id);
			if (state.results[step.id] === 'failed') {
				toast('Stopped — a step failed', 'err');
				return;
			}
		}
	}

	function renderSteps() {
		mount(
			stepsEl,
			registry.steps.map((step, i) => {
				const blocked = blockedReason(step);
				const status = state.results[step.id];
				return h(
					`div.step${blocked ? '.blocked' : ''}${status ? `.${status}` : ''}`,
					h('div.step-num', status === 'running' ? h('span.spin', '◌') : status === 'done' ? '✓' : status === 'failed' ? '✕' : String(i + 1)),
					h('div.step-body',
						h('div.step-title', step.title),
						h('div.step-blurb', blocked ? h('span.dim', blocked) : step.blurb),
					),
					h('button.btn.btn-small', {
						disabled: Boolean(blocked) || Boolean(state.running),
						onclick: () => run(step.id),
					}, status === 'done' ? 'Re-run' : 'Run'),
				);
			}),
		);
	}

	renderSteps();

	return h('div',
		h('div.card',
			h('div.row',
				h('h2', { style: 'margin:0' }, 'Build'),
				h('div.spacer'),
				h('button.btn', {
					onclick: () => { state.lines.length = 0; mount(log); },
				}, 'Clear log'),
				h('button.btn.btn-primary', {
					disabled: Boolean(state.running) || !game.valid,
					onclick: runAll,
				}, 'Run all'),
			),
			h('p.card-sub', 'Each step runs the same command the CLI does — the exact line is echoed into the log.'),
			stepsEl,
		),
		h('div.card', h('h2', 'Output'), h('p.card-sub', 'Live, as it happens.'), log),
	);
}

function logLine(line) {
	let kind = line.stream === 'err' ? 'err' : line.stream === 'meta' ? 'meta' : '';
	// The CLI marks outcomes with these, and colouring them makes a long run
	// scannable at a glance rather than a wall of text.
	if (!kind && /^\s*✓|PASS/.test(line.text)) kind = 'ok';
	if (!kind && /^\s*!|WARN|^\s*·/.test(line.text)) kind = 'warn';
	if (!kind && /FAIL|ERROR|✗/.test(line.text)) kind = 'err';
	return h(`div.log-line.${kind}`, line.text || ' ');
}
