/**
 * Tiny DOM + fetch helpers.
 *
 * No framework and no build step on purpose: this is a local tool that should
 * start instantly and stay readable, and the UI is forms, tables and a log —
 * none of which need a virtual DOM.
 */

/** Create an element. `h('div.card', {onclick}, child, child)` */
export function h(spec, props = null, ...children) {
	const [tag, ...classes] = String(spec).split('.');
	const el = document.createElement(tag || 'div');
	if (classes.length) el.className = classes.join(' ');

	if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
		children.unshift(props);
		props = null;
	}
	for (const [key, value] of Object.entries(props ?? {})) {
		if (value === null || value === undefined || value === false) continue;
		if (key.startsWith('on') && typeof value === 'function') {
			el.addEventListener(key.slice(2).toLowerCase(), value);
		} else if (key === 'class') {
			el.className = `${el.className} ${value}`.trim();
		} else if (key === 'html') {
			el.innerHTML = value;
		} else if (key === 'value') {
			el.value = value;
		} else if (key === 'dataset') {
			Object.assign(el.dataset, value);
		} else if (value === true) {
			el.setAttribute(key, '');
		} else {
			el.setAttribute(key, value);
		}
	}
	append(el, children);
	return el;
}

function append(el, children) {
	for (const child of children.flat(Infinity)) {
		if (child === null || child === undefined || child === false) continue;
		el.append(child instanceof Node ? child : document.createTextNode(String(child)));
	}
}

export function clear(el) {
	while (el.firstChild) el.removeChild(el.firstChild);
	return el;
}

export function mount(el, ...children) {
	clear(el);
	append(el, children);
	return el;
}

/** JSON fetch that turns an API error body into a thrown Error with details. */
export async function api(url, options = {}) {
	const res = await fetch(url, {
		headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
		...options,
		body: options.body ? JSON.stringify(options.body) : undefined,
	});
	const text = await res.text();
	let data = null;
	try {
		data = text ? JSON.parse(text) : null;
	} catch {
		data = { error: text };
	}
	if (!res.ok) {
		const error = new Error(data?.error ?? `${res.status} ${res.statusText}`);
		error.details = data?.details ?? null;
		throw error;
	}
	return data;
}

export function toast(message, kind = 'info', ms = 4200) {
	const el = h(`div.toast.${kind}`, message);
	document.getElementById('toasts').append(el);
	setTimeout(() => el.remove(), ms);
}

/** Open a modal. `render(close)` returns the modal body. */
export function modal(render) {
	const backdrop = document.getElementById('modal-backdrop');
	const box = document.getElementById('modal');
	const close = () => {
		backdrop.hidden = true;
		clear(box);
		document.removeEventListener('keydown', onKey);
	};
	const onKey = (e) => {
		if (e.key === 'Escape') close();
	};
	document.addEventListener('keydown', onKey);
	backdrop.onclick = (e) => {
		if (e.target === backdrop) close();
	};
	mount(box, render(close));
	backdrop.hidden = false;
	const focusable = box.querySelector('input, select, textarea, button');
	focusable?.focus();
	return close;
}

/** Debounce, for live validation while typing. */
export function debounce(fn, ms = 350) {
	let timer;
	return (...args) => {
		clearTimeout(timer);
		timer = setTimeout(() => fn(...args), ms);
	};
}

/** Deep clone that survives structuredClone being unavailable. */
export function clone(value) {
	return typeof structuredClone === 'function'
		? structuredClone(value)
		: JSON.parse(JSON.stringify(value));
}
