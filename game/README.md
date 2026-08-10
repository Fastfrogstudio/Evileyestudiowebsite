# Untitled Roguelike — Milestone 1 (vertical slice)

A top-down, room-based roguelike in the style of *The Binding of Isaac*, built
in **Godot 4 (GDScript)**. Cult of the Lamb-style 2D art pipeline: smooth,
hand-drawn, high-resolution sprites loaded from `assets/` — with coloured
placeholder shapes standing in until your art arrives.

## Run it

1. Install **Godot 4.3+** (standard, GDScript build).
2. Open Godot → *Import* → select `game/project.godot`.
3. Press **F5** (Play).

There is no build step and no C#/Mono requirement.

## Controls

| Action | Keyboard | Gamepad |
|--------|----------|---------|
| Move | WASD | Left stick |
| Shoot (4-directional "tears") | Arrow keys | Right stick |
| Place bomb | E | X / Square |
| Confirm / Start | Enter / Space | A / Cross |
| Return to title (end screen) | Enter / R | A / Y |

## The loop (Milestone 1 scope)

Title → generate one floor (8–10 rooms, incl. a treasure room, a shop, and a
boss room) → clear rooms (doors bar while enemies live, open when cleared) →
beat the boss → step on the trapdoor → **Victory**. Dying ends the run
(permadeath) → **You Died** → back to the title. Each run regenerates the floor.

Included: player movement + shooting wired to a stat system, 3 enemy types
(wanderer / chaser / shooter) + a 2-phase boss, 5 data-driven items, heart /
coin / key / bomb pickups, destructible rocks, and a HUD with hearts, counts,
a minimap and a boss bar.

## Architecture (decoupled systems)

Nothing references anything directly; systems talk through the `Events` signal
bus and read/write shared run state in `GameState`. Most scenes are built in
code (self-constructing nodes), so there are very few `.tscn` files to hand-edit.

```
game/
  project.godot                 Autoloads, display, input filter
  scenes/Main.tscn|.gd          Flow: Title -> Play -> End -> Title
  src/
    config/GameConfig.gd        ALL tunables: sizes, colours, base stats
    autoload/
      Events.gd                 Global signal bus
      Controls.gd               Input actions (keyboard + gamepad), set in code
      GameState.gd              Run state: stats, health, inventory, floor, rooms
    util/
      Assets.gd                 Loads res://assets/... or falls back to shapes
      Placeholder.gd            The coloured placeholder shape
    systems/
      stats/StatBlock.gd        Base stats + stacking item modifiers
      items/ItemData.gd|ItemDB  Data-driven items (game/data/items/*.json)
      enemies/                  Enemy base + Wanderer/Chaser/Shooter/Boss + EnemyDB
      combat/Projectile.gd      Tears (friendly + hostile)
      pickups/                  Pickup, ItemPedestal, Rock
      bombs/Bomb.gd             Placed bombs
      floor/                    RoomModel, FloorModel, FloorGenerator (documented)
    actors/Player.gd            Movement, shooting, bombs, contact damage
    world/
      RoomInstance.gd           Walls, doors (bar/open/lock), room population
      GameWorld.gd              Player + camera + room transitions
    ui/                         HUD, HeartsBar, Minimap, TitleScreen, EndScreen
  data/
    items/*.json                One file per item
    enemies/*.json              One file per enemy type
    spawns.json                 Enemy layouts per room type
assets/                         Your art (see ../ASSETS.md)
```

### Extending without rewrites
- **New item:** drop a JSON in `game/data/items/` (see `ASSETS.md`).
- **New enemy:** drop a JSON in `game/data/enemies/`; reuse an `ai` behaviour or
  add one small subclass and map it in `EnemyDB`.
- **Room difficulty / layouts:** edit `game/data/spawns.json`.
- **Feel / sizes / colours:** `game/src/config/GameConfig.gd`.

## Notes / known scope limits (by design for M1)
- Sprites are single static frames; animation (spritesheets + frame counts) is
  Milestone 2 — see `ASSETS.md`.
- Enemy "pathfinding" is direct steering (rooms are open boxes).
- Floor/wall tiles are drawn, not a TileMap yet.
