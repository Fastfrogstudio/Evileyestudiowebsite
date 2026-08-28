/**
 * Assets view — upload your own art and wire it to symbols.
 *
 * The centrepiece is the per-symbol wiring table. A symbol is supplied either
 * by a spine export (atlas + image + skeleton) or a flat image, and each state
 * its role and behaviors require has to point at something. Because a spine
 * skeleton carries its animation names, those states are picked from a dropdown
 * populated from YOUR export rather than typed blind and discovered wrong at
 * runtime.
 */

import { h, mount, api, toast, modal } from '../lib.js';

export function renderAssets(ctx) {
	const { game } = ctx;
	const root = h('div');
	let data = null;

	async function load() {
		try {
			data = await api(`/api/games/${game.id}/assets`);
			render();
		} catch (err) {
			mount(root, h('div.card', h('div.msg.msg-err', err.message)));
		}
	}

	async function upload(files) {
		if (!files?.length) return;
		const form = new FormData();
		for (const file of files) form.append('files', file);
		try {
			const result = await api(`/api/games/${game.id}/assets/upload`, { method: 'POST', body: form });
			if (result.rejected?.length) {
				for (const r of result.rejected) toast(`${r.file}: ${r.reason}`, 'err', 8000);
			}
			if (result.written?.length) {
				toast(`Uploaded ${result.written.length} file${result.written.length === 1 ? '' : 's'}`, 'ok');
			}
			await load();
		} catch (err) {
			toast(err.message, 'err', 8000);
		}
	}

	async function attach(body) {
		try {
			await api(`/api/games/${game.id}/assets/attach`, { method: 'POST', body });
			toast('Wired up — run Import art on the Build tab to apply it', 'ok', 6000);
			await load();
			ctx.refreshGame();
		} catch (err) {
			toast(err.message, 'err', 8000);
		}
	}

	async function detach(symbol) {
		await api(`/api/games/${game.id}/assets/detach`, { method: 'POST', body: { symbol } });
		await load();
	}

	async function remove(file) {
		if (!confirm(`Delete ${file} from assets-source?`)) return;
		await api(`/api/games/${game.id}/assets/${encodeURIComponent(file)}`, { method: 'DELETE' });
		await load();
	}

	function render() {
		mount(root,
			uploadCard({ upload }),
			wiringCard({ data, attach, detach, openWiring }),
			screensCard({ data, attach, detachSlot }),
			namedCard({ data, attach, detachNamed }),
			filesCard({ data, gameId: game.id, remove }),
		);
	}

	function openWiring(row) {
		modal((close) => wiringModal({ row, data, attach, close }));
	}

	async function detachSlot(slotId) {
		await api(`/api/games/${game.id}/assets/detach`, { method: 'POST', body: { slotId } });
		await load();
	}

	async function detachNamed(key) {
		await api(`/api/games/${game.id}/assets/detach`, { method: 'POST', body: { key } });
		await load();
	}

	mount(root, h('div.card', h('p.card-sub', 'Loading…')));
	load();
	return root;
}

// ── upload ──────────────────────────────────────────────────────────────────
function uploadCard({ upload }) {
	const input = h('input', {
		type: 'file',
		multiple: true,
		style: 'display:none',
		onchange: (e) => {
			upload(e.target.files);
			e.target.value = '';
		},
	});

	const drop = h('div.dropzone', {
		ondragover: (e) => { e.preventDefault(); drop.classList.add('over'); },
		ondragleave: () => drop.classList.remove('over'),
		ondrop: (e) => {
			e.preventDefault();
			drop.classList.remove('over');
			upload(e.dataTransfer.files);
		},
		onclick: () => input.click(),
	},
		h('div', { style: 'font-size:22px' }, '↥'),
		h('div', { style: 'font-weight:550; margin-top:6px' }, 'Drop your art here'),
		h('div.small.dim', { style: 'margin-top:4px' },
			'A spine export is three files — the .atlas, its image, and a skeleton .json per symbol. ',
			'Drop them all at once.',
		),
		input,
	);

	return h('div.card',
		h('h2', 'Upload'),
		h('p.card-sub', 'Files land in the game’s assets-source folder. Nothing is wired up until you say so.'),
		drop,
	);
}

