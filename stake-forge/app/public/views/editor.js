/**
 * Spec editor.
 *
 * Every constraint offered here comes from /api/registry, which is built from
 * the same modules the generators use — so the editor cannot offer a role,
 * special key or behavior the engine does not actually have, and cannot drift
 * from them later.
 */

import { h, mount, clear, api, toast, debounce, clone } from '../lib.js';

export function renderEditor(ctx) {
	const { game, registry } = ctx;
	const spec = ctx.draft;
	const mech = registry.mechanics[spec.game?.mechanic] ?? null;

	const root = h('div');
	const problems = h('div');

	// Live validation: the rules live server-side in loadGameSpec, so the editor
	// asks rather than reimplementing them and slowly disagreeing.
	const revalidate = debounce(async () => {
		try {
			const result = await api(`/api/games/${game.id}/validate`, {
				method: 'POST',
				body: { spec },
			});
			ctx.setValidation(result);
			renderProblems(problems, result);
		} catch (err) {
			renderProblems(problems, { valid: false, errors: [err.message], warnings: [] });
		}
	}, 400);

	const changed = () => {
		ctx.markDirty();
		revalidate();
		rerender();
	};

	const rerender = () => {
		mount(
			root,
			problems,
			gameCard(spec, registry, changed),
			reelsCard(spec, registry, changed),
			betModesCard(spec, changed),
			symbolsCard(spec, registry, changed, ctx),
			freeSpinsCard(spec, changed),
			screensCard(spec, registry, mech, changed),
		);
	};

	rerender();
	renderProblems(problems, ctx.validation ?? { valid: game.valid, errors: game.errors, warnings: game.warnings });
	return root;
}

function renderProblems(el, result) {
	const items = [];
	for (const error of result.errors ?? []) items.push(h('div.msg.msg-err', error));
	for (const warning of result.warnings ?? []) items.push(h('div.msg.msg-warn', warning));
	mount(el, items);
}

// ── game ────────────────────────────────────────────────────────────────────
function gameCard(spec, registry, changed) {
	const g = (spec.game ??= {});
	const mech = registry.mechanics[g.mechanic];

	return h(
		'div.card',
		h('h2', 'Game'),
		h('p.card-sub', 'Identity and the base mechanic everything is cloned from.'),
		h(
			'div.grid-3',
			field('Name', 'Folder and app name. Kebab-case.', input(g.name, (v) => { g.name = v; changed(); })),
			field('Provider', null, input(g.providerName, (v) => { g.providerName = v; changed(); })),
			field(
				'Game ID',
				'Also the math-sdk folder name.',
				input(g.gameId, (v) => { g.gameId = v; changed(); }, 'mono'),
			),
		),
		h(
			'div.grid-3',
			field('Working title', null, input(g.workingName, (v) => { g.workingName = v; changed(); })),
			field(
				'RTP',
				'Target return to player.',
				input(g.rtp, (v) => { g.rtp = Number(v); changed(); }, 'mono', 'number'),
			),
			field(
				'Mechanic',
				mech ? `math ${mech.mathSample} · web apps/${mech.webApp}` : null,
				select(
					Object.keys(registry.mechanics),
					g.mechanic,
					(v) => {
						g.mechanic = v;
						const profile = registry.mechanics[v];
						g.reels = { ...profile.defaultReels };
						if (profile.supportsPaylines) spec.paylines ??= 'default_20';
						else delete spec.paylines;
						changed();
					},
				),
			),
		),
		mech &&
			h(
				'div.msg.msg-info.small',
				h('strong', `${mech.winType} `),
				`win type · game types ${mech.gameTypes.join(', ')} · `,
				mech.supportsPaylines ? 'uses paylines' : 'no paylines',
				mech.tumbles ? ' · tumbling board' : '',
				mech.requiredSymbols.length
					? ` · requires a symbol named ${mech.requiredSymbols.map((s) => s.name).join(', ')}`
					: '',
			),
	);
}

