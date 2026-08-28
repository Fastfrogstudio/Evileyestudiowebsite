/**
 * Inspiration intake — mapping plain-language mechanic descriptions onto the
 * taxonomy.
 *
 * ── The hard boundary, enforced in code ──────────────────────────────────────
 * The ONLY input this accepts is a plain-language description. Never another
 * game's asset files, source, or client bundle. `assertNoExtractedMaterial()`
 * below rejects an inspiration file that points at images, archives, code, or
 * a decompiled bundle, and says what to do instead.
 *
 * Screenshots are a CONVERSATION input, not a tool input: look at the reference
 * yourself, write down what it does in words, and put the words here. That way
 * the tool never ingests, stores, or reprocesses another company's art — and
 * the boundary lives at exactly one file, which is the only way it stays
 * enforceable.
 *
 * ── How matching works ───────────────────────────────────────────────────────
 * Each rule carries `any` (at least one must appear) and optional `all` phrases.
 * Rules are deliberately conservative: an unmatched line is reported as
 * "needs a human decision" rather than silently guessed at, because a wrong
 * guess here propagates into every generator downstream.
 */

/** File extensions that indicate extracted material rather than a description. */
const FORBIDDEN_EXTENSIONS = [
	'.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg', '.avif',
	'.atlas', '.skel', '.spine',
	'.zip', '.rar', '.7z', '.tar', '.gz', '.asar', '.pak', '.unity3d', '.assets',
	'.js', '.ts', '.wasm', '.swf', '.py', '.map',
	'.mp3', '.ogg', '.wav', '.m4a',
	'.fla', '.psd', '.ai',
];

/** Keys that would only appear if someone were pointing at extracted material. */
const FORBIDDEN_KEYS = [
	'bundle', 'clientbundle', 'decompiled', 'assetdir', 'assetsdir', 'assetpath',
	'spritesheet', 'atlas', 'sourcecode', 'apk', 'swf', 'extracted', 'rip',
];

/**
 * Refuse an inspiration file that carries extracted material rather than a
 * description. Throws with an explanation of the accepted alternative.
 */
export function assertNoExtractedMaterial(raw, parsed) {
	const problems = [];

	const walk = (node, pathParts) => {
		if (node == null) return;
		if (typeof node === 'string') {
			const lower = node.trim().toLowerCase();
			const ext = FORBIDDEN_EXTENSIONS.find((e) => lower.endsWith(e));
			if (ext) {
				problems.push(
					`${pathParts.join('.') || '(root)'}: "${node}" looks like a file (${ext}), not a description`,
				);
			}
			return;
		}
		if (Array.isArray(node)) {
			node.forEach((item, i) => walk(item, [...pathParts, String(i)]));
			return;
		}
		if (typeof node === 'object') {
			for (const [key, value] of Object.entries(node)) {
				const normalised = key.toLowerCase().replace(/[^a-z]/g, '');
				if (FORBIDDEN_KEYS.includes(normalised)) {
					problems.push(`${[...pathParts, key].join('.')}: "${key}" refers to extracted material`);
				}
				walk(value, [...pathParts, key]);
			}
		}
	};

	walk(parsed, []);

	// A pasted client bundle would not be valid YAML mapping content; catch the
	// obvious markers anyway, in case it landed inside a quoted block scalar.
	for (const marker of ['webpackJsonp', 'sourceMappingURL', '!function(', 'PIXI.Application']) {
		if (raw.includes(marker)) {
			problems.push(`the file contains "${marker}" — that is code, not a description`);
		}
	}

	if (problems.length) {
		throw new Error(
			`Inspiration must be a plain-language description only.\n\n` +
				problems.map((p) => `  - ${p}`).join('\n') +
				`\n\nstake-forge will not process another game's assets, code, or client bundle as an\n` +
				`inspiration source — not as files, and not as pasted contents.\n\n` +
				`If you are working from a screenshot or a video: describe what you SAW in words and\n` +
				`put the words in \`features:\`. For example, instead of pointing at a sprite sheet,\n` +
				`write "wild multiplier trail that grows across a tumble sequence".`,
		);
	}
}

