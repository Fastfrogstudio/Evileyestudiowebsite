/**
 * stake-forge app shell — state, routing, sidebar, settings, behavior picker.
 */

import { h, mount, clear, api, toast, modal, clone } from './lib.js';
import { renderEditor } from './views/editor.js';
import { renderPipeline } from './views/pipeline.js';
import { renderAssets } from './views/assets.js';
import { renderPreview } from './views/preview.js';

const state = {
	registry: null,
	config: null,
	problems: [],
	games: [],
	current: null, // { game, draft, dirty, validation }
	tab: 'spec',
	/** Kept per game so switching tabs does not lose a running build's log. */
	pipelines: new Map(),
	previews: new Map(),
	leaveHandlers: [],
};

const main = document.getElementById('main');

// ── boot ────────────────────────────────────────────────────────────────────
init();

async function init() {
	document.getElementById('new-game-btn').onclick = openNewGame;
	document.getElementById('settings-btn').onclick = openSettings;

	try {
		state.registry = await api('/api/registry');
	} catch (err) {
		return mount(main, h('div.page-body', h('div.msg.msg-err', `Could not reach the server: ${err.message}`)));
	}

	await refreshConfig();
	await refreshGames();

	if (!state.config.workspace || state.problems.some((p) => p.level === 'error')) {
		openSettings({ firstRun: !state.config._exists });
	} else if (state.games.length) {
		selectGame(state.games[0].id);
	} else {
		renderWelcome();
	}

	window.addEventListener('beforeunload', (e) => {
		if (state.current?.dirty) {
			e.preventDefault();
			e.returnValue = '';
		}
	});
}

async function refreshConfig() {
	const data = await api('/api/config');
	state.config = data.config;
	state.problems = data.problems;
	state.guesses = data.guesses;
	document.getElementById('workspace-label').textContent = state.config.workspace || 'no games folder set';
}

async function refreshGames() {
	const { games } = await api('/api/games');
	state.games = games;
	renderSidebar();
}

function renderSidebar() {
	const list = document.getElementById('game-list');
	if (!state.games.length) {
		return mount(list, h('div.dim.small', { style: 'padding:8px 10px' }, 'No games yet.'));
	}
	mount(list, state.games.map((game) =>
		h(`button.game-item${game.id === state.current?.game.id ? '.active' : ''}${game.valid ? '' : '.invalid'}`,
			{ onclick: () => selectGame(game.id) },
			h('div.game-item-name', game.name ?? game.id),
			h('div.game-item-meta',
				game.valid ? `${game.mechanic} · ${game.symbolCount} symbols` : 'spec has errors',
			),
		),
	));
}

// ── game ────────────────────────────────────────────────────────────────────
async function selectGame(id, { keepTab = false } = {}) {
	if (state.current?.dirty && state.current.game.id !== id) {
		if (!confirm('You have unsaved changes. Discard them?')) return;
	}
	runLeaveHandlers();

	const game = await api(`/api/games/${id}`);
	state.current = {
		game,
		draft: clone(game.raw ?? {}),
		dirty: false,
		validation: { valid: game.valid, errors: game.errors, warnings: game.warnings },
	};
	if (!keepTab) state.tab = 'spec';
	if (!state.pipelines.has(id)) state.pipelines.set(id, { lines: [], results: {}, running: null });
	if (!state.previews.has(id)) state.previews.set(id, { storyId: null });

	renderSidebar();
	renderGame();
}

async function refreshGame() {
	if (!state.current) return;
	const game = await api(`/api/games/${state.current.game.id}`);
	state.current.game = game;
	if (!state.current.dirty) state.current.draft = clone(game.raw ?? {});
	renderGame();
	refreshGames();
}

function runLeaveHandlers() {
	for (const fn of state.leaveHandlers.splice(0)) {
		try { fn(); } catch { /* a torn-down view is not worth crashing over */ }
	}
}

