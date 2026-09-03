/**
 * Colossal / oversized symbol block.
 *
 * An NxN region of the board is replaced by a single symbol repeated into every
 * cell it covers. Lines and ways evaluators read each cell independently, so a
 * 3x3 block of H1 simply IS three H1s on each of the three rows it spans — no
 * evaluator change is needed, and that is the whole reason this is buildable
 * from primitives.
 *
 * ── Why this one is written from scratch ─────────────────────────────────────
 *
 * Unlike `expanding` and `sticky`, there is NO sample to adapt: neither SDK
 * ships a colossal-symbol game and no doc under docs/math_docs describes one.
 * Everything below is built on documented engine behaviour and proven by
 * execution (py_compile, GameConfig(), live spins, then a statistical run).
 *
 * ── Three engine facts this depends on ───────────────────────────────────────
 *
 * 1. `create_board_reelstrips()` records special symbols as it draws, and
 *    `get_special_symbols_on_board()` RECOMPUTES that record from the board.
 *    Stamping cells behind the engine's back leaves the record stale, so the
 *    stamp calls the recompute — otherwise a covered scatter still counts
 *    toward the free-spin trigger.
 *
 * 2. `draw_board()` has already decided the trigger for this spin by the time
 *    we run: in the base game it re-rolls until the board is BELOW the trigger,
 *    and under force_freegame it places an exact scatter count. A block that
 *    covered a scatter would silently rewrite that decision after the fact, so
 *    placements overlapping a scatter are excluded and the block is skipped
 *    when no safe placement exists. The trigger count is never changed by this
 *    mechanic — that is a property worth being able to state.
 *
 * 3. `create_symbol()` runs the per-symbol special functions, so a colossal
 *    WILD would roll an independent multiplier into all nine cells, and
 *    apply_added_symbol_mult() SUMS the multipliers on a winning line. Nine
 *    independent rolls is not one big symbol, it is nine small ones stacked.
 *    The first cell's multiplier is therefore copied across the block.
 *
 * @param {string}   ctx.colossalSymbol  the spec symbol carrying the behavior
 * @param {number}   ctx.size            largest block edge the ladder may draw
 * @param {string[]} ctx.gameTypes       gametypes the block may land in
 */