// ── reels ───────────────────────────────────────────────────────────────────
function reelsCard(spec, registry, changed) {
	const reels = (spec.game.reels ??= { count: 5, rows: [3, 3, 3, 3, 3] });
	const mech = registry.mechanics[spec.game.mechanic];

	const rowsRow = h(
		'div.row',
		reels.rows.map((rows, i) =>
			h('input.mono.narrow', {
				type: 'number',
				min: 1,
				value: rows,
				oninput: (e) => {
					reels.rows[i] = Number(e.target.value);
					changed();
				},
			}),
		),
	);

	return h(
		'div.card',
		h('h2', 'Board'),
		h('p.card-sub', 'One row count per reel — the engine indexes num_rows[reel], so they must match.'),
		h(
			'div.row',
			field(
				'Reels',
				null,
				h('input.mono.narrow', {
					type: 'number',
					min: 1,
					value: reels.count,
					oninput: (e) => {
						const count = Math.max(1, Number(e.target.value) || 1);
						const fill = reels.rows[0] ?? 3;
						reels.count = count;
						reels.rows = Array.from({ length: count }, (_, i) => reels.rows[i] ?? fill);
						changed();
					},
				}),
			),
			h('div', { style: 'flex:1' }, h('label', 'Rows per reel'), rowsRow),
		),
		mech?.supportsPaylines
			? field(
					'Paylines',
					'"default_20" uses the sample 20-line pattern.',
					input(
						typeof spec.paylines === 'string' ? spec.paylines : 'custom (edit the YAML)',
						(v) => {
							spec.paylines = v;
							changed();
						},
						'mono',
					),
				)
			: null,
	);
}

// ── bet modes ───────────────────────────────────────────────────────────────
function betModesCard(spec, changed) {
	const modes = (spec.game.betModes ??= {});

	const rows = Object.entries(modes).map(([key, mode]) =>
		h(
			'tr',
			h('td', h('span.pill.mono', key)),
			h('td', numberInput(mode.cost, (v) => { mode.cost = v; changed(); })),
			h('td', numberInput(mode.rtp ?? spec.game.rtp, (v) => { mode.rtp = v; changed(); }, 0.001)),
			h('td', numberInput(mode.maxWin, (v) => { mode.maxWin = v; changed(); }, 1)),
			h('td', checkbox(mode.feature, (v) => { mode.feature = v; changed(); })),
			h('td', checkbox(mode.buyBonus, (v) => { mode.buyBonus = v; changed(); })),
			h(
				'td',
				h('button.btn.btn-small.btn-danger', {
					onclick: () => {
						if (Object.keys(modes).length <= 1) return toast('A game needs at least one bet mode', 'err');
						delete modes[key];
						changed();
					},
				}, 'Remove'),
			),
		),
	);

	return h(
		'div.card',
		h('h2', 'Bet modes'),
		h('p.card-sub', 'Max win also sets the win cap. Distributions are generated minimally — balancing them is a math job.'),
		h(
			'table',
			h('thead', h('tr', ['Mode', 'Cost', 'RTP', 'Max win', 'Feature', 'Buy bonus', ''].map((t) => h('th', t)))),
			h('tbody', rows),
		),
		h('div.row', { style: 'margin-top:12px' },
			h('button.btn.btn-small', {
				onclick: () => {
					let name = 'mode';
					let n = 2;
					while (modes[name]) name = `mode${n++}`;
					modes[name] = { cost: 1.0, rtp: spec.game.rtp, maxWin: 5000, feature: true, buyBonus: false };
					changed();
				},
			}, 'Add bet mode'),
		),
	);
}