// ── wiring ──────────────────────────────────────────────────────────────────
function wiringCard({ data, detach, openWiring }) {
	const rows = (data.wiring ?? []).map((row) => {
		// Three distinct outcomes, deliberately not conflated: a base state with
		// no animation falls back to the static pose and is fine; a BEHAVIOR
		// state doing so means the feature never visibly fires.
		const status = row.kind === 'spine'
			? row.unmapped.length
				? h('span.pill.err', `${row.unmapped.length} unmapped`)
				: row.inert.length
					? h('span.pill.warn', `${row.inert.join(', ')} inert`)
					: h('span.pill.ok', 'your art')
			: row.kind === 'sprite'
				? h('span.pill', 'placeholder')
				: h('span.pill.err', 'nothing');

		const detail = row.kind === 'spine'
			? h('span',
					h('span.mono.small.dim', row.source.skeleton),
					row.fallback.length
						? h('div.small.dim', `${row.fallback.join(', ')} show the static pose`)
						: null,
				)
			: row.kind === 'sprite'
				? h('span.mono.small.dim', row.source.sprite)
				: h('span.small.dim', '—');

		return h('tr',
			h('td', h('span.mono', row.symbol)),
			h('td', h(`span.pill.role-${row.role}`, row.role)),
			h('td', (row.behaviors ?? []).length ? h('span.mono.small', row.behaviors.join(', ')) : h('span.dim', '—')),
			h('td', status),
			h('td', detail),
			h('td', { style: 'text-align:right; white-space:nowrap' },
				h('button.btn.btn-small', { onclick: () => openWiring(row) },
					row.kind === 'sprite' ? 'Replace' : row.kind === 'none' ? 'Attach' : 'Change'),
				row.kind !== 'none'
					? h('button.btn.btn-small.btn-danger', { style: 'margin-left:5px', onclick: () => detach(row.symbol) }, '×')
					: null,
			),
		);
	});

	const placeholders = (data.wiring ?? []).filter((r) => r.kind === 'sprite').length;
	const unmapped = (data.wiring ?? []).filter((r) => r.unmapped.length).length;
	const inert = (data.wiring ?? []).filter((r) => r.inert.length).length;

	return h('div.card',
		h('div.row',
			h('h2', { style: 'margin:0' }, 'Symbols'),
			h('div.spacer'),
			placeholders ? h('span.pill', `${placeholders} still on placeholder art`) : null,
			inert ? h('span.pill.warn', `${inert} with an inert behavior state`) : null,
			unmapped ? h('span.pill.err', `${unmapped} with nothing to show`) : null,
		),
		h('p.card-sub',
			'Every state a symbol’s role and behaviors require has to point at something. ',
			'Animation names are read out of your skeleton, so you pick them rather than typing them.',
		),
		h('table',
			h('thead', h('tr', ['Symbol', 'Role', 'Behaviors', 'Supplied by', 'Source', ''].map((t) => h('th', t)))),
			h('tbody', rows),
		),
	);
}

/**
 * Attach art to one symbol.
 *
 * Two shapes, because that is what the manifest and the engine actually
 * support: a spine group with an animation per state, or a flat image that
 * covers everything without animating.
 */