export function renderColossalMath({
	colossalSymbol,
	size = 3,
	gameTypes = ['freegame'],
	winType = 'lines',
	paysBothWays = false,
}) {
	const S = colossalSymbol;
	/**
	 * Lines and ways are evaluated LEFT TO RIGHT from reel 0, so a block that does
	 * not include reel 0 cannot contribute to a win at all. Measured on a 5x3
	 * lines game with placements unrestricted: two thirds of 3x3 blocks and three
	 * quarters of 2x2 blocks were cosmetic — a board-dominating symbol that paid
	 * nothing. Anchoring the block to reel 0 is what makes the mechanic mean
	 * something on those evaluators. Cluster and scatter pays do not care where a
	 * symbol sits, so there the block roams.
	 */
	const anchorLeft = !paysBothWays && (winType === 'lines' || winType === 'ways');

	const executableMethods = `    def colossal_placements(self, size: int) -> list:
        """Every top-left cell where a size x size block fits and covers no scatter.

        With COLOSSAL_ANCHOR_LEFT the block always includes reel 0, because a
        left-to-right evaluator cannot pay a combination that does not start
        there — an unanchored block is a board-dominating symbol that pays
        nothing two times in three.

        num_rows is per-reel, so a block spanning reels r..r+size-1 is bounded by
        the SHORTEST of those reels — assuming a rectangular board is what breaks
        the moment anyone scaffolds a 3-4-5-4-3 layout.

        Scatter cells are excluded rather than overwritten. draw_board() has
        already settled this spin's trigger count before the block is stamped,
        so covering a scatter would rewrite that decision after the fact.
        """
        if size > self.config.num_reels:
            return []

        scatter_cells = set()
        for entry in self.special_syms_on_board.get("scatter", []):
            scatter_cells.add((entry["reel"], entry["row"]))

        placements = []
        last_reel = 0 if COLOSSAL_ANCHOR_LEFT else self.config.num_reels - size
        for reel in range(last_reel + 1):
            rows_here = min(self.config.num_rows[reel + d] for d in range(size))
            for row in range(rows_here - size + 1):
                covered = {
                    (reel + dr, row + dc) for dr in range(size) for dc in range(size)
                }
                if covered & scatter_cells:
                    continue
                placements.append((reel, row))

        return placements

    def assign_colossal_block(self) -> None:
        """Stamp one colossal block onto the freshly drawn board, or none.

        Called from the draw_board override so that every caller — base spin,
        free spin, forced board — gets the same treatment without each one
        needing its own splice.
        """
        self.colossal_block = None
        if self.gametype not in COLOSSAL_GAMETYPES:
            return

        size = int(get_random_outcome(self.get_current_distribution_conditions()["colossal_size"]))
        if size < 2:
            return

        placements = self.colossal_placements(size)
        if len(placements) == 0:
            return

        reel, row = random.choice(placements)

        # One symbol, not size*size of them: create the first cell, then copy any
        # attribute the special-symbol functions rolled onto it across the block.
        # apply_added_symbol_mult() SUMS multipliers on a winning line, so nine
        # independent rolls would pay as nine symbols rather than one big one.
        anchor = self.create_symbol(COLOSSAL_SYMBOL)
        # Symbol uses __slots__, so there is no attribute dict to copy: the
        # value-carrying properties are exactly the special flags the symbol
        # declares. Reading them off defn.special_flags keeps this correct for a
        # colossal PRIZE symbol as well as a colossal wild.
        shared = {}
        for prop in ("multiplier", "prize"):
            if prop in anchor.defn.special_flags:
                shared[prop] = anchor.get_attribute(prop)

        for dr in range(size):
            for dc in range(size):
                if dr == 0 and dc == 0:
                    cell = anchor
                else:
                    cell = self.create_symbol(COLOSSAL_SYMBOL)
                    if len(shared) > 0:
                        cell.assign_attribute(dict(shared))
                self.board[reel + dr][row + dc] = cell

        self.colossal_block = {"reel": reel, "row": row, "size": size, "symbol": COLOSSAL_SYMBOL}

        # The engine's record of what is special was built while the board was
        # drawn. Stamping cells invalidates it, so recompute from the board.
        self.get_special_symbols_on_board()
`;

	const events = `"""Book event for the colossal-symbol block. GENERATED by stake-forge.

Rows are offset for board padding here, exactly as the expanding-wild and
prize events do it: the client renders a board padded by one row top and
bottom when config.include_padding is True. Do not offset again on the client.
"""

from copy import deepcopy

COLOSSAL_SYMBOL_EVENT = "colossalSymbol"


def colossal_symbol_event(gamestate) -> None:
    """Announce the block that was stamped onto this reveal."""
    block = deepcopy(gamestate.colossal_block)
    if gamestate.config.include_padding:
        block["row"] += 1

    event = {
        "index": len(gamestate.book.events),
        "type": COLOSSAL_SYMBOL_EVENT,
        "colossal": block,
    }
    gamestate.book.add_event(event)
`;

	/**
	 * Hooking draw_board itself rather than splicing every call site.
	 *
	 * The alternative — replacing each `self.draw_board()` line the way the
	 * expanding recipe does — puts the reveal in a different place per method and
	 * fights any other recipe that splices around the same line. Overriding the
	 * engine method keeps `emit_event` meaning exactly what it meant, so every
	 * existing caller is unaffected and the ordering is decided in one place.
	 */
	const drawBoardOverride = `    def draw_board(self, emit_event: bool = True, trigger_symbol: str = "scatter") -> None:
        """Draw the board, then stamp the colossal block BEFORE anything is emitted.

        The block has to land before the reveal or the client is sent a board
        that does not match the one the win evaluator scored.
        """
        super().draw_board(emit_event=False, trigger_symbol=trigger_symbol)
        self.assign_colossal_block()
        if emit_event:
            reveal_event(self)
            if self.colossal_block is not None:
                colossal_symbol_event(self)
`;

	return {
		moduleFunctions: [
			{ file: 'game_events.py', source: events, probe: 'colossal_symbol_event' },
		],

		classMethods: [
			{
				file: 'game_executables.py',
				className: 'GameExecutables',
				probe: 'assign_colossal_block',
				source: executableMethods,
				imports: [
					{ module: null, statement: 'import random' },
					{ module: 'src.calculations.statistics', names: ['get_random_outcome'] },
				],
				constants: [
					`COLOSSAL_SYMBOL = "${S}"`,
					`COLOSSAL_GAMETYPES = {${gameTypes.map((t) => JSON.stringify(t)).join(', ')}}`,
					`COLOSSAL_ANCHOR_LEFT = ${anchorLeft ? 'True' : 'False'}`,
				],
			},
		],

		overridePatches: [
			{
				id: 'colossal:draw_board',
				anchor: 'method',
				probe: 'draw_board',
				pythonMethod: drawBoardOverride,
				imports: [
					{ module: 'src.events.events', names: ['reveal_event'] },
					{ module: 'game_events', names: ['colossal_symbol_event'] },
				],
			},
			{
				id: 'colossal:reset_book',
				anchor: 'reset_book',
				pythonBody: '        self.colossal_block = None',
			},
		],

		/**
		 * The ladder chooses the block edge, and 0 means "no block this spin".
		 * Sizes above the spec's `size` are never offered, so the spec stays the
		 * ceiling while the weights stay the tuning knob.
		 */
		requiredConditions: ['colossal_size'],

		maxColossalSize: size,
	};
}

