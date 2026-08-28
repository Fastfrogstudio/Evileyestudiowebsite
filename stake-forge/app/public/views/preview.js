/**
 * Preview view — the game itself, running in storybook.
 *
 * Storybook is the web-sdk's own way to look at a game without an RGS
 * connection, so this embeds it rather than inventing a renderer. Starting one
 * is slow (a full vite dev server), so state is tracked and polled rather than
 * assumed.
 */

import { h, mount, api, toast } from '../lib.js';

/** Stories worth offering first — the rest go in the dropdown as-is. */
const PREFERRED = [
	['mode-base-book--random', 'A full spin (base)'],
	['mode-bonus-book--random', 'A full spin (bonus)'],
	['mode-base-bookevent--reveal', 'The board'],
	['components-symbol--symbols', 'Every symbol × every state'],
];

export function renderPreview(ctx) {
	const { game } = ctx;
	const root = h('div');
	let poll = null;
	let stories = [];
	let selected = ctx.preview.storyId ?? null;

	async function refresh() {
		try {
			const state = await api(`/api/games/${game.id}/preview`);
			stories = state.stories ?? [];
			render(state);
			if (state.status === 'starting' && !poll) {
				poll = setInterval(refresh, 2500);
			}
			if (state.status !== 'starting' && poll) {
				clearInterval(poll);
				poll = null;
			}
		} catch (err) {
			mount(root, h('div.card', h('div.msg.msg-err', err.message)));
		}
	}

	// Stop polling when the view is torn down, so switching tabs does not leave
	// a timer hammering the server forever.
	ctx.onLeave(() => {
		if (poll) clearInterval(poll);
		ctx.preview.storyId = selected;
	});

	async function start() {
		try {
			await api(`/api/games/${game.id}/preview/start`, { method: 'POST' });
			toast('Starting storybook — this takes a minute the first time', 'info');
			refresh();
		} catch (err) {
			toast(err.message, 'err', 9000);
			mount(root, h('div.card', h('h2', 'Preview'), h('div.msg.msg-err', err.message)));
		}
	}

	async function stop() {
		await api(`/api/games/${game.id}/preview/stop`, { method: 'POST' });
		refresh();
	}

	function render(state) {
		if (state.status === 'stopped') {
			return mount(root,
				h('div.card',
					h('h2', 'Preview'),
					h('p.card-sub', 'Runs the game in storybook and embeds it here.'),
					!game.scaffolded?.web
						? h('div.msg.msg-info', 'Scaffold the web app first — Build tab.')
						: h('button.btn.btn-primary', { onclick: start }, 'Start preview'),
				),
			);
		}

		if (state.status === 'starting') {
			return mount(root,
				h('div.card',
					h('div.row', h('h2', { style: 'margin:0' }, 'Preview'), h('div.spacer'),
						h('button.btn.btn-small', { onclick: stop }, 'Cancel')),
					h('p.card-sub', h('span.spin', '◌'), ' Starting storybook on port ', String(state.port), '…'),
					h('div.log', (state.log ?? []).slice(-14).map((l) => h('div.log-line.meta', l))),
				),
			);
		}

		if (state.status === 'error') {
			return mount(root,
				h('div.card',
					h('h2', 'Preview'),
					h('div.msg.msg-err', state.error ?? 'storybook failed'),
					h('div.log', (state.log ?? []).slice(-20).map((l) => h('div.log-line.err', l))),
					h('button.btn', { style: 'margin-top:12px', onclick: start }, 'Try again'),
				),
			);
		}

		// ready
		const known = new Set(stories.map((s) => s.id));
		const options = [
			...PREFERRED.filter(([id]) => known.has(id)).map(([id, label]) => ({ id, label })),
			...stories
				.filter((s) => !PREFERRED.some(([id]) => id === s.id))
				.map((s) => ({ id: s.id, label: `${s.title} / ${s.name}` })),
		];
		selected = options.some((o) => o.id === selected) ? selected : options[0]?.id;

		const frame = h('iframe.preview-frame', {
			src: `${state.url}/iframe.html?id=${encodeURIComponent(selected ?? '')}&viewMode=story`,
			allow: 'autoplay',
		});

		mount(root,
			h('div.card',
				h('div.preview-bar',
					h('select', {
						onchange: (e) => {
							selected = e.target.value;
							frame.src = `${state.url}/iframe.html?id=${encodeURIComponent(selected)}&viewMode=story`;
						},
					}, options.map((o) => h('option', { value: o.id, selected: o.id === selected }, o.label))),
					h('button.btn.btn-small', { onclick: () => { frame.src = frame.src; } }, 'Reload'),
					h('a.btn.btn-small', { href: state.url, target: '_blank', rel: 'noreferrer' }, 'Open in a tab'),
					h('div.spacer'),
					h('span.dim.small.mono', `:${state.port}`),
					h('button.btn.btn-small', { onclick: stop }, 'Stop'),
				),
				frame,
				h('p.card-sub', { style: 'margin:12px 0 0' },
					'Book stories replay the sample app’s fixture data, not your generated math — ',
					'they exercise your config, symbols and art. To see your own math, run it in the math-sdk.',
				),
			),
		);
	}

	mount(root, h('div.card', h('p.card-sub', 'Checking preview…')));
	refresh();
	return root;
}
