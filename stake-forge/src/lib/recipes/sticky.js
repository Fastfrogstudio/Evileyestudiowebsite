/**
 * "sticky" behavior recipe — code emitters.
 *
 * ── What this actually is ────────────────────────────────────────────────────
 * A hold-and-win respin round. A prize symbol lands, locks to its cell, and
 * resets the respin counter; when the respins run out, every locked prize on
 * the board pays. It is NOT a modifier you sprinkle on a free-spin round — in
 * the one verified implementation it is a whole separate bet mode with its own
 * game loop, and pretending otherwise would be inventing the interesting half.
 *
 * ── Provenance ───────────────────────────────────────────────────────────────
 * Adapted from, not inspired by, math-sdk games/0_0_expwilds' "superspin" mode.
 * Line-for-line correspondence:
 *
 *   check_for_new_prize()        <- games/0_0_expwilds/game_executables.py:45-63
 *   replace_board_with_stickys() <- games/0_0_expwilds/game_executables.py:65-68
 *   get_final_board_prize()      <- games/0_0_expwilds/game_executables.py:70-83
 *   assign_prize_value()         <- games/0_0_expwilds/game_override.py:27-31
 *   reset_superspin()            <- games/0_0_expwilds/game_override.py:47-51
 *   new_sticky_event()           <- games/0_0_expwilds/game_events.py:39-47
 *   reveal_prize_event()         <- games/0_0_expwilds/game_events.py:72-110
 *   win_info_prize_event()       <- games/0_0_expwilds/game_events.py:50-69
 *   run_superspin()              <- games/0_0_expwilds/gamestate.py:70-107
 *   run_spin() dispatch          <- games/0_0_expwilds/gamestate.py:20-21
 *
 * The only intentional changes are that the prize symbol name is parameterised
 * from the spec instead of being hardcoded "P", and that the respin count comes
 * from the spec rather than the literal 3 in reset_superspin().
 *
 * Two details that look like noise and are not:
 *   * reveal_prize_event multiplies every board symbol's prize by 100 before
 *     emitting. Payouts cross to the frontend as HUNDREDTHS of the bet — the
 *     same convention Book.to_json uses — so dropping it makes every prize
 *     read 100x too small on screen.
 *   * new_sticky_event adds 1 to `row` when include_padding is set, because the
 *     client board has a padding row above the visible one. Without it every
 *     sticky renders one cell too high.
 */

/**
 * @param {object} ctx
 * @param {string} ctx.prizeSymbol   the spec symbol carrying the behavior
 * @param {number} ctx.respins       respins awarded, and reset to, per landing
 */
