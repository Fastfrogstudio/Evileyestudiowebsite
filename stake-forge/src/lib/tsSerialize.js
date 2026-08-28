const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function quoteKey(key) {
	return IDENT.test(key) ? key : `'${key}'`;
}

function quoteString(str) {
	return `'${String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * Serialize a plain JS value into a TS object-literal source string,
 * matching the formatting style used throughout the web-sdk (tabs,
 * unquoted identifier keys, single-quoted strings).
 */
/** Wrap a raw JS expression (e.g. `new URL(...).href`) so tsStringify emits it verbatim, unquoted. */
export class RawExpr {
	constructor(code) {
		this.code = code;
	}
}

export function tsStringify(value, indent = 0) {
	const pad = '\t'.repeat(indent);
	const padIn = '\t'.repeat(indent + 1);

	if (value instanceof RawExpr) return value.code;
	if (value === null) return 'null';
	if (value === undefined) return 'undefined';
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	if (typeof value === 'string') return quoteString(value);

	if (Array.isArray(value)) {
		if (value.length === 0) return '[]';
		const items = value.map((v) => `${padIn}${tsStringify(v, indent + 1)},`).join('\n');
		return `[\n${items}\n${pad}]`;
	}

	if (typeof value === 'object') {
		const keys = Object.keys(value);
		if (keys.length === 0) return '{}';
		const items = keys.map((k) => `${padIn}${quoteKey(k)}: ${tsStringify(value[k], indent + 1)},`).join('\n');
		return `{\n${items}\n${pad}}`;
	}

	throw new Error(`tsStringify: unsupported value type ${typeof value}`);
}