function wiringModal({ row, data, attach, close }) {
	const groups = data.groups ?? [];
	const images = (data.assets ?? []).filter((a) => a.kind === 'image');

	let mode = row.kind === 'sprite' || (!groups.length && images.length) ? 'sprite' : 'spine';
	const body = h('div');

	const render = () => {
		mount(body, mode === 'spine' ? spineForm() : spriteForm());
	};

	function spineForm() {
		if (!groups.length) {
			return h('div.msg.msg-info',
				'No spine export uploaded yet. A spine needs three files — the ',
				h('span.mono', '.atlas'), ', its image, and a skeleton ',
				h('span.mono', '.json'), '. Drop them in above and they will appear here.',
			);
		}

		const groupSelect = h('select', groups.map((g, i) =>
			h('option', { value: String(i) }, `${g.atlas}  →  ${g.image ?? 'no image'}`)));
		let group = groups[0];

		const skeletonSelect = h('select');
		const stateRows = h('div');

		const currentAnimations = row.kind === 'spine' ? (row.source.animations ?? {}) : {};

		const renderSkeletons = () => {
			mount(skeletonSelect, group.skeletons.map((s) =>
				h('option', { value: s.file }, `${s.file}  (${s.animations.length} animations)`)));
			renderStates();
		};

		const renderStates = () => {
			const skeleton = group.skeletons.find((s) => s.file === skeletonSelect.value) ?? group.skeletons[0];
			if (!skeleton) return mount(stateRows, h('div.msg.msg-warn', 'No skeleton in this group.'));

			if (skeleton.binary) {
				return mount(stateRows,
					h('div.msg.msg-warn',
						'This is a binary skeleton, so its animation names cannot be read. ',
						'Type them by hand below — they must match the names inside the export exactly.',
					),
					...row.required.map((state) => stateRow(state, null)),
				);
			}

			mount(stateRows,
				h('p.small.dim', { style: 'margin:0 0 10px' },
					`${skeleton.animations.length} animation${skeleton.animations.length === 1 ? '' : 's'} found in this skeleton. `,
					'Leave a state blank to fall back to the static pose.',
				),
				...row.required.map((state) => stateRow(state, skeleton.animations)),
			);
		};

		const stateInputs = new Map();
		function stateRow(state, animations) {
			// Guess sensibly: an animation named after the state, or after the
			// symbol, saves mapping six states by hand for the common export.
			const guess = animations
				? animations.find((a) => a.toLowerCase() === state.toLowerCase()) ??
					animations.find((a) => a.toLowerCase().endsWith(`_${state.toLowerCase()}`)) ??
					(state === 'win' ? animations.find((a) => a.toLowerCase() === row.symbol.toLowerCase()) : null)
				: null;

			const control = animations
				? h('select',
						h('option', { value: '' }, '— none —'),
						animations.map((a) => h('option', { value: a }, a)),
					)
				: h('input.mono', { placeholder: 'animation name' });

			const value = currentAnimations[state] ?? guess ?? '';
			control.value = value;
			stateInputs.set(state, control);

			const fromBehavior = !['static', 'spin', 'land', 'win', 'postWinStatic', 'explosion'].includes(state);
			return h('div.row', { style: 'margin-bottom:7px' },
				h('span.mono', { style: 'width:130px; flex:none' }, state,
					fromBehavior ? h('span.pill.tier3', { style: 'margin-left:5px' }, 'behavior') : null),
				control,
			);
		}

		groupSelect.onchange = () => { group = groups[Number(groupSelect.value)]; renderSkeletons(); };
		skeletonSelect.onchange = renderStates;
		renderSkeletons();

		return h('div',
			group.imageMissing
				? h('div.msg.msg-warn',
						h('span.mono', group.atlas), ' names ', h('span.mono', group.image),
						' but that file has not been uploaded. The spine will fail to load without it.',
					)
				: null,
			h('div.field', h('label', 'Spine export'), groupSelect),
			h('div.field', h('label', 'Skeleton for this symbol'), skeletonSelect),
			h('div.field', h('label', 'Animation per state'), stateRows),
			h('div.modal-actions',
				h('button.btn', { onclick: close }, 'Cancel'),
				h('button.btn.btn-primary', {
					onclick: () => {
						const animations = {};
						for (const [state, control] of stateInputs) {
							if (control.value) animations[state] = control.value;
						}
						attach({
							symbol: row.symbol,
							kind: 'spine',
							atlas: group.atlas,
							png: group.image,
							skeleton: skeletonSelect.value,
							animations,
						});
						close();
					},
				}, 'Attach'),
			),
		);
	}

	function spriteForm() {
		if (!images.length) {
			return h('div.msg.msg-info', 'No images uploaded yet.');
		}
		const select = h('select', images.map((i) => h('option', { value: i.file }, i.file)));
		if (row.kind === 'sprite') select.value = row.source.sprite;

		return h('div',
			h('div.msg.msg-info.small',
				'A flat image covers every state — it renders, it just does not animate. ',
				'This is what placeholder art uses, and it is right for symbols that never move.',
			),
			h('div.field', h('label', 'Image'), select),
			h('div.modal-actions',
				h('button.btn', { onclick: close }, 'Cancel'),
				h('button.btn.btn-primary', {
					onclick: () => {
						attach({ symbol: row.symbol, kind: 'sprite', sprite: select.value });
						close();
					},
				}, 'Attach'),
			),
		);
	}

	render();

	return h('div',
		h('h2', `Art for ${row.symbol}`),
		h('p.modal-sub',
			`${row.role}`,
			(row.behaviors ?? []).length ? ` · behaviors: ${row.behaviors.join(', ')}` : '',
			` · needs ${row.required.length} states: `,
			h('span.mono', row.required.join(', ')),
		),
		h('div.row', { style: 'margin-bottom:14px; gap:6px' },
			h(`button.btn.btn-small${mode === 'spine' ? '.btn-primary' : ''}`, {
				onclick: () => { mode = 'spine'; render(); rerenderTabs(); },
			}, 'Spine'),
			h(`button.btn.btn-small${mode === 'sprite' ? '.btn-primary' : ''}`, {
				onclick: () => { mode = 'sprite'; render(); rerenderTabs(); },
			}, 'Flat image'),
		),
		body,
	);

	// The two mode buttons live above `body`, so flipping mode has to restyle
	// them as well as swap the form.
	function rerenderTabs() {
		const buttons = body.parentElement?.querySelectorAll('.btn-small');
		if (!buttons) return;
		buttons[0].classList.toggle('btn-primary', mode === 'spine');
		buttons[1].classList.toggle('btn-primary', mode === 'sprite');
	}
}

