/**
 * Python source patching for math-sdk game files.
 *
 * ── Why this is not a regex ──────────────────────────────────────────────────
 * The failure mode this module exists to prevent is a patcher that matches the
 * OPENING bracket of a value, scans to its matching close, and stops — leaving
 * whatever followed on the line still attached. In a real math-sdk game_config.py
 * that is not hypothetical:
 *
 *     self.num_rows = [3] * self.num_reels
 *
 * A bracket-matching replacer that swaps `[3]` for `[3, 3, 3, 3, 3]` and stops at
 * the `]` produces `[3, 3, 3, 3, 3] * self.num_reels` — a silently 5x-too-long
 * board that only shows up much later as a reel-length mismatch.
 *
 * So `replaceAssignment` consumes the whole logical right-hand side: it scans to
 * the end of the STATEMENT, tracking bracket depth, string literals (including
 * triple-quoted and raw/f-prefixed), comments, and backslash continuations. It
 * stops only at a newline reached at depth 0 outside any string.
 */

const QUOTE_PREFIX = /[rRbBuUfF]{0,3}$/;

/**
 * Find the index just past the end of the Python statement whose right-hand side
 * begins at `start`. Returns -1 if the source ends mid-expression (unbalanced).
 */
export function endOfStatement(source, start) {
	let i = start;
	let depth = 0;

	while (i < source.length) {
		const ch = source[i];

		// --- comments: run to end of line, but a comment cannot end a statement
		//     that is still inside brackets, so we only skip it.
		if (ch === '#') {
			while (i < source.length && source[i] !== '\n') i += 1;
			continue;
		}

		// --- string literals
		if (ch === '"' || ch === "'") {
			const isTriple = source.slice(i, i + 3) === ch.repeat(3);
			const delim = isTriple ? ch.repeat(3) : ch;
			// A raw string (r"...") does not honour backslash escapes.
			const prefix = QUOTE_PREFIX.exec(source.slice(Math.max(0, i - 3), i))?.[0] ?? '';
			const isRaw = /[rR]/.test(prefix);
			i += delim.length;
			while (i < source.length) {
				if (!isRaw && source[i] === '\\') {
					i += 2;
					continue;
				}
				if (source.slice(i, i + delim.length) === delim) {
					i += delim.length;
					break;
				}
				i += 1;
			}
			continue;
		}

		// --- brackets
		if (ch === '(' || ch === '[' || ch === '{') {
			depth += 1;
			i += 1;
			continue;
		}
		if (ch === ')' || ch === ']' || ch === '}') {
			depth -= 1;
			i += 1;
			if (depth < 0) return -1; // unbalanced: refuse rather than guess
			continue;
		}

		// --- explicit line continuation
		if (ch === '\\' && source[i + 1] === '\n') {
			i += 2;
			continue;
		}

		// --- statement ends at a newline only when nothing is left open
		if (ch === '\n') {
			if (depth === 0) return i;
			i += 1;
			continue;
		}

		i += 1;
	}

	return depth === 0 ? source.length : -1;
}

/**
 * Replace `<indent><target> = <anything>` with `<indent><target> = <newValue>`.
 *
 * `target` is matched literally (so pass e.g. `self.paytable`), anchored to the
 * start of a line so a same-named attribute inside an expression is never hit.
 * Returns { source, replaced }; `replaced` is false when the assignment is
 * absent, so callers can decide between appending and failing loudly instead of
 * silently no-op'ing.
 */
export function replaceAssignment(source, target, newValue) {
	const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const re = new RegExp(`^([ \\t]*)${escaped}\\s*=\\s*`, 'm');
	const match = re.exec(source);
	if (!match) return { source, replaced: false };

	const indent = match[1];
	const valueStart = match.index + match[0].length;
	const valueEnd = endOfStatement(source, valueStart);
	if (valueEnd === -1) {
		throw new Error(
			`pyPatch: could not find the end of the assignment to ${target} — ` +
				`the source appears to have unbalanced brackets. Refusing to patch.`,
		);
	}

	return {
		source: `${source.slice(0, match.index)}${indent}${target} = ${newValue}${source.slice(valueEnd)}`,
		replaced: true,
	};
}