function renderGame() {
	const { game, draft, dirty, validation } = state.current;
	runLeaveHandlers();

    const ctx = {
		game,
		draft,
		registry: state.registry,
		config: state.config,
		validation,
		pipeline: state.pipelines.get(game.id),
		preview: state.previews.get(game.id),
		markDirty: () => {
			if (!state.current.dirty) {
				state.current.dirty = true;
				renderHead();
			}
		},
		setValidation: (v) => {
			state.current.validation = v;
			renderHead();
		},
		refreshGame,
		openBehaviorPicker: (symbol, changed) => openBehaviorPicker(symbol, changed),
		onLeave: (fn) => state.leaveHandlers.push(fn),
	};

	const head = h('div.page-head');
	const body = h('div.page-body');

	function renderHead() {
		const v = state.current.validation;
		const errorCount = v?.errors?.length ?? 0;
		const warnCount = v?.warnings?.length ?? 0;

		mount(head,
			h('div.page-title',
				h('h1', draft.game?.name ?? game.id),
				h('span.sub', draft.game?.mechanic ?? '', draft.game?.gameId ? ` · ${draft.game.gameId}` : ''),
				game.scaffolded?.math ? h('span.pill.ok', 'math') : null,
				game.scaffolded?.web ? h('span.pill.ok', 'web') : null,
				h('div.page-actions',
					state.current.dirty ? h('span.pill.warn', { style: 'align-self:center' }, 'unsaved') : null,
					h('button.btn', {
						disabled: !state.current.dirty,
						onclick: () => { state.current.draft = clone(game.raw ?? {}); state.current.dirty = false; renderGame(); },
					}, 'Revert'),
					h('button.btn.btn-primary', {
						disabled: !state.current.dirty,
						onclick: save,
					}, 'Save'),
				),
			),
			h('div.tabs',
				tab('spec', 'Spec', errorCount ? { count: errorCount, kind: 'err' } : warnCount ? { count: warnCount, kind: 'warn' } : null),
				tab('build', 'Build'),
				tab('assets', 'Assets'),
				tab('preview', 'Preview'),
			),
		);
	}

	function tab(id, label, badge) {
		return h(`button.tab${state.tab === id ? '.active' : ''}`, {
			onclick: () => { state.tab = id; renderHead(); renderBody(); },
		}, label, badge ? h(`span.count.${badge.kind}`, String(badge.count)) : null);
	}

	function renderBody() {
		runLeaveHandlers();
		ctx.validation = state.current.validation;
		ctx.pipeline = state.pipelines.get(game.id);
		if (state.tab === 'spec') mount(body, renderEditor(ctx));
		else if (state.tab === 'build') mount(body, renderPipeline(ctx));
		else if (state.tab === 'assets') mount(body, renderAssets(ctx));
		else mount(body, renderPreview(ctx));
	}

	async function save() {
		try {
			const result = await api(`/api/games/${game.id}`, { method: 'PUT', body: { spec: draft } });
			state.current.dirty = false;
			state.current.validation = result;
			toast('Saved', 'ok');
			await refreshGames();
			renderHead();
		} catch (err) {
			toast(err.message, 'err', 8000);
			if (err.details) {
				state.current.validation = { valid: false, errors: err.details, warnings: [] };
				renderHead();
				renderBody();
			}
		}
	}

	renderHead();
	renderBody();
	mount(main, head, body);
}

function renderWelcome() {
	mount(main, h('div.page-body',
		h('div.empty',
			h('h2', 'No games yet'),
			h('p', 'Create one and it will be ready to scaffold, render and verify straight away.'),
			h('button.btn.btn-primary', { style: 'margin-top:14px', onclick: openNewGame }, 'New game'),
		),
	));
}

