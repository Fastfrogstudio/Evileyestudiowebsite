/**
 * Replace `export const <name> = <...>;` (optionally followed by `as const`)
 * in `source` with a freshly generated value, by scanning matched
 * brackets/braces rather than a fragile single regex — object/array
 * literals in this codebase can be arbitrarily deep and multi-line.
 *
 * Returns { source, replaced } — replaced is false if the export wasn't found,
 * so callers can fall back to appending instead of silently no-op'ing.
 */
export function replaceExportConst(source, name, newValueSource) {
	// Allow an optional TS type annotation between the name and `=`, e.g.
	// `export const INITIAL_BOARD: RawSymbol[][] = [...]`.
	const headerRe = new RegExp(`export const ${name}(\\s*:\\s*[^=]+?)?\\s=\\s`);
	const headerMatch = source.match(headerRe);
	if (!headerMatch) return { source, replaced: false };
	const startIdx = headerMatch.index;
	const valueStart = startIdx + headerMatch[0].length;
	const openChar = source[valueStart];
	const closeChar = openChar === '{' ? '}' : openChar === '[' ? ']' : null;

	let i = valueStart;
	if (closeChar) {
		let depth = 0;
		for (; i < source.length; i++) {
			if (source[i] === openChar) depth++;
			else if (source[i] === closeChar) {
				depth--;
				if (depth === 0) {
					i++; // move past the closing bracket
					break;
				}
			}
		}
	} else {
		// A SCALAR value — `export const SYMBOL_SIZE = 120;`. This used to bail
		// out and report the patch as missed, which is how a scaffold could
		// silently leave a constant at the sample's value while claiming to have
		// configured the app. Read to the terminating semicolon instead.
		const end = source.indexOf(';', valueStart);
		if (end === -1) return { source, replaced: false };
		i = end;
	}

	// consume optional trailing " as const" and the terminating ";"
	let tail = source.slice(i);
	const asConstMatch = tail.match(/^\s*as const/);
	if (asConstMatch) i += asConstMatch[0].length;
	if (source[i] === ';') i += 1;

	const before = source.slice(0, startIdx);
	const after = source.slice(i);

	// Preserve any type annotation. Dropping it is not cosmetic: apps/lines
	// declares `export const INITIAL_BOARD: RawSymbol[][]`, and without the
	// annotation the literal widens to `{ name: string }[][]`, which is not
	// assignable to RawSymbol[][] because RawSymbol.name is a union of the
	// game's own symbol-name literals. That surfaces as a tsc error in
	// stateGame.svelte.ts, far from the file that was edited.
	const annotation = headerMatch[1] ?? '';
	// `as const` and an explicit annotation are mutually exclusive here: an
	// annotated const is already narrowed by its type, and appending `as const`
	// to one changes what the annotation means.
	const suffix = annotation ? ';' : closeChar === '}' ? ' as const;' : ';';

	return {
		source: `${before}export const ${name}${annotation} = ${newValueSource}${suffix}${after}`,
		replaced: true,
	};
}

/** Same as replaceExportConst but for `export default {...};`. */
export function replaceExportDefault(source, newValueSource) {
	const startMarker = `export default `;
	const startIdx = source.indexOf(startMarker);
	if (startIdx === -1) return { source, replaced: false };

	const valueStart = startIdx + startMarker.length;
	if (source[valueStart] !== '{') return { source, replaced: false };

	let depth = 0;
	let i = valueStart;
	for (; i < source.length; i++) {
		if (source[i] === '{') depth++;
		else if (source[i] === '}') {
			depth--;
			if (depth === 0) {
				i++;
				break;
			}
		}
	}
	if (source[i] === ';') i += 1;

	const before = source.slice(0, startIdx);
	const after = source.slice(i);
	return { source: `${before}export default ${newValueSource};${after}`, replaced: true };
}
