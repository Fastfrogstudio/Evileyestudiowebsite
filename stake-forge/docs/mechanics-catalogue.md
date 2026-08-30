# Slot mechanics catalogue

Research reference for deciding what stake-forge should build next. **Nothing in this
document is implemented** unless the Status column says so — this is a roadmap, not a
feature list.

## How to read this

**Status**
- `BUILT` — generates code today, verified by running it
- `CONFIG` — works via spec settings; the SDK already implements it
- `SAMPLE` — a math-sdk sample implements it, so it is adaptable at Tier A confidence
- `ROADMAP` — no sample; would be built from engine primitives and verified by execution

**Difficulty**
- `T0` config only · `T1` board post-processor · `T2` round-loop orchestration ·
  `T3` needs a new win-evaluation engine

**Sourcing.** Mechanic descriptions were gathered from public marketing pages, review sites
and vendor documentation as plain-language rules. No game assets, bundles, source or sprite
data were fetched or inspected from any studio. Branded names are attributed to their owners
and flagged; they are not ours to use.

## Trademark and patent flags — read before scoping

- **Megaways, Megaclusters, Megaquads, Megapays** — Big Time Gaming. Megaways carries a
  **US patent**, not just a trademark. This is the one item where the underlying mechanic
  itself may be blocked. Legal review before any engineering.
- **xWays, xNudge, xSplit, xBomb, xPays** — Nolimit City trademarks.
- **Infinity Reels** (ReelPlay) · **DuelReels** (Hacksaw) · **X-iter** (ELK) ·
  **Dream Drop** (Relax) · **Jackpot King** (Blueprint) · **Daily Drop** (Red Tiger) ·
  **Avalanche** (NetEnt) · **Swooping Reels** (Quickspin).

Trademarks bite on *names and presentation*. Build the mechanic, use our own name and our
own art. **This is not legal advice.**

---

## What is built today

| Mechanic | Status | From | What it does |
|---|---|---|---|
| **Expanding wild** | `BUILT` | `0_0_expwilds` | A wild lands, expands to fill its whole reel, and stays for the rest of the free-spin round. Re-rolls a fresh multiplier on every reveal — the wild is sticky, its multiplier is not. Gated to lines/ways: on a tumbling board the cascade wipes the expansion. |
| **Hold-and-win (sticky prize)** | `BUILT` | `0_0_expwilds` superspin | Its own bet mode with its own loop. A prize symbol lands, locks to its cell, and **resets the respin counter** — that reset is the mechanic. When respins run out, every locked prize on the board pays. Verified on lines. |
| Free spins | `CONFIG` | all samples | Scatter-triggered round, usually on a richer reel set. Retrigger supported. |
| Global multiplier | `CONFIG` | `0_0_cluster`, `0_0_scatter` | One number multiplying all wins; increments per free spin or per cascade. |
| Tumble / cascade | `CONFIG` | `0_0_cluster`, `0_0_scatter` | Winning symbols removed, remainder falls, new symbols drop, re-evaluate until no win. `src/calculations/tumble.py` references no win type, so it is engine-agnostic — **but no shipped sample pairs it with lines or ways.** |
| Win cap | `CONFIG` | all samples | Round payout ceiling. Also re-bands win-level presentation tiers. |

---

## Next up — adaptable from samples we already have (Tier A)

| Mechanic | From | What it does | Difficulty |
|---|---|---|---|
| **Persistent position multipliers** | `0_0_gold_rush` | Grid positions activate when a win lands on them, then **double** on each subsequent hit (capped at 512x). Sticky for the round; summed and applied at sequence end. The Sugar Rush pattern. Needs cluster/scatter + cascade — spot multipliers do nothing without repeat visits. | T2 |
| **Multiplier composition** | `0_0_lines` (adds) / `0_0_ways` (multiplies) | Not a mechanic so much as a *rule*: do multipliers add or multiply? Two 5x wilds are 10x or 25x. **This is the single highest-leverage volatility dial and both patterns already exist in our samples.** | T1 |