// ── screens ─────────────────────────────────────────────────────────────────
/**
 * Backgrounds, intro/outro screens, banners.
 *
 * These mostly want spines: Background.svelte, FreeSpinIntro.svelte and
 * WinAnimation.svelte all hardcode <SpineProvider> and play named tracks, so a
 * flat image cannot stand in for one. Slots you do not supply keep the sample
 * app's art, which is why placeholder runs leave them alone.
 */
function screensCard({ data, attach, detachSlot }) {
	const slots = data.screenSlots ?? [];
	const groups = data.groups ?? [];
	const images = (data.assets ?? []).filter((a) => a.kind === 'image');
	const spriteAtlases = (data.assets ?? []).filter((a) => a.kind === 'spriteAtlas');

	const openSlot = (slot) =>
		modal((close) => {
			const wantsSpine = slot.assetType === 'spine';
			const groupSelect = h('select', groups.map((g, i) =>
				h('option', { value: String(i) }, `${g.atlas}  →  ${g.image ?? 'no image'}`)));
			const skeletonSelect = h('select');
			const fileSelect = h('select', [...images, ...spriteAtlases].map((a) =>
				h('option', { value: a.file }, a.file)));

			const syncSkeletons = () => {
				const group = groups[Number(groupSelect.value)];
				mount(skeletonSelect, (group?.skeletons ?? []).map((s) =>
					h('option', { value: s.file }, `${s.file}  (${s.animations.length} animations)`)));
			};
			groupSelect.onchange = syncSkeletons;
			syncSkeletons();

			const canSpine = wantsSpine && groups.length;

			return h('div',
				h('h2', slot.slotId),
				h('p.modal-sub',
					h('span.mono', slot.assetKey), ' → ', slot.component,
					slot.animations?.length
						? h('div', { style: 'margin-top:6px' },
								h('span.dim', 'it plays: '), h('span.mono', slot.animations.join(', ')))
						: null,
				),
				slot.note ? h('div.msg.msg-info.small', slot.note) : null,

				wantsSpine && !groups.length
					? h('div.msg.msg-warn',
							'This slot needs a spine — ', h('span.mono', slot.component),
							' plays named animation tracks, so a flat image cannot stand in. ',
							'Upload the .atlas, its image and a skeleton .json.',
						)
					: null,

				canSpine
					? h('div',
							h('div.field', h('label', 'Spine export'), groupSelect),
							h('div.field', h('label', 'Skeleton'), skeletonSelect),
						)
					: !wantsSpine
						? h('div.field', h('label', 'File'), fileSelect)
						: null,

				h('div.modal-actions',
					h('button.btn', { onclick: close }, 'Cancel'),
					h('button.btn.btn-primary', {
						disabled: canSpine ? false : wantsSpine,
						onclick: () => {
							const group = groups[Number(groupSelect.value)];
							attach({
								slotId: slot.slotId,
								entry: canSpine
									? { atlas: group.atlas, png: group.image, skeleton: skeletonSelect.value }
									: { type: slot.assetType, sprite: fileSelect.value },
							});
							close();
						},
					}, 'Attach'),
				),
			);
		});

	return h('div.card',
		h('h2', 'Screens'),
		h('p.card-sub', 'Backgrounds, free-spin screens and banners. Unsupplied slots keep the sample app’s art.'),
		h('table',
			h('thead', h('tr', ['', 'Slot', 'Drives', 'Type', ''].map((t) => h('th', t)))),
			h('tbody', slots.map((slot) =>
				h('tr',
					h('td', slot.supplied
						? h('span', { style: 'color:var(--ok)' }, '✓')
						: h('span.dim', '·')),
					h('td', h('span.mono', slot.slotId),
						slot.required ? h('span.pill.warn', { style: 'margin-left:6px' }, 'needed') : null,
						// Some slots register an asset but have no component wired to
						// render it — saying so beats letting you wonder why nothing
						// appeared after importing.
						slot.manualWiring
							? h('span.pill', { style: 'margin-left:6px' }, 'needs a component edit')
							: null),
					h('td', h('span.small.dim', slot.component)),
					h('td', h('span.pill', slot.assetType)),
					h('td', { style: 'text-align:right; white-space:nowrap' },
						h('button.btn.btn-small', { onclick: () => openSlot(slot) },
							slot.supplied ? 'Change' : 'Attach'),
						slot.supplied
							? h('button.btn.btn-small.btn-danger', {
									style: 'margin-left:5px',
									onclick: () => detachSlot(slot.slotId),
								}, '×')
							: null,
					),
				),
			)),
		),
	);
}