// ── behavior picker ─────────────────────────────────────────────────────────
function openBehaviorPicker(symbol, changed) {
	const registry = state.registry;
	const mechanic = state.current.draft.game?.mechanic;
	const current = new Set(symbol.behaviors ?? []);

	modal((close) => {
		const rows = Object.values(registry.behaviors).map((b) => {
			const wrongRole = b.appliesToRoles.length && !b.appliesToRoles.includes(symbol.role);
			const wrongMechanic =
				(b.verifiedForMechanics && !b.verifiedForMechanics.includes(mechanic)) ||
				(b.requiresMechanic && !b.requiresMechanic.includes(mechanic));

			const blocked = wrongMechanic;
			const reason = wrongMechanic
				? b.verifiedForMechanics
					? `Only verified on ${b.verifiedForMechanics.join('/')} — not ${mechanic}`
					: `Requires ${b.requiresMechanic.join(' or ')}`
				: wrongRole
					? `Normally used on ${b.appliesToRoles.join('/')}, not ${symbol.role}`
					: null;

			return h('div', { style: `padding:11px 0; border-bottom:1px solid var(--line-soft); ${blocked ? 'opacity:.5' : ''}` },
				h('label.row', { style: 'align-items:flex-start; gap:10px; cursor:pointer' },
					h('input', {
						type: 'checkbox',
						checked: current.has(b.id),
						disabled: blocked,
						style: 'width:auto; margin-top:3px',
						onchange: (e) => { e.target.checked ? current.add(b.id) : current.delete(b.id); },
					}),
					h('div', { style: 'flex:1; min-width:0' },
						h('div.row', { style: 'gap:8px' },
							h('span.mono', { style: 'font-weight:600' }, b.id),
							h(`span.pill.tier${b.tier}`, `tier ${b.tier}`),
							b.generatesCode
								? h('span.pill.ok', 'generated')
								: b.tier === 2
									? h('span.pill.ok', 'built in')
									: h('span.pill.warn', b.status),
						),
						h('div.small.dim', { style: 'margin-top:3px' }, b.summary || b.title),
						b.requiredAnimationStates.length
							? h('div.small', { style: 'margin-top:4px' },
									h('span.dim', 'extra states: '),
									h('span.mono', b.requiredAnimationStates.join(', ')),
								)
							: null,
						b.requiredSpecialKeys.length || b.suggestedSpecialKeys.length
							? h('div.small', { style: 'margin-top:2px' },
									h('span.dim', 'special: '),
									h('span.mono', [...b.requiredSpecialKeys, ...b.suggestedSpecialKeys.map((k) => `${k}?`)].join(', ')),
								)
							: null,
						reason ? h('div.small', { style: 'margin-top:4px; color:var(--warn)' }, reason) : null,
						b.referenceSample?.math || b.referenceSample?.web
							? h('div.small.dim', { style: 'margin-top:3px' },
									'from ', h('span.mono', b.referenceSample.math ?? b.referenceSample.web))
							: h('div.small.dim', { style: 'margin-top:3px' }, 'no sample in either SDK'),
					),
				),
			);
		});

		return h('div',
			h('h2', `Behaviors — ${symbol.name}`),
			h('p.modal-sub',
				'Tier 2 is built in to both SDKs and needs only config. Tier 3 needs custom code; ',
				'"generated" means stake-forge writes it, adapted from a sample it has actually run.',
			),
			rows,
			h('div.modal-actions',
				h('button.btn', { onclick: close }, 'Cancel'),
				h('button.btn.btn-primary', {
					onclick: () => {
						if (current.size) symbol.behaviors = [...current];
						else delete symbol.behaviors;
						changed();
						close();
					},
				}, 'Apply'),
			),
		);
	});
}

