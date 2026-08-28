/**
 * Apply a behavior recipe's web half to a scaffolded app.
 *
 * The edit list follows web-sdk/README.md's own "Steps to Add a New BookEvent"
 * procedure verbatim, in the order it prescribes:
 *
 *   1. src/game/typesBookEvent.ts   — the event type + a member of the BookEvent union
 *   2. src/game/bookEventHandlerMap.ts — a handler keyed by bookEvent.type
 *   3. src/components/<Name>.svelte  — the component, exporting its EmitterEvent union
 *   4. src/game/typesEmitterEvent.ts — import that union into EmitterEventGame
 *   5. src/stories/data/<mode>_events.ts — a fixture per event, for the bookEvent stories
 *
 * Every edit is idempotent: re-running scaffold with --force on an app that has
 * already been patched will not stack duplicate types, handlers or imports.
 */

import fs from 'fs-extra';
import path from 'node:path';

import { tsStringify } from './tsSerialize.js';

/** Insert `text` before the `export type BookEvent =` union declaration. */
function insertBeforeUnion(source, text) {
	const idx = source.indexOf('export type BookEvent =');
	if (idx === -1) return null;
	return `${source.slice(0, idx)}${text}\n\n${source.slice(idx)}`;
}

/** Add members to the `export type BookEvent = A | B;` union. */
function extendBookEventUnion(source, members) {
	const re = /export type BookEvent =([\s\S]*?);/;
	const match = re.exec(source);
	if (!match) return null;

	let body = match[1];
	const additions = members.filter((m) => !body.includes(m));
	if (!additions.length) return source;

	body = `${body.replace(/\s*$/, '')}\n\t| ${additions.join('\n\t| ')}`;
	return source.replace(re, `export type BookEvent =${body};`);
}

function patchTypesBookEvent(appDir, emitted) {
	const file = path.join(appDir, 'src', 'game', 'typesBookEvent.ts');
	let source = fs.readFileSync(file, 'utf8');

	if (!source.includes(emitted.bookEventUnionMembers[0])) {
		const withTypes = insertBeforeUnion(source, `// stake-forge behavior recipe\n${emitted.bookEventTypes}`);
		if (!withTypes) throw new Error('typesBookEvent.ts: could not find `export type BookEvent =`');
		source = withTypes;
	}

	const withUnion = extendBookEventUnion(source, emitted.bookEventUnionMembers);
	if (!withUnion) throw new Error('typesBookEvent.ts: could not extend the BookEvent union');

	fs.writeFileSync(file, withUnion, 'utf8');
}

function patchBookEventHandlerMap(appDir, emitted) {
	const file = path.join(appDir, 'src', 'game', 'bookEventHandlerMap.ts');
	let source = fs.readFileSync(file, 'utf8');

	const firstHandlerName = /^\t(\w+):/m.exec(emitted.handlers)?.[1];
	if (firstHandlerName && new RegExp(`^\\t${firstHandlerName}:`, 'm').test(source)) return;

	const marker = 'export const bookEventHandlerMap';
	const start = source.indexOf(marker);
	if (start === -1) throw new Error('bookEventHandlerMap.ts: could not find the handler map export');

	// Walk to the matching close brace of the map object.
	const openIdx = source.indexOf('{', start);
	let depth = 0;
	let i = openIdx;
	for (; i < source.length; i += 1) {
		if (source[i] === '{') depth += 1;
		else if (source[i] === '}') {
			depth -= 1;
			if (depth === 0) break;
		}
	}

	source = `${source.slice(0, i)}${emitted.handlers}\n${source.slice(i)}`;
	fs.writeFileSync(file, source, 'utf8');
}

function patchTypesEmitterEvent(appDir, emitted) {
	const file = path.join(appDir, 'src', 'game', 'typesEmitterEvent.ts');
	let source = fs.readFileSync(file, 'utf8');
	const { typeName, from } = emitted.emitterImport;
	if (source.includes(typeName)) return;

	source = `import type { ${typeName} } from '${from}';\n${source}`;

	const re = /export type EmitterEventGame =([\s\S]*?);/;
	const match = re.exec(source);
	if (!match) throw new Error('typesEmitterEvent.ts: could not find the EmitterEventGame union');
	const body = `${match[1].replace(/\s*$/, '')}\n\t| ${typeName}`;
	source = source.replace(re, `export type EmitterEventGame =${body};`);

	fs.writeFileSync(file, source, 'utf8');
}

/**
 * Story fixtures. These make the new bookEvents testable in isolation via the
 * MODE_<MODE>/bookEvent/<TYPE> stories, which is the step the web-sdk README
 * calls out as "set up the testing environment first".
 */
function patchStoryEvents(appDir, emitted) {
	const dataDir = path.join(appDir, 'src', 'stories', 'data');
	if (!fs.existsSync(dataDir) || !emitted.storyEvents) return;

	for (const file of fs.readdirSync(dataDir).filter((f) => f.endsWith('_events.ts'))) {
		const full = path.join(dataDir, file);
		let source = fs.readFileSync(full, 'utf8');
		const additions = Object.entries(emitted.storyEvents).filter(
			([key]) => !new RegExp(`^\\t${key}:`, 'm').test(source),
		);
		if (!additions.length) continue;

		const openIdx = source.indexOf('{', source.indexOf('export default'));
		if (openIdx === -1) continue;
		let depth = 0;
		let i = openIdx;
		for (; i < source.length; i += 1) {
			if (source[i] === '{') depth += 1;
			else if (source[i] === '}') {
				depth -= 1;
				if (depth === 0) break;
			}
		}

		// tsStringify rather than JSON.stringify: the sample story files use the
		// codebase's own style (tabs, unquoted identifier keys, single quotes),
		// and a block of double-quoted JSON in the middle of one reads as foreign
		// and fails the repo's prettier check.
		const block = additions.map(([key, value]) => `\t${key}: ${tsStringify(value, 1)},`).join('\n');
		source = `${source.slice(0, i)}${block}\n${source.slice(i)}`;
		fs.writeFileSync(full, source, 'utf8');
	}
}

export function applyWebRecipe(appDir, emitted) {
	for (const file of emitted.files ?? []) {
		const dest = path.join(appDir, file.path);
		if (file.mode === 'create' && fs.existsSync(dest)) continue;
		fs.ensureDirSync(path.dirname(dest));
		fs.writeFileSync(dest, file.contents, 'utf8');
	}
	if (emitted.bookEventTypes) patchTypesBookEvent(appDir, emitted);
	if (emitted.handlers) patchBookEventHandlerMap(appDir, emitted);
	if (emitted.emitterImport) patchTypesEmitterEvent(appDir, emitted);
	patchStoryEvents(appDir, emitted);
}
