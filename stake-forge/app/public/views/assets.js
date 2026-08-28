/**
 * Assets view — the audit table plus whatever art currently exists.
 *
 * The audit is the useful half: it lists every animation state each symbol's
 * role AND behaviors require, and which of them the manifest actually supplies.
 * A missing expanding-wild state is otherwise invisible until the feature fires
 * in-game.
 */

import { h, mount, api, toast } from '../lib.js';

export function renderAssets(ctx) {
	const { game } = ctx;
	const root = h('div');

	const auditCard = h('div.card', h('h2', 'Audit'), h('p.card-sub', 'Loading…'));
	const artCard = h('div.card', h('h2', 'Art'), h('p.card-sub', 'Loading…'));
	mount(root, auditCard, artCard);

	loadAudit();
	loadArt();

	async function loadAudit() {
		if (!game.hasManifest) {
			return mount(auditCard,
				h('h2', 'Audit'),
				h('p.card-sub', 'Checks the manifest against the states each symbol needs.'),
				h('div.msg.msg-info',
					'No assets-manifest.yaml yet. Run ',
					h('strong', 'Generate placeholder art'),
					' on the Build tab and the game will render immediately with stand-in tiles.',
				),
			);
		}
		try {
			const result = await api(`/api/games/${game.id}/audit`);
			if (!result.ok) throw new Error(result.error);
			mount(auditCard, auditContent(result.report));
		} catch (err) {
			mount(auditCard, h('h2', 'Audit'), h('div.msg.msg-err', err.message));
		}
	}

	async function loadArt() {
		try {
			const { files } = await api(`/api/games/${game.id}/art`);
			mount(artCard,
				h('div.row',
					h('h2', { style: 'margin:0' }, 'Art'),
					h('div.spacer'),
					h('span.dim.small', `${files.length} file${files.length === 1 ? '' : 's'} in assets-source/`),
				),
				h('p.card-sub', 'Everything currently in the game’s assets-source folder.'),
				files.length
					? h('div.art-grid', files.map((f) =>
							h('div.art-tile',
								h('img', { src: f.url, alt: f.file, loading: 'lazy' }),
								h('div.name', f.file),
							),
						))
					: h('p.dim.small', 'Nothing yet.'),
			);
		} catch (err) {
			mount(artCard, h('h2', 'Art'), h('div.msg.msg-err', err.message));
		}
	}

	return root;
}

function auditContent(report) {
	const errors = report.findings.filter((f) => f.level === 'error');
	const warnings = report.findings.filter((f) => f.level === 'warn');

	return [
		h('div.row',
			h('h2', { style: 'margin:0' }, 'Audit'),
			h('div.spacer'),
			errors.length
				? h('span.pill.err', `${errors.length} error${errors.length === 1 ? '' : 's'}`)
				: h('span.pill.ok', 'no errors'),
			warnings.length ? h('span.pill.warn', `${warnings.length} warning${warnings.length === 1 ? '' : 's'}`) : null,
		),
		h('p.card-sub', 'Required states come from each symbol’s role plus its behaviors.'),

		h('table',
			h('thead', h('tr', ['', 'Symbol', 'Role', 'Behaviors', 'States'].map((t) => h('th', t)))),
			h('tbody', report.symbolRows.map((row) =>
				h('tr',
					h('td', row.missing.length
						? h('span', { style: 'color:var(--err)' }, '✕')
						: row.kind === 'sprite'
							? h('span', { style: 'color:var(--info)' }, '◐')
							: h('span', { style: 'color:var(--ok)' }, '✓')),
					h('td', h('span.mono', row.symbol)),
					h('td', h(`span.pill.role-${row.role}`, row.role)),
					h('td', (row.behaviors ?? []).length ? h('span.mono.small', row.behaviors.join(', ')) : h('span.dim', '—')),
					h('td', row.missing.length
						? h('span', { style: 'color:var(--err)' }, `missing: ${row.missing.join(', ')}`)
						: row.kind === 'sprite'
							? h('span.dim', `${row.required.length} states via placeholder sprite`)
							: h('span.dim', `${row.required.length} states ok`)),
				),
			)),
		),

		h('h2', { style: 'margin-top:22px' }, 'Screens'),
		h('table',
			h('thead', h('tr', ['', 'Slot', 'Asset key', 'Component'].map((t) => h('th', t)))),
			h('tbody', report.screenRows.map((row) =>
				h('tr',
					h('td', row.supplied
						? h('span', { style: 'color:var(--ok)' }, '✓')
						: row.declared
							? h('span', { style: 'color:var(--info)' }, '◐')
							: h('span.dim', '·')),
					h('td', h('span.mono', row.slot)),
					h('td', h('span.mono.dim', row.assetKey)),
					h('td', h('span.small.dim', row.component),
						!row.supplied && row.declared ? h('span.dim.small', ' — using sample art') : null),
				),
			)),
		),

		errors.length || warnings.length
			? h('div', { style: 'margin-top:20px' },
					...errors.map((f) => h('div.msg.msg-err',
						h('strong', `${f.area}: `), f.message,
						f.fix ? h('div.small.dim', { style: 'margin-top:4px' }, f.fix) : null,
					)),
					...warnings.map((f) => h('div.msg.msg-warn', h('strong', `${f.area}: `), f.message)),
				)
			: null,
	];
}