// ── symbols ─────────────────────────────────────────────────────────────────
function symbolsCard(spec, registry, changed, ctx) {
	const symbols = (spec.symbols ??= []);
	const mechanicId = spec.game.mechanic;
	const kinds = [...new Set(symbols.flatMap((s) => Object.keys(s.paytable ?? {})).map(Number))]
		.sort((a, b) => b - a);
	const maxKind = spec.game.reels?.count ?? 5;
	const allKinds = kinds.length ? kinds : [maxKind, maxKind - 1, maxKind - 2].filter((k) => k > 0);

	const rows = symbols.map((symbol, index) =>
		symbolRow({ symbol, index, symbols, registry, mechanicId, allKinds, changed, ctx }),
	);

	return h(
		'div.card',
		h('h2', 'Symbols'),
		h(
			'p.card-sub',
			'Role is the source of truth — it implies the special key. Add a special only to extend it. ',
			h('span.dim', `Engine keys with defaults: ${registry.engineSpecialKeys.join(', ')}.`),
		),
		h(
			'table',
			h(
				'thead',
				h('tr', [
					h('th', 'Name'),
					h('th', 'Role'),
					h('th', 'Order'),
					h('th', 'Label'),
					h('th', 'Special'),
					h('th', 'Behaviors'),
					...allKinds.map((k) => h('th', { style: 'text-align:right' }, `${k}×`)),
					h('th', ''),
				]),
			),
			h('tbody', rows),
		),
		h('div.row', { style: 'margin-top:12px' },
			h('button.btn.btn-small', {
				onclick: () => {
					const n = symbols.filter((s) => s.role === 'low').length + 1;
					symbols.push({ name: `L${n}`, role: 'low', label: `Low ${n}`, paytable: { [maxKind]: 1 } });
					changed();
				},
			}, 'Add symbol'),
		),
	);
}

function symbolRow({ symbol, index, symbols, registry, mechanicId, allKinds, changed, ctx }) {
	const impliedSpecial = { wild: ['wild'], scatter: ['scatter'], high: [], low: [] }[symbol.role] ?? [];
	const effectiveSpecial = symbol.special ?? impliedSpecial;

	return h(
		'tr',
		h('td', h('input.mono', {
			value: symbol.name ?? '',
			style: 'width:70px',
			oninput: (e) => { symbol.name = e.target.value; changed(); },
		})),
		h('td', select(registry.roles, symbol.role, (v) => {
			symbol.role = v;
			// Drop an explicit special that only restated the old implied key, so
			// changing role does not silently leave a stale wild/scatter behind.
			const wasImplied = JSON.stringify(symbol.special) === JSON.stringify(impliedSpecial);
			if (wasImplied) delete symbol.special;
			changed();
		}, `pill role-${symbol.role}`)),
		h('td', h('input.mono.narrow', {
			type: 'number', min: 1, style: 'width:56px',
			value: symbol.order ?? '',
			placeholder: 'auto',
			oninput: (e) => {
				const v = e.target.value;
				if (v === '') delete symbol.order;
				else symbol.order = Number(v);
				changed();
			},
		})),
		h('td', h('input', {
			value: symbol.label ?? '',
			oninput: (e) => { symbol.label = e.target.value; changed(); },
		})),
		h('td', specialPicker(symbol, impliedSpecial, effectiveSpecial, registry, changed)),
		h('td', behaviorPicker(symbol, registry, mechanicId, changed, ctx)),
		...allKinds.map((kind) =>
			h('td', { style: 'text-align:right' },
				h('input.mono', {
					type: 'number', step: '0.1', style: 'width:66px; text-align:right',
					value: symbol.paytable?.[kind] ?? '',
					placeholder: '—',
					oninput: (e) => {
						const v = e.target.value;
						symbol.paytable ??= {};
						if (v === '') delete symbol.paytable[kind];
						else symbol.paytable[kind] = Number(v);
						if (!Object.keys(symbol.paytable).length) delete symbol.paytable;
						changed();
					},
				}),
			),
		),
		h('td', h('button.btn.btn-small.btn-danger', {
			onclick: () => { symbols.splice(index, 1); changed(); },
		}, '×')),
	);
}

function specialPicker(symbol, implied, effective, registry, changed) {
	const label = effective.length ? effective.join(', ') : '—';
	const isImplied = !symbol.special;

	return h('button.btn.btn-small', {
		class: 'mono',
		style: 'min-width:120px; text-align:left',
		onclick: () => openSpecialPicker(symbol, implied, registry, changed),
		title: isImplied ? `Implied by role "${symbol.role}"` : 'Explicitly set',
	}, label, isImplied && effective.length ? h('span.dim', ' (auto)') : null);
}