/** Read the raw right-hand side of an assignment, or null when absent. */
export function readAssignment(source, target) {
	const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const re = new RegExp(`^([ \\t]*)${escaped}\\s*=\\s*`, 'm');
	const match = re.exec(source);
	if (!match) return null;
	const valueStart = match.index + match[0].length;
	const valueEnd = endOfStatement(source, valueStart);
	if (valueEnd === -1) return null;
	return source.slice(valueStart, valueEnd);
}

/**
 * Append lines to the body of a method, just before the next method definition
 * (or end of class). Idempotent via a marker comment, so `math:scaffold` can be
 * re-run without stacking duplicate state resets.
 */
export function appendToMethod(source, methodName, bodyLines, markerId) {
	const marker = `  # stake-forge:${markerId}`;
	if (source.includes(marker)) return { source, replaced: true, alreadyPresent: true };

	const defRe = new RegExp(`^([ \\t]*)def\\s+${methodName}\\s*\\(`, 'm');
	const match = defRe.exec(source);
	if (!match) return { source, replaced: false };

	const indent = match[1];
	// Walk forward to the first line at or below the `def` indentation that is
	// not blank and not part of this method's body.
	const lines = source.split('\n');
	let lineIdx = source.slice(0, match.index).split('\n').length - 1;
	lineIdx += 1;
	let lastBodyLine = lineIdx;
	for (; lineIdx < lines.length; lineIdx += 1) {
		const line = lines[lineIdx];
		if (line.trim() === '') continue;
		const lineIndent = line.match(/^[ \t]*/)[0];
		if (lineIndent.length <= indent.length) break;
		lastBodyLine = lineIdx;
	}

	const injected = bodyLines.map((line) => `${line}`);
	injected[injected.length - 1] += marker;
	lines.splice(lastBodyLine + 1, 0, ...injected);
	return { source: lines.join('\n'), replaced: true, alreadyPresent: false };
}

/** Insert a whole method into a class, before the class ends. Idempotent by name. */
export function insertMethod(source, className, methodSource, methodName) {
	if (new RegExp(`^[ \\t]*def\\s+${methodName}\\s*\\(`, 'm').test(source)) {
		return { source, replaced: true, alreadyPresent: true };
	}
	const classRe = new RegExp(`^class\\s+${className}\\b[^\\n]*:\\n`, 'm');
	if (!classRe.test(source)) return { source, replaced: false };

	const trimmed = source.replace(/\s*$/, '');
	return { source: `${trimmed}\n\n${methodSource.replace(/\s*$/, '')}\n`, replaced: true };
}

/** Ensure `from <module> import <names>` is present, merging into an existing import. */
export function ensureImport(source, module, names) {
	const escaped = module.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const re = new RegExp(`^from\\s+${escaped}\\s+import\\s+([^\\n(]+)$`, 'm');
	const match = re.exec(source);

	if (match) {
		const existing = match[1].split(',').map((n) => n.trim()).filter(Boolean);
		const merged = [...new Set([...existing, ...names])];
		if (merged.length === existing.length) return { source, changed: false };
		return {
			source: source.replace(match[0], `from ${module} import ${merged.join(', ')}`),
			changed: true,
		};
	}

	// Insert after the last existing top-level import.
	//
	// The scan must treat a parenthesised import as ONE unit:
	// 0_0_scatter/game_executables.py opens with
	//     from src.events.events import (
	//         set_win_event,
	//         ...
	//     )
	// and a naive line-wise "last import" match lands on the opening line,
	// splicing a new statement into the middle of the parenthesised list and
	// producing a SyntaxError.
	const line = `from ${module} import ${names.join(', ')}`;
	const insertAt = endOfImportBlock(source);
	if (insertAt === null) return { source: `${line}\n${source}`, changed: true };
	return { source: `${source.slice(0, insertAt)}\n${line}${source.slice(insertAt)}`, changed: true };
}

/** Serialise a JS value as Python source (dict/list/str/num/bool/None). */
export function pyLiteral(value, indent = 0) {
	const pad = '    '.repeat(indent);
	const padIn = '    '.repeat(indent + 1);

	if (value === null || value === undefined) return 'None';
	if (typeof value === 'boolean') return value ? 'True' : 'False';
	if (typeof value === 'number') return String(value);
	if (typeof value === 'string') return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
	if (value instanceof PyRaw) return value.code;

	if (Array.isArray(value)) {
		if (!value.length) return '[]';
		const items = value.map((v) => `${padIn}${pyLiteral(v, indent + 1)},`).join('\n');
		return `[\n${items}\n${pad}]`;
	}

	if (typeof value === 'object') {
		const entries = value instanceof Map ? [...value.entries()] : Object.entries(value);
		if (!entries.length) return '{}';
		const items = entries
			.map(([k, v]) => `${padIn}${pyLiteral(k, indent + 1)}: ${pyLiteral(v, indent + 1)},`)
			.join('\n');
		return `{\n${items}\n${pad}}`;
	}

	throw new Error(`pyLiteral: unsupported value type ${typeof value}`);
}

