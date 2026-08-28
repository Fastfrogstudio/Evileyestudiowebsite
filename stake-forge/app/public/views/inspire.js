/**
 * Inspiration intake — describe the game you want, get a spec.
 *
 * ── The boundary, restated where it matters ──────────────────────────────────
 * The only input is a description in words. The server refuses anything
 * pointing at images, archives, sprite sheets, code or a client bundle, and
 * that refusal is shown here rather than silently swallowed.
 *
 * Naming games you are drawing from is fine and is the intended use — but the
 * name is a note for you, not a lookup. There is no database of other studios'
 * games and no attempt to infer mechanics from a title, because that would be
 * inventing facts. What the game DOES has to come from your own description.
 */

import { h, mount, api, toast, debounce } from '../lib.js';

const EXAMPLE = `tumbling board where winning symbols explode and new ones drop in
wild multiplier that grows across a tumble sequence
sticky wilds during free spins
ante bet unlocks a higher scatter chance
buy-bonus at 100x
max win capped at 5000x`;

export function renderInspire({ registry, onCreated, close }) {
	const root = h('div');

	const nameInput = h('input.mono', { placeholder: 'my-next-game' });
	const referencesInput = h('input', { placeholder: 'games you are drawing from, comma separated' });
	const featuresInput = h('textarea.mono', {
		rows: 10,
		placeholder: EXAMPLE,
		style: 'resize:vertical; line-height:1.7',
	});

	const resultBox = h('div');
	let latest = null;

	const analyse = debounce(async () => {
		const features = featuresInput.value.split('\n').map((l) => l.trim()).filter(Boolean);
		if (!features.length) {
			latest = null;
			return mount(resultBox, h('p.dim.small', 'Describe a mechanic per line and the mapping appears here.'));
		}
		try {
			latest = await api('/api/inspire/analyse', {
				method: 'POST',
				body: {
					name: nameInput.value.trim() || 'new-game',
					features,
					references: splitList(referencesInput.value),
					raw: featuresInput.value,
				},
			});
			mount(resultBox, renderResult(latest, registry));
		} catch (err) {
			latest = null;
			mount(resultBox, h('div.msg.msg-err', h('strong', 'Refused. '), err.message));
		}
	}, 350);

	featuresInput.oninput = analyse;
	nameInput.oninput = analyse;
	referencesInput.oninput = analyse;

	const create = async () => {
		const id = nameInput.value.trim();
		if (!id) return toast('Give the game a folder name', 'err');
		if (!latest) return toast('Describe at least one mechanic first', 'err');
		try {
			const { id: created } = await api('/api/inspire/create', {
				method: 'POST',
				body: {
					id,
					name: id,
					features: latest.lines.map((l) => l.text),
					references: latest.references,
					raw: featuresInput.value,
				},
			});
			toast('Game created from your description', 'ok');
			close();
			onCreated(created);
		} catch (err) {
			mount(resultBox, h('div.msg.msg-err', err.message), resultBox.firstChild ? resultBox : null);
			toast(err.message, 'err', 8000);
		}
	};

	mount(root,
		h('h2', 'New game from a description'),
		h('p.modal-sub',
			'Write what you want the game to DO, one mechanic per line. Each line is mapped onto ',
			'the taxonomy: built-in (config only) versus bespoke (needs a behavior recipe).',
		),
		h('div.grid-2',
			h('div.field', h('label', 'Folder / app name'), nameInput,
				h('div.field-hint', 'Kebab-case.')),
			h('div.field', h('label', 'Drawing from (optional)'), referencesInput,
				h('div.field-hint', 'Recorded as a note. Nothing is looked up — describe the mechanics below.')),
		),
		h('div.field',
			h('label', 'Mechanics, one per line'),
			featuresInput,
			h('div.field-hint',
				'Plain language only. Never paste asset files, sprite sheets, code or a client bundle ',
				'from another game — that is refused.',
			),
		),
		h('div.row', { style: 'margin-bottom:12px' },
			h('button.btn.btn-small', {
				onclick: () => { featuresInput.value = EXAMPLE; analyse(); },
			}, 'Use the example'),
			h('div.spacer'),
			h('span.dim.small', `${Object.keys(registry.behaviors).length} behaviors known`),
		),
		resultBox,
		h('div.modal-actions',
			h('button.btn', { onclick: close }, 'Cancel'),
			h('button.btn.btn-primary', { onclick: create }, 'Create game'),
		),
	);

	mount(resultBox, h('p.dim.small', 'Describe a mechanic per line and the mapping appears here.'));
	return root;
}

function splitList(value) {
	return value.split(',').map((s) => s.trim()).filter(Boolean);
}

function renderResult(result, registry) {
	const mech = registry.mechanics[result.mechanic];

	return h('div',
		h('div.msg.msg-info',
			h('strong', result.mechanic), ' — ',
			`clone from math ${mech.mathSample}, web apps/${mech.webApp}`,
			h('div.small.dim', { style: 'margin-top:3px' },
				`${result.tier2.length} built-in · ${result.tier3.length} bespoke · ${result.unmatched.length} undecided`,
			),
		),

		h('table', { style: 'margin-top:10px' },
			h('tbody', result.lines.map((line) =>
				h('tr',
					h('td', { style: 'width:52px; vertical-align:top' },
						line.tier === null
							? h('span.pill.warn', '?')
							: h(`span.pill.tier${line.tier}`, `T${line.tier}`),
					),
					h('td',
						h('div', line.text),
						line.rules.length
							? h('div', { style: 'margin-top:3px' }, line.rules.map((rule) =>
									h('div.small.dim',
										rule.implies,
										rule.behavior
											? h('span', ' · ',
													h('span.mono', rule.behavior),
													rule.generates
														? h('span.pill.ok', { style: 'margin-left:5px' }, 'generated')
														: h('span.pill.warn', { style: 'margin-left:5px' }, rule.status ?? 'by hand'),
												)
											: null,
										h('div', { style: 'opacity:.75' }, rule.reference),
									),
								))
							: h('div.small', { style: 'color:var(--warn); margin-top:3px' },
									'No rule matched — this one is a human decision. Reword it, or treat it as art direction.',
								),
					),
				),
			)),
		),

		result.refused.length
			? h('div', { style: 'margin-top:12px' }, result.refused.map((r) =>
					h('div.msg.msg-warn',
						h('strong', `${r.behavior} was not attached. `),
						`It is ${r.reason}, but this description implies ${r.mechanic}. `,
						'Attaching it anyway would produce a spec that fails to save.',
					),
				))
			: null,

		result.extracted.length
			? h('div.msg.msg-ok', { style: 'margin-top:12px' },
					h('strong', 'Read out of your text: '),
					result.extracted.join(' · '),
				)
			: null,

		result.notes.length
			? h('div', { style: 'margin-top:12px' }, result.notes.map((note) =>
					h('div.msg.msg-info.small', note),
				))
			: null,

		h('div.msg.msg-warn.small', { style: 'margin-top:12px' },
			h('strong', 'The draft gets the taxonomy right, not the maths. '),
			'Paytable values, RTP and reel weights are placeholders — those come from a math-sdk ',
			'optimisation run, and nothing about them can be derived from a description of mechanics.',
		),
	);
}