---

## Roadmap — no sample, build from primitives (Tier B)

Ordered by value per unit of effort.

### Hold-and-win family
- **Resetting respins with collectors and payers** — a collector sweeps all visible cash
  values; a payer adds its value to every other on-screen value. Order of operations moves
  RTP by whole percentage points and must be fixed and documented.
- **Fixed prize tiers** (Mini/Minor/Major/Grand, typically 20x/50x/200x/500x) — lowers
  volatility by adding a floor. Just payout values; cheap.
- **In-round grid unlock** — filling a column opens more rows. Hazard: adding rows at the
  bottom shifts every locked cell's `(reel,row)` index. Lock by identity, not position.

### Wild variants — cheap breadth
- **Sticky wild** — stays for the whole round; coverage accumulates so late spins are worth
  far more.
- **Walking wild** — moves one reel per spin granting a respin, until it exits. *Incompatible
  with cascades*: "one step per spin" is undefined when a spin contains eight cascade steps.
- **Random/mystery wild** — injected at random positions after the spin resolves. **Lowers**
  volatility and raises hit rate — a lever for the low end, counterproductive above 10,000x.
- **Wild spawner** — a trigger fires extra wilds onto the grid.

### Cascade family
- **Per-cascade progressive multiplier** — a meter increments with each successive cascade
  (1x, 2x, 3x, 5x...) applied to subsequent wins.
- **Cascading paylines / ways** — the maths layer is engine-agnostic and already present; no
  sample pairs it with lines or ways, so this is build-and-verify, not copy.
- **Blocker cells** — inert cells removable only by adjacent wins, opening space. Delays the
  payoff, raising volatility.

### Symbol behaviour
- **Mystery symbols** — placeholders revealing simultaneously as one random symbol type.
- **Symbol upgrade** — low-pays promoted to high-pays.
- **Symbol trade/conversion** — all of one symbol type becomes another to manufacture a win.
  Lowers volatility.
- **Paying scatter** — the trigger scatter also awards an instant prize.

### Bet-level — nearly free, first-class on Stake
- **Tiered buy menu** — several priced entry modes, each configuring the round differently.
- **Ante bet** — pay ~1.25x for roughly double trigger frequency.

---

## Deliberately not building

| | Why |
|---|---|
| Network progressive jackpots | Needs cross-player state. The books + lookup-table contract has nowhere to hold it. |
| Must-drop / time-bounded jackpots | Platform-level, cross-game. Same problem. |
| Gamble / double-up | Reportedly prohibited on Stake; also cross-round. |
| Any cross-round meter | Stake games are stateless per round. Keep every meter inside one round. |
| Megaways-class variable reel heights | `num_rows` is a static array read at board creation (`board.py:26,41,89`) — needs engine work in **both** SDKs. Plus the BTG patent. |

**Confirm the Stake prohibitions directly** — they come from secondary sources, not the
official docs I could read.

---

## Combination rules

Almost every mechanic conflict reduces to **two mechanics claiming the same step in the
round pipeline**, or **one assuming a board invariant another violates**:

```
generate board → mutate board → evaluate wins → apply multipliers
    → dispose of winners (remove / lock / persist) → refill → repeat or end
```

Our own empirically-found bug is exactly this: expanding wilds write at *mutate* time and
assume the board persists; tumbling owns *dispose + refill* and redraws it. Nobody told the
expanded wild whether it was a win participant or furniture.

**The general fix** — and the prerequisite for most of the roadmap above — is to make every
board-writing mechanic declare a **lifetime** (`this-evaluation`, `this-cascade-sequence`,
`this-round`, `until-consumed`) and have the cascade disposal step honour it.

### Known conflicts