/**
 * The frontend half.
 *
 * The block is described once, on the reveal it lands on, and the client draws
 * one overlay across the cells it covers. Rows arrive already offset for board
 * padding — see the event emitter — so nothing here offsets again.
 */
export function renderColossalWeb({ colossalSymbol }) {
	const component = `<script lang="ts" module>
	// GENERATED by stake-forge — colossal-block behavior for symbol "${colossalSymbol}".
	// Follows the emitterEvent shape used by the shipped GlobalMultiplier.svelte
	// and FreeSpinCounter.svelte components.
	export type ColossalBlock = { reel: number; row: number; size: number; symbol: string };

	export type EmitterEventColossal =
		| { type: 'colossalShow'; block: ColossalBlock }
		| { type: 'colossalClear' };
</script>

<script lang="ts">
	import { Container } from 'pixi-svelte';

	import { getContext } from '../game/context';

	const context = getContext();

	let block = $state<ColossalBlock | null>(null);

	context.eventEmitter.subscribeOnMount({
		colossalShow: async (emitterEvent) => {
			// Play colossal_in, then hold on colossal_idle for the rest of the reveal.
			block = emitterEvent.block;
		},
		colossalClear: () => {
			block = null;
		},
	});
</script>

<Container>
	{#if block}
		<!--
			One overlay spanning block.size x block.size cells from (reel, row).
			Point this at your own spine once \`forge assets:import\` has registered
			it; the audit command checks that the manifest supplies colossal_in /
			colossal_idle for "${colossalSymbol}".

			The art is a real NxN export, not the 1x1 symbol scaled up — scaling a
			200x200 symbol to cover three cells looks exactly like what it is.
		-->
		<Container x={block.reel} y={block.row} />
	{/if}
</Container>
`;

	const bookEventTypes = `type BookEventColossalSymbol = {
	index: number;
	type: 'colossalSymbol';
	colossal: { reel: number; row: number; size: number; symbol: string };
};`;

	const handlers = `	colossalSymbol: async (bookEvent: BookEventOfType<'colossalSymbol'>) => {
		await eventEmitter.broadcastAsync({ type: 'colossalShow', block: bookEvent.colossal });
	},`;

	return {
		files: [{ path: 'src/components/ColossalSymbol.svelte', contents: component, mode: 'create' }],
		bookEventTypes,
		bookEventUnionMembers: ['BookEventColossalSymbol'],
		handlers,
		emitterImport: {
			typeName: 'EmitterEventColossal',
			from: '../components/ColossalSymbol.svelte',
		},
		/** Shaped from a payload a real generated run emitted, not invented. */
		storyEvents: {
			colossalSymbol: {
				type: 'colossalSymbol',
				colossal: { reel: 0, row: 1, size: 3, symbol: colossalSymbol },
			},
		},
	};
}