function openSpecialPicker(symbol, implied, registry, changed) {
	import('../lib.js').then(({ modal, h: hh }) => {
		modal((close) => {
			const current = new Set(symbol.special ?? implied);
			const custom = (symbol.special ?? []).filter((k) => !registry.engineSpecialKeys.includes(k));

			const boxes = registry.engineSpecialKeys.map((key) =>
				hh('label.row', { style: 'margin-bottom:8px' },
					hh('input', {
						type: 'checkbox',
						checked: current.has(key),
						style: 'width:auto',
						onchange: (e) => { e.target.checked ? current.add(key) : current.delete(key); },
					}),
					hh('span', { style: 'margin-left:8px' },
						hh('span.mono', key),
						implied.includes(key) ? hh('span.dim', `  implied by role "${symbol.role}"`) : null,
					),
				),
			);

			const customInput = hh('input.mono', {
				value: custom.join(', '),
				placeholder: 'e.g. blank',
			});

			return hh('div',
				hh('h2', `Special keys — ${symbol.name}`),
				hh('p.modal-sub',
					'These become keys of the engine’s special_symbols dict. The four listed get real ' +
					'default values from Symbol.assign_default_attribute(); anything else exists in ' +
					'special_flags but stays unset until a behavior recipe assigns it.',
				),
				boxes,
				hh('div.field', { style: 'margin-top:16px' },
					hh('label', 'Other keys (comma separated)'),
					customInput,
					hh('div.field-hint', 'Legal, but they get no engine default — forge will warn.'),
				),
				hh('div.modal-actions',
					hh('button.btn', { onclick: close }, 'Cancel'),
					hh('button.btn.btn-primary', {
						onclick: () => {
							const extras = customInput.value.split(',').map((s) => s.trim()).filter(Boolean);
							const next = [...current, ...extras];
							// Only store it when it differs from what the role implies —
							// otherwise the spec fills up with restated defaults.
							if (JSON.stringify(next.sort()) === JSON.stringify([...implied].sort())) delete symbol.special;
							else symbol.special = next;
							changed();
							close();
						},
					}, 'Apply'),
				),
			);
		});
	});
}

function behaviorPicker(symbol, registry, mechanicId, changed, ctx) {
	const current = symbol.behaviors ?? [];
	const label = current.length ? current.join(', ') : '—';
	return h('button.btn.btn-small.mono', {
		style: 'min-width:110px; text-align:left',
		onclick: () => ctx.openBehaviorPicker(symbol, changed),
	}, label);
}

// ── free spins ──────────────────────────────────────────────────────────────
function freeSpinsCard(spec, changed) {
	const enabled = Boolean(spec.freeSpins);
	const fs = spec.freeSpins ?? {};
	const scatters = (spec.symbols ?? []).filter(
		(s) => s.role === 'scatter' || (s.special ?? []).includes('scatter'),
	);

	return h(
		'div.card',
		h('div.row',
			h('h2', { style: 'margin:0' }, 'Free spins'),
			h('div.spacer'),
			checkbox(enabled, (v) => {
				if (v) spec.freeSpins = { triggerSymbol: scatters[0]?.name ?? 'S', triggerCount: 3, awardedSpins: 10, spinsPerExtraScatter: 2, retrigger: true };
				else delete spec.freeSpins;
				changed();
			}),
		),
		h('p.card-sub', 'Built in to both SDKs — this is config, not code.'),
		enabled
			? h('div.grid-3',
					field('Trigger symbol', 'Must carry special: [scatter].',
						select(scatters.map((s) => s.name), fs.triggerSymbol, (v) => { fs.triggerSymbol = v; changed(); })),
					field('Scatters to trigger', null,
						numberInput(fs.triggerCount, (v) => { fs.triggerCount = v; changed(); }, 1)),
					field('Spins awarded', null,
						numberInput(fs.awardedSpins, (v) => { fs.awardedSpins = v; changed(); }, 1)),
					field('Extra spins per extra scatter', 'Every landable count gets an entry — a missing one is a KeyError mid-simulation.',
						numberInput(fs.spinsPerExtraScatter ?? 2, (v) => { fs.spinsPerExtraScatter = v; changed(); }, 1)),
					field('Retrigger', null, checkbox(fs.retrigger, (v) => { fs.retrigger = v; changed(); })),
				)
			: h('p.dim.small', 'No free-spin round.'),
	);
}

