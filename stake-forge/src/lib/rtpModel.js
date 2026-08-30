/**
 * A model of what a designed reel strip actually pays.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * reelDesign.js sets RELATIVE symbol frequencies: a symbol paying 50x appears
 * less often than one paying 0.5x. That gives a strip a shape. It does not give
 * it a LEVEL — nothing in it knows whether the resulting game pays 96% or
 * 14,000%, because nothing evaluates a board.
 *
 * That gap was invisible on a 5x3 lines game and fatal on a 5x4 ways game. The
 * numbers, measured off a generated 100,000x ways title:
 *
 *     free-spin round, cheapest of 300:   908.7x
 *     optimiser's target average:         184.8x
 *
 * The optimiser reweights simulated rounds; it cannot invent a cheap one. When
 * the poorest free-spin round in the whole simulation pays five times the target
 * AVERAGE, no reweighting exists and the Rust solver fails with
 * "pos_pigs=50/50, neg_pigs=0/50" — every candidate above target, none below.
 * The cause was arithmetic, not tuning: 5x4 is 1024 ways where 5x3 is 243, and
 * the paytable had been written for the latter.
 *
 * So: evaluate boards here, in JavaScript, before generating anything. This is a
 * MODEL, and it is deliberately a conservative one — it evaluates the base board
 * only, with no multipliers, no cascades, no features. Its job is not to predict
 * the game's RTP. Its job is to answer "is the level of this paytable within
 * reach of the target at all, and if not, by what factor is it out?", which it
 * answers to within a few percent and in about a second.
 *
 * ── Where it mirrors the engine, and where it knowingly does not ────────────
 * Mirrored, because getting these wrong makes the number meaningless:
 *   - ways counts the PRODUCT of per-reel matches from reel 0 (src/calculations/ways.py)
 *   - lines pay left-to-right along a fixed payline, longest run wins
 *   - cluster pays by the SIZE of an orthogonally-connected group
 *   - scatter pays by a count anywhere on the board, position irrelevant
 *   - wilds substitute; the scatter symbol never pays as an ordinary symbol
 *
 * Not mirrored, deliberately:
 *   - multipliers (they scale the answer, they do not change whether the level
 *     is right, and modelling them here would double-count what
 *     multiplierCeiling already reports)
 *   - tumbling (a cascade is a repeat of this same evaluation)
 *   - free spins (measured separately, as a multiple of the base level)
 */

import { getMechanic } from './mechanics.js';
import { expandPaytable } from './taxonomy.js';
import { DEFAULT_20_LINES } from './generators.js';

/** Same generator as reelDesign's, so a modelled strip is the strip that ships. */
function seededRng(key) {
	let h = 2166136261;
	for (const ch of key) {
		h ^= ch.charCodeAt(0);
		h = Math.imul(h, 16777619);
	}
	return () => {
		h ^= h << 13;
		h ^= h >>> 17;
		h ^= h << 5;
		return ((h >>> 0) % 100000) / 100000;
	};
}

/**
 * The paytable in one uniform shape: paytable[symbolName][size] = payout.
 *
 * Range keys ("6-9": 12.5) are expanded, because the engine expands them too —
 * Config.convert_range_table() does it at load. A model that read the raw keys
 * would find nothing for a cluster of 7 and report a game that pays nothing.
 */
export function payoutTable(spec) {
	const table = new Map();
	for (const symbol of spec.symbols) {
		if (!symbol.paytable) continue;
		if (symbol.special?.includes('scatter')) continue;
		table.set(symbol.name, expandPaytable(symbol.paytable));
	}
	return table;
}

/** Read one board off the strips: a random stop per reel, rows read down. */
function drawBoard(columns, rows, rng) {
	const board = [];
	for (let reel = 0; reel < columns.length; reel += 1) {
		const col = columns[reel];
		const stop = Math.floor(rng() * col.length);
		const cells = [];
		for (let row = 0; row < rows[reel]; row += 1) cells.push(col[(stop + row) % col.length]);
		board.push(cells);
	}
	return board;
}

function evaluateWays(board, { pay, wild, rows }) {
	let total = 0;
	for (const [name, table] of pay) {
		if (name === wild) continue;
		let ways = 1;
		let kind = 0;
		for (let reel = 0; reel < board.length; reel += 1) {
			let count = 0;
			for (const cell of board[reel]) if (cell === name || cell === wild) count += 1;
			if (count === 0) break;
			ways *= count;
			kind += 1;
		}
		const payout = table[kind];
		if (payout) total += payout * ways;
	}
	// The wild pays as itself too, on its own line, matching every sample that
	// gives the wild a paytable row.
	if (wild && pay.has(wild)) {
		let ways = 1;
		let kind = 0;
		for (let reel = 0; reel < board.length; reel += 1) {
			let count = 0;
			for (const cell of board[reel]) if (cell === wild) count += 1;
			if (count === 0) break;
			ways *= count;
			kind += 1;
		}
		const payout = pay.get(wild)[kind];
		if (payout) total += payout * ways;
	}
	return total;
}