// ── anything else ───────────────────────────────────────────────────────────
/**
 * Register an image under a key you choose.
 *
 * The sample apps have components for symbols, backgrounds, free-spin screens,
 * banners and board chrome — and nothing else. There is no character, pop-up or
 * variant concept in the SDK. So art for those goes here: it gets loaded and
 * addressable as `<Sprite key="..." />`, and a component of yours renders it.
 * Registering is the half that can be automated; drawing it is not.
 */
function namedCard({ data, attach, detachNamed }) {
	const images = (data.assets ?? []).filter((a) => a.kind === 'image');
	const named = data.namedSprites ?? [];

	const add = () =>
		modal((close) => {
			const key = h('input.mono', { placeholder: 'e.g. logo, popup_bg, character_idle' });
			const file = h('select', images.map((i) => h('option', { value: i.file }, i.file)));
			const err = h('div');

			return h('div',
				h('h2', 'Register an image under a key'),
				h('p.modal-sub',
					'For anything the sample apps have no slot for — logos, pop-up art, characters, ',
					'alternate variants. It becomes loadable as ',
					h('span.mono', '<Sprite key="…" />'), '.',
				),
				h('div.msg.msg-warn.small',
					h('strong', 'Nothing renders it on its own. '),
					'The SDK has no component for these, so after importing you add one — or reference ',
					'the key from a component you already have.',
				),
				err,
				h('div.field', h('label', 'Asset key'), key,
					h('div.field-hint', 'Letters, digits and underscores. This is what your component asks for.')),
				h('div.field', h('label', 'Image'), file),
				h('div.modal-actions',
					h('button.btn', { onclick: close }, 'Cancel'),
					h('button.btn.btn-primary', {
						onclick: () => {
							if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key.value)) {
								return mount(err, h('div.msg.msg-err', 'Key must be a plain identifier.'));
							}
							attach({ kind: 'named', key: key.value, file: file.value });
							close();
						},
					}, 'Register'),
				),
			);
		});

	return h('div.card',
		h('div.row',
			h('h2', { style: 'margin:0' }, 'Anything else'),
			h('div.spacer'),
			h('button.btn.btn-small', { disabled: !images.length, onclick: add }, 'Register an image'),
		),
		h('p.card-sub',
			'Logos, pop-up art, characters, variants — anything the sample apps have no component for. ',
			'These get loaded and addressable; rendering them is a component you write.',
		),
		named.length
			? h('table',
					h('tbody', named.map((n) =>
						h('tr',
							h('td', h('span.mono', n.key)),
							h('td', h('span.small.dim', n.file)),
							h('td', h('span.mono.small.dim', `<Sprite key="${n.key}" />`)),
							h('td', { style: 'text-align:right' },
								h('button.btn.btn-small.btn-danger', { onclick: () => detachNamed(n.key) }, '×')),
						),
					)),
				)
			: h('p.dim.small', 'Nothing registered.'),
	);
}

