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

## Workflow

```
inspiration.yaml ──forge inspire──> game-spec.yaml ──┬──forge math:scaffold──> math-sdk/games/<game_id>
                                                     └──forge scaffold───────> web-sdk/apps/<name>
     forge art:placeholder ──> stand-in symbol tiles, so it renders on day one
                    assets-manifest.yaml ──forge audit──> gaps, before anything is written
                                         ──forge assets:import──> your art, wired in
                                                          forge verify ──> proof it runs
```

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

- **It does not generate math or RTP.** The reel strips written by `math:scaffold` and the
  `paddingReels` written by `scaffold` are deterministic placeholders so both SDKs can run
  immediately. Real strips, weights and RTP come from a math-sdk optimisation run
  (`python games/<game_id>/run.py`).
- **It does not tune bet-mode distributions.** The generated `BetMode` blocks carry the minimum
  distributions that let `create_books()` run. Balancing quotas is a math job.
- **It does not replace design work.** It gets you to "the game runs in storybook with my art and my
  paytable, and the math simulates end-to-end". Win presentation and bonus screens are still yours.

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
| `forge assets:import --manifest <yaml> --sdk <path> --game <name> [--spec <yaml>]` | Copy + wire your art |
| `forge verify --spec <yaml> [--math-sdk <path>] [--sdk <path>] [--skip-spin]` | Run the generated output for real |

## Tests

```bash
npm test                                              # unit tests, no SDK needed
npm run test:e2e -- --math-sdk ../math-sdk --sdk ../web-sdk   # real scaffold + run + typecheck
```

The e2e run covers all four mechanics on both sides, and asserts that `expanding` is *refused* on
tumbling mechanics as loudly as it asserts the successes.

## Starting your next game

Nothing here is game-specific. `forge init` into a fresh folder, point `--sdk`/`--math-sdk` at the
same checkouts, give it a new `game.name` and `game.gameId`.