/** Wrap raw Python source so pyLiteral emits it verbatim (e.g. a tuple key). */
export class PyRaw {
	constructor(code) {
		this.code = code;
	}
}

/**
 * Locate a method's body within a class and return its line span.
 * Returns null when the method is absent.
 */
export function findMethodBody(source, methodName) {
	const lines = source.split('\n');
	const defRe = new RegExp(`^([ \\t]*)def\\s+${methodName}\\s*\\(`);

	for (let i = 0; i < lines.length; i += 1) {
		const match = defRe.exec(lines[i]);
		if (!match) continue;
		const indent = match[1];
		let end = i;
		for (let j = i + 1; j < lines.length; j += 1) {
			if (lines[j].trim() === '') continue;
			const lineIndent = lines[j].match(/^[ \t]*/)[0];
			if (lineIndent.length <= indent.length) break;
			end = j;
		}
		return { start: i, end, indent, lines };
	}
	return null;
}

/**
 * Replace the first line inside `methodName` matching `lineRe` with `newLines`,
 * re-indented to the line being replaced. Idempotent via a marker comment.
 *
 * This is how a behavior recipe splices its steps into a sample game's existing
 * run_freespin() without replacing the whole method — which matters because each
 * mechanic's run_freespin differs (lines calls evaluate_lines_board, cluster runs
 * a tumble loop, and so on), so a wholesale replacement would only ever be
 * correct for one of them.
 */
export function replaceLineInMethod(source, methodName, lineRe, newLines, markerId) {
	const marker = `  # stake-forge:${markerId}`;
	if (source.includes(marker)) return { source, replaced: true, alreadyPresent: true };

	const found = findMethodBody(source, methodName);
	if (!found) return { source, replaced: false };

	const { start, end, lines } = found;
	for (let i = start + 1; i <= end; i += 1) {
		if (!lineRe.test(lines[i])) continue;
		const indent = lines[i].match(/^[ \t]*/)[0];
		const injected = newLines.map((l) => (l === '' ? '' : `${indent}${l}`));
		injected[0] += marker;
		lines.splice(i, 1, ...injected);
		return { source: lines.join('\n'), replaced: true, alreadyPresent: false };
	}
	return { source, replaced: false };
}