function evaluateLines(board, { pay, wild, paylines }) {
	let total = 0;
	for (const line of Object.values(paylines)) {
		// The symbol the line pays as is the first non-wild on it; an all-wild
		// run pays as the wild.
		let name = null;
		for (let reel = 0; reel < board.length; reel += 1) {
			const cell = board[reel][line[reel]];
			if (cell === undefined) break;
			if (cell !== wild) {
				name = cell;
				break;
			}
		}
		if (name === null) name = wild;
		const table = pay.get(name);
		if (!table) continue;

		let kind = 0;
		for (let reel = 0; reel < board.length; reel += 1) {
			const cell = board[reel][line[reel]];
			if (cell !== name && cell !== wild) break;
			kind += 1;
		}
		const payout = table[kind];
		if (payout) total += payout;
	}
	return total;
}

function evaluateCluster(board, { pay, wild }) {
	const reels = board.length;
	const seen = new Set();
	let total = 0;
	const key = (r, c) => `${r}:${c}`;

	for (let reel = 0; reel < reels; reel += 1) {
		for (let row = 0; row < board[reel].length; row += 1) {
			const name = board[reel][row];
			if (name === wild || !pay.has(name)) continue;
			if (seen.has(key(reel, row))) continue;

			// Flood fill over orthogonal neighbours of this symbol, wilds joining
			// any group. A wild can belong to several groups, so it is never marked
			// seen — only the real symbol is.
			const stack = [[reel, row]];
			const group = new Set();
			while (stack.length) {
				const [r, c] = stack.pop();
				if (r < 0 || r >= reels || c < 0 || c >= board[r].length) continue;
				const k = key(r, c);
				if (group.has(k)) continue;
				const cell = board[r][c];
				if (cell !== name && cell !== wild) continue;
				group.add(k);
				if (cell === name) seen.add(k);
				stack.push([r + 1, c], [r - 1, c], [r, c + 1], [r, c - 1]);
			}
			const payout = pay.get(name)[group.size];
			if (payout) total += payout;
		}
	}
	return total;
}

function evaluateScatterPays(board, { pay, wild }) {
	const counts = new Map();
	for (const column of board) {
		for (const cell of column) {
			if (cell === wild) continue;
			counts.set(cell, (counts.get(cell) ?? 0) + 1);
		}
	}
	let total = 0;
	for (const [name, count] of counts) {
		const table = pay.get(name);
		if (!table) continue;
		const payout = table[count];
		if (payout) total += payout;
	}
	return total;
}

/**
 * Expected win per spin, and how often a spin wins at all.
 *
 * Returns the pair the optimiser actually cares about: `ev` is what the base
 * game contributes to RTP before any feature or multiplier, and `hitRate` is one
 * paying spin in N — the number the volatility profile states as a target and
 * that Stake's approval checklist asks to be in the 3-8 range.
 */
export function estimateStripEv(spec, columns, { spins = 20000, seed = 'ev' } = {}) {
	const mechanic = spec._mechanic ?? getMechanic(spec.game.mechanic);
	const rows = spec.game.reels.rows;
	const pay = payoutTable(spec);
	const wild = spec.symbols.find((s) => s.special?.includes('wild'))?.name ?? null;
	const paylines = spec.paylines === 'default_20' ? DEFAULT_20_LINES : (spec.paylines ?? DEFAULT_20_LINES);
	const rng = seededRng(`${spec.game.name}:${seed}`);

	const evaluate = {
		ways: evaluateWays,
		lines: evaluateLines,
		cluster: evaluateCluster,
		scatter: evaluateScatterPays,
	}[mechanic.winType] ?? evaluateWays;

	let total = 0;
	let winners = 0;
	let biggest = 0;
	for (let n = 0; n < spins; n += 1) {
		const board = drawBoard(columns, rows, rng);
		const win = evaluate(board, { pay, wild, rows, paylines });
		if (win > 0) {
			winners += 1;
			total += win;
			if (win > biggest) biggest = win;
		}
	}

	return {
		spins,
		ev: total / spins,
		hitRate: winners ? spins / winners : Infinity,
		averageWin: winners ? total / winners : 0,
		biggest,
	};
}
