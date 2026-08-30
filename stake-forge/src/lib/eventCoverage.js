import fs from 'fs-extra';
import path from 'node:path';

/**
 * Does the front end handle every event the maths emits?
 *
 * ── The failure this catches ────────────────────────────────────────────────
 * From docs/math_docs/gamestate_section/events_info.md, the rule the whole
 * client contract rests on:
 *
 *   "Anything not contained within or implied by the events cannot be shown to
 *    the player. The events are crucial as all events need to be handled by the
 *    front-end."
 *
 * And when one is not handled, createPlayBookUtils.ts does this:
 *
 *   const bookEventHandler = bookEventHandlerMap?.[bookEvent.type];
 *   if (bookEventHandler) { ... } else {
 *     console.error('Missing bookEventHandler in "bookEventHandlerMap" for: ', bookEvent);
 *   }
 *
 * It logs to a console nobody is watching and CARRIES ON. The round completes,
 * the balance is right, every math check passes — and the feature is simply
 * never shown. A player wins 5,000x and sees a normal win, because `wincap` had
 * no handler.
 *
 * ── Why a generated game hits this and the samples do not ───────────────────
 * The sample apps were each written against their own sample's event set:
 *
 *   lines, ways   9 events   no updateGlobalMult, no freeSpinRetrigger
 *   cluster      14 events
 *   scatter      13 events
 *   none of them handle `wincap`
 *
 * A scaffolded game starts from one of those apps and then has mechanics added
 * to its MATHS. Turn on a global multiplier in a lines game and the engine emits
 * updateGlobalMult into an app that has never heard of it. Nothing fails; the
 * multiplier is invisible.
 *
 * So this is checked against the events actually observed in a live run rather
 * than against a list someone maintains by hand, because the list is exactly the
 * thing that goes stale.
 */

/**
 * Event types the front end declares a handler for.
 *
 * Read from bookEventHandlerMap.ts, which is the file the dispatcher indexes —
 * typesBookEvent.ts is only the TypeScript union, and a type without a handler
 * still drops the event on the floor at runtime.
 */
export function declaredHandlers(appDir) {
	const file = path.join(appDir, 'src', 'game', 'bookEventHandlerMap.ts');
	if (!fs.existsSync(file)) return null;
	const source = fs.readFileSync(file, 'utf8');

	// Entries look like `updateGlobalMult: async (bookEvent: ...) => {`, at one
	// tab of indent inside the exported map. Matching the BookEventOfType tag as
	// well would miss the handlers that take no argument.
	const handlers = new Set();
	for (const match of source.matchAll(/^\t([A-Za-z][A-Za-z0-9_]*)\s*:\s*(async\s*)?\(/gm)) {
		handlers.add(match[1]);
	}
	return handlers;
}

/**
 * Events the engine emitted, minus the ones no front end is expected to draw.
 *
 * `createBonusSnapshot` is the reverse case — an app-side event with no math
 * counterpart — so it never appears here and is not the concern.
 */
export function coverageGaps({ emitted, handlers }) {
	if (!handlers) return null;
	const missing = [...new Set(emitted)].filter((type) => !handlers.has(type)).sort();
	return {
		emitted: [...new Set(emitted)].sort(),
		handled: [...handlers].sort(),
		missing,
		ok: missing.length === 0,
	};
}

/**
 * What each event is FOR, so the failure message says what the player loses.
 *
 * Taken from src/events/events.py in the math-sdk, not invented — an event whose
 * purpose is guessed would produce a confident, wrong explanation.
 */
export const EVENT_PURPOSE = {
	wincap: 'the maximum win — the single biggest moment in the game — is reached and not announced',
	updateGlobalMult: 'the global multiplier changes and the player is never shown its value',
	freeSpinRetrigger: 'free spins are retriggered and the player is not told they gained spins',
	updateTumbleWin: 'the running total during a cascade sequence never updates',
	tumbleBoard: 'symbols are removed and refilled with no cascade animation',
	updateGrid: 'a position multiplier grows and the cell never shows it',
	boardMultiplierInfo: 'board multipliers are applied and never displayed',
	setTumbleWin: 'the cascade win total is not shown',
	enterBonus: 'the bonus is entered with no transition',
};

/**
 * Events a spec will cause the engine to emit, worked out BEFORE simulating.
 *
 * `forge verify` catches a coverage gap by observing a live run, which is the
 * honest check but happens far too late — the app has already been scaffolded
 * and the maths already run. Scaffold needs the same answer up front, from the
 * spec alone, so the handlers are there from the first build.
 *
 * Deliberately conservative: an unused handler is dead code that still
 * type-checks, whereas a missing one is a feature the player never sees.
 */
export function eventsImpliedBy(spec) {
	const implied = new Set();
	const game = spec?.game ?? {};

	// Every bet mode carries a wincap distribution and a maxWin, so every game
	// can reach the cap — and set_win_event() is suppressed once it does, making
	// this the ONLY event on a capped round.
	implied.add('wincap');

	// update_global_mult_event fires from the per-spin growth, from an explicit
	// growth ladder, and from the cascade-multiplier board mechanic.
	if (game.globalMultiplierPerSpin || game.globalMultiplier || game.cascadeMultiplier) {
		implied.add('updateGlobalMult');
	}

	if (spec?.freeSpins?.retrigger) implied.add('freeSpinRetrigger');

	return [...implied];
}
