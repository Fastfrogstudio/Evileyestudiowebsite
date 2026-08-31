# stake-forge

A CLI that scaffolds [Stake Engine](https://stake-engine.com/docs) games — **both** halves,
[math-sdk](https://github.com/StakeEngine/math-sdk) and [web-sdk](https://github.com/StakeEngine/web-sdk) —
from a single `game-spec.yaml` plus your own art/spine assets.

`game-spec.yaml` and `assets-manifest.yaml` are the only per-game inputs. Everything else is
derived: the Python paytable and the TypeScript one come from the same source, so they cannot
drift apart.

It does **not** rip assets or logic out of any other game. You provide the art; the tool's job is
mechanical — turn a YAML description into the exact shapes each SDK expects, cloning from the SDKs'
own sample games so you inherit a working spin/reveal/win/freespin flow rather than starting blank.

---

## The rule this tool is built around

**Nothing is generated from a pattern that has not been read AND run.**

Every behavior recipe carries a `status` and a `verifiedAgainst` string naming exactly what was
checked. Only `verified` recipes emit code. A recipe whose pattern is real but unproven reports
where to find the sample and refuses to write Python — because a generator that invents
plausible-looking math is worse than one that says "not built yet, here is what to copy".

Run `forge behaviors --json` to see the provenance of every recipe.

The same rule applies to the facts this tool encodes. Several things that "everyone knows" about
the engine turn out to be wrong when you check them against a real checkout:

| Common belief | What the source actually says |
|---|---|
| `special_symbols` has 3 keys: wild, scatter, multiplier | It has **4** with engine defaults. `src/calculations/symbol.py` `Symbol.assign_default_attribute()` also matches `prize` (setting `has_prize`/`prize`). `0_0_expwilds` ships all four. Keys beyond those are legal too — they land in `special_flags` and are readable via `check_attribute()`; the SDK's own tests use a `"blank"` key. |
| `win_type` only accepts 4 values | It is not validated anywhere. Grep a checkout: it is only ever *assigned*, never read by any code under `src/`. `games/fifty_fifty` sets `"other"`. What actually decides win evaluation is which `src/calculations/*` module your `gamestate.py` calls. |
| Tumble is a fifth win type | It is `cluster` or `scatter` with `explode=True` set on winning symbols by those evaluators. See `docs/math_docs/source_section/tumble_info.md`. |
| `paddingReels` looks the same in every web app | Four apps, three shapes. `lines`/`scatter` ship reel arrays, `cluster`/`ways` ship empty strings; `ways` adds a third `superspingame` key; and `scatter` names its second key **`freeSpins`**, not `freegame`. Since `GameType = keyof typeof config.paddingReels`, the key set is part of each app's type surface. |

---

## Install

```bash
cd stake-forge
npm install
npm link          # makes `forge` global, or just run `node bin/forge.js`
```

You also need local checkouts of both SDKs:

```bash
git clone https://github.com/StakeEngine/web-sdk.git   && (cd web-sdk && pnpm install)
git clone https://github.com/StakeEngine/math-sdk.git  && (cd math-sdk && python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt)
```

> math-sdk's `requirements.txt` starts with an editable self-install that needs Python ≥ 3.12.
> Install the remaining lines into a 3.12+ venv; `forge verify` finds `<math-sdk>/.venv/bin/python`
> automatically.

---

## Run it locally

Two things run in a browser on your own machine, and they are different things.

### The editor — needs only this repo

```bash
cd stake-forge && npm install
npm run app          # http://localhost:4173
```

The spec, your assets, the whole pipeline and a live preview, with no SDK
checkouts required to open it. It runs commands and reads and writes files on the
machine it is running on, so it binds to localhost and nothing else.

### A game — needs both SDK checkouts

`forge preview` starts the web-sdk's own story server, which replays REAL
simulated books through the REAL renderer. No RGS backend, no wallet, no deploy.

```bash
# from a clean clone, with ../web-sdk and ../math-sdk checked out as above
forge math:scaffold --spec examples/sticky-wilds.yaml --math-sdk ../math-sdk
forge scaffold      --spec examples/sticky-wilds.yaml --sdk ../web-sdk
forge deps:link     --sdk ../web-sdk

forge math:run      --spec examples/sticky-wilds.yaml --math-sdk ../math-sdk --sims 2000
forge math:optimise --spec examples/sticky-wilds.yaml --math-sdk ../math-sdk
forge math:sync     --spec examples/sticky-wilds.yaml --math-sdk ../math-sdk --sdk ../web-sdk

forge preview --spec examples/sticky-wilds.yaml --sdk ../web-sdk   # http://localhost:6006
```

`deps:link` is not optional on a freshly scaffolded app — it is a new pnpm
workspace package, and until the workspace is re-linked its `node_modules` does
not exist and nothing can resolve its imports.

The three story groups, and what each is for:

| Story | What you get |
|---|---|
| `MODE_BASE/book`, `MODE_BONUS/book` | A whole round, end to end. Click **Action** to start. |
| `MODE_*/bookEvent` | One event at a time — the one to use when an animation is wrong and you need to see the state it is wrong in. |
| `COMPONENTS/<Symbol>` | The symbol sheet at real size. Fastest check that art dropped in right. |

The stories read `src/stories/data/*.ts`, which `math:sync` writes from the
simulation. **Preview a game you have not synced and you are looking at the SDK
sample's rounds, not yours** — `forge preview` checks and says which one you are
about to see, because reviewing the wrong game is a silent waste of a review.

Skip `math:run`/`optimise`/`sync` if you only want to see the art and the layout;
the game still renders, it just plays the sample's maths.

---

## Workflow

```
     forge mechanics ──> what to build: 56 mechanics, 29 reference games,
                         what each costs the art team, what conflicts with what

inspiration.yaml ──forge inspire──> game-spec.yaml ──┬──forge brief──────────> what to DRAW,
                                                     │                          before any art exists
                                                     ├──forge math:balance───> is this paytable
                                                     │                          payable at all? (1s)
                                                     ├──forge math:scaffold──> math-sdk/games/<game_id>
                                                     └──forge scaffold───────> web-sdk/apps/<name>
     forge art:placeholder ──> stand-in symbol tiles, so it renders on day one
                    assets-manifest.yaml ──forge audit──> gaps, before anything is written
                                         ──forge assets:import──> your art, wired in
                        sounds-source/ ──forge sound:build──> the one audio sprite the SDK loads

     forge math:run ──> simulated rounds, books, lookup tables
     forge math:optimise ──> reweighted until it pays the target RTP
     forge math:sync ──> the real maths into the web app
     forge math:report ──> what it actually pays
     forge math:validate ──> whether that is SHIPPABLE, rule by rule
                                                          forge verify ──> proof it runs
                                                          forge package ──> the upload folder
```

`math:balance` runs first because it is the cheap check that makes the expensive ones worth
running: a paytable that cannot pay its RTP on this board will simulate for an hour and then fail
in the optimiser with a message about pig counts. `math:validate` runs last because it is the only
step that asks whether the finished numbers are good enough to submit.

Or run the whole thing in a browser: `npm run app` opens a local editor with the
spec, your assets, this pipeline and a live preview.

### 1. `forge init`

Writes `game-spec.yaml`, `assets-manifest.yaml`, `inspiration.yaml` and `assets-source/`.

### 2. `forge inspire` — optional, from a feature checklist

```bash
forge inspire --in inspiration.yaml --out game-spec.draft.yaml
```

Takes a plain-language list of mechanics and produces a draft spec with `role`/`order`/`special`/
`behaviors` filled in, plus `inspiration-report.md` splitting the features into **tier 2**
(built in to both SDKs — config only) and **tier 3** (bespoke — needs a behavior recipe), pointing
at the closest sample for anything bespoke.

What the draft gets right is the taxonomy and the mechanic. Paytable values, RTP and reel weights
are placeholders — nothing about payout maths can be derived from a description of mechanics.

**The hard boundary.** The only accepted input is a plain-language description. `forge inspire`
refuses to run on a file that points at images, archives, sprite sheets, code, or a client bundle,
and says what to do instead. Working from a screenshot? Look at it yourself, write down what it
*does* in words, and put the words in `features:`. The tool never ingests another studio's pixels —
that boundary is only enforceable if it lives at exactly one file, so it does.

### 3. `forge art:placeholder` — see it before your art exists

```bash
forge art:placeholder --spec game-spec.yaml
```

Generates one legible tile per symbol — role-coloured, name on the front, top
payout underneath — writes them to `assets-source/`, and adds a `spriteSymbols:`
block to `assets-manifest.yaml`. From there `assets:import` wires them in and the
game renders with symbols you can actually tell apart on a spinning reel.

Symbols carrying a behavior also get a tile per extra state, so a feature firing
is **visible on the board** rather than only in the event log — an expanding wild
produces `w.png` plus `w_expand_in.png`, `w_expand_loop.png`, `w_expand_out.png`.

The tiles are plain PNGs written by a small encoder in `src/lib/png.js` (no image
dependency), so nothing here needs a design tool to regenerate.

**Symbols only, and that limit is deliberate.** `SYMBOL_INFO_MAP` entries may be
`{ type: 'sprite', assetKey }`, and pixi-svelte's loader registers a `sprite`
under its own key — so a flat PNG per symbol renders with no spine anywhere.
Screens cannot work that way: `Background.svelte`, `FreeSpinIntro.svelte`,
`WinAnimation.svelte` and the rest hardcode `<SpineProvider key="...">` and play
named animation tracks, so a PNG cannot stand in for one without rewriting the
component. Placeholder runs leave those on the sample app's art, and `forge audit`
marks them `◐ using sample art`.

**Swapping in your real art** is per symbol and needs no spec change: add the
symbol to `spineSymbols:` with its atlas/skeleton and delete its `spriteSymbols:`
entry. The loader rejects a symbol listed in both, so you cannot half-migrate one
by accident.

### 4. `forge audit` — before you scaffold

```bash
forge audit --spec game-spec.yaml --manifest assets-manifest.yaml
```

Cross-checks the manifest against the animation states each symbol's **role + behaviors** imply,
and the screen slots against the components they drive. This is the check that pays for itself: an
expanding wild needs `expand_in`/`expand_loop`/`expand_out` on top of the usual states, and there is
no way to notice those are missing from a spine export until the feature fires in-game.

```
Symbols
  ✗ W    wild     [expanding]  missing: expand_loop, expand_out
  ✓ H1   high      5 states ok
  ◐ H2   high      5 states via placeholder sprite

ERROR symbol W: missing animation state "expand_loop" (required by behavior "expanding")
      Add it under W.animations in assets-manifest.yaml, pointing at the animation name inside w.json.
```

Exits non-zero when there are errors, so it drops straight into CI.

### 5. `forge math:scaffold` and `forge scaffold`

```bash
forge math:scaffold --spec game-spec.yaml --math-sdk ../math-sdk
forge scaffold      --spec game-spec.yaml --sdk      ../web-sdk
```

**math-sdk** — clones `games/<sample>` to `games/<game_id>` (the folder name *is* the `game_id`;
`Config.construct_paths()` joins `PATH_TO_GAMES` with it), then patches `game_config.py`: paytable,
paylines, `special_symbols`, `freespin_triggers`, `anticipation_triggers`, `num_rows`, `bet_modes`,
and writes placeholder reel CSVs. Behavior recipes append their methods to the existing classes —
never overwriting `game_executables.py` or `game_events.py`, which carry the mechanic's own win
evaluator and events.

**web-sdk** — clones `apps/<sample>` to `apps/<name>`, writes `config.ts`, patches `constants.ts`
(`SYMBOL_INFO_MAP`, `HIGH_SYMBOLS`, `INITIAL_BOARD`), and for each verified behavior applies the
8-step "Steps to Add a New BookEvent" procedure from web-sdk's own README: event types, the
`BookEvent` union, handlers, a new component, the `EmitterEventGame` union, and story fixtures.

### 6. `forge assets:import`

```bash
forge assets:import --manifest assets-manifest.yaml --sdk ../web-sdk --game le-bandit --spec game-spec.yaml
```

Copies your files in and patches `assets.ts` + `SYMBOL_INFO_MAP`. Pass `--spec` so states are wired
per symbol role *and* behavior — otherwise it can only guess the default five.

### 7. `forge verify` — the part that matters

```bash
forge verify --spec game-spec.yaml --math-sdk ../math-sdk --sdk ../web-sdk
```

```
✓ PASS  py_compile
        8 file(s) compiled
✓ PASS  GameConfig()
        constructed: game_id=0_0_le_bandit, 30 paytable entries, 2 bet mode(s), 3 reel strip(s)
✓ PASS  run_spin(base/freegame)
        12 rounds, events: reveal×163, freeSpinTrigger×12, newExpandingWilds×29, updateExpandingWilds×107, ...
✓ PASS  tsc --noEmit
        no new errors vs apps/lines (baseline 65 pre-existing, 0 not reproduced in the generated app)
```

Four levels, cheapest first:

1. **`py_compile`** — the generated Python parses.
2. **`GameConfig()`** — it actually *constructs*, which catches far more: `Config.__init__` runs
   `construct_paths()` and `read_reels_csv()`, so reel files must exist and every symbol on them
   must be declared. The resulting config is then compared field-by-field against the spec, which
   turns "it ran" into "it ran and produced what was asked for".
3. **`run_spin()`** — real simulated rounds. The only level that proves a behavior recipe's runtime
   path is reachable; a recipe's own bookEvents must appear in the output or the check fails.
4. **`tsc --noEmit`, baseline-differential** — typecheck the pristine sample app, record its error
   set, typecheck the generated app, report only what is *new*. This is deliberate: a clean
   web-sdk sample reports ~65 errors under plain `tsc` (SvelteKit's `$app`/`$env` aliases don't
   exist outside `svelte-kit sync`, `*.svelte` module-context type exports are invisible to plain
   tsc, and `apps/lines` has genuine pre-existing errors). Reporting those against generated code
   would be noise that hides real regressions.

A freshly scaffolded app is a new pnpm workspace package, so run `pnpm install` in the web-sdk once
before the tsc check — `forge verify` detects the missing `node_modules` and tells you.

---

### 8. `forge math:run` -> `math:optimise` -> `math:report` — the maths, for real

Scaffolding produces a game that *runs*. It does not produce a game that *pays what you asked for*.
Three steps close that gap, and the order matters:

```bash
forge math:run      --spec game-spec.yaml --math-sdk ../math-sdk --sims 100000 --compress
forge math:optimise --spec game-spec.yaml --math-sdk ../math-sdk
forge math:report   --spec game-spec.yaml --math-sdk ../math-sdk
```

**Why the raw numbers are meaningless.** The generated distributions re-roll any round that pays
nothing, so every simulated round is a winner and the measured RTP is far above target *by design*.
`math:report` says so and refuses to judge a pre-optimisation run against your target. Only after
the optimiser has reweighted the distribution do the figures mean anything — at which point, on the
sample games here, both bet modes land on their target RTP to two decimal places.

**Volatility is a spec field**, not a number to invent per game:

```yaml
game:
  volatility: high   # low | medium | high
```

It decides how the RTP divides between base game and feature and what hit rates to aim for, and it
generates `game_optimization.py`. That file is yours once written — `math:optimise` will not
overwrite it without `--force`, because tuning those targets by hand is exactly the work the step
exists to enable. Its header says which parts are asserted fact and which are opinions from the
profile.

**A hold-and-win mode** is a bet mode, not a modifier:

```yaml
betModes:
  superspin: { cost: 50, rtp: 0.96, maxWin: 2000, feature: true, superspin: true }
symbols:
  - { name: P, role: high, special: [prize], behaviors: [sticky] }
```

### 9. `forge sound:build` — the audio sprite

The web-sdk does not load loose audio files. It loads **one sprite** — a single timeline in four
formats plus a JSON of millisecond offsets. Name your clips after the sounds they are and this
assembles it:

```bash
forge sound:build --spec game-spec.yaml --sdk ../web-sdk --source sounds-source
```

Needs `ffmpeg`. `forge audit` cross-checks the result, and that check earns its keep: **a missing
sound does not throw and does not log** — the moment just plays nothing.

### 10. `forge package` — the upload folder

A game goes to Stake Engine as two uploads from two different places. This builds and assembles
both, and refuses to call the folder ready when it is not:

```bash
forge package --spec game-spec.yaml --sdk ../web-sdk --math-sdk ../math-sdk
```

It checks the four ways the math half looks finished and is not — missing compressed books, an
empty or stale `sha256`, lookup tables the optimiser never touched, and tables optimised against a
*different* simulation than the books beside them. Each of those uploads cleanly and then does the
wrong thing.


## The spec

### Symbol taxonomy

```yaml
symbols:
  - name: H1
    role: high            # low | high | wild | scatter
    order: 1              # rank within role, 1 = strongest (optional: derived from paytable)
    label: "Bandit Boss"
    paytable: { "5": 20, "4": 10, "3": 5 }

  - name: W
    role: wild            # implies special: [wild]
    special: [wild, multiplier]   # explicit -> ADDS multiplier
    behaviors: [expanding]
    paytable: { "5": 20, "4": 10, "3": 5 }

  - name: S
    role: scatter         # implies special: [scatter]; no paytable needed
```

**`role`** is the source of truth. `role: wild` implies `special: [wild]`, `role: scatter` implies
`special: [scatter]`. Write `special:` explicitly only to *add* keys. An explicit list that drops
the implied key is allowed but warns loudly, because it silently breaks wild substitution or
free-spin triggering.

**`special`** keys map to `GameConfig.special_symbols`. The four with engine defaults
(`wild`, `scatter`, `multiplier`, `prize`) pass silently; anything else is accepted with a warning
saying it has no default and a recipe must set it — because that *is* how a bespoke behavior adds
a flag.

**`order`** ranks within a role, driving paytable sort and `HIGH_SYMBOLS`. Optional; derived from
the paytable descending, and explicit values slot around derived ones without collision.

**`behaviors`** are tags resolved against the recipe registry. Unknown tags are an error listing
the known ones.

`tier: high | low | special` from taxonomy v1 still loads, migrating to `role` with a warning.

### Screens

```yaml
screens:
  background:
    basegame: true     # -> assets.ts "foregroundAnimation"      -> Background.svelte
    freegame: true     # -> assets.ts "foregroundFeatureAnimation" -> Background.svelte
  freeSpins:
    intro: true        # -> "fsIntro"       -> FreeSpinIntro.svelte
    outroNumber: true  # -> "fsOutroNumber" -> FreeSpinOutro.svelte
  transition: true     # -> "transition"    -> TransitionAnimation.svelte
  loading: true        # -> "loader"        -> LoadingScreen.svelte
  winBanner: true      # -> "bigwin"        -> WinAnimation.svelte
  winCoins: true       # -> "coins"         -> WinCoins.svelte
```

Each slot names a real asset key that a real component looks up. `forge audit` lists every slot,
which component it drives, and whether you have supplied it.

### Mechanic quirks the tool encodes for you

- **scatter** names its second game type `freeSpins`, while the math side emits
  `gameType: "freegame"` — so the shipped sample's reveal handler looks up a `paddingReels` key
  that does not exist. Pre-existing in the SDK, but worth knowing if a free-game padding board
  looks wrong.
- **scatter** also hardcodes a symbol named `M` in `stateGame.svelte.ts` and `utils.ts`, so a
  scatter game must declare one. `forge` errors with that explanation rather than letting it
  surface as a mystery tsc failure.
- **ways** has a third game type, `superspingame`. Dropping it changes the app's `GameType` union.
- **`0_0_scatter/game_config.py`** assigns `self.provider_numer` — a typo in the SDK that leaves
  the real `provider_number` at its `Config` default. `forge math:scaffold` inserts the correctly
  spelled assignment and tells you it did.
- **`0_0_cluster/game_override.py`**'s `assign_special_sym_function()` is just `pass`, so there is
  no assignment to patch — `forge` inserts one.
- **`0_0_ways/game_override.py`**'s `assign_mult_property()` reads a *flat* `mult_values` dict,
  while `0_0_lines` and `0_0_expwilds` read one nested by game type. A recipe that emits nested
  values therefore owns the reader too, or the two disagree at runtime.

**Win-tier banners** map onto `Config.get_win_level()`, which returns 1–10 on two scales:
`standard` (used by `setWin`) and `endFeature` (used by `freeSpinEnd`). Only levels 6–10 render a
banner in `winLevelMap.ts` — 1–5 are silent count-ups — so the `bigwin` spine needs intro/idle/exit
for each of `big_win_*`, `super_win_*`, `mega_win_*`, `epic_win_*`, `max_win_*`.

---

## Behavior recipes

```bash
forge behaviors           # human-readable
forge behaviors --json    # full provenance
```

| Tier | Meaning |
|---|---|
| **2** | Built in to *both* SDKs. Config only, no code: free spins, global multiplier, tumble, win cap. |
| **3** | Bespoke. Needs a `special_symbol_functions` hook plus custom bookEvents and a new component. |

| Recipe | Tier | Status | Reference |
|---|---|---|---|
| `expanding` | 3 | **verified — generated** | math `games/0_0_expwilds`; web has no sample, so it follows web-sdk's own "Steps to Add a New BookEvent" |
| `sticky` | 3 | documented | the superspin mode of `games/0_0_expwilds` |
| `prize` | 3 | documented | `games/0_0_expwilds` prize handling (also needs `prize?: number` on `RawSymbol`) |
| `colossal` | 3 | documented | **no sample in either SDK** — genuinely from scratch |
| `freespins`, `global_multiplier`, `tumble`, `wincap` | 2 | builtin | already wired end-to-end |

### Recipes are gated by mechanic

`expanding` declares `verifiedForMechanics: ['lines', 'ways']`, and asking for it on `cluster` or
`scatter` is an error. That is not caution about untested ground — on a tumbling board the round
re-draws mid-spin via `tumble_game_board()`, which the recipe's splice into `run_freespin()` never
sees, so the expanded wilds would be wiped by the first cascade. `0_0_expwilds` is a lines game and
never exercises that interaction, so there is no verified pattern to copy. Making it work needs a
tumble-aware variant, which is design work rather than scaffolding.

### Adding a recipe

1. **Find a real sample** in math-sdk `games/` or web-sdk `apps/`, or a documented pattern in
   `docs/math_docs/`. If there is none, say so in `verifiedAgainst` and stop at `documented`.
2. Add the entry to `src/lib/behaviorRecipes.js` with `status: 'documented'` — `forge audit` will
   already report its animation states and hook sites.
3. Write the emitters in `src/lib/recipes/<id>.js`, adapting the sample's code rather than inventing
   logic. Note the line correspondence in a header comment, as `recipes/expanding.js` does.
4. **Run it**: `forge math:scaffold` then `forge verify`, and confirm the recipe's own bookEvents
   appear in the `run_spin()` output.
5. Only then promote it to `status: 'verified'` and record what you ran in `verifiedAgainst`.

---

## What this tool does NOT do

Two claims used to live here that are no longer true, and are recorded rather than quietly
deleted: *"it does not generate math or RTP"* and *"it does not tune bet-mode distributions"*.
Both were accurate when written and both were made obsolete by the reel-strip designer and the
balance model. What follows is the current honest boundary.

- **It does not replace design work.** It gets you to "the game runs in storybook with my art and
  my paytable, and the maths simulates, optimises and validates end-to-end". Win presentation,
  bonus screens and the actual *feel* of the game are still yours.
- **Its balance model is a pre-flight, not the truth.** `math:balance` evaluates the base board
  only — no multipliers, no cascades, no free spins. It answers "is the level of this paytable
  within reach of the target", in about a second. The simulation remains the ground truth.
- **Four of the ten `math:validate` rules are our reading of Stake's approval criteria**,
  gathered from research rather than handed to us, and the command says so on every run.
  Confirm them before a submission.
- **Nothing here has been through a real upload or certification.** `forge package` assembles a
  bundle that satisfies every check we know how to write. That is not the same as a bundle Stake
  has accepted, and until one has been, this line stays.
- **`feature-variety` is our own rule and its threshold is a judgement.** It reports the share
  of simulated free-game rounds that carry real weight in the shipped game, and flags below 5%
  — the point at which the optimiser is discarding almost everything it was given. Advisory;
  it never fails a build.
- **The volatility bands are a declaration of intent, not a measurement.** No shipped math-sdk
  sample carries simulation output, so there was nothing to calibrate against. `math:validate`
  reports that check as advisory and never fails on it.

## What it does do, that the above used to deny

- **Designs reel strips against the paytable**, calibrating symbol frequency to the target RTP and
  hit rate — and, on a cascading mechanic, to a cascade length that terminates.
- **Balances the paytable against the board geometry.** Ways pay per way, so a 5x3 paytable on a
  5x4 board is 4.2x too rich before anything else is considered. `math:balance` reports the exact
  scale factor, and `--apply` writes it into the spec.
- **Generates the wincap distribution** that makes a max win reachable at a chosen frequency —
  `hit_rate = max_win / rtp_allocated`, which is why 100,000x at 0.5% of RTP is exactly
  1-in-20,000,000.
- **Optimises to target and proves it.** Three games, one per volatility tier, each reach their
  cap with every rule passing: a 10,000x cluster game, a 5,000x lines game, and a 100,000x ways
  game, all on 96.50% against 96.50%.

### Generating art from a style guide

The loop that works is: describe the look once, generate candidates, keep the good
ones, and let those anchor everything generated after. The tedious middle is knowing
what to ask for — and that is the part forge already derives.

```bash
forge art:guide                                    # write art-guide.yaml, describe the look
#   ...or drop your own art-guide.md beside it — a written guide's tuned
#   prompt template is used as-is rather than recomposed from its parts
forge art:check                                    # one request, before spending on a batch
forge art:prompts --spec game-spec.yaml --sdk ../web-sdk --out art-prompts.json
```

Or do the whole loop in the app: **Generate** tab, brief at the top, assets below.

**Seedream, not Seedance.** Seedance is ByteDance's video model — 30-second clips
with audio, the wrong tool for a slot symbol. Seedream is the image line, from the
same BytePlus ModelArk endpoint, and Seedream 5.0 Pro returns a background plus
individual elements as separate transparent PNGs from one prompt — the exact shape
a Spine screen is stored in.

Two API details that are easy to get wrong and expensive to: `size` is a single
`"WIDTHxHEIGHT"` string with each side in **512–2048**, and `watermark` must be
explicitly `false`. Most of what a slot game needs is under that floor — symbol
parts in the shipped atlas are 160x160 — so generation scales up to a valid master
and records the target for the packer. That is the right artefact anyway: the
sample symbol skeletons author at 1080x1080 and pack down.

**A background is not one image.** `mm_bg.atlas` in the lines sample holds named
layers — `bg_base` 2020x991, `bg_cart_add` 404x220, `bg_shovel_add` 130x282,
`dust1`, `dust2`, a 17x17 particle. Spine animates those parts independently; a
single flat painting cannot be animated at all, because there is nothing to move.

That is also what makes generation viable. "An animated mine background" is a bad
prompt with no usable output. "A mine cart, 404x220, on a plain white
background" is a good one, and the parts assemble into something a rig can drive. `art:prompts`
reads the layer list straight out of the reference app's atlases, so it briefs the
exact slots the game's Spine skeletons expect — 178 parts for a 5x3 lines game.

Two rules it encodes that decide whether an asset is usable at all:

- **Transparency.** Everything is composited by Spine, so every part is briefed
  transparent except the full-bleed backdrop. A symbol on an opaque square tiles
  the reel with rectangles.
- **Size.** `art:accept` refuses an image that is not the size it briefed, and says
  whether the aspect ratio also changed — same ratio only needs resampling, a
  different one means the model composed a different picture. Caught here it is one
  regeneration; caught in the build it is a day of confusion.

The guide is a **description**, not a collection. It is not a place for another
studio's screenshots, sprite sheets or extracted files — the same line
`inspirationRules.js` holds for mechanics.

### Art made elsewhere

Generate art in whatever tool the studio already uses; forge says what to make and
makes it work.

```bash
forge art:prompts --spec game-spec.yaml --sdk ../web-sdk --out art-prompts.json
# ...your art tool produces PNGs, on white...
forge art:import  --spec game-spec.yaml --from ./delivered --dry-run
forge anim:brief  --spec game-spec.yaml --sdk ../web-sdk --out animation-brief.md
```

`art:import` matches files to slots by name — forgiving about case, separators and
export suffixes (`w_final_v2.png` finds `symbol.W`), unforgiving about ambiguity,
because guessing puts the cart art in the shovel's slot and nothing downstream
notices. Then it fixes what can be fixed and refuses what cannot:

- **Size** — resampled to the slot's size, premultiplied. Resizing transparent art
  without premultiplying puts a dark fringe on every symbol, and it only shows up
  after packing.
- **Aspect ratio** — a different ratio is refused rather than squashed. That is a
  different composition, not the same picture at another size.
- **Alpha** — a symbol with no transparency is an error, not a note: it tiles the
  reel with rectangles and looks perfectly fine in a folder. A see-through backdrop
  is flagged the other way.

`anim:brief` is the handoff to whoever rigs the Spine files, and `forge deliver`
is the flat checklist of every filename — both PNGs and Spine bundles — because
the name is what the import matches on.

A Spine delivery is a skeleton, its atlas and the atlas page, validated as a set:
`art:import` checks that every animation the front end will call is actually
present. That is the sharp edge — the front end plays `h4` and `h4_static` by
literal string, so a rig with the right motion under a different name loads
without error, validates cleanly, and plays nothing on screen.

Path, clipping and bounding-box attachments are excluded from the region check —
they are geometry rather than art and never appear in the atlas. Checking them
would report two false failures on a correct file, and a validator that cries wolf
gets switched off.

### The gate that reads what the optimiser cannot fix

Nine of the ten `math:validate` rules read the **optimised** table, where RTP, hit rate and the
win bands are correct by construction — that is what the optimiser is for. Which means a
mechanic can inflate the raw feature by any amount and every rule stays green.

Measured on a sticky-wilds game against the identical game with the mechanic off: raw RTP went
**21.8x to 338.4x**, and after optimisation both reported 96.50% RTP, a 1-in-3.4 hit rate and
the same feature frequency. Every rule passed on both.

What moved was the weight *inside* the feature. The optimiser holds RTP by leaning on the
cheapest free-game rounds, and the richer the raw feature, the harder it leans. Far enough and
the rounds the mechanic exists to produce are simulated and then almost never served — the
designed feature and the shipped feature stop being the same thing.

`feature-variety` measures that directly. On a game stacking six enriching mechanics:

```
! 2.13% of the simulated free-game rounds carry real weight in the shipped game
     1.1 effectively distinct round(s) of 50 simulated; 1 carry 95% of the feature weight.
```

One round out of fifty, served on essentially every trigger. Everything else passed.

The metric is a **share**, not a round count, and that is the point. Effective sample size scales
with the simulation — re-running one game at 5x the rounds took it from 9.7 to 30.2 while the
share barely moved (4.8% to 3.0%) — so a floor on the count would mostly measure how long you
simulated. The share is scale-free, so a longer simulation raises the count and not the number
the rule reads. The fix is to thin the feature, not to simulate more.

### Measured, on three generated games

Not a claim about what the tool should do — the numbers three real games actually
produced, each scaffolded from a spec, simulated, optimised and validated end to end.

| | low | medium | high |
|---|---|---|---|
| game | `emberfall` (cluster) | `audit` (lines) | `titan` (ways) |
| max win | 10,000x | 5,000x | 100,000x |
| **max win reached** | yes, 1 in 20,000,000 | yes, 1 in 20,000,002 | yes, 1 in 20,000,000 |
| RTP after optimisation | 96.50% (-0.00pp) | 96.50% (-0.00pp) | 96.50% (-0.00pp) |
| base hit rate | 1 in 2.4 | 1 in 3.4 | 1 in 5.4 |
| p99.9 | 68.7x | 68.8x | 189.5x |
| `math:validate` | all rules pass | all rules pass | all rules pass |

The hit rates come out ordered by volatility without being set directly — they fall
out of the strip design, which is the thing that had to work. Max win is reached at
the 1-in-20,000,000 frequency in every tier because that frequency is *chosen*
(`maxWin ÷ the RTP allocated to the wincap distribution`), not discovered.

---

## Command reference

| Command | What it does |
|---|---|
| `forge init` | Write example spec/manifest/inspiration files + `assets-source/` |
| `forge inspire --in <yaml> [--out <yaml>] [--report <md>]` | Feature checklist -> draft spec + tier report |
| `forge behaviors [--json]` | List the recipe registry and its provenance |
| `forge art:placeholder --spec <yaml> [--out <dir>] [--size <px>]` | Generate stand-in symbol tiles + wire them into the manifest |
| `forge audit --spec <yaml> --manifest <yaml> [--json]` | Check the manifest against required states + screen slots |
| `forge math:scaffold --spec <yaml> --math-sdk <path> [--force]` | Create `games/<game_id>` |
| `forge scaffold --spec <yaml> --sdk <path> [--force]` | Create `apps/<name>` |
| `forge deps:link --sdk <path> [--with-scripts]` | Re-link the pnpm workspace so a freshly scaffolded app can resolve its imports |
| `forge assets:import --manifest <yaml> --sdk <path> --game <name> [--spec <yaml>]` | Copy + wire your art |
| `forge verify --spec <yaml> [--math-sdk <path>] [--sdk <path>] [--skip-spin]` | Run the generated output for real |
| `forge sound:build --sdk <path> --source <dir> [--spec <yaml>\|--game <name>] [--dry-run]` | Mix your sound files into the audio sprite, in all four formats |
| `forge math:run --spec <yaml> --math-sdk <path> [--sims <n>] [--compress]` | Simulate rounds — books, lookup tables, frontend config |
| `forge math:optimise --spec <yaml> --math-sdk <path> [--volatility <p>] [--force] [--setup-only]` | Reweight until it pays the target RTP |
| `forge math:sync --spec <yaml> --math-sdk <path> --sdk <path> [--dry-run]` | Replace placeholder config + story data with the real maths |
| `forge math:report --spec <yaml> --math-sdk <path> [--json]` | Measured RTP, hit rate and spread against your targets |
| `forge math:balance --spec <yaml> [--volatility <p>] [--apply] [--json]` | Pre-flight: is this paytable payable at this RTP, on this board? |
| `forge math:validate --spec <yaml> --math-sdk <path> [--json]` | Is it shippable? Every rule measured, with the number it was judged on |
| `forge brief --spec <yaml> [--format md\|csv\|json\|manifest] [--out <path>]` | What to draw — the complete asset spec, before any art exists |
| `forge art:guide [--out <path>]` | Write art-guide.yaml — the look, once, for every asset in this game. A written `art-guide.md` is used in preference where one exists |
| `forge deliver --spec <yaml> [--guide <yaml>] [--sdk <path>] [--out <md>]` | One checklist: every file this game needs and exactly what to call it |
| `forge art:cutout --from <path> [--out <dir>] [--size <WxH>] [--dry-run]` | Knock the white background out of generated art and trim it to the subject |
| `forge art:import --spec <yaml> --from <dir> [--game <dir>] [--dry-run]` | Bring in art made elsewhere: match to slots, cut out white, resample, check alpha |
| `forge anim:brief --spec <yaml> [--sdk <path>] [--out <md>]` | What the animation team needs: skeleton names, animation names, canvas sizes |
| `forge art:check [--endpoint <url>] [--key <key>] [--model <id>]` | One request to the image provider, reported in full — run before a batch |
| `forge art:prompts --spec <yaml> [--guide <yaml>] [--sdk <path>] [--out <json>] [--only <kinds>]` | One prompt per asset part, at the exact size this game needs |
| `forge art:accept --manifest <json> --id <id> --file <png> [--guide <yaml>] [--game <dir>]` | Promote a generated candidate and make it a style anchor |
| `forge mechanics [--id <id>] [--win-type <t>] [--volatility <v>] [--games] [--combine <ids>] [--art <ids>]` | Browse the researched mechanics library |
| `forge package --spec <yaml> --sdk <path> --math-sdk <path> [--out <dir>] [--skip-build]` | Build and assemble both upload halves |
| `forge preview --sdk <path> [--spec <yaml>\|--name <app>] [--port <n>]` | Look at the game — real books through the real renderer, in your browser |

## Tests

```bash
npm test                                              # unit tests, no SDK needed
npm run test:e2e -- --math-sdk ../math-sdk --sdk ../web-sdk   # real scaffold + run + typecheck
```

The e2e run covers all four mechanics on both sides. It asserts that `expanding` is *refused* on
`scatter` as loudly as it asserts the successes — and, since the board-lifetime work made the
combination real, that an expanding wild on a *cascading* board generates, constructs a
`GameConfig`, runs a spin, and lands its restore call in both cascade loops.

## Merging mechanics from different games

You can. That is what the mechanics library is for, and `examples/merged-mechanics.yaml`
is a worked one: cluster-pays tumbling, doubling grid multipliers, expanding wilds and a
climbing global multiplier — four mechanics from four different studios' games — in a single
spec that reaches 96.50% RTP, hits a 25,000x cap at 1-in-20,000,000, and passes every
`math:validate` rule.

Check a combination before building it:

```bash
forge mechanics --combine cluster_pays,tumble,expanding_wild,grid_multipliers
forge mechanics --art     cluster_pays,tumble,expanding_wild,grid_multipliers
```

The first reports conflicts with reasons and flags anything the tool cannot generate yet.
The second lists what the art team must produce for that combination — the point being that
choosing mechanics and knowing the art cost are the same action.

Three things bound this, and the tool tells you which one you have hit:

- **17 of 54 catalogued mechanics generate code today.** The rest are labelled `roadmap` or
  `blocked` and `--combine` says so. Picking one means building it.
- **Some pairs genuinely conflict**, and the reason is almost always that two mechanics claim
  the same step of the round. `--combine` names the reason rather than just refusing.
- **A coherent combination can still be a badly balanced game.** Four multiplier mechanics on
  one board reach the cap on every feature. `math:balance` catches that in about a second,
  before a simulation proves it slowly.

## Starting your next game

Nothing here is game-specific. `forge init` into a fresh folder, point `--sdk`/`--math-sdk` at the
same checkouts, give it a new `game.name` and `game.gameId`.
