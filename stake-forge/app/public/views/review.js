import { h, mount, api } from '../lib.js';

/**
 * The Review tab — look at every delivered asset before it goes into the game.
 *
 * ── Why this is a gate and not a gallery ────────────────────────────────────
 * `art:import` reports what it can measure: size, transparency, whether the
 * animation names match. All of that can pass on an asset that is simply wrong —
 * the right size, correct alpha, correct names, and the wrong picture, or a rig
 * that technically animates and reads as broken. No amount of validation
 * substitutes for looking at it.
 *
 * So this shows the delivery as delivered, before anything is written into the
 * game: PNGs at real size on a checkerboard, and Spine rigs actually PLAYING.
 *
 * ── Playing them in the runtime the game uses ───────────────────────────────
 * The animation is run through the SDK's own spine-pixi, served out of the
 * configured web-sdk checkout rather than vendored here. A preview that used a
 * different runtime version could show something the game will not, which would
 * make it worse than no preview at all.
 */
export function renderReview(ctx) {
	const state = {
		from: 'delivered',
		loading: true,
		exists: false,
		dir: '',
		images: [],
		spine: [],
		error: null,
		playing: new Map(),
	};

	const root = h('div');

	const load = async () => {
		state.loading = true;
		render();
		try {
			const data = await api(
				`/api/games/${ctx.game.id}/review?from=${encodeURIComponent(state.from)}`,
			);
			Object.assign(state, data, { loading: false, error: null });
		} catch (err) {
			state.error = err.message;
			state.loading = false;
		}
		render();
		if (state.spine.length) queueMicrotask(mountSpine);
	};

	// The canvas is the tile, exactly. A larger one is drawn and then clipped by
	// the tile's overflow, which reads on screen as a cropped rig.
	const TILE = 240;
	const PAD = 20;

	/**
	 * Scale a rig to fit the tile and centre it ON ITS OWN BOUNDS.
	 *
	 * ── Why the origin cannot be used for this ──────────────────────────────────
	 * A skeleton's origin is wherever the rigger put it, and both conventions are
	 * common: at the feet for a character, at the middle for a slot symbol. So the
	 * origin says nothing about where the art actually is. The SETUP-POSE BOUNDS
	 * do, and Spine exports them in the skeleton itself:
	 *
	 *   h1.json  "skeleton": { x: -613.43, y: -620.56, width: 1225.25, height: 1241.81 }
	 *
	 * x ≈ -width/2 and y ≈ -height/2 — centre-origin. Nudging such a rig down by
	 * half its height (the correct correction for a bottom-origin one) drops it
	 * half out of the tile. That was the bug this replaces, and it is invisible on
	 * a bottom-origin rig, which is why it survived: it renders correctly for one
	 * convention and wrongly for the other.
	 *
	 * Measured once from the setup pose rather than per animation. Bounds move as a
	 * rig plays, so re-centring every frame would make the preview crawl around its
	 * tile instead of animating in place.
	 *
	 * Spine is y-up and pixi is y-down, so the vertical extent [y, y+height] in
	 * skeleton space is [-(y+height), -y] on the canvas — hence the negated centre.
	 */
	const fitToTile = (spine) => {
		const data = spine.skeleton?.data;
		let cx;
		let cy;
		let width;
		let height;

		if (data && data.width > 0 && data.height > 0) {
			width = data.width;
			height = data.height;
			cx = data.x + width / 2;
			cy = -(data.y + height / 2);
		} else {
			// Older exports omit the bounds. Fall back to what the runtime measures,
			// read at scale 1 from the origin so the numbers are the rig's own.
			spine.scale.set(1);
			spine.position.set(0, 0);
			const b = spine.getBounds();
			width = b.width;
			height = b.height;
			if (!(width > 0) || !(height > 0)) return null;
			cx = b.x + width / 2;
			cy = b.y + height / 2;
		}

		// Only ever shrink. Blowing a 64px rig up to fill the tile would hide that
		// it is far too small for a 200px symbol slot — which is precisely what a
		// review is meant to catch.
		const scale = Math.min(1, (TILE - PAD) / width, (TILE - PAD) / height);
		spine.scale.set(scale);
		spine.x = TILE / 2 - cx * scale;
		spine.y = TILE / 2 - cy * scale;
		return { width: Math.round(width), height: Math.round(height), scale };
	};

	/**
	 * Boot one pixi canvas per rig and play its animation.
	 *
	 * Loaded through an import map so the SDK's own ESM packages resolve without
	 * a bundler. Done per-canvas rather than one shared app because each rig has
	 * its own atlas and its own natural size, and a shared stage would need
	 * layout logic that adds nothing to the review.
	 */
	const mountSpine = async () => {
		let PIXI;
		let SpinePixi;
		try {
			PIXI = await import('/vendor/pixi.mjs');
			SpinePixi = await import('/vendor/spine-pixi/dist/index.js');
		} catch (err) {
			// Almost always a web-sdk path that is not set, which is worth saying
			// plainly rather than as a module-resolution error.
			for (const entry of state.spine) {
				const host = document.getElementById(`spine-${entry.name}`);
				if (host) {
					mount(
						host,
						h('div.err-box',
							'Could not load the Spine runtime from the configured web-sdk. ',
							'Check the path in Settings. ',
							h('span.dim', err.message)),
					);
				}
			}
			return;
		}

		for (const entry of state.spine) {
			const host = document.getElementById(`spine-${entry.name}`);
			if (!host || host.dataset.mounted) continue;
			host.dataset.mounted = '1';
			try {
				// Path-based so the atlas's page image resolves as its sibling.
				const base = `/review-file/${ctx.game.id}/${encodeURIComponent(state.from)}/`;
				const app = new PIXI.Application();
				await app.init({ width: TILE, height: TILE, backgroundAlpha: 0, antialias: true });
				host.innerHTML = '';
				host.appendChild(app.canvas);

				PIXI.Assets.add({ alias: `${entry.name}-atlas`, src: base + encodeURIComponent(entry.atlas) });
				PIXI.Assets.add({ alias: `${entry.name}-skel`, src: base + encodeURIComponent(entry.skeleton) });
				await PIXI.Assets.load([`${entry.name}-atlas`, `${entry.name}-skel`]);

				const spine = SpinePixi.Spine.from({
					skeleton: `${entry.name}-skel`,
					atlas: `${entry.name}-atlas`,
				});
				app.stage.addChild(spine);
				const box = fitToTile(spine);

				const first = entry.animations[0];
				if (first) spine.state.setAnimation(0, first, true);
				state.playing.set(entry.name, { app, spine });

				const label = document.getElementById(`size-${entry.name}`);
				if (label && box) label.textContent = `rigged at ${box.width} \u00d7 ${box.height}`;
			} catch (err) {
				mount(host, h('div.err-box', `could not play: ${err.message}`));
			}
		}
	};

	const setAnimation = (name, animation) => {
		const live = state.playing.get(name);
		if (live) live.spine.state.setAnimation(0, animation, true);
	};

	function imageTile(image) {
		return h('div.rv-tile',
			h('div.rv-art', h('img', { src: image.url, loading: 'lazy' })),
			h('b', image.file),
		);
	}

	/**
	 * The verdict line under a rig.
	 *
	 * Seeing it play proves the rig works. It does not prove the GAME can play it:
	 * animations are called by literal string, so a perfect rig whose animation
	 * kept Spine's default export name loads, validates, and sits inert on the
	 * board with nothing anywhere reporting a fault. That gap is the whole reason
	 * this tab is a gate rather than a gallery, so the verdict has to be here,
	 * next to the thing it judges.
	 */
	function verdict(entry) {
		if (!entry.expected) {
			return h('div.rv-note',
				`Nothing in this game is called ${entry.name}. `,
				'It will be reviewed but not imported — check the name against the ',
				'animation brief.');
		}
		if (entry.problems?.length) {
			return h('div.rv-bad',
				...entry.problems.map((problem) => h('div', problem)));
		}
		return h('div.rv-good', `plays in-game as ${entry.slot}`);
	}

	function spineTile(entry) {
		const expected = new Set(entry.expected ?? []);
		return h('div.rv-tile.rv-wide',
			h('div.rv-art', { id: `spine-${entry.name}` }, h('span.dim', 'loading…')),
			h('b', entry.name),
			h('div.rv-size', { id: `size-${entry.name}` }),
			h('div.rv-anims',
				...entry.animations.map((animation) =>
					h(expected.has(animation) ? 'button.chip.active' : 'button.chip',
						{ onclick: () => setAnimation(entry.name, animation) },
						animation),
				),
			),
			verdict(entry),
			entry.atlas ? null : h('div.gen-err', 'no atlas beside it — cannot play'),
		);
	}

	function render() {
		mount(
			root,
			h('div.card',
				h('h2', 'Review delivered assets'),
				h('p.card-sub',
					'What is in the delivery folder, before anything is written into the game. ' +
					'Rigs play in the same runtime the game uses.'),
				h('div.row',
					h('label', { style: 'font-size:12px;color:#8b8397' }, 'Folder'),
					h('input.mono', {
						value: state.from,
						style: 'background:#16131c;color:#ded7e8;border:1px solid #322a3c;border-radius:6px;padding:6px 10px;font-size:12px',
						onchange: (e) => { state.from = e.target.value.trim() || 'delivered'; load(); },
					}),
					h('button.btn', { onclick: load }, 'Reload'),
					state.dir ? h('span.dim', state.dir) : null,
				),
			),

			state.error ? h('div.card', h('div.err-box', state.error)) : null,

			state.loading
				? h('div.card', h('p.dim', 'reading the folder…'))
				: !state.exists
					? h('div.card',
							h('div.warn-box',
								h('b', 'No such folder. '),
								'Drop the delivery into it, or point at another one above.'))
					: null,

			state.spine.length
				? h('div.card',
						h('h2', `Animations (${state.spine.length})`),
						h('p.card-sub',
							'Click an animation name to play it. A highlighted name is one the ' +
							'game will actually call — the rest are along for the ride.'),
						h('div.rv-grid', ...state.spine.map(spineTile)))
				: null,

			state.images.length
				? h('div.card',
						h('h2', `Images (${state.images.length})`),
						h('p.card-sub',
							'Shown at real size on a chequerboard — anything with an opaque ' +
							'rectangle behind it will tile the reel with rectangles.'),
						h('div.rv-grid', ...state.images.map(imageTile)))
				: null,
		);
	}

	load();
	return root;
}
