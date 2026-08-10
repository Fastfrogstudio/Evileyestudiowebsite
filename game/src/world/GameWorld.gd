class_name GameWorld
extends Node2D
## Owns the live run: one persistent Player and Camera, and a single current
## RoomInstance that is rebuilt on every door transition. Because every room is
## drawn at the origin, the camera simply sits at the room centre and never
## moves — rooms swap underneath it, Isaac-style.
##
## GameState.start_run() must be called before this node enters the tree.

var _room_holder: Node2D
var _room: RoomInstance
var _player: Player
var _camera: Camera2D

func _ready() -> void:
	_room_holder = Node2D.new()
	add_child(_room_holder)

	_player = Player.new()
	add_child(_player)

	_camera = Camera2D.new()
	_camera.zoom = Vector2(GameConfig.CAMERA_ZOOM, GameConfig.CAMERA_ZOOM)
	_camera.position = GameConfig.room_full * 0.5
	add_child(_camera)
	_camera.make_current()

	Events.floor_descended.connect(_on_floor_descended)

	_enter_room(GameState.current_cell, Vector2i.ZERO)

func _on_floor_descended(_n: int) -> void:
	# A new floor was generated; drop the player into its start room.
	_enter_room(GameState.current_cell, Vector2i.ZERO)

func _enter_room(cell: Vector2i, travel_dir: Vector2i) -> void:
	GameState.enter_room(cell)

	if _room != null and is_instance_valid(_room):
		_room.queue_free()
	_room = RoomInstance.new().setup(GameState.current_room())
	_room_holder.add_child(_room)
	_room.exit_requested.connect(_on_exit_requested)

	_place_player(travel_dir)

func _on_exit_requested(travel_dir: Vector2i) -> void:
	var dest: Vector2i = GameState.current_cell + travel_dir
	if GameState.floor_model.get_room(dest) == null:
		return
	_enter_room(dest, travel_dir)

## Position the player at the door they entered through (opposite the travel
## direction), or in the centre when spawning fresh.
func _place_player(travel_dir: Vector2i) -> void:
	var center := GameConfig.room_full * 0.5
	if travel_dir == Vector2i.ZERO:
		_player.global_position = center
		return
	var entry_side := Vector2(-travel_dir.x, -travel_dir.y)
	var half := GameConfig.room_interior * 0.5
	var margin := GameConfig.WALL_TILES * GameConfig.TILE_SIZE \
		+ GameConfig.player_radius + 24.0
	_player.global_position = center + entry_side * (half - Vector2(margin, margin))
	# Keep the player on the doorway centre-line of the wall they came in on.
	if travel_dir.x != 0:
		_player.global_position.y = center.y
	else:
		_player.global_position.x = center.x
