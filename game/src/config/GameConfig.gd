extends Node
## Central configuration for the whole game.
##
## Everything tunable lives here so systems stay decoupled and you can adjust
## the feel of the game (and the size of your art) in ONE place. Autoloaded as
## `GameConfig` (see project.godot). Access from anywhere, e.g.
## `GameConfig.TILE_SIZE`.

# --- World / room geometry -------------------------------------------------
# One tile is the base world unit. Rooms are a fixed screen of interior tiles
# surrounded by a one-tile wall, in the classic Binding of Isaac 13x7 layout.
const TILE_SIZE: int = 64
const ROOM_TILES_W: int = 13        # interior width in tiles
const ROOM_TILES_H: int = 7         # interior height in tiles
const WALL_TILES: int = 1           # wall thickness around the interior
const DOOR_TILES: int = 2           # width of a door gap, in tiles

# Derived pixel sizes (do not edit; computed from the above).
var room_interior: Vector2 = Vector2(ROOM_TILES_W * TILE_SIZE, ROOM_TILES_H * TILE_SIZE)
var room_full: Vector2 = Vector2((ROOM_TILES_W + WALL_TILES * 2) * TILE_SIZE,
								 (ROOM_TILES_H + WALL_TILES * 2) * TILE_SIZE)

# The camera sits at the room centre and zooms so the room fills the view.
const CAMERA_ZOOM: float = 1.2

# --- Art / sprite pipeline -------------------------------------------------
# Cult of the Lamb-style: smooth, hand-drawn, higher-resolution sprites (NOT
# pixel art). Characters are anchored at the FEET (bottom-centre) so they look
# like they are standing in the room. These are the *display* sizes for the
# placeholder shapes; real art is scaled to match via Assets.gd. See ASSETS.md.
const CHAR_BASE_PX: int = 128       # nominal character sprite size (your export)
var player_radius: float = 26.0     # collision + placeholder radius
var enemy_default_radius: float = 24.0
var boss_radius: float = 70.0
var projectile_radius: float = 9.0
var pickup_radius: float = 18.0

# --- Player base stats -----------------------------------------------------
# Items modify these; changes stack (see StatBlock.gd). Health is measured in
# HALF-hearts (Isaac-style), so 6 == 3 full hearts.
const PLAYER_START_MAX_HEALTH: int = 6      # half-hearts
const PLAYER_BASE_DAMAGE: float = 3.5       # damage per tear
const PLAYER_BASE_TEARS: float = 2.0        # shots per second (fire rate)
const PLAYER_BASE_SHOT_SPEED: float = 520.0 # projectile speed, px/s
const PLAYER_BASE_RANGE: float = 420.0      # projectile travel distance, px
const PLAYER_BASE_MOVE_SPEED: float = 210.0 # px/s

const PLAYER_START_COINS: int = 0
const PLAYER_START_KEYS: int = 1            # enough to open the treasure room
const PLAYER_START_BOMBS: int = 1

const PLAYER_IFRAMES: float = 0.9           # invulnerability after a hit, secs
const SHOOTING_SNAP_TO_4DIR: bool = true    # true = classic 4-directional tears

# --- Combat / misc ---------------------------------------------------------
const BOMB_FUSE: float = 1.4
const BOMB_RADIUS: float = 120.0
const BOMB_DAMAGE: float = 30.0
const BOMB_SELF_DAMAGE: int = 1             # half-hearts if you stand in it
const PICKUP_DROP_CHANCE_ON_CLEAR: float = 0.5

# --- Floor generation ------------------------------------------------------
const FLOOR_GRID: int = 9                   # rooms laid out on a 9x9 cell grid
const ROOMS_MIN: int = 8
const ROOMS_MAX: int = 10
const FLOORS_PER_RUN: int = 1               # Milestone 1 is a single floor

# --- Placeholder colour palette --------------------------------------------
# Muted, storybook-ish tones as a nod to the Cult of the Lamb look. Swap for
# real art any time by dropping files into assets/ (see Assets.gd / ASSETS.md).
const COL_FLOOR := Color("2e2a3d")
const COL_FLOOR_ALT := Color("332f45")
const COL_WALL := Color("15121f")
const COL_DOOR_OPEN := Color("6b5a3e")
const COL_DOOR_CLOSED := Color("3a3348")
const COL_DOOR_LOCKED := Color("c9a227")
const COL_PLAYER := Color("f4e2c8")
const COL_PLAYER_TEAR := Color("8fd6ff")
const COL_ENEMY_TEAR := Color("ff8f6b")
const COL_WANDERER := Color("8f8fb0")
const COL_CHASER := Color("d9564f")
const COL_SHOOTER := Color("6fae7a")
const COL_BOSS := Color("b04fd9")
const COL_ROCK := Color("4a4458")
const COL_HEART := Color("e0405e")
const COL_COIN := Color("f2c14e")
const COL_KEY := Color("d9c46a")
const COL_BOMB := Color("2f2f38")
const COL_TRAPDOOR := Color("111018")
const COL_PEDESTAL := Color("5a5170")

func window_width() -> int:
	return int(ProjectSettings.get_setting("display/window/size/viewport_width", 1280))

func window_height() -> int:
	return int(ProjectSettings.get_setting("display/window/size/viewport_height", 720))

func room_origin() -> Vector2:
	# Top-left of the full room (walls included), keeping the room centred on
	# world origin so the camera can simply sit at (room_full/2).
	return Vector2.ZERO