// ── files ───────────────────────────────────────────────────────────────────
function filesCard({ data, gameId, remove }) {
	const assets = data.assets ?? [];
	if (!assets.length) {
		return h('div.card', h('h2', 'Files'), h('p.dim.small', 'Nothing in assets-source yet.'));
	}

	const byKind = { image: [], skeleton: [], atlas: [], other: [] };
	for (const a of assets) {
		(byKind[a.kind] ?? byKind.other).push(a);
	}

	return h('div.card',
		h('div.row',
			h('h2', { style: 'margin:0' }, 'Files'),
			h('div.spacer'),
			h('span.dim.small', `${assets.length} in assets-source/`),
		),

		byKind.image.length
			? h('div',
					h('p.card-sub', { style: 'margin-top:10px' }, 'Images'),
					h('div.art-grid', byKind.image.map((a) =>
						h('div.art-tile',
							h('img', { src: `/api/games/${gameId}/art/${encodeURIComponent(a.file)}`, alt: a.file, loading: 'lazy' }),
							h('div.name', a.file),
							h('button.btn.btn-small.btn-danger', { style: 'margin-top:5px', onclick: () => remove(a.file) }, 'Delete'),
						),
					)),
				)
			: null,

		[...byKind.skeleton, ...byKind.atlas, ...byKind.other].length
			? h('div',
					h('p.card-sub', { style: 'margin-top:16px' }, 'Spine and other files'),
					h('table',
						h('tbody', [...byKind.skeleton, ...byKind.atlas, ...byKind.other].map((a) =>
							h('tr',
								h('td', h('span.mono', a.file)),
								h('td', h('span.pill', a.kind)),
								h('td.small.dim',
									a.kind === 'skeleton'
										? a.binary
											? 'binary — animation names not readable'
											: `${a.animations.length} animations: ${a.animations.slice(0, 6).join(', ')}${a.animations.length > 6 ? '…' : ''}`
										: a.kind === 'atlas'
											? `image: ${a.image ?? 'not named'}`
											: a.error ?? '',
								),
								h('td', { style: 'text-align:right' },
									h('button.btn.btn-small.btn-danger', { onclick: () => remove(a.file) }, 'Delete')),
							),
						)),
					),
				)
			: null,
	);
}