export function renderStickyMath({ prizeSymbol, respins = 3, superspinModes = ['superspin'] }) {
	const P = prizeSymbol;

	const executableMethods = `    def check_for_new_prize(self) -> list:
        """Find prize symbols on the current reveal that are not already locked.

        Locked cells are tracked by (reel, row) rather than by symbol identity,
        because the board is redrawn every respin and the symbol objects on it
        are new each time. Adapted from 0_0_expwilds.
        """
        new_sticky_symbols = []
        for reel, _ in enumerate(self.board):
            for row, _ in enumerate(self.board[reel]):
                if (
                    self.board[reel][row].check_attribute("prize")
                    and (reel, row) not in self.existing_sticky_symbols
                ):
                    sym_details = {
                        "reel": reel,
                        "row": row,
                        "prize": self.board[reel][row].get_attribute("prize"),
                    }
                    new_sticky_symbols.append(sym_details)
                    self.sticky_symbols.append(deepcopy(sym_details))
                    self.existing_sticky_symbols.append((sym_details["reel"], sym_details["row"]))

        return new_sticky_symbols

    def replace_board_with_stickys(self) -> None:
        """Stamp every already-locked prize back onto the freshly drawn board.

        This runs BEFORE the reveal event, so what the player sees is the new
        board with the locked symbols already in place rather than a flash of
        the raw draw.
        """
        for sym in self.sticky_symbols:
            self.board[sym["reel"]][sym["row"]] = self.create_symbol(STICKY_PRIZE_SYMBOL)
            self.board[sym["reel"]][sym["row"]].assign_attribute({"prize": sym["prize"]})

    def get_final_board_prize(self) -> dict:
        """Sum every prize left on the board when the respins run out.

        A hold-and-win round pays once, at the end, from the board state — not
        per spin. Reading the board rather than the sticky list means a prize
        that arrived by any route is counted.
        """
        total_win = 0.0
        winning_pos = []
        for reel, _ in enumerate(self.board):
            for row, _ in enumerate(self.board[reel]):
                if self.board[reel][row].check_attribute("prize"):
                    total_win += self.board[reel][row].get_attribute("prize")
                    winning_pos.append(
                        {"reel": reel, "row": row, "value": self.board[reel][row].get_attribute("prize")},
                    )

        return {"totalWin": total_win, "wins": winning_pos}
`;

	const events = `NEW_STICKY_SYMS = "newStickySymbols"
PRIZE_WIN_DATA = "prizeWinInfo"


def new_sticky_event(gamestate, new_sticky_syms: list) -> None:
    """Announce prizes that just locked.

    The row offset and the x100 are both required, not cosmetic: the client
    board carries a padding row above the visible one, and payouts cross to the
    frontend as hundredths of the bet.
    """
    if gamestate.config.include_padding:
        for sym in new_sticky_syms:
            sym["row"] += 1
            sym["prize"] = int(sym["prize"] * 100)

    event = {"index": len(gamestate.book.events), "type": NEW_STICKY_SYMS, "newPrizes": new_sticky_syms}
    gamestate.book.add_event(event)


def reveal_prize_event(gamestate) -> None:
    """The board reveal for a respin, with every prize value scaled for the client."""
    board_client = []
    special_attributes = list(gamestate.config.special_symbols.keys())
    for reel, _ in enumerate(gamestate.board):
        board_client.append([])
        for row in range(len(gamestate.board[reel])):
            board_client[reel].append(json_ready_sym(gamestate.board[reel][row], special_attributes))

    if gamestate.config.include_padding:
        for reel, _ in enumerate(board_client):
            board_client[reel] = [
                json_ready_sym(gamestate.top_symbols[reel], special_attributes)
            ] + board_client[reel]
            board_client[reel].append(json_ready_sym(gamestate.bottom_symbols[reel], special_attributes))

    for idx, _ in enumerate(board_client):
        for idy, _ in enumerate(board_client[idx]):
            # Guarded on the KEY, not on the blank symbol's name.
            # 0_0_expwilds writes "if name != X", which works only because its
            # superspin strip holds nothing but X and P. json_ready_sym omits an
            # attribute the symbol does not carry, so the moment any other symbol
            # reaches this board that form is a KeyError inside an event emitter.
            if "prize" in board_client[idx][idy]:
                board_client[idx][idy]["prize"] = int(board_client[idx][idy]["prize"] * 100)

    event = {
        "index": len(gamestate.book.events),
        "type": EventConstants.REVEAL.value,
        "board": board_client,
        "paddingPositions": gamestate.reel_positions,
        "gameType": "superspin",
        "anticipation": gamestate.anticipation,
    }
    gamestate.book.add_event(event)


def win_info_prize_event(gamestate, include_padding_index=True) -> None:
    """The end-of-round payout, itemised per locked prize."""
    win_data_copy = {"wins": deepcopy(gamestate.win_data["wins"])}
    prize_details = []
    for _, w in enumerate(win_data_copy["wins"]):
        row = w["row"] + 1 if include_padding_index else w["row"]
        prize_details.append({"reel": w["reel"], "row": row, "prize": int(100 * w["value"])})

    event = {
        "index": len(gamestate.book.events),
        "type": PRIZE_WIN_DATA,
        "totalWin": int(round(min(gamestate.win_data["totalWin"], gamestate.config.wincap) * 100, 0)),
        "wins": prize_details,
    }
    gamestate.book.add_event(event)
`;

	/**
	 * The respin loop.
	 *
	 * `self.fs = 0` on a new landing is the whole mechanic: respins reset every
	 * time a prize locks, so the round runs until STICKY_RESPINS consecutive
	 * spins land nothing.
	 *
	 * The two criteria guards are what let the distributions actually be met.
	 * check_repeat() re-rolls any round that wins nothing unless its criteria is
	 * "0", so a "0" round has to be forced to land no prizes at all, and a wincap
	 * round has to be forced to land some early.
	 */
	const runSuperspin = `    def run_superspin(self) -> None:
        """Hold-and-win respin round. Adapted from 0_0_expwilds.run_superspin."""
        self.repeat = False
        self.reset_superspin()
        while self.fs < self.tot_fs:
            self.update_freespin()
            self.create_board_reelstrips()
            if self.criteria == "0":
                while len(self.special_syms_on_board["prize"]) > 0:
                    self.create_board_reelstrips()
            elif (
                self.criteria.upper() == "WINCAP"
                and self.win_manager.running_bet_win < 0.95 * self.config.wincap
                and self.fs <= 1
            ):
                while len(self.special_syms_on_board["prize"]) == 0:
                    self.create_board_reelstrips()
            self.replace_board_with_stickys()
            reveal_prize_event(self)

            new_sticky_symbols = self.check_for_new_prize()
            if len(new_sticky_symbols) > 0:
                new_sticky_event(self, new_sticky_symbols)
                # The respin counter resets on every landing. This is the game.
                self.fs = 0
                update_freespin_event(self)

        prize_win = self.get_final_board_prize()
        self.win_data = prize_win
        if prize_win["totalWin"] > 0:
            self.win_manager.update_spinwin(prize_win["totalWin"])
            self.win_manager.update_gametype_wins(self.gametype)

        if self.win_manager.spin_win > 0:
            win_info_prize_event(self)
            self.evaluate_wincap()
            set_win_event(self)
        set_total_event(self)

        self.evaluate_finalwin()
`;

	return {
		moduleFunctions: [
			{
				file: 'game_events.py',
				source: events,
				probe: 'new_sticky_event',
				// A sample's own game_events.py imports only what its own events
				// need. Without these the first superspin round dies with a
				// NameError — late, and only under the one bet mode that reaches it.
				imports: [
					{ module: 'copy', names: ['deepcopy'] },
					{ module: 'src.events.event_constants', names: ['EventConstants'] },
					{ module: 'src.events.events', names: ['json_ready_sym'] },
				],
			},
		],

		classMethods: [
			{
				file: 'game_executables.py',
				className: 'GameExecutables',
				probe: 'check_for_new_prize',
				source: executableMethods,
				imports: [{ module: 'copy', names: ['deepcopy'] }],
				constants: [`STICKY_PRIZE_SYMBOL = "${P}"`],
			},
		],

		overridePatches: [
			{
				id: 'sticky:reset_book',
				anchor: 'reset_book',
				pythonBody: ['        self.sticky_symbols = []', '        self.existing_sticky_symbols = []'].join('\n'),
			},
			{
				id: 'sticky:reset_superspin',
				anchor: 'method',
				// Not a reset_book extension: run_superspin calls this itself at the
				// top of each round, and reset_book has already run by then.
				pythonMethod: `    def reset_superspin(self) -> None:
        """Start a hold-and-win round: no locks, full respin count."""
        self.tot_fs = ${respins}
        self.fs = 0
        self.sticky_symbols = []
        self.existing_sticky_symbols = []
`,
				probe: 'reset_superspin',
			},
			{
				id: 'sticky:special_symbol_functions',
				symbol: P,
				functionName: 'assign_prize_value',
				ownMethod: true,
				pythonMethod: `    def assign_prize_value(self, symbol) -> None:
        """Roll a prize onto the symbol as it lands.

        Unlike a multiplier wild this is NOT gated on gametype: a hold-and-win
        round runs in the base game type, so gating it there would leave every
        prize symbol worth nothing.
        """
        prize_value = get_random_outcome(self.get_current_distribution_conditions()["prize_values"])
        symbol.assign_attribute({"prize": prize_value})
`,
			},
		],

		gamestatePatches: [
			{
				id: 'sticky:run_superspin',
				mode: 'add-method',
				className: 'GameState',
				probe: 'run_superspin',
				source: runSuperspin,
			},
			{
				id: 'sticky:dispatch',
				method: 'run_spin',
				mode: 'wrap-after',
				// run_spin's body is the normal round. A superspin bet mode must not
				// run it at all — it is a different game — so the dispatch goes in
				// immediately after reset_book(), which every sample calls first.
				afterRe: /^\s*self\.reset_book\(\)/,
				body: [
					'if self.betmode in SUPERSPIN_BETMODES:',
					'    self.run_superspin()',
					'    self.check_repeat()',
					'    continue',
				],
			},
		],

		gamestateImports: [
			{ module: 'src.events.events', names: ['update_freespin_event', 'set_total_event', 'set_win_event'] },
			{ module: 'game_events', names: ['new_sticky_event', 'reveal_prize_event', 'win_info_prize_event'] },
		],

		/**
		 * game_config.py needs the superspin reel strip registered and given a
		 * padding entry. Without the padding entry create_board_reelstrips() has
		 * no strips to draw from for the superspin gametype.
		 */
		configPatches: [
			{
				id: 'sticky:reels',
				mode: 'dict-entry',
				assignment: 'reels',
				key: 'SSR',
				value: '"SSR.csv"',
			},
			{
				id: 'sticky:padding',
				mode: 'after-line',
				lineRe: /^\s*self\.padding_reels\[self\.basegame_type\]/,
				body: ['        self.padding_reels["superspin"] = self.reels["SSR"]'],
			},
		],

		/** Distribution conditions the recipe's code reads at runtime. */
		requiredConditions: ['prize_values'],

		/**
		 * Kept as a named set rather than a literal in the dispatch, so a spec
		 * with two hold-and-win modes needs no change to the generated branch.
		 */
		gamestateConstants: [
			`SUPERSPIN_BETMODES = {${superspinModes.map((m) => JSON.stringify(m)).join(', ')}}`,
		],
	};
}
