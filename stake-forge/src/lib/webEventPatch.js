import fs from 'fs-extra';
import path from 'node:path';

import { WEB_EVENT_HANDLERS } from './webEventHandlers.js';

/**
 * Splice missing bookEvent handlers into a scaffolded app.
 *
 * ── The three files docs/fe_docs/steps.md says must change ──────────────────
 * That doc walks through adding one bookEvent by hand and names six files. Three
 * are DATA that `forge math:sync` already writes from the simulation
 * (stories/data/*_books.ts, stories/data/*_events.ts) or that only affect the
 * storybook listing. The three that decide whether the event reaches the player
 * are:
 *
 *   typesBookEvent.ts      the type, and its arm of the BookEvent union
 *   bookEventHandlerMap.ts the handler — the ONLY one the dispatcher reads
 *   components/Game.svelte the component mount, when the handler needs one
 *
 * A type without a handler still drops the event at runtime, so the handler is
 * the one that matters and the type is what makes it type-check.
 *
 * Every edit is idempotent: an app that already handles an event is left alone,
 * which is what makes `forge scaffold --force` safe to re-run and keeps the
 * cluster and scatter apps (which ship their own updateGlobalMult) untouched.
 */

/** Add a type block and hang it off the BookEvent union. */
function patchTypes(source, handler) {
	if (source.includes(`type: '${handler.type}'`)) return { source, changed: false };

	// The union is `export type BookEvent =` followed by `| Name` arms and a `;`.
	const unionMatch = source.match(/export type BookEvent =\n((?:\t\| [A-Za-z]+\n)+)/);
	if (!unionMatch) return { source, changed: false, reason: 'no BookEvent union found' };

	const withType = source.replace(
		'export type BookEvent =',
		`${handler.tsType}\n\nexport type BookEvent =`,
	);
	return {
		source: withType.replace(
			unionMatch[1],
			`${unionMatch[1]}\t| ${handler.tsTypeName}\n`,
		),
		changed: true,
	};
}

/** Add the handler entry to the exported map. */
function patchHandlerMap(source, handler) {
	// A handler key at one tab of indent — the same shape eventCoverage reads.
	if (new RegExp(`^\\t${handler.type}\\s*:`, 'm').test(source)) {
		return { source, changed: false };
	}

	// Insert before the final `};` of the exported map rather than after a named
	// sibling, because which handlers exist differs per app.
	const close = source.lastIndexOf('\n};');
	if (close === -1) return { source, changed: false, reason: 'no closing brace on the handler map' };

	return {
		source: `${source.slice(0, close)}\n${handler.handler}${source.slice(close)}`,
		changed: true,
	};
}

/**
 * Mount a component in Game.svelte.
 *
 * GlobalMultiplier.svelte ships in every sample app including lines and ways —
 * complete, and simply never imported. So this is a mount, not a generated
 * component: writing our own would shadow art the app already has.
 */
function patchGameMount(source, component) {
	if (new RegExp(`<${component}\\s*/>`).test(source)) return { source, changed: false };

	const importLine = `\timport ${component} from './${component}.svelte';`;
	let next = source;
	if (!source.includes(importLine.trim())) {
		// After the last import inside the module script.
		const imports = [...source.matchAll(/^\timport .+;$/gm)];
		if (!imports.length) return { source, changed: false, reason: 'no imports in Game.svelte' };
		const last = imports[imports.length - 1];
		next = `${next.slice(0, last.index + last[0].length)}\n${importLine}${next.slice(last.index + last[0].length)}`;
	}

	// Mounted beside the other overlay components, which every sample app keeps
	// inside the same container as <Win />.
	const anchor = next.match(/^(\t+)<Win\s*\/>$/m);
	if (!anchor) return { source: next, changed: false, reason: 'no <Win /> to mount beside' };
	return {
		source: next.replace(anchor[0], `${anchor[0]}\n${anchor[1]}<${component} />`),
		changed: true,
	};
}

/**
 * Add handlers for every event in `types` the app does not already handle.
 *
 * Returns what it did rather than logging, so the caller decides how loud to be.
 */
export function addWebEventHandlers(appDir, types) {
	const added = [];
	const skipped = [];
	const problems = [];

	const typesFile = path.join(appDir, 'src', 'game', 'typesBookEvent.ts');
	const mapFile = path.join(appDir, 'src', 'game', 'bookEventHandlerMap.ts');
	const gameFile = path.join(appDir, 'src', 'components', 'Game.svelte');
	if (!fs.existsSync(typesFile) || !fs.existsSync(mapFile)) {
		return { added, skipped, problems: ['this app has no typesBookEvent.ts / bookEventHandlerMap.ts'] };
	}

	let typesSource = fs.readFileSync(typesFile, 'utf8');
	let mapSource = fs.readFileSync(mapFile, 'utf8');
	let gameSource = fs.existsSync(gameFile) ? fs.readFileSync(gameFile, 'utf8') : null;

	for (const type of types) {
		const handler = WEB_EVENT_HANDLERS[type];
		if (!handler) continue;

		const t = patchTypes(typesSource, handler);
		const m = patchHandlerMap(mapSource, handler);
		if (t.reason) problems.push(`${type}: ${t.reason}`);
		if (m.reason) problems.push(`${type}: ${m.reason}`);
		typesSource = t.source;
		mapSource = m.source;

		if (handler.component && gameSource) {
			// Only mount a component the app actually ships. Every sample carries
			// GlobalMultiplier.svelte, but that is a fact to check rather than assume.
			const componentFile = path.join(appDir, 'src', 'components', `${handler.component}.svelte`);
			if (fs.existsSync(componentFile)) {
				const g = patchGameMount(gameSource, handler.component);
				if (g.reason) problems.push(`${type}: ${g.reason}`);
				gameSource = g.source;
			} else {
				problems.push(
					`${type}: needs components/${handler.component}.svelte, which this app does not ship`,
				);
			}
		}

		if (m.changed) added.push(type);
		else skipped.push(type);
	}

	if (added.length) {
		fs.writeFileSync(typesFile, typesSource, 'utf8');
		fs.writeFileSync(mapFile, mapSource, 'utf8');
		if (gameSource !== null) fs.writeFileSync(gameFile, gameSource, 'utf8');
	}
	return { added, skipped, problems };
}
