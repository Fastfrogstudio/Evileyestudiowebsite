import { h, mount } from '../lib.js';

/**
 * The Art brief tab.
 *
 * For an art-and-animation studio this is the first screen that matters: what to
 * draw, before any art exists. Everything else in the app operates on art that
 * already exists — this is the one view that is useful on day one of a project.
 *
 * Deliberately read-only. It states the engine's contract; nothing here is a
 * decision the user makes, so nothing here is editable. The three download
 * buttons are the point: the brief leaves this screen and goes to whoever is
 * actually drawing.
 */
export function renderBrief(ctx) {
	const root = h('div.brief');
	const body = h('div');
	root.append(h('div.brief-head'), body);

	let data = null;
	let payload = null;

	load();

	async function load() {
		mount(body, h('p.dim', 'Reading the spec…'));
		try {
			const res = await fetch(`/api/games/${ctx.game.id}/brief`);
			payload = await res.json();
			if (!res.ok) throw new Error(payload.error || 'could not build the brief');
			data = payload.data;
			render();
		} catch (err) {
			mount(
				body,
				h('div.card',
					h('div.msg.msg-err', 'Could not build the art brief.'),
					h('p.dim', String(err.message)),
					h('p.dim', 'The spec has to validate first — fix anything the Spec tab reports.'),
				),
			);
		}
	}

	function download(name, contents, type) {
		const blob = new Blob([contents], { type });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = name;
		a.click();
		URL.revokeObjectURL(url);
	}

	function render() {
		const t = data.totals;
		const g = data.game;

		mount(root.querySelector('.brief-head'),
			h('div.row',
				h('div',
					h('h2', 'Art brief'),
					h('p.dim',
						`${g.mechanic} · ${g.reels.count}x${g.reels.rows[0]} · ` +
						`${(g.rtp * 100).toFixed(2)}% RTP · ${g.volatility} volatility · ` +
						`${g.maxWin.toLocaleString('en-US')}x max win`),
				),
				h('div.spacer'),
				h('div.row',
					h('button.btn', { onclick: () => download(`${g.name}-art-brief.md`, payload.markdown, 'text/markdown') }, 'Markdown'),
					h('button.btn', { onclick: () => download(`${g.name}-art-brief.csv`, payload.csv, 'text/csv') }, 'CSV'),
					h('button.btn', { onclick: () => download('assets-manifest.yaml', payload.manifest, 'text/yaml') }, 'Manifest'),
				),
			),
		);

		mount(body,
			// ── the numbers that get scheduled ──────────────────────────────────
			h('div.stat-row',
				stat(t.symbols, 'symbols'),
				stat(t.symbolStates, 'animation states'),
				stat(`${t.requiredScreens}/${t.screens}`, 'screens required'),
				stat(t.bannerAnimations, 'banner animations'),
				stat(t.localisedFrames, 'localised frames', 'warn'),
				stat(t.sounds, 'sounds'),
			),

			// ── symbols ─────────────────────────────────────────────────────────
			h('div.card',
				h('h2', 'Symbols'),
				h('p.dim',
					`Spine skeletons sharing one atlas, at ${data.symbols[0]?.size.width ?? 200}x` +
					`${data.symbols[0]?.size.height ?? 200}px. A flat *_static.webp can stand in for the ` +
					'states that do not animate.'),
				h('table',
					h('thead', h('tr',
						h('th', 'Symbol'), h('th', 'Role'), h('th', 'States'), h('th', 'Animation names'),
					)),
					h('tbody', ...data.symbols.map((s) =>
						h('tr',
							h('td', h('strong', s.name), ' ', h('span.dim', s.label)),
							h('td', s.role, s.special.length ? h('span.dim', ` ${s.special.join(', ')}`) : null),
							h('td', String(s.states.length)),
							h('td.mono.dim.small', s.states.map((st) => st.animationName).join(', ')),
						),
					)),
				),
				...data.symbols.filter((s) => s.note).map((s) =>
					h('div.msg.msg-info.small', h('strong', `${s.name}: `), s.note)),
			),

			// ── screens ─────────────────────────────────────────────────────────
			h('div.card',
				h('h2', 'Screens and board furniture'),
				h('table',
					h('thead', h('tr',
						h('th', 'Slot'), h('th', 'Type'), h('th', 'Animations'), h('th', 'Needed'), h('th', 'Scope'),
					)),
					h('tbody', ...data.screens.map((s) =>
						h('tr',
							h('td', s.id, h('div.dim.small.mono', s.assetKey)),
							h('td.dim', s.assetType),
							h('td.dim.mono', s.animations.join(', ') || '—'),
							h('td', s.required ? h('span.pill.err', 'required') : h('span.dim', 'optional')),
							h('td.dim', s.reusableAcrossGames ? 'reused across games' : 'per game'),
						),
					)),
				),
			),

			// ── banners ─────────────────────────────────────────────────────────
			h('div.card',
				h('h2', 'Win banners'),
				h('p.dim',
					'Levels 1-5 are count-ups with no art. The same banner plays on two scales — a ' +
					'single win during a spin, and the total of a whole free-spin round — so each level ' +
					'covers two different ranges.'),
				h('table',
					h('thead', h('tr',
						h('th', 'Level'), h('th', 'Name'), h('th', 'Single win'), h('th', 'Feature total'), h('th', 'Animations'),
					)),
					h('tbody', ...data.banners.map((b) =>
						h('tr',
							h('td', String(b.level)),
							h('td', b.alias),
							h('td.mono', `${fmt(b.standard.from)}x – ${fmt(b.standard.to)}x`),
							h('td.mono', `${fmt(b.endFeature.from)}x – ${fmt(b.endFeature.to)}x`),
							h('td.dim.mono', b.animations.join(', ')),
						),
					)),
				),
				...data.banners
					.filter((b) => Number.isFinite(b.widestRatio) && b.widestRatio > 100)
					.map((b) => h('div.msg.msg-info.small',
						h('strong', `Level ${b.level} covers a ${fmt(b.widestRatio)}x range. `),
						'One banner behind wins that feel nothing alike — worth escalating it with the count-up.')),
			),

			// ── localisation ────────────────────────────────────────────────────
			h('div.card',
				h('h2', `Localised text art — ${t.localisedFrames} frames`),
				h('div.msg.msg-info.small',
					h('strong', 'This is baked artwork, not strings. '),
					`The sample apps render these words as images, one per language. It is the most ` +
					`under-estimated line in a slot art budget, which is why it is itemised.`),
				h('p.dim.small.mono', data.locales.join(' · ')),
				h('table',
					h('thead', h('tr', h('th', 'Sheet'), h('th', 'Content'), h('th', 'Frames'))),
					h('tbody', ...data.localised.map((l) =>
						h('tr',
							h('td.mono', l.sheet),
							h('td', l.content),
							h('td', String(l.count)),
						),
					)),
				),
			),

			// ── what the mechanics add ──────────────────────────────────────────
			data.fromMechanics.animations.length
				? h('div.card',
						h('h2', 'What this game’s mechanics add'),
						h('p.dim.small.mono', data.fromMechanics.mechanics.join(', ')),
						h('h3.sub', 'Animations'),
						h('ul', ...data.fromMechanics.animations.map((a) => h('li.dim.small.mono', a))),
						data.fromMechanics.screens.length ? h('h3.sub', 'Screens') : null,
						data.fromMechanics.screens.length
							? h('ul', ...data.fromMechanics.screens.map((x) => h('li.dim.small', x)))
							: null,
						...data.fromMechanics.notes.map((n) =>
							h('div.msg.msg-info.small', h('strong', `${n.mechanic}: `), n.note)),
					)
				: null,

			// ── sound ───────────────────────────────────────────────────────────
			h('div.card',
				h('h2', 'Sound'),
				h('p.dim', 'Named as sound:build expects them — drop the files in sounds-source/.'),
				h('table',
					h('thead', h('tr', h('th', 'Name'), h('th', 'Kind'), h('th', 'Loops'), h('th', 'Note'))),
					h('tbody', ...data.sounds.map((s) =>
						h('tr',
							h('td.mono', s.name),
							h('td.dim', s.kind),
							h('td.dim', s.loops ? 'yes' : 'no'),
							h('td.dim', s.note || ''),
						),
					)),
				),
			),

			h('p.dim',
				'When every item above exists, the Build tab’s audit step passes with zero errors. ' +
				'That equivalence is asserted by a test, so this brief cannot quietly drift from the checker.'),
		);
	}

	function stat(value, label, kind) {
		return h('div.stat',
			h(`div.stat-value${kind ? `.${kind}` : ''}`, String(value)),
			h('div.stat-label', label),
		);
	}

	const fmt = (n) =>
		!Number.isFinite(n) ? '∞' : n >= 1000 ? Math.round(n).toLocaleString('en-US') : Math.round(n * 100) / 100;

	return root;
}