| Pairing | Verdict | Why |
|---|---|---|
| Expanding wild + tumble | **needs sequencing** | Our known bug. Anchor the expansion for the cascade sequence and refill around it. |
| Sticky wild + tumble | **needs sequencing** | Same, plus gravity: falling symbols must stack above a sticky cell, not through it. |
| Walking wild + tumble | **incompatible** | "One step per spin" is undefined inside a multi-step cascade. |
| Hold-and-win + tumble | **incompatible in one phase** | Both own disposal and give opposite instructions — lock what landed vs remove what won. Fine as *separate phases*. |
| Scatter-pays + any wild | **pointless** | Scatter-pays counts instances with no positional requirement, so a substituting wild has nothing to bridge. |
| Cluster + ways | **incompatible** | Orthogonal adjacency vs reel adjacency. Double-pays overlapping sets. |
| Variable heights + cluster | **incompatible** | Cluster adjacency needs a regular lattice. |
| Global multiplier + pooled orbs | **needs sequencing** | `(win × Σorbs) × global` vs `win × (Σorbs × global)` give very different RTPs. Pick one, document it, golden-master test it. |
| Compounding multipliers + win cap | **RTP distortion risk** | If the multiplier tail routinely exceeds the cap, the cap silently truncates RTP. Model the cap inside the simulation. |

### Clean pairings, proven by shipped games
Cluster + tumble · scatter-pays + tumble · hold-and-win + scatter-pays · variable heights +
ways · split symbols + ways · colossal + ways · blockers + cluster + cascade.

---

## Volatility levers

| Tier | Target max win | Reach for |
|---|---|---|
| **Low** | 300–2,000x | High hit-rate evaluator (scatter-pays at a low threshold); tumbling; random/mystery wilds; symbol conversion; flat paytables; **additive, capped** multipliers only; fixed prize tiers as a floor |
| **Medium** | 3,000–10,000x | Single-tier free spins; hold-and-win with fixed tiers; sticky and expanding wilds; capped retriggers; collectors with a bounded ladder |
| **High** | 10,000–50,000x | Per-cascade progressive multipliers; doubling position multipliers; accumulating sticky wilds; grid growth; pooled orbs; paying scatters |
| **Extreme** | 50,000x+ | **Multiplicative** multiplier composition; uncapped in-round global multipliers; unlimited retriggers; simultaneous grid *and* multiplier growth |

**The single dial**: change how multipliers compose. Additive for low/medium, multiplicative
for high/extreme. Both patterns exist in our samples — you can span most of the range without
building a single new mechanic.

### Three constraints bounding the extreme end

1. **Max win must be obtainable at ≥1-in-20,000,000.** Derived independently two ways:
   `docs/math_docs/gamestate_section/repeat_info.md:12` gives 1% of RTP at 5000x = 1-in-500k,
   and `0_0_lines/game_optimization.py` asks for `rtp=0.001, av_win=5000` = 1-in-5M. The
   formula is `hit_rate = max_win / rtp_allocated`. 100,000x at 0.5% RTP = exactly 1-in-20M.
2. **No gaps in the win range.** Extreme designs go bimodal — nothing, then everything. You
   must deliberately engineer intermediate outcomes.
3. **The win cap silently truncates.** Simulate with it applied or reported RTP will be wrong.

---

## Low-cost distinctive combinations

Worth building because they reuse what we already have:

- **Anchored expanding wilds on a tumbling ways board** — fixes our known bug and turns it
  into a feature: the wild survives cascades and gains +1x per cascade it outlives.
- **Cluster-adjacency hold-and-win** — during the respin phase, orthogonally adjacent locked
  coins *multiply each other*. The player is placing coins, not just collecting them. Reuses
  our cluster adjacency code inside a hold-and-win phase.
- **Guaranteed-cluster low-volatility tumbler** — every spin guarantees a qualifying cluster,
  flat paytable, no multiplier tail. **The low end of the range is under-served and this is
  nearly free** given cluster + tumble already work.
- **Column-local hold-and-win inside a cascade game** — filling one column triggers a mini
  hold-and-win on that column only. Separates the two conflicting mechanics in *space*
  rather than time.