// ── new game ────────────────────────────────────────────────────────────────
function openNewGame() {
	if (!state.config?.workspace) {
		toast('Set a games folder in Settings first', 'err');
		return openSettings();
	}

	modal((close) => {
		const name = h('input', { placeholder: 'Le Bandit' });
		const id = h('input.mono', { placeholder: 'le-bandit' });
		const mechanic = h('select', Object.keys(state.registry.mechanics).map((m) =>
			h('option', { value: m }, m)));
		const provider = h('input', { value: state.config.lastProvider ?? '', placeholder: 'your_studio' });
		const errorBox = h('div');

		// Derive the folder id from the title, but stop once it is hand-edited.
		let idTouched = false;
		id.oninput = () => { idTouched = true; };
		name.oninput = () => {
			if (idTouched) return;
			id.value = name.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
		};

		const create = async () => {
			try {
				const result = await api('/api/games', {
					method: 'POST',
					body: {
						id: id.value.trim(),
						name: name.value.trim(),
						mechanic: mechanic.value,
						providerName: provider.value.trim(),
					},
				});
				close();
				await refreshGames();
				selectGame(result.id);
				toast('Game created — it is already valid and ready to build', 'ok');
			} catch (err) {
				mount(errorBox, h('div.msg.msg-err', err.message));
			}
		};

		return h('div',
			h('h2', 'New game'),
			h('p.modal-sub', 'Starts from a complete, valid spec so you can scaffold and preview immediately.'),
			errorBox,
			h('div.field', h('label', 'Title'), name),
			h('div.field', h('label', 'Folder / app name'), id,
				h('div.field-hint', 'Kebab-case. Becomes apps/<name> in the web-sdk.')),
			h('div.field', h('label', 'Mechanic'), mechanic,
				h('div.field-hint', 'Each clones a real sample in both SDKs.')),
			h('div.field', h('label', 'Provider'), provider),
			h('div.modal-actions',
				h('button.btn', { onclick: close }, 'Cancel'),
				h('button.btn.btn-primary', { onclick: create }, 'Create'),
			),
		);
	});
}

// ── settings ────────────────────────────────────────────────────────────────
function openSettings({ firstRun = false } = {}) {
	modal((close) => {
		const guesses = state.guesses ?? {};
		const fields = {
			workspace: h('input.mono', { value: state.config.workspace || guesses.workspace || '' }),
			webSdk: h('input.mono', { value: state.config.webSdk || guesses.webSdk || '' }),
			mathSdk: h('input.mono', { value: state.config.mathSdk || guesses.mathSdk || '' }),
			python: h('input.mono', { value: state.config.python || '' }),
		};
		const problemBox = h('div');

		const showProblems = (problems) => {
			mount(problemBox, problems.map((p) =>
				h(`div.msg.msg-${p.level === 'error' ? 'err' : 'warn'}`, p.message)));
		};
		showProblems(state.problems);

		const save = async () => {
			try {
				const body = Object.fromEntries(Object.entries(fields).map(([k, el]) => [k, el.value.trim()]));
				const data = await api('/api/config', { method: 'POST', body });
				state.config = data.config;
				state.problems = data.problems;
				document.getElementById('workspace-label').textContent = state.config.workspace || '—';
				showProblems(data.problems);

				if (data.problems.some((p) => p.level === 'error')) {
					return toast('Saved, but some paths still look wrong', 'err');
				}
				toast('Settings saved', 'ok');
				close();
				await refreshGames();
				if (state.games.length && !state.current) selectGame(state.games[0].id);
				else if (!state.games.length) renderWelcome();
			} catch (err) {
				mount(problemBox, h('div.msg.msg-err', err.message));
			}
		};

		return h('div',
			h('h2', firstRun ? 'Welcome — point it at your checkouts' : 'Settings'),
			h('p.modal-sub', 'Set once. Everything else is derived from these.'),
			problemBox,
			h('div.field', h('label', 'Games folder'), fields.workspace,
				h('div.field-hint', 'One folder per game, each with a game-spec.yaml. Created if it does not exist.')),
			h('div.field', h('label', 'web-sdk checkout'), fields.webSdk,
				h('div.field-hint', 'Needs a pnpm install before previewing or type-checking.')),
			h('div.field', h('label', 'math-sdk checkout'), fields.mathSdk),
			h('div.field', h('label', 'Python (optional)'), fields.python,
				h('div.field-hint', 'Blank auto-detects <math-sdk>/.venv/bin/python. The SDK needs 3.12+.')),
			h('div.modal-actions',
				firstRun ? null : h('button.btn', { onclick: close }, 'Cancel'),
				h('button.btn.btn-primary', { onclick: save }, 'Save'),
			),
		);
	});
}