/** Insert lines at the very top of a method's body. Idempotent via a marker. */
export function prependToMethod(source, methodName, bodyLines, markerId) {
	const marker = `  # stake-forge:${markerId}`;
	if (source.includes(marker)) return { source, replaced: true, alreadyPresent: true };

	const found = findMethodBody(source, methodName);
	if (!found) return { source, replaced: false };

	const { start, lines, indent } = found;
	// Skip a docstring if the method opens with one.
	let insertAt = start + 1;
	const firstBody = lines[insertAt]?.trim() ?? '';
	if (/^("""|''')/.test(firstBody)) {
		const quote = firstBody.slice(0, 3);
		if (!(firstBody.length > 3 && firstBody.endsWith(quote))) {
			while (insertAt < lines.length && !lines[insertAt].includes(quote, 3)) insertAt += 1;
		}
		insertAt += 1;
	}

	const bodyIndent = `${indent}    `;
	const injected = bodyLines.map((l) => (l === '' ? '' : `${bodyIndent}${l}`));
	injected[injected.length - 1] += marker;
	lines.splice(insertAt, 0, ...injected);
	return { source: lines.join('\n'), replaced: true, alreadyPresent: false };
}

/**
 * Append methods to an existing class, creating the file from `fallbackHeader`
 * if it does not exist. Never replaces the file, so sibling methods the sample
 * game relies on (evaluate_lines_board, get_clusters_update_wins, ...) survive.
 */
export function appendMethodsToClass(source, className, methodsSource, probeMethodName) {
	if (new RegExp(`^[ \\t]*def\\s+${probeMethodName}\\s*\\(`, 'm').test(source)) {
		return { source, changed: false };
	}
	const classRe = new RegExp(`^class\\s+${className}\\b[^\\n]*:`, 'm');
	if (!classRe.test(source)) return { source, changed: false, missingClass: true };
	return { source: `${source.replace(/\s*$/, '')}\n\n${methodsSource.replace(/\s*$/, '')}\n`, changed: true };
}

/**
 * Replace an assignment if it exists, otherwise INSERT it into `methodName`'s
 * body. Returns { source, action } where action is 'replaced' | 'inserted' |
 * 'failed', so callers can report an insert differently from an edit.
 *
 * Needed because the sample games are not uniform: 0_0_scatter's game_config.py
 * has no `self.provider_number` at all (it assigns `self.provider_numer` — a
 * typo in the SDK, which leaves the real attribute at the Config default), and
 * 0_0_cluster's game_override.py has no `self.special_symbol_functions`
 * assignment because its assign_special_sym_function() is just `pass`.
 */
export function replaceOrInsertAssignment(source, methodName, target, value) {
	const replaced = replaceAssignment(source, target, value);
	if (replaced.replaced) return { source: replaced.source, action: 'replaced' };

	const found = findMethodBody(source, methodName);
	if (!found) return { source, action: 'failed' };

	const { start, end, lines, indent } = found;
	const bodyIndent = `${indent}    `;

	// Drop a lone `pass` — it exists only to make an empty body legal.
	let insertAt = end + 1;
	for (let i = start + 1; i <= end; i += 1) {
		if (lines[i].trim() === 'pass') {
			lines.splice(i, 1);
			insertAt = i;
			break;
		}
	}

	const rendered = `${bodyIndent}${target} = ${value}`
		.split('\n')
		.map((l, idx) => (idx === 0 ? l : l));
	lines.splice(insertAt, 0, ...rendered);
	return { source: lines.join('\n'), action: 'inserted' };
}

/**
 * Index just past the last top-level import statement, or null if there is none.
 * Parenthesised imports are consumed whole via endOfStatement, so nothing is
 * ever inserted inside one.
 */
export function endOfImportBlock(source) {
	const re = /^(?:from|import)\s+/gm;
	let last = null;
	let match;
	while ((match = re.exec(source)) !== null) {
		const end = endOfStatement(source, match.index);
		if (end === -1) break;
		last = end;
		re.lastIndex = end;
	}
	return last;
}

/**
 * Insert a method into a class, REPLACING an existing one of the same name.
 *
 * Unlike insertMethod (which leaves an existing method alone), this is for
 * methods a recipe must own outright, because the recipe also decides the shape
 * of the data that method reads. 0_0_ways ships an assign_mult_property() that
 * reads a FLAT `mult_values` dict, while 0_0_lines and 0_0_expwilds read one
 * NESTED by gametype — so a recipe that emits nested mult_values must also own
 * the reader, or the two disagree and get_random_outcome() dies with
 * "unsupported operand type(s) for +: 'int' and 'dict'".
 */
export function replaceOrInsertMethod(source, className, methodSource, methodName) {
	const found = findMethodBody(source, methodName);
	if (found) {
		const { start, end, lines } = found;
		lines.splice(start, end - start + 1, ...methodSource.replace(/\s*$/, '').split('\n'));
		return { source: lines.join('\n'), action: 'replaced' };
	}
	const classRe = new RegExp(`^class\\s+${className}\\b[^\\n]*:`, 'm');
	if (!classRe.test(source)) return { source, action: 'failed' };
	return {
		source: `${source.replace(/\s*$/, '')}\n\n${methodSource.replace(/\s*$/, '')}\n`,
		action: 'inserted',
	};
}

/**
 * Append top-level functions to an existing module, or create it from scratch.
 * Never replaces: 0_0_cluster's game_events.py defines update_grid_mult_event(),
 * which its gamestate.py imports — overwriting the file breaks the game.
 */
export function appendModuleFunctions(existingSource, newSource, probeFunctionName) {
	if (existingSource === null) return { source: newSource, action: 'created' };
	if (new RegExp(`^def\\s+${probeFunctionName}\\s*\\(`, 'm').test(existingSource)) {
		return { source: existingSource, action: 'already-present' };
	}
	return {
		source: `${existingSource.replace(/\s*$/, '')}\n\n\n${newSource.replace(/^"""[\s\S]*?"""\n*/, '').replace(/\s*$/, '')}\n`,
		action: 'appended',
	};
}
