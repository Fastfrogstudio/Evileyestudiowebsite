import fs from 'fs-extra';
import path from 'node:path';
import YAML from 'yaml';

/**
 * `feedback.yaml` — what somebody said was wrong with this game, and whether it
 * is fixed.
 *
 * ── Why this lives beside the spec instead of in a tracker ──────────────────
 * A note from Stake is not a bug report about the tool, it is a change to THIS
 * GAME: a max win that cannot be reached, a hit rate out of band, a symbol that
 * reads badly at reel size. The fix is an edit to game-spec.yaml or a re-export
 * of one asset, and then the whole pipeline runs again.
 *
 * Kept anywhere else, the note and the thing it is about drift apart: the game
 * is regenerated, the spec changes, and nothing connects the change to the
 * reason for it. Kept here, it is versioned with the spec, travels with the
 * game folder, and can be checked against the spec it names.
 *
 * ── Why it has teeth ────────────────────────────────────────────────────────
 * A list nobody is forced to read is a list that gets shipped past. An item
 * from `stake` or `certification` that is still open BLOCKS packaging, because
 * that is exactly the case where shipping anyway wastes a review cycle. Every
 * other source warns and lets you through — an internal note about a symbol's
 * colour should not stop a build.
 */

export const SOURCES = ['stake', 'certification', 'internal', 'playtest'];
export const STATUSES = ['open', 'in-progress', 'fixed', 'wont-fix'];
export const AREAS = ['math', 'art', 'sound', 'ux', 'compliance', 'other'];

/** Sources whose open items stop a package being built. */
export const BLOCKING_SOURCES = ['stake', 'certification'];

export const FEEDBACK_FILE = 'feedback.yaml';

const TEMPLATE = `# feedback.yaml — what was raised against this game, and whether it is fixed.
#
# Written by \`forge feedback\` and the Feedback tab, but it is ordinary YAML and
# editing it by hand is fine.
#
#   source:  ${SOURCES.join(' | ')}
#   status:  ${STATUSES.join(' | ')}
#   area:    ${AREAS.join(' | ')}
#
# An OPEN item from stake or certification blocks \`forge package\`. Everything
# else warns. That is the whole enforcement model.

items: []
`;

export function feedbackPath(gameDir) {
	return path.join(gameDir, FEEDBACK_FILE);
}

export function loadFeedback(gameDir) {
	const file = feedbackPath(gameDir);
	if (!fs.existsSync(file)) return { items: [] };
	const parsed = YAML.parse(fs.readFileSync(file, 'utf8')) ?? {};
	return { items: Array.isArray(parsed.items) ? parsed.items : [] };
}

export function saveFeedback(gameDir, feedback) {
	const file = feedbackPath(gameDir);
	const header = fs.existsSync(file)
		? fs.readFileSync(file, 'utf8').split('\nitems:')[0]
		: TEMPLATE.split('\nitems:')[0];
	fs.outputFileSync(
		file,
		`${header}\n${YAML.stringify({ items: feedback.items }, { lineWidth: 0 })}`,
		'utf8',
	);
	return file;
}

/**
 * The next id, as FB-001.
 *
 * Sequential and stable rather than a hash, because these get quoted in email
 * to people outside the tool — "FB-004 is fixed" has to mean something to
 * somebody who will never open this file.
 */
export function nextId(items) {
	const used = items
		.map((item) => Number.parseInt(String(item.id ?? '').replace(/^FB-/, ''), 10))
		.filter(Number.isFinite);
	const next = (used.length ? Math.max(...used) : 0) + 1;
	return `FB-${String(next).padStart(3, '0')}`;
}

/** Add an item, returning the whole list. Validated, because a typo'd source silently un-gates a build. */
export function addItem(feedback, { source, area, title, detail = '', affects = [], raised = null }) {
	if (!title?.trim()) throw new Error('a feedback item needs a title');
	if (!SOURCES.includes(source)) {
		throw new Error(`source must be one of: ${SOURCES.join(', ')} (got "${source}")`);
	}
	if (area && !AREAS.includes(area)) {
		throw new Error(`area must be one of: ${AREAS.join(', ')} (got "${area}")`);
	}
	const item = {
		id: nextId(feedback.items),
		raised: raised ?? new Date().toISOString().slice(0, 10),
		source,
		area: area ?? 'other',
		status: 'open',
		title: title.trim(),
		...(detail ? { detail } : {}),
		...(affects.length ? { affects } : {}),
	};
	return { items: [...feedback.items, item] };
}

export function updateItem(feedback, id, patch) {
	if (patch.status && !STATUSES.includes(patch.status)) {
		throw new Error(`status must be one of: ${STATUSES.join(', ')}`);
	}
	let found = false;
	const items = feedback.items.map((item) => {
		if (item.id !== id) return item;
		found = true;
		const next = { ...item, ...patch };
		// A resolution date is recorded the moment it stops being open, so "when
		// did we fix that" is answerable later without reading git.
		if (patch.status && ['fixed', 'wont-fix'].includes(patch.status) && !next.resolved) {
			next.resolved = new Date().toISOString().slice(0, 10);
		}
		if (patch.status === 'open' || patch.status === 'in-progress') delete next.resolved;
		return next;
	});
	if (!found) throw new Error(`no feedback item with id "${id}"`);
	return { items };
}

/** Open items, split into the ones that block a package and the ones that warn. */
export function openItems(feedback) {
	const open = feedback.items.filter((item) => ['open', 'in-progress'].includes(item.status));
	return {
		blocking: open.filter((item) => BLOCKING_SOURCES.includes(item.source)),
		advisory: open.filter((item) => !BLOCKING_SOURCES.includes(item.source)),
	};
}

/** A one-line count for a header or a tab badge. */
export function summarise(feedback) {
	const { blocking, advisory } = openItems(feedback);
    const byStatus = {};
	for (const item of feedback.items) byStatus[item.status] = (byStatus[item.status] ?? 0) + 1;
	return { total: feedback.items.length, open: blocking.length + advisory.length, blocking: blocking.length, byStatus };
}
