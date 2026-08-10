class_name RoomModel
extends RefCounted
## Pure data describing one room in the floor graph (no scene, no visuals).
## The runtime RoomInstance is built from this when the player enters.

enum Type { START, NORMAL, TREASURE, BOSS, SHOP }

# The four cardinal directions as grid offsets.
const N := Vector2i(0, -1)
const S := Vector2i(0, 1)
const W := Vector2i(-1, 0)
const E := Vector2i(1, 0)
const DIRS := [N, S, W, E]

var cell: Vector2i
var type: int = Type.NORMAL
var connections: Dictionary = {}   # Vector2i dir -> RoomModel neighbour
var cleared: bool = false          # enemies defeated (doors open)
var visited: bool = false          # player has been inside
var discovered: bool = false       # shown on the minimap
var distance: int = 0              # BFS steps from the start room
var extra: Dictionary = {}         # per-room persistent flags (reward id, shop stock, ...)

func _init(p_cell: Vector2i = Vector2i.ZERO, p_type: int = Type.NORMAL) -> void:
	cell = p_cell
	type = p_type

func connect_to(other: RoomModel, dir: Vector2i) -> void:
	connections[dir] = other

func has_door(dir: Vector2i) -> bool:
	return connections.has(dir)

func door_dirs() -> Array:
	return connections.keys()

func is_special() -> bool:
	return type == Type.TREASURE or type == Type.BOSS or type == Type.SHOP

func spawns_enemies() -> bool:
	return type == Type.NORMAL or type == Type.BOSS
