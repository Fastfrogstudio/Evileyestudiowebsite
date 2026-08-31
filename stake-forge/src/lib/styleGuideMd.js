/**
 * Read a written art style guide — the Markdown an art director actually keeps
 * — and turn it into the same shape `art-guide.yaml` produces.
 *
 * ── Why not just ask for the YAML ───────────────────────────────────────────
 * The YAML guide was invented here, and it is a worse document than the one the
 * studio already has. A real guide runs to sections on line weight, a palette
 * table with hex values, a four-tier shading system, material rendering rules —
 * and, crucially, a PROMPT TEMPLATE that has already been tuned against the
 * model until it produced the right pictures.
 *
 * Retyping any of that into a thinner format loses the tuning and creates a
 * second copy to keep in step with the first. So this reads the real one.
 *
 * ── What is actually extracted, and why so little ───────────────────────────
 * Almost none of a style guide belongs in a prompt. "Outer silhouette lines are
 * thickest; interior detail lines are 50-70% of outer line weight" is a rule for
 * a person; pasted into a prompt it is noise that crowds out the subject. Models
 * weight early tokens most heavily, so a 250-line guide sent verbatim produces
 * WORSE output than three lines of it.
 *
 * What is taken is the part a guide writes FOR prompting, which good ones have
 * as an explicit section:
 *
 *   the prompt template   the tuned sentence, with a slot for the subject
 *   style descriptors     "use these terms"
 *   negative prompts      "avoid these"
 *   the palette           hex values, as colour words the model can use
 *
 * The rest stays where it belongs: a document for the people drawing.
 */

/** Headings whose following code block is that kind of content. */
const SECTIONS = [
	{ key: 'template', match: /sample prompt|prompt structure|prompt template/i },
	{ key: 'descriptors', match: /style descriptor|use these terms|key style/i },
	{ key: 'avoid', match: /negative prompt|avoid these|do not use/i },
];

/**
 * Per-asset subjects, if the guide carries them.
 *
 * The style is reusable across games; WHAT each symbol is, is not — so most
 * guides will not have this and should not be made to. But a studio that wants
 * one file per game rather than two can write a section of them, in any of the
 * three ways people naturally write a name-to-description list.
 */
