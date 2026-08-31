import { h, mount, api } from '../lib.js';

/**
 * The Generate tab — art brief in, finished assets out.
 *
 * ── What this is, and what it deliberately is not ───────────────────────────
 * It is not a candidate browser. There is no grid of four options to pick from
 * and no "accepted" folder. The brief says what the house style is, the spec
 * says what this game needs, and each asset is generated straight to the path it
 * belongs at.
 *
 * That is the whole design decision. Picking between candidates moves the work
 * back onto a person for every one of 178 assets, and the thing that actually
 * determines quality — whether "cartoony" is described well enough to hit — is
 * in the brief, not in the picking. So the loop is: edit the brief, regenerate,
 * look at the game. A regeneration overwrites rather than accumulating.
 */
export function renderGenerate(ctx) {
	const state = {
		jobs: [],
		totals: null,
		ready: false,
		model: '',
		needsGuide: false,
		guide: '',
		guideDirty: false,
		running: false,
		results: new Map(),
		filter: 'all',
	};

	const root = h('div');

	const load = async () => {
		const [jobs, guide] = await Promise.all([
			api(`/api/games/${ctx.game.id}/generate/jobs`),
			api(`/api/games/${ctx.game.id}/art-guide`),
		]);
		state.jobs = jobs.jobs ?? [];
		state.totals = jobs.totals ?? null;
		state.ready = jobs.ready ?? false;
		state.model = jobs.model ?? '';
		state.needsGuide = Boolean(jobs.needsGuide) || !guide.exists;
		state.guide = guide.content ?? '';
		state.guideFile = guide.file ?? 'art-guide.yaml';
		// A written art-guide.md is the studio's own document. It is shown, not
		// offered as a textarea: a box that silently rewrote it on save would be a
		// trap, and it is edited in whatever they already write it in.
		state.guideEditable = guide.editable !== false;
		render();
	};

	const createGuide = async () => {
		const result = await api(`/api/games/${ctx.game.id}/art-guide`, { method: 'POST', body: {} });
		state.guide = result.content;
		state.needsGuide = false;
		await load();
	};

	const saveGuide = async () => {
		await api(`/api/games/${ctx.game.id}/art-guide`, {
			method: 'POST',
			body: { content: state.guide, force: true },
		});
		state.guideDirty = false;
		// The brief drives every prompt, so re-derive them rather than letting the
		// list describe a guide that is no longer on disk.
		await load();
	};

	/**
	 * Run the batch, reading the newline-delimited stream as it arrives.
	 *
	 * A full set is 178 requests. Waiting for one response at the end would be
	 * indistinguishable from a hang, so each result is shown as it lands.
	 */
	const generate = async (ids) => {
		state.running = true;
		state.results = new Map();
		render();
		try {
			const response = await fetch(`/api/games/${ctx.game.id}/generate`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ ids }),
			});
			if (!response.ok) {
				const problem = await response.json().catch(() => ({ error: response.statusText }));
				throw new Error(problem.error ?? 'generation failed');
			}
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() ?? '';
				for (const line of lines) {
					if (!line.trim()) continue;
					const event = JSON.parse(line);
					if (event.type === 'begin') state.results.set(event.id, { pending: true });
					else if (event.type === 'result') state.results.set(event.id, event);
					render();
				}
			}
		} catch (err) {
			state.error = err.message;
		} finally {
			state.running = false;
			render();
		}
	};

	function jobRow(job) {
		const result = state.results.get(job.id);
		const mark = result?.pending
			? h('span.dot.pending', '·')
			: result?.ok
				? h('span.dot.ok', '✓')
				: result
					? h('span.dot.err', '✗')
					: h('span.dot', '');
		return h(
			'div.gen-row',
			mark,
			h('div.gen-main',
				h('div.gen-id', job.id),
				h('div.gen-prompt', job.prompt),
				result?.error ? h('div.gen-err', result.error) : null,
				result?.warnings?.length ? h('div.gen-warn', result.warnings.join('; ')) : null,
			),
			h('div.gen-size',
				h('span.mono', `${job.width}×${job.height}`),
				h('span.gen-kind', job.kind),
				// The single most common way a generated asset is unusable.
				job.kind === 'backdrop' ? h('span.gen-flag', 'opaque') : h('span.gen-flag', 'alpha'),
			),
		);
	}

	function render() {
		const visible =
			state.filter === 'all' ? state.jobs : state.jobs.filter((j) => j.kind === state.filter);
		const undescribed = state.jobs.filter((j) => !j.described && !j.skipped).length;

		mount(
			root,
			h('div.card',
				h('h2', 'Generate art'),
				h('p.card-sub',
					'The brief sets the style, the spec sets what this game needs. Each asset is generated ' +
					'straight to where it belongs — edit the brief and re-run to change the look.'),

				state.needsGuide
					? h('div.empty',
							h('p', 'This game has no art brief yet.'),
							h('p.dim',
								'Already have one? Drop it in the game folder as ',
								h('code', 'art-guide.md'),
								' — a written guide is used in preference, and its prompt template is ',
								'used as-is rather than rebuilt from its parts.'),
							h('button.btn.primary', { onclick: createGuide }, 'Or write art-guide.yaml here'))
					: null,

				!state.ready && !state.needsGuide
					? h('div.warn-box',
							h('b', 'No image provider configured. '),
							'Set the endpoint, key and model in Settings before generating.')
					: null,

				!state.needsGuide
					? h('div.gen-guide',
							h('label', `Art brief — ${state.guideFile}`),
							h('textarea.mono', {
								rows: 14,
								value: state.guide,
								readOnly: !state.guideEditable,
								style: state.guideEditable ? '' : 'opacity:0.72',
								oninput: (e) => {
									if (!state.guideEditable) return;
									state.guide = e.target.value;
									state.guideDirty = true;
								},
							}),
							h('div.row',
								state.guideEditable
									? h('button.btn', {
											disabled: !state.guideDirty,
											onclick: saveGuide,
										}, state.guideDirty ? 'Save brief and re-derive prompts' : 'Brief saved')
									: h('span.dim', 'Your own document — edit it where you write it, then Reload'),
								h('span.dim',
									`${state.jobs.length} asset(s)` +
									(undescribed ? ` · ${undescribed} with no subject line` : '') +
									(state.model ? ` · ${state.model}` : '')),
							))
					: null,
			),

			state.jobs.length
				? h('div.card',
						h('div.row.between',
							h('h2', 'Assets'),
							h('div.row',
								...['all', 'symbol', 'backdrop', 'layer'].map((kind) =>
									h(`button.chip${state.filter === kind ? '.active' : ''}`, {
										onclick: () => { state.filter = kind; render(); },
									}, kind)),
								h('button.btn.primary', {
									disabled: state.running || !state.ready,
									onclick: () => generate(visible.map((j) => j.id)),
								}, state.running
									? `Generating… ${state.results.size}/${visible.length}`
									: `Generate ${visible.length}`),
							)),
						state.error ? h('div.err-box', state.error) : null,
						h('div.gen-list', ...visible.map(jobRow)))
				: null,
		);
	}

	load();
	return root;
}