// ── screens ─────────────────────────────────────────────────────────────────
function screensCard(spec, registry, mech, changed) {
	const declared = flatten(spec.screens ?? {});
	const slots = Object.entries(registry.screenSlots).filter(
		([, slot]) => !slot.onlyMechanics || (mech && slot.onlyMechanics.includes(mech.id)),
	);

	return h(
		'div.card',
		h('h2', 'Screens'),
		h('p.card-sub', 'Each slot names the real asset key a real component looks up. Unticked slots keep the sample app’s art.'),
		h('table',
			h('thead', h('tr', [h('th', 'Want'), h('th', 'Slot'), h('th', 'Asset key'), h('th', 'Component'), h('th', 'Type')].map((x) => x))),
			h('tbody', slots.map(([id, slot]) =>
				h('tr',
					h('td', checkbox(declared.has(id), (v) => {
						setScreen(spec, id, v);
						changed();
					})),
					h('td', h('span.mono', id), slot.required ? h('span.pill.warn', { style: 'margin-left:6px' }, 'needed') : null),
					h('td', h('span.mono.dim', slot.assetKey)),
					h('td', h('span.small.dim', slot.component)),
					h('td', h('span.pill', slot.assetType)),
				),
			)),
		),
		h('div.msg.msg-info.small', { style: 'margin-top:12px' },
			'Win-tier banners map onto get_win_level() 1–10. Only levels ',
			registry.winLevels.banners.join(', '),
			' render a banner, so the "bigwin" spine needs intro/idle/exit for each of: ',
			h('span.mono', registry.winLevels.banners.map((l) => registry.winLevels.aliases[l]).join(', ')),
			'.',
		),
	);
}

function flatten(screens, prefix = '') {
	const out = new Set();
	for (const [key, value] of Object.entries(screens ?? {})) {
		const id = prefix ? `${prefix}.${key}` : key;
		if (value && typeof value === 'object' && !Array.isArray(value)) {
			for (const nested of flatten(value, id)) out.add(nested);
		} else if (value) {
			out.add(id);
		}
	}
	return out;
}

function setScreen(spec, id, on) {
	spec.screens ??= {};
	const parts = id.split('.');
	let node = spec.screens;
	for (const part of parts.slice(0, -1)) {
		node[part] ??= {};
		node = node[part];
	}
	const leaf = parts[parts.length - 1];
	if (on) node[leaf] = true;
	else delete node[leaf];

	// Tidy up any branch left empty, so the YAML does not grow husks.
	if (parts.length > 1) {
		let parent = spec.screens;
		const branch = parts[0];
		if (parent[branch] && !Object.keys(parent[branch]).length) delete parent[branch];
	}
	if (!Object.keys(spec.screens).length) delete spec.screens;
}

// ── small controls ──────────────────────────────────────────────────────────
function field(label, hint, control) {
	return h('div.field', h('label', label), control, hint ? h('div.field-hint', hint) : null);
}

function input(value, onInput, cls = '', type = 'text') {
	return h('input', {
		class: cls,
		type,
		value: value ?? '',
		oninput: (e) => onInput(e.target.value),
	});
}

function numberInput(value, onInput, step = 0.1) {
	return h('input.mono', {
		type: 'number',
		step,
		value: value ?? '',
		oninput: (e) => onInput(e.target.value === '' ? undefined : Number(e.target.value)),
	});
}

function select(options, value, onChange, cls = '') {
	return h('select', {
		class: cls,
		onchange: (e) => onChange(e.target.value),
	}, options.map((opt) => h('option', { value: opt, selected: opt === value }, opt)));
}

function checkbox(checked, onChange) {
	return h('input', {
		type: 'checkbox',
		checked: Boolean(checked),
		style: 'width:auto',
		onchange: (e) => onChange(e.target.checked),
	});
}
