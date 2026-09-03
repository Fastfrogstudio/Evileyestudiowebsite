# Mechanics library — what is in it, and where each came from

Generated from `src/lib/mechanicsLibrary.js` by `forge mechanics --doc`. **24 of 56** work today (18 generate code, 6 from a spec setting); 1 adaptable from a shipped math-sdk sample; 26 would have to be built; 5 blocked. 29 reference games indexed.

**Status** — `built` generates code today · `config` works from a spec setting · `sample` adaptable from a shipped math-sdk sample · `roadmap` would be built from primitives · `blocked` engine limit or licence.

Everything here is a plain-language **rule** plus attribution. No studio's assets, bundles, source, sprite data, reel strips or RTP configuration were fetched or inspected. Max-win figures are indicative.

*This file is generated. Edit `src/lib/mechanicsLibrary.js` and re-run `forge mechanics --doc`; a test fails if the two disagree.*

## Win evaluators

| Mechanic | Status | Works on | From these games | What it does |
|---|---|---|---|---|
| **Cluster pays**<br>`cluster_pays` | `config` T0 | cluster | Sugar Rush (Pragmatic Play); Fruit Party (Pragmatic Play); Reactoonz (Play'n GO); Aloha! Cluster Pays (NetEnt); Jammin' Jars (Push Gaming) | Wins are groups of five or more of the same symbol connected orthogonally, anywhere on the grid. Payout scales with GROUP SIZE rather than a count per reel, so the paytable is a range table (5, 6-9, 10-13, 14+) rather than a 3/4/5-of-a-kind row. |
| **Scatter pays (pay anywhere)**<br>`scatter_pays` | `config` T0 | scatter | Sweet Bonanza (Pragmatic Play); Gates of Olympus (Pragmatic Play) | Position is irrelevant: eight or more of a symbol anywhere on the grid pays, by count. The highest hit-rate evaluator in the engine, which makes it the natural choice for the low end of the volatility range. |
| **Ways (243/1024/…)**<br>`ways_pays` | `config` T0 | ways | — | Adjacent from the leftmost reel, any row. Ways are the PRODUCT of matching symbols per reel, so a 5x4 board is 1024 ways where a 5x3 is 243. Payouts are per way, which is why a ways paytable must be scaled to the geometry — a 5x3 paytable on a 5x4 board pays 4.2x too much before anything else is considered. |
| **Paylines**<br>`lines_pays` | `config` T0 | lines | — | Wins run left-to-right along fixed patterns across the reels. The most legible evaluator for a player and the easiest to present, which is why it still carries most hold-and-win and money-symbol games. |

## Round structure

| Mechanic | Status | Works on | From these games | What it does |
|---|---|---|---|---|
| **Tumble / cascade**<br>`tumble` | `built` T2 | cluster, scatter, lines, ways | Sweet Bonanza (Pragmatic Play); Gates of Olympus (Pragmatic Play); Sugar Rush (Pragmatic Play); Fruit Party (Pragmatic Play); Reactoonz (Play'n GO); Aloha! Cluster Pays (NetEnt); Jammin' Jars (Push Gaming); Gonzo's Quest (NetEnt); Samurai Dogs Unleashed (Twist Gaming); Fire in the Hole xBomb (Nolimit City); Bonanza (Big Time Gaming) | Winning symbols are removed, the remainder falls, new symbols drop in, and the board is re-evaluated until no win remains. One round becomes a SEQUENCE of boards, and the win cap is tested against the running round total rather than any single board. |
| **Free spins**<br>`freespins` | `built` T0 | lines, ways, cluster, scatter | Sweet Bonanza (Pragmatic Play); Gates of Olympus (Pragmatic Play); Sugar Rush (Pragmatic Play); Fruit Party (Pragmatic Play); Aloha! Cluster Pays (NetEnt); Gonzo's Quest (NetEnt); Samurai Dogs Unleashed (Twist Gaming); Scroll Keeper (Paperclip Gaming); Big Bass Bonanza (Reel Kingdom / Pragmatic Play); Chaos Crew (Hacksaw Gaming); Razor Shark (Push Gaming); Book of Dead (Play'n GO); Dead or Alive 2 (NetEnt); Bonanza (Big Time Gaming); Jack and the Beanstalk (NetEnt); Mystery Museum (Push Gaming); Big Bass Rock and Roll Enhanced (Pragmatic Play) | Scatters trigger a bounded run of spins on a richer reel set, usually with a mechanic the base game does not have. The default home for every multiplier in the library. |
| **Free spins that reset on a symbol**<br>`freespin_reset` | `built` T2 | lines, ways, cluster, scatter | Scroll Keeper (Paperclip Gaming) | The free-spin counter resets whenever a qualifying symbol lands, so the round ends only after N consecutive spins without one. The hold-and-win respin-reset rule applied to a FREE-SPIN round rather than a separate bet mode — the player watches a countdown that keeps being pushed back rather than ticking down. |
| **Upgrade on retrigger**<br>`retrigger_upgrade` | `roadmap` T1 | lines, ways, cluster, scatter | Big Bass Bonanza (Reel Kingdom / Pragmatic Play); Big Bass Rock and Roll Enhanced (Pragmatic Play) | Each retrigger not only adds spins but improves the feature — the collector multiplier steps up, a symbol is promoted, a meter advances. The Big Bass pattern, and the reason that game feels progressive without any cross-round state. |
| **Selectable feature modes**<br>`multi_mode_feature` | `roadmap` T2 | lines, ways, cluster, scatter | Wanted Dead or a Wild (Hacksaw Gaming); Dead or Alive 2 (NetEnt) | The trigger picks between two or more free-spin variants — more spins with a lower multiplier, or fewer with a higher one, or an entirely different mechanic per mode. One game with three feature identities. |
| **Respin**<br>`respin` | `sample` T2 | lines, ways | Starburst (NetEnt) | A qualifying event holds part of the board and re-spins the rest, without consuming a new bet. |

## Wilds

| Mechanic | Status | Works on | From these games | What it does |
|---|---|---|---|---|
| **Guaranteed wild on every cascade**<br>`guaranteed_wild_per_cascade` | `roadmap` T1 | cluster, scatter | Samurai Dogs Unleashed (Twist Gaming) | At least one of the symbols dropped in by each cascade is a wild. Sustains a cascade sequence without making the strips richer, which keeps the base board honest while the sequence itself becomes the feature. |
| **Expanding wild**<br>`expanding_wild` | `built` T3 | lines, ways | Starburst (NetEnt) | A wild lands and expands to fill its entire reel, staying for the rest of the free-spin round. A fresh multiplier is rolled onto it on each reveal — the wild is sticky, its multiplier is not. |
| **Sticky wild**<br>`sticky_wild` | `built` T3 | lines, ways | Aloha! Cluster Pays (NetEnt); Scroll Keeper (Paperclip Gaming); Mental (Nolimit City); San Quentin xWays (Nolimit City); Wanted Dead or a Wild (Hacksaw Gaming); Dead or Alive 2 (NetEnt); Mystery Museum (Push Gaming) | A wild stays in place for the rest of the round. Coverage accumulates, so late spins are worth far more than early ones — the accumulation IS the mechanic, and it is what lets a plain 5x3 payline game reach six figures. |
| **Walking wild**<br>`walking_wild` | `roadmap` T2 | lines, ways, cluster | Jammin' Jars (Push Gaming); Wanted Dead or a Wild (Hacksaw Gaming); Jack and the Beanstalk (NetEnt) | A wild moves one position per spin and grants a respin each time, until it walks off the board. On a cluster board it can move in any direction and carry a multiplier that grows each time it takes part in a win. |
| **Random / mystery wild**<br>`random_wild` | `roadmap` T1 | lines, ways, cluster | — | Wilds injected at random positions after the spin resolves. |
| **Wild spawner**<br>`wild_spawner` | `roadmap` T1 | cluster, lines, ways | Reactoonz (Play'n GO) | A trigger condition fires extra wilds onto the grid — a charged meter, a symbol landing, a cascade count. |
| **Book-style expanding symbol**<br>`expanding_special_symbol` | `roadmap` T2 | lines | Book of Dead (Play'n GO) | One symbol is chosen at the start of the feature. Whenever it lands it expands to fill its reel and pays as both wild and scatter — position stops mattering for that symbol. |

## Multipliers — the volatility dial

| Mechanic | Status | Works on | From these games | What it does |
|---|---|---|---|---|
| **Multiplier composition (add vs compound)**<br>`multiplier_composition` | `built` T0 | lines, ways, cluster, scatter | — | Not a mechanic so much as a RULE: do two 5x multipliers make 10x or 25x? The engine offers three strategies, and symbol multipliers ALWAYS SUM except on a ways board under the "symbol" strategy, where a multiplier adds its VALUE to that reel's ways count and ways multiply across reels. |
| **Progressive global multiplier**<br>`progressive_global_multiplier` | `built` T0 | lines, ways, cluster, scatter | Samurai Dogs Unleashed (Twist Gaming); Razor Shark (Push Gaming); El Dorado Infinity Reels (ReelPlay) | One number multiplying every win, growing on a trigger — per free spin, per cascade, or per qualifying symbol — and never resetting within the round. Two growth modes: INCREMENT (+1, what the engine does) and DOUBLE (x2), with separate caps for the base game and the feature. Eight winning spins is 8x one way and 256x the other, so the mode is one of the largest volatility dials available. |
| **Per-cascade multiplier ladder**<br>`progressive_cascade_multiplier` | `built` T1 | cluster, scatter | Jammin' Jars (Push Gaming); Gonzo's Quest (NetEnt); Bonanza (Big Time Gaming) | A meter steps up with each successive cascade in one sequence (1x, 2x, 3x, 5x…) and applies to subsequent wins. Resets when the sequence ends. |
| **Persistent position multipliers**<br>`grid_multipliers` | `built` T2 | cluster | Sugar Rush (Pragmatic Play) | Grid POSITIONS activate when a win lands on them and grow on each subsequent hit, capped. Sticky for the round, summed and applied at sequence end. The player reads the board as a heat map rather than a set of symbols. Two growth modes: INCREMENT (+1 per hit, what the shipped sample does) and DOUBLE (x2 per hit, the pattern the mechanic is known for). Nine hits on one cell is 9x one way and 256x the other, so the mode is a large volatility dial in its own right. |
| **Multiplier orbs (pooled)**<br>`multiplier_orbs` | `roadmap` T1 | scatter, cluster | Sweet Bonanza (Pragmatic Play); Gates of Olympus (Pragmatic Play) | Multiplier symbols land anywhere and are POOLED, then applied once at the end of a cascade sequence rather than per cascade. That ordering is the mechanic: applying them per-cascade instead produces a materially different RTP. |
| **Sticky multiplier**<br>`sticky_multiplier` | `built` T1 | lines, ways, cluster | Scroll Keeper (Paperclip Gaming); Wanted Dead or a Wild (Hacksaw Gaming); Chaos Crew (Hacksaw Gaming); Le Bandit (Hacksaw Gaming); Dead or Alive 2 (NetEnt) | A wild locks to its cell for the rest of the round and its multiplier steps up on every subsequent spin, to a cap. Wilds accumulate, so a round that starts rich gets richer — the mechanic is the accumulation, not the individual wild. |
| **Random multiplier drop**<br>`random_multiplier` | `roadmap` T1 | cluster, lines, ways | Fruit Party (Pragmatic Play); Chaos Crew (Hacksaw Gaming) | A multiplier lands on a random cell after the spin resolves, applying to any win it touches. |
| **Bomb symbol raising a multiplier**<br>`xbomb` | `roadmap` T1 | ways, cluster | Fire in the Hole xBomb (Nolimit City) | A bomb symbol destroys its neighbours and raises the round multiplier — a wild and a multiplier trigger in one. |
| **Nudging wild raising a multiplier**<br>`xnudge` | `roadmap` T2 | ways, lines | Mental (Nolimit City); San Quentin xWays (Nolimit City) | An oversized wild nudges fully into view, adding +1 to the round multiplier per row nudged. |

## Hold-and-win family

| Mechanic | Status | Works on | From these games | What it does |
|---|---|---|---|---|
| **Hold and win (resetting respins)**<br>`hold_and_win` | `built` T3 | lines, ways, cluster | Money Train 2 (Relax Gaming); Money Train 4 (Relax Gaming); Lightning Link (Aristocrat) | Its own round with its own loop. A prize symbol lands, locks to its cell, and RESETS the respin counter — that reset is the mechanic. When respins run out, every locked prize on the board pays. |
| **Money / cash symbol**<br>`money_symbol` | `built` T1 | lines, ways, cluster | Big Bass Bonanza (Reel Kingdom / Pragmatic Play); Lightning Link (Aristocrat); Le Bandit (Hacksaw Gaming); Big Bass Rock and Roll Enhanced (Pragmatic Play) | A symbol carrying a cash value that pays directly rather than through the paytable. |
| **Collector**<br>`collector_symbol` | `built` T1 | lines, ways, cluster | Money Train 2 (Relax Gaming); Money Train 4 (Relax Gaming); Big Bass Bonanza (Reel Kingdom / Pragmatic Play); Le Bandit (Hacksaw Gaming); Big Bass Rock and Roll Enhanced (Pragmatic Play) | A symbol that sweeps every visible money value into itself and pays the total. |
| **Payer**<br>`payer_symbol` | `built` T1 | lines, ways, cluster | Money Train 2 (Relax Gaming); Money Train 4 (Relax Gaming) | A symbol that ADDS its value to every other money value on screen — the inverse of a collector. |
| **Special symbol taxonomy**<br>`special_symbol_roles` | `roadmap` T2 | lines, ways, cluster | Money Train 2 (Relax Gaming); Money Train 4 (Relax Gaming) | Not one mechanic but a PATTERN: define a set of symbol roles (collector, payer, sniper, reviver, multiplier) each with a small rule, and let the interactions carry the game. The Money Train school. |
| **Fixed prize tiers (Mini / Minor / Major / Grand)**<br>`prize_tiers` | `config` T0 | lines, ways, cluster | Lightning Link (Aristocrat) | A fixed ladder of named awards, typically around 20x / 50x / 200x / 500x. |
| **In-round grid growth**<br>`grid_expansion` | `roadmap` T3 | lines, ways, cluster | Money Train 4 (Relax Gaming); Fire in the Hole xBomb (Nolimit City) | Filling a column or hitting a trigger opens more rows or reels, mid-round. |

## Symbol behaviour

| Mechanic | Status | Works on | From these games | What it does |
|---|---|---|---|---|
| **Mystery symbol**<br>`mystery_symbol` | `roadmap` T1 | lines, ways, cluster | Mystery Museum (Push Gaming) | Placeholder symbols land, then all reveal simultaneously as one randomly chosen type. |
| **Mystery stack**<br>`mystery_stack` | `roadmap` T1 | ways, lines | Razor Shark (Push Gaming) | A full or partial reel of covered symbols revealing as one type — the stacked form of a mystery symbol. |
| **Nudging reel**<br>`nudging_reel` | `roadmap` T2 | ways, lines | Razor Shark (Push Gaming) | A partially visible stack nudges up or down until it is fully in view, often granting a respin. |
| **Symbol upgrade**<br>`symbol_upgrade` | `roadmap` T1 | lines, ways, cluster | Jack and the Beanstalk (NetEnt) | Low-paying symbols are promoted to high-paying ones, permanently for the round or for one spin. |
| **Symbol conversion**<br>`symbol_transform` | `roadmap` T1 | cluster, scatter, lines, ways | Reactoonz (Play'n GO); Mental (Nolimit City) | Every instance of one symbol type becomes another, manufacturing a win that was not there. |
| **Colossal symbol**<br>`colossal_symbol` | `built` T3 | ways, lines | — | A symbol occupying an NxN block, counting as N separate symbols in each cell it covers. |
| **Split symbol**<br>`split_symbol` | `roadmap` T2 | ways | — | A symbol splits every other symbol it touches into two, doubling the effective ways count per split reel. A very cheap route to enormous ways counts without variable reel heights. |
| **Paying scatter**<br>`paying_scatter` | `config` T0 | lines, ways, cluster, scatter | — | The trigger scatter also awards an instant prize when it lands in sufficient numbers. |
| **Blocker cells**<br>`blocker_cell` | `roadmap` T1 | cluster, scatter | — | Inert cells that pay nothing and are removable only by an adjacent win, opening space as the round goes. |
| **Charge meter**<br>`charge_meter` | `roadmap` T2 | cluster, scatter | Reactoonz (Play'n GO) | A meter fills from qualifying wins and fires escalating board-wide effects at thresholds. Resets at round end, so it holds no cross-round state. |
| **Symbol collection**<br>`symbol_collect` | `roadmap` T1 | cluster, scatter, lines, ways | Aloha! Cluster Pays (NetEnt) | Collecting N instances of a symbol within the round awards a feature or a prize. |
| **Persistent symbol**<br>`persistent_symbol` | `roadmap` T2 | cluster, scatter, ways, lines | Money Train 2 (Relax Gaming); Fire in the Hole xBomb (Nolimit City) | A symbol that survives cascades or spins within a round while everything around it is replaced. |
| **Splitting symbol**<br>`xsplit` | `roadmap` T2 | ways | San Quentin xWays (Nolimit City) | See split_symbol — recorded here so the trademarked name resolves to the generic mechanic. |

## Bet level

| Mechanic | Status | Works on | From these games | What it does |
|---|---|---|---|---|
| **Bonus buy**<br>`buy_bonus` | `built` T0 | lines, ways, cluster, scatter | Sweet Bonanza (Pragmatic Play); Gates of Olympus (Pragmatic Play); Sugar Rush (Pragmatic Play); Scroll Keeper (Paperclip Gaming); Money Train 2 (Relax Gaming); Money Train 4 (Relax Gaming); Big Bass Bonanza (Reel Kingdom / Pragmatic Play); Mental (Nolimit City); Fire in the Hole xBomb (Nolimit City); Wanted Dead or a Wild (Hacksaw Gaming); Chaos Crew (Hacksaw Gaming); Le Bandit (Hacksaw Gaming) | Pay a multiple of the stake to enter the feature immediately. |
| **Tiered buy menu**<br>`tiered_buy_menu` | `roadmap` T0 | lines, ways, cluster, scatter | — | Several priced entry points, each configuring the feature differently. |
| **Ante bet**<br>`ante_bet` | `roadmap` T0 | lines, ways, cluster, scatter | Sweet Bonanza (Pragmatic Play); Gates of Olympus (Pragmatic Play) | Pay roughly 1.25x the stake for roughly double the feature trigger frequency. |
| **Win cap**<br>`wincap` | `built` T0 | lines, ways, cluster, scatter | — | A ceiling on what one round can pay. Also re-bands the win-level presentation tiers, so raising it changes which banner a given win shows. |
| **Pays both ways**<br>`both_ways` | `built` T1 | lines | Starburst (NetEnt) | Lines pay from the leftmost reel AND from the rightmost. Costs no engine change: a right-to-left win on a pattern IS a left-to-right win on that pattern reversed, so the mirrored patterns are simply appended to the payline table. How much it is worth depends entirely on how asymmetric the existing line set is — see math.notes before treating it as a hit-rate lever. |

## Blocked — engine limit or licence

| Mechanic | Status | Works on | From these games | What it does |
|---|---|---|---|---|
| **Variable reel heights**<br>`megaways` | `blocked` T3 | ways | Bonanza (Big Time Gaming) | Each reel draws a random number of rows every spin, so the ways count changes spin to spin. |
| **Reels added while wins continue**<br>`infinity_reels` | `blocked` T3 | ways | El Dorado Infinity Reels (ReelPlay) | Each win adds a reel to the right, extending the board until a spin fails to win. |
| **Symbol revealing a variable stack**<br>`xways` | `blocked` T3 | ways | Mental (Nolimit City); San Quentin xWays (Nolimit City) | A special symbol reveals as a stack of 2 to 12 of one type, changing the ways count that spin. |

## Deliberately not building

| Mechanic | Status | Works on | From these games | What it does |
|---|---|---|---|---|
| **Network progressive jackpot**<br>`network_jackpot` | `blocked` T3 | any | — | A prize pool accumulating across players and games. |
| **Gamble / double-up**<br>`gamble` | `blocked` T2 | any | — | Stake a win on a coin flip or card draw to double it. |

## Reference games indexed

| Game | Studio | Max win | Mechanics it is indexed under |
|---|---|---|---|
| Sweet Bonanza | Pragmatic Play | 21,100x | tumble, scatter_pays, multiplier_orbs, freespins, buy_bonus, ante_bet |
| Gates of Olympus | Pragmatic Play | 5,000x | tumble, scatter_pays, multiplier_orbs, freespins, buy_bonus, ante_bet |
| Sugar Rush | Pragmatic Play | 5,000x | tumble, cluster_pays, grid_multipliers, freespins, buy_bonus |
| Fruit Party | Pragmatic Play | 5,000x | tumble, cluster_pays, random_multiplier, freespins |
| Reactoonz | Play'n GO | 4,570x | tumble, cluster_pays, charge_meter, symbol_transform, wild_spawner |
| Aloha! Cluster Pays | NetEnt | 1,000x | tumble, cluster_pays, symbol_collect, sticky_wild, freespins |
| Jammin' Jars | Push Gaming | 20,000x | tumble, cluster_pays, walking_wild, progressive_cascade_multiplier |
| Gonzo's Quest | NetEnt | 2,500x | tumble, progressive_cascade_multiplier, freespins |
| Samurai Dogs Unleashed | Twist Gaming | — | tumble, progressive_global_multiplier, freespins, guaranteed_wild_per_cascade |
| Scroll Keeper | Paperclip Gaming | 5,000x | sticky_wild, freespin_reset, sticky_multiplier, freespins, buy_bonus |
| Money Train 2 | Relax Gaming | 50,000x | hold_and_win, special_symbol_roles, collector_symbol, payer_symbol, persistent_symbol, buy_bonus |
| Money Train 4 | Relax Gaming | 150,000x | hold_and_win, special_symbol_roles, collector_symbol, payer_symbol, grid_expansion, buy_bonus |
| Big Bass Bonanza | Reel Kingdom / Pragmatic Play | 4,000x | collector_symbol, money_symbol, freespins, retrigger_upgrade, buy_bonus |
| Lightning Link | Aristocrat | 2,000x | hold_and_win, money_symbol, prize_tiers |
| Mental | Nolimit City | 66,666x | xways, xnudge, sticky_wild, symbol_transform, buy_bonus |
| Fire in the Hole xBomb | Nolimit City | 60,000x | xbomb, tumble, grid_expansion, persistent_symbol, buy_bonus |
| San Quentin xWays | Nolimit City | 150,000x | xways, xnudge, xsplit, sticky_wild |
| Wanted Dead or a Wild | Hacksaw Gaming | 12,500x | multi_mode_feature, sticky_wild, walking_wild, sticky_multiplier, buy_bonus |
| Chaos Crew | Hacksaw Gaming | 10,000x | sticky_multiplier, random_multiplier, freespins, buy_bonus |
| Le Bandit | Hacksaw Gaming | 10,000x | money_symbol, collector_symbol, sticky_multiplier, buy_bonus |
| Razor Shark | Push Gaming | 50,000x | mystery_stack, nudging_reel, progressive_global_multiplier, freespins |
| Book of Dead | Play'n GO | 5,000x | expanding_special_symbol, freespins |
| Dead or Alive 2 | NetEnt | 111,111x | sticky_wild, multi_mode_feature, sticky_multiplier, freespins |
| Starburst | NetEnt | 500x | expanding_wild, respin, both_ways |
| Bonanza | Big Time Gaming | 12,000x | megaways, tumble, progressive_cascade_multiplier, freespins |
| Jack and the Beanstalk | NetEnt | 600x | walking_wild, freespins, symbol_upgrade |
| Mystery Museum | Push Gaming | 10,000x | mystery_symbol, sticky_wild, freespins |
| El Dorado Infinity Reels | ReelPlay | — | infinity_reels, progressive_global_multiplier |
| Big Bass Rock and Roll Enhanced | Pragmatic Play | 5,000x | collector_symbol, money_symbol, freespins, retrigger_upgrade |

## Studios shipping on Stake Engine itself

These ship on the Engine itself, so their titles are the closest thing to a
reference for what it actually supports.

- **Twist Gaming** — Samurai Dogs Unleashed, Serpentina
- **Massive Studios** — Jawsome
- **Titan Gaming**
- **Mirror Image Gaming**
- **Paperclip Gaming**