function subjectsFrom(text) {
	const lines = text.split('\n');
	const subjects = {};
	let inside = false;

	for (const line of lines) {
		const heading = /^\s{0,3}(#{1,6})\s+(.*\S)\s*$/.exec(line);
		if (heading) {
			// Any heading at all ends the section — a subject list runs to the next
			// one, and reading on would collect prose from the section after it.
			inside = /^(\d+\.\s*)?(subjects?|symbols?|assets?)\b/i.test(heading[2]);
			continue;
		}
		if (!inside) continue;

		// | W | a silver stake |
		const row = /^\s*\|\s*\*{0,2}([A-Za-z][\w.]*)\*{0,2}\s*\|\s*([^|]+?)\s*\|/.exec(line);
		if (row && !/^-+$/.test(row[2].trim())) {
			subjects[row[1]] = row[2].replace(/\*\*/g, '').trim();
			continue;
		}
		// - **W**: a silver stake      /      - W — a silver stake
		const item = /^\s*[-*+]\s*\*{0,2}([A-Za-z][\w.]*)\*{0,2}\s*[:\u2014-]\s*(.+\S)\s*$/.exec(line);
		if (item) subjects[item[1]] = item[2].replace(/\*\*/g, '').trim();
	}
	return subjects;
}

/** Fenced blocks, each tagged with the nearest heading above it. */
function fencedBlocksByHeading(text) {
	const lines = text.split('\n');
	const blocks = [];
	let heading = '';
	let fence = null;

	for (const line of lines) {
		const fenceMatch = /^\s*(```|~~~)/.exec(line);
		if (fenceMatch) {
			if (fence) {
				blocks.push({ heading, body: fence.body.join('\n') });
				fence = null;
			} else {
				fence = { body: [] };
			}
			continue;
		}
		if (fence) {
			fence.body.push(line);
			continue;
		}
		const headingMatch = /^\s{0,3}#{1,6}\s+(.*\S)\s*$/.exec(line);
		if (headingMatch) heading = headingMatch[1];
	}
	// An unclosed fence still holds content worth having.
	if (fence?.body.length) blocks.push({ heading, body: fence.body.join('\n') });
	return blocks;
}

/** A quoted-or-bare list of short phrases, one per line. */
function phraseList(body) {
	return body
		.split('\n')
		.map((line) => line.trim().replace(/^[-*+]\s*/, '').replace(/^["'`]|["'`],?$/g, '').trim())
		.filter((line) => line && !line.startsWith('#'))
		.map((line) => line.replace(/,$/, ''));
}

/** Hex colours in a markdown table, with the label of the row they sit in. */
function paletteFromTables(text) {
	const palette = [];
	for (const line of text.split('\n')) {
		if (!/^\s*\|/.test(line)) continue;
		const cells = line.split('|').map((c) => c.trim());
		const hexes = line.match(/#[0-9a-f]{6}\b/gi);
		if (!hexes) continue;
		// Column 1 is the row label in every table shaped like a palette; falling
		// back to the hex itself keeps a nameless row usable rather than dropping it.
		const label = cells[1] && !/^#/.test(cells[1]) ? cells[1].replace(/\*\*/g, '') : null;
		const words = cells[2] && !/#/.test(cells[2]) ? cells[2] : null;
		const name = words ?? label;
		if (name) palette.push(name.toLowerCase());
	}
	return [...new Set(palette)];
}

/**
 * Parse a Markdown style guide.
 *
 * Returns the same shape `loadArtGuide` returns for YAML, plus `_found` — what
 * it managed to read. That list is reported rather than kept private: a guide
 * whose prompt section is headed something unexpected parses to almost nothing,
 * and silently generating eleven weak prompts is the expensive failure here.
 */
export function parseStyleGuideMarkdown(text) {
	const blocks = fencedBlocksByHeading(text);
	const found = [];
	const picked = {};

	for (const block of blocks) {
		for (const section of SECTIONS) {
			if (picked[section.key]) continue;
			if (section.match.test(block.heading)) {
				picked[section.key] = block.body;
				found.push(section.key);
				break;
			}
		}
	}

	const style = {};

	// The tuned prompt, if the guide has one. `[Object description]` — or any
	// bracketed placeholder — marks where the subject goes.
	if (picked.template) {
		const template = picked.template.split('\n').map((l) => l.trim()).filter(Boolean).join(' ');
		if (/\[[^\]]+\]/.test(template)) {
			style.promptTemplate = template;
		} else {
			// No placeholder means it is an example, not a template. Still useful as
			// descriptors, but it must not be used as a template or every asset gets
			// the same subject.
			style.rendering = template;
		}
	}

	if (picked.descriptors) {
		const list = phraseList(picked.descriptors);
		if (list.length) style.descriptors = list;
	}
	if (picked.avoid) {
		const list = phraseList(picked.avoid);
		if (list.length) style.avoid = list;
	}

	const palette = paletteFromTables(text);
	if (palette.length) {
		style.palette = palette;
		found.push('palette');
	}

	// A one-line summary, for the places that show one and for composing a prompt
	// where the template does not apply. The first heading is the guide's own
	// title and is the most reliable thing in any of these documents — but it is a
	// DOCUMENT title, so the words that make it one are stripped. "Gothic Vampire
	// Hunter Game Assets" is a filename; "Gothic Vampire Hunter" is a style.
	const title = /^\s{0,3}#\s+(.*\S)\s*$/m.exec(text);
	if (title) {
		style.summary = title[1]
			.replace(/^\s*art\s+style\s+guide\s*[:\u2014-]\s*/i, '')
			.replace(/\s*\b(game\s+)?assets?\b\s*$/i, '')
			.replace(/\s*\bstyle\s+guide\b\s*$/i, '')
			.trim();
	}

	const subjects = subjectsFrom(text);
	if (Object.keys(subjects).length) {
		found.push('subjects');
		return { style, symbols: subjects, parts: subjects, _found: found, _format: 'markdown' };
	}

	return { style, _found: found, _format: 'markdown' };
}