/**
 * @typedef {object} InspirationRule
 * @property {string}   id
 * @property {string[]} any        at least one of these phrases must appear
 * @property {string[]} [all]      every one of these must also appear
 * @property {string}   implies    human-readable consequence
 * @property {2|3}      tier
 * @property {string[]} [winTypes] win types this narrows the game to
 * @property {string}   [behavior] behavior tag to attach
 * @property {string}   [role]     role the behavior attaches to
 * @property {string[]} [special]  special keys it needs
 * @property {object}   [spec]     spec fragments to merge into the draft
 */

/** @type {InspirationRule[]} */
export const INSPIRATION_RULES = [
	// ── win type signals ────────────────────────────────────────────────────
	{
		id: 'tumble',
		any: [
			'tumble',
			'tumbling',
			'cascade',
			'cascading',
			'avalanche',
			'chain reaction',
			'symbols drop',
			'drop in',
			'explode',
			'exploding',
			'symbols disappear',
		],
		implies: 'tumbling board — winning symbols explode and are replaced',
		tier: 2,
		winTypes: ['cluster', 'scatter'],
		behavior: 'tumble',
		reference: 'math: src/calculations/tumble.py + games/0_0_cluster · web: apps/cluster TumbleBoard handlers',
		note:
			'Tumble is NOT a fifth win_type. It is cluster or scatter with explode=True set on ' +
			'winning symbols by those evaluators (docs/math_docs/source_section/tumble_info.md).',
	},
	{
		id: 'cluster',
		any: ['cluster pays', 'cluster win', 'clusters of', 'grid of symbols', 'match adjacent'],
		implies: 'cluster win type',
		tier: 2,
		winTypes: ['cluster'],
		reference: 'math: games/0_0_cluster · web: apps/cluster',
	},
	{
		id: 'ways',
		any: ['ways to win', 'ways-to-win', '243 ways', '1024 ways', 'megaways', 'adjacent reels'],
		implies: 'ways win type',
		tier: 2,
		winTypes: ['ways'],
		reference: 'math: games/0_0_ways · web: apps/ways',
		note:
			'Megaways specifically (variable rows per reel per spin) is NOT covered by the ways ' +
			'sample — num_rows is fixed at config time. That part is bespoke.',
	},
	{
		id: 'scatterpays',
		any: ['scatter pays', 'pays anywhere', 'anywhere on the board', 'pay anywhere'],
		implies: 'scatter (pay-anywhere) win type',
		tier: 2,
		winTypes: ['scatter'],
		reference: 'math: games/0_0_scatter · web: apps/scatter',
	},
	{
		id: 'paylines',
		any: ['payline', 'pay line', 'lines game', '20 lines', '25 lines', '10 lines'],
		implies: 'lines win type',
		tier: 2,
		winTypes: ['lines'],
		reference: 'math: games/0_0_lines · web: apps/lines',
	},

	// ── tier 2, built-in ────────────────────────────────────────────────────
	{
		id: 'freespins',
		any: ['free spin', 'free-spin', 'freespin', 'bonus round', 'bonus game', 'scatter unlocks'],
		implies: 'free-spin round (trigger + counter + intro/outro)',
		tier: 2,
		behavior: 'freespins',
		role: 'scatter',
		special: ['scatter'],
		reference: 'math: src/executables/executables.py + games/0_0_lines · web: apps/lines FreeSpin*.svelte',
		spec: { freeSpins: { triggerSymbol: 'S', triggerCount: 3, awardedSpins: 10, retrigger: true } },
	},
	{
		id: 'global_multiplier',
		any: ['global multiplier', 'multiplier increases each', 'progressive multiplier', 'multiplier trail', 'growing multiplier', 'multiplier ladder'],
		implies: 'round-level global multiplier',
		tier: 2,
		behavior: 'global_multiplier',
		reference: 'math: global_multiplier threaded into each win calculator · web: apps/lines GlobalMultiplier.svelte',
		note:
			'apps/lines ships GlobalMultiplier.svelte and the asset key but does NOT add its ' +
			'EmitterEvent union to typesEmitterEvent.ts — that one import is still yours to add.',
	},
	{
		id: 'buybonus',
		any: ['buy bonus', 'buy-bonus', 'bonus buy', 'feature buy', 'buy the feature', 'buy at'],
		implies: 'a purchasable bet mode',
		tier: 2,
		reference: 'math: BetMode(is_buybonus=True) in every sample game_config.py',
		spec: { game: { betModes: { bonus: { cost: 100.0, feature: false, buyBonus: true } } } },
		extract: [
			{
				pattern: /(\d+(?:\.\d+)?)\s*x/i,
				apply: (draft, match) => {
					draft.game.betModes.bonus = draft.game.betModes.bonus ?? {};
					draft.game.betModes.bonus.cost = Number(match[1]);
				},
				describe: (match) => `buy-in cost read from the line: ${match[1]}x`,
			},
		],
	},
	{
		id: 'wincap',
		any: ['max win', 'win cap', 'wincap', 'capped at', 'maximum win'],
		implies: 'max-win stop',
		tier: 2,
		behavior: 'wincap',
		reference: 'math: Config.wincap + evaluate_wincap() · web: winLevelMap.ts level 10 ("max")',
		extract: [
			{
				pattern: /(\d[\d,]*)\s*x/i,
				apply: (draft, match) => {
					const value = Number(match[1].replace(/,/g, ''));
					for (const mode of Object.values(draft.game.betModes)) mode.maxWin = value;
				},
				describe: (match) => `max win read from the line: ${match[1]}x`,
			},
		],
	},
	{
		id: 'antebet',
		any: ['ante bet', 'ante-bet', 'higher scatter chance', 'boosted bet', 'bet boost'],
		implies: 'an extra bet mode with its own reel weighting',
		tier: 2,
		reference: 'math: a second BetMode with different reel_weights in its Distributions',
		spec: { game: { betModes: { ante: { cost: 1.25, feature: true, buyBonus: false } } } },
		note:
			'An ante bet is just another BetMode whose distributions weight the scatter-heavy ' +
			'reel strip more highly. No new code — but the reel strips and weights are real math ' +
			'work, not something scaffolding can produce.',
	},

	// ── tier 3, bespoke ─────────────────────────────────────────────────────
	{
		id: 'expanding',
		any: ['expanding wild', 'expands to fill', 'wild expands', 'full reel wild', 'whole reel wild'],
		implies: 'expanding wild behavior',
		tier: 3,
		behavior: 'expanding',
		role: 'wild',
		special: ['wild', 'multiplier'],
		reference: 'math: games/0_0_expwilds (verified end-to-end) · web: no sample, fully custom',
	},
	{
		id: 'sticky',
		any: ['sticky wild', 'sticky symbol', 'stays in place', 'locks in place', 'held symbol', 'hold and win', 'respin'],
		implies: 'sticky symbol behavior',
		tier: 3,
		behavior: 'sticky',
		role: 'wild',
		reference: 'math: the superspin mode of games/0_0_expwilds · web: no sample',
	},
	{
		id: 'prize',
		any: ['prize symbol', 'cash symbol', 'coin value', 'money symbol', 'collect symbol'],
		implies: 'prize/cash-value symbol behavior',
		tier: 3,
		behavior: 'prize',
		role: 'high',
		special: ['prize'],
		reference: 'math: games/0_0_expwilds prize handling · web: needs `prize` added to RawSymbol',
	},
	{
		id: 'colossal',
		any: ['colossal', 'giant symbol', 'mega symbol', 'oversized symbol', '2x2 symbol', '3x3 symbol'],
		implies: 'colossal symbol behavior',
		tier: 3,
		behavior: 'colossal',
		role: 'high',
		reference: 'NO SAMPLE in either SDK — genuinely from scratch',
	},
	{
		id: 'multiplier_wild',
		any: ['wild multiplier', 'multiplier wild', 'wild carries a multiplier', 'wild with multiplier'],
		implies: 'wild carrying a per-symbol multiplier',
		tier: 3,
		role: 'wild',
		special: ['wild', 'multiplier'],
		reference: 'math: games/0_0_lines assign_mult_property in game_override.py',
		note:
			'The multiplier flag itself is native (Symbol.assign_default_attribute sets ' +
			'has_multiplier/multiplier), so this is only tier 3 in that it needs a ' +
			'special_symbol_functions hook to choose the value.',
	},
];

/** Match one plain-language line against the rule set. */
export function matchLine(line) {
	const lower = line.toLowerCase();
	const matched = [];
	for (const rule of INSPIRATION_RULES) {
		const hitAny = rule.any.some((phrase) => lower.includes(phrase));
		if (!hitAny) continue;
		if (rule.all && !rule.all.every((phrase) => lower.includes(phrase))) continue;
		matched.push(rule);
	}
	return matched;
}
