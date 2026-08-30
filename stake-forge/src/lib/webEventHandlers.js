/**
 * Front-end handlers for engine events the sample apps do not cover.
 *
 * ── Why this is needed ──────────────────────────────────────────────────────
 * The four sample apps were each written against their own sample's event set:
 *
 *   lines, ways    9 handlers   no updateGlobalMult, no freeSpinRetrigger
 *   cluster       14 handlers
 *   scatter       13 handlers
 *   none of the four handles `wincap`
 *
 * A scaffolded game starts from one of those apps and then gets mechanics added
 * to its MATHS. Turn on a global multiplier in a lines game and the engine emits
 * updateGlobalMult into an app that has never heard of it.
 *
 * Nothing fails. createPlayBookUtils.ts logs `Missing bookEventHandler` to a
 * console nobody is watching and carries on, so the round completes and the
 * balance is correct. The feature is simply never shown — precisely what
 * events_info.md warns about: "Anything not contained within or implied by the
 * events cannot be shown to the player."
 *
 * ── What these handlers are built from ──────────────────────────────────────
 * Not invented. Each is the shape the SDK's own apps use for the same event
 * (cluster's updateGlobalMult, lines' setWin), broadcasting only emitter events
 * that were checked to exist in the target app's components.
 */

/**
 * @typedef {object} WebEventHandler
 * @property {string} type          the bookEvent type, as the engine emits it
 * @property {string} why           what the player loses without it
 * @property {string} tsTypeName    the type's name, for the BookEvent union
 * @property {string} tsType        the TypeScript type block
 * @property {string} handler       the entry for bookEventHandlerMap
 * @property {string} [component]   a component that must be mounted in Game.svelte
 */

const UPDATE_GLOBAL_MULT_TYPE = `type BookEventUpdateGlobalMult = {
	index: number;
	type: 'updateGlobalMult';
	globalMult: number;
};`;

// Mirrors apps/cluster's handler, minus its tumble-only reset — a lines or ways
// game has no tumble win to clear. globalMultiplierShow / globalMultiplierUpdate
// are declared by GlobalMultiplier.svelte, which every sample app ships.
const UPDATE_GLOBAL_MULT_HANDLER = `	updateGlobalMult: async (bookEvent: BookEventOfType<'updateGlobalMult'>) => {
		eventEmitter.broadcast({ type: 'globalMultiplierShow' });
		await eventEmitter.broadcastAsync({
			type: 'globalMultiplierUpdate',
			multiplier: bookEvent.globalMult,
		});
	},`;

const WINCAP_TYPE = `type BookEventWincap = {
	index: number;
	type: 'wincap';
	amount: number;
};`;

// The reason this matters more than it looks: set_win_event() in
// src/events/events.py is guarded by `if not gamestate.wincap_triggered`, so on
// a capped round the ordinary setWin event is SUPPRESSED and this replaces it.
// Without a handler the max win is not merely under-celebrated — the win
// presentation does not play at all.
//
// Driven through the same winLevelMap path as setWin, at the top level, which
// every sample app defines with its own sound and max_win_intro / max_win_idle /
// max_win_exit animations.
const WINCAP_HANDLER = `	wincap: async (bookEvent: BookEventOfType<'wincap'>) => {
		const maxLevel = Math.max(...Object.keys(winLevelMap).map(Number).filter(Number.isFinite));
		const winLevelData = winLevelMap[maxLevel as WinLevel];

		eventEmitter.broadcast({ type: 'winShow' });
		winLevelSoundsPlay({ winLevelData });
		await eventEmitter.broadcastAsync({
			type: 'winUpdate',
			amount: bookEvent.amount,
			winLevelData,
		});
		winLevelSoundsStop();
		eventEmitter.broadcast({ type: 'winHide' });
	},`;

const RETRIGGER_TYPE = `type BookEventFreeSpinRetrigger = {
	index: number;
	type: 'freeSpinRetrigger';
	totalFs: number;
	positions: Position[];
};`;

// Deliberately NOT cluster's version. Cluster replays the whole free-spin INTRO
// on a retrigger — transition, intro screen, music change — which is right for a
// game that retriggers rarely and wrong for one that retriggers often, where it
// would interrupt the round every few spins. This announces the scatters and
// updates the counter, and leaves the round running.
const RETRIGGER_HANDLER = `	freeSpinRetrigger: async (bookEvent: BookEventOfType<'freeSpinRetrigger'>) => {
		eventEmitter.broadcast({ type: 'soundOnce', name: 'sfx_scatter_win_v2' });
		await animateSymbols({ positions: bookEvent.positions });
		await eventEmitter.broadcastAsync({
			type: 'freeSpinCounterUpdate',
			total: bookEvent.totalFs,
		});
	},`;

/** @type {Record<string, WebEventHandler>} */
export const WEB_EVENT_HANDLERS = {
	updateGlobalMult: {
		type: 'updateGlobalMult',
		why: 'the global multiplier changes and the player is never shown its value',
		tsTypeName: 'BookEventUpdateGlobalMult',
		tsType: UPDATE_GLOBAL_MULT_TYPE,
		handler: UPDATE_GLOBAL_MULT_HANDLER,
		component: 'GlobalMultiplier',
	},
	wincap: {
		type: 'wincap',
		why: 'the maximum win — the biggest moment in the game — is reached and not announced',
		tsTypeName: 'BookEventWincap',
		tsType: WINCAP_TYPE,
		handler: WINCAP_HANDLER,
	},
	freeSpinRetrigger: {
		type: 'freeSpinRetrigger',
		why: 'free spins are retriggered and the player is not told they gained spins',
		tsTypeName: 'BookEventFreeSpinRetrigger',
		tsType: RETRIGGER_TYPE,
		handler: RETRIGGER_HANDLER,
	},
};

export const WEB_EVENT_TYPES = Object.keys(WEB_EVENT_HANDLERS);

/** Which of the events a game emits we can generate a handler for. */
export function generatableFor(missing) {
	return (missing ?? []).filter((type) => WEB_EVENT_HANDLERS[type]);
}
