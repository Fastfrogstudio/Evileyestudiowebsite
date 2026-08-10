# Asset Guide

This documents exactly what art to export so it drops straight into the game
with **no code changes**. Until a file exists, the game draws a coloured
placeholder shape of the right size, so everything is playable right now.

## Where files go

The Godot **project root is `game/`**, so the engine only sees files under it.
Assets therefore live at:

```
game/assets/
  player/
  enemies/
  items/
  tiles/
  ui/
```

Inside Godot these are addressed as `res://assets/...`. Just drop your PNGs into
the matching folder using the filenames below and reopen the project — Godot
imports them and they replace the placeholders automatically.

## Art style / import settings (Cult of the Lamb-style 2D)

- **Smooth, hand-drawn, high-resolution** art — *not* pixel art. Texture
  filtering is set to **Linear** project-wide (`project.godot` →
  `default_texture_filter=1`), so upscaled art stays soft rather than blocky.
- **Characters are anchored at the feet** (bottom-centre pivot). Draw a
  character standing; the code pins the bottom of the sprite to its world
  position so it "stands" in the room.
- **Export bigger than you need.** Every sprite is scaled *by height* to a
  target on-screen size (below). Exporting at ~2× the target height keeps it
  crisp. Transparent background (PNG with alpha).

## Milestone 1 uses single static PNGs (one frame each)

M1 shows one still frame per entity (a `Sprite2D`). **Animation comes in
Milestone 2.** Before I wire up walk/attack animations I need two numbers from
you per animated sprite: **frame count** and **frames-per-second**, and whether
you'll deliver **horizontal spritesheets** (all frames in a row) or individual
frames. Tell me those and I'll switch the relevant sprites to
`AnimatedSprite2D`/`SpriteFrames` and expose the frame data in config — nothing
is hardcoded yet.

## File list

`Target height` is the on-screen height of the placeholder today; match your
art's silhouette to roughly that proportion. `Suggested export` is ~2× for
crispness. All sizes in pixels; aspect ratio is up to you.

### player/
| File | Target height | Suggested export | Notes |
|------|---------------|------------------|-------|
| `player.png` | ~68 | 128–256 tall | Anchored at feet. |

### enemies/
| File | Target height | Suggested export | Notes |
|------|---------------|------------------|-------|
| `wanderer.png` | ~53 | 96–128 | Anchored at feet. |
| `chaser.png` | ~58 | 96–128 | Anchored at feet. |
| `shooter.png` | ~55 | 96–128 | Anchored at feet. |
| `boss_gluttony.png` | ~168 | 256–512 | Big. Anchored at feet. |
| `tear.png` | ~20 | 48–64 | Hostile projectile (enemy shots). |

### items/
One PNG per item id (matches the `sprite` field in `game/data/items/*.json`).
| File | Target height | Suggested export | Notes |
|------|---------------|------------------|-------|
| `sad_onion.png` | ~42 | 96–128 | Pickup / pedestal icon. |
| `crickets_head.png` | ~42 | 96–128 | |
| `magic_mushroom.png` | ~42 | 96–128 | |
| `the_belt.png` | ~42 | 96–128 | |
| `telescope_lens.png` | ~42 | 96–128 | |
| `tear.png` | ~20 | 48–64 | Friendly projectile (player tears). |
| `heart.png` | ~36 | 64–96 | Health pickup. |
| `coin.png` | ~36 | 64–96 | Currency pickup. |
| `key.png` | ~36 | 64–96 | Key pickup. |
| `bomb.png` | ~40 | 64–96 | Bomb pickup / placed bomb. |

### tiles/
| File | Size | Notes |
|------|------|-------|
| `rock.png` | 64×64 | Destructible obstacle (matches `TILE_SIZE`). |
| `trapdoor.png` | ~90×90 | Appears after the boss dies; step on it to win. |
| `floor.png` *(optional)* | 64×64 | Not wired yet — floor is drawn. Ask and I'll add a TileMap. |
| `wall.png` *(optional)* | 64×64 | Not wired yet — walls are drawn. |

### ui/
The HUD (hearts, coin/key/bomb counts, minimap, boss bar) is currently drawn in
code, so no UI art is required for M1. When you want custom art here — heart
full/half/empty, coin/key/bomb icons, minimap frame — tell me and I'll swap the
drawn HUD for your sprites.

## Adding a new item (no code)

Drop a new JSON file in `game/data/items/`, e.g. `game/data/items/big_book.json`:

```json
{
  "id": "big_book",
  "name": "Big Book",
  "description": "+1 Damage, +40 Range",
  "sprite": "items/big_book.png",
  "price": 20,
  "tags": ["passive"],
  "modifiers": {
    "damage": { "add": 1.0 },
    "range":  { "add": 40.0 }
  }
}
```

Valid stat keys: `max_health`, `damage`, `tears`, `shot_speed`, `range`,
`move_speed`. Each takes `{ "add": x }` and/or `{ "mult": y }`; all held items
stack. Add `items/big_book.png` when ready, or leave it for a placeholder.

## Changing sizes globally

All dimensions, colours and base stats live in
`game/src/config/GameConfig.gd`. Change `TILE_SIZE`, the room tile counts, the
placeholder radii, or the camera zoom there and everything follows.
