class_name RoomInstance
extends Node2D
## The runtime view of one RoomModel: floor + walls drawn, doors as barriers
## and triggers, and enemies/pickups/items spawned per room type.
##
## Doors are BARRED while enemies live, OPEN once the room is cleared, and
## LOCKED (needs a key) when they lead into a treasure room. Walking into an
## open door emits exit_requested(dir); GameWorld handles the transition.

signal exit_requested(dir)

var room: RoomModel

var _full: Vector2
var _wall_t: float
var _door_w: float
var _interior: Rect2
var _center: Vector2

var _alive: int = 0
var _barriers: Dictionary = {}     # dir -> StaticBody2D
var _rng := RandomNumberGenerator.new()

# Spawn layouts are loaded once and shared by every room.
static var _spawns: Dictionary = {}

func setup(p_room: RoomModel) -> RoomInstance:
	room = p_room
	return self

func _ready() -> void:
	add_to_group("room_root")
	_rng.randomize()
	_full = GameConfig.room_full
	_wall_t = GameConfig.WALL_TILES * GameConfig.TILE_SIZE
	_door_w = GameConfig.DOOR_TILES * GameConfig.TILE_SIZE
	_interior = Rect2(Vector2(_wall_t, _wall_t), GameConfig.room_interior)
	_center = _full * 0.5
	_load_spawns()

	_build_walls()
	_build_doors()
	_populate()
	_refresh_doors()
	queue_redraw()

# --- Geometry --------------------------------------------------------------
func _gap_rect(dir: Vector2i) -> Rect2:
	var cx := _full.x * 0.5
	var cy := _full.y * 0.5
	if dir == RoomModel.N:
		return Rect2(cx - _door_w * 0.5, 0, _door_w, _wall_t)
	if dir == RoomModel.S:
		return Rect2(cx - _door_w * 0.5, _full.y - _wall_t, _door_w, _wall_t)
	if dir == RoomModel.W:
		return Rect2(0, cy - _door_w * 0.5, _wall_t, _door_w)
	return Rect2(_full.x - _wall_t, cy - _door_w * 0.5, _wall_t, _door_w)  # E

## Solid wall rectangles (bands minus any door gaps). Used for collision + draw.
func _solid_wall_rects() -> Array:
	var rects: Array = []
	var w := _full.x
	var h := _full.y

	# Top / bottom bands span the full width (corners included).
	for is_top in [true, false]:
		var y := 0.0 if is_top else h - _wall_t
		var dir := RoomModel.N if is_top else RoomModel.S
		if room.has_door(dir):
			var g := _gap_rect(dir)
			rects.append(Rect2(0, y, g.position.x, _wall_t))
			rects.append(Rect2(g.end.x, y, w - g.end.x, _wall_t))
		else:
			rects.append(Rect2(0, y, w, _wall_t))

	# Left / right bands span only the middle so they don't overlap corners.
	for is_left in [true, false]:
		var x := 0.0 if is_left else w - _wall_t
		var dir := RoomModel.W if is_left else RoomModel.E
		if room.has_door(dir):
			var g := _gap_rect(dir)
			rects.append(Rect2(x, _wall_t, _wall_t, g.position.y - _wall_t))
			rects.append(Rect2(x, g.end.y, _wall_t, (h - _wall_t) - g.end.y))
		else:
			rects.append(Rect2(x, _wall_t, _wall_t, h - 2.0 * _wall_t))
	return rects

# --- Build -----------------------------------------------------------------
func _build_walls() -> void:
	var body := StaticBody2D.new()
	body.add_to_group("walls")
	body.set_collision_layer_value(1, true)
	for r in _solid_wall_rects():
		if r.size.x <= 0 or r.size.y <= 0:
			continue
		var cs := CollisionShape2D.new()
		var shape := RectangleShape2D.new()
		shape.size = r.size
		cs.shape = shape
		cs.position = r.position + r.size * 0.5
		body.add_child(cs)
	add_child(body)

func _build_doors() -> void:
	for dir in room.door_dirs():
		var g := _gap_rect(dir)

		# Barrier that physically bars the doorway when not passable.
		var barrier := StaticBody2D.new()
		barrier.add_to_group("walls")
		barrier.set_collision_layer_value(1, true)
		var bcs := CollisionShape2D.new()
		var bshape := RectangleShape2D.new()
		bshape.size = g.size
		bcs.shape = bshape
		barrier.add_child(bcs)
		barrier.position = g.position + g.size * 0.5
		add_child(barrier)
		_barriers[dir] = barrier

		# Trigger sits just inside the doorway so the player can reach it even
		# when a locked barrier is still up (to spend a key).
		var trigger := Area2D.new()
		trigger.set_collision_mask_value(2, true)   # player
		var tcs := CollisionShape2D.new()
		var tshape := RectangleShape2D.new()
		var inward := 44.0
		if dir == RoomModel.N or dir == RoomModel.S:
			tshape.size = Vector2(g.size.x, inward)
		else:
			tshape.size = Vector2(inward, g.size.y)
		tcs.shape = tshape
		trigger.add_child(tcs)
		trigger.position = _center + Vector2(dir.x, dir.y) \
			* (Vector2(_interior.size.x, _interior.size.y) * 0.5 - Vector2(inward, inward) * 0.5)
		# Snap trigger onto the doorway centre-line of that wall.
		if dir == RoomModel.N or dir == RoomModel.S:
			trigger.position.x = _full.x * 0.5
		else:
			trigger.position.y = _full.y * 0.5
		add_child(trigger)
		var d := dir
		trigger.body_entered.connect(func(b): _on_door_trigger(b, d))

func _refresh_doors() -> void:
	for dir in _barriers.keys():
		var solid := not _is_passable(dir)
		var barrier: StaticBody2D = _barriers[dir]
		(barrier.get_child(0) as CollisionShape2D).set_deferred("disabled", not solid)
	queue_redraw()

func _is_passable(dir: Vector2i) -> bool:
	return room.cleared and not _is_locked(dir)

func _is_locked(dir: Vector2i) -> bool:
	var dest: RoomModel = room.connections.get(dir, null)
	if dest == null:
		return false
	return dest.type == RoomModel.Type.TREASURE and not GameState.is_room_unlocked(dest.cell)

func _on_door_trigger(body: Node, dir: Vector2i) -> void:
	if not body.is_in_group("player") or not room.cleared:
		return
	if _is_locked(dir):
		if GameState.use_key():
			GameState.unlock_room((room.connections[dir] as RoomModel).cell)
			_refresh_doors()
			exit_requested.emit(dir)
		return
	exit_requested.emit(dir)

# --- Population ------------------------------------------------------------
func _populate() -> void:
	match room.type:
		RoomModel.Type.START:
			room.cleared = true
		RoomModel.Type.NORMAL:
			if room.cleared:
				_scatter_rocks()
			else:
				_scatter_rocks()
				_spawn_enemy_layout(_pick_normal_layout())
		RoomModel.Type.BOSS:
			if room.cleared:
				Pickup.spawn(self, Pickup.Kind.TRAPDOOR, _center)
			else:
				var boss := EnemyDB.spawn("boss_gluttony")
				_add_enemy(boss, _center + Vector2(0, -60))
		RoomModel.Type.TREASURE:
			room.cleared = true
			_populate_treasure()
		RoomModel.Type.SHOP:
			room.cleared = true
			_populate_shop()

	if _alive == 0 and not room.cleared:
		room.cleared = true

func _populate_treasure() -> void:
	if room.extra.get("taken", false):
		return
	if not room.extra.has("reward"):
		var it := ItemDB.random_item(GameState.rng)
		room.extra["reward"] = it.id if it != null else ""
	var reward := ItemDB.get_item(String(room.extra.get("reward", "")))
	if reward == null:
		return
	var pedestal := ItemPedestal.new().setup(reward, false)
	pedestal.taken.connect(func(_i): room.extra["taken"] = true)
	add_child(pedestal)
	pedestal.global_position = _center

func _populate_shop() -> void:
	if not room.extra.has("stock"):
		var stock: Array = []
		var picked: Array = []
		for i in 2:
			var it := ItemDB.random_item(GameState.rng, picked)
			if it != null:
				stock.append(it.id)
				picked.append(it.id)
		room.extra["stock"] = stock
	var stock: Array = room.extra.get("stock", [])
	var n := stock.size()
	for i in n:
		var it := ItemDB.get_item(String(stock[i]))
		if it == null:
			continue
		var pedestal := ItemPedestal.new().setup(it, true)
		var id := String(stock[i])
		pedestal.taken.connect(func(_i): (room.extra["stock"] as Array).erase(id))
		add_child(pedestal)
		var spacing := 150.0
		pedestal.global_position = _center + Vector2((i - (n - 1) * 0.5) * spacing, 0)

func _add_enemy(enemy: Enemy, pos: Vector2) -> void:
	add_child(enemy)
	enemy.global_position = pos
	enemy.died.connect(_on_enemy_died)
	_alive += 1

func _spawn_enemy_layout(layout: Array) -> void:
	for id in layout:
		if not EnemyDB.has(id):
			continue
		_add_enemy(EnemyDB.spawn(id), _random_spawn_point())

func _on_enemy_died(_enemy) -> void:
	_alive -= 1
	if _alive <= 0:
		_on_cleared()

func _on_cleared() -> void:
	if room.cleared:
		return
	GameState.clear_current_room()
	_refresh_doors()
	if room.type == RoomModel.Type.BOSS:
		Pickup.spawn(self, Pickup.Kind.TRAPDOOR, _center)
	elif _rng.randf() < GameConfig.PICKUP_DROP_CHANCE_ON_CLEAR:
		Pickup.spawn(self, _random_clear_drop(), _center)

func _random_clear_drop() -> int:
	var roll := _rng.randf()
	if roll < 0.55:
		return Pickup.Kind.COIN
	elif roll < 0.75:
		return Pickup.Kind.HEART
	elif roll < 0.9:
		return Pickup.Kind.BOMB
	return Pickup.Kind.KEY

func _scatter_rocks() -> void:
	if room.type != RoomModel.Type.NORMAL:
		return
	if _rng.randf() > 0.5:
		return
	var count := _rng.randi_range(2, 4)
	for i in count:
		var rock := Rock.new()
		# Occasionally hide a pickup under a rock so bombs have a payoff.
		if _rng.randf() < 0.25:
			rock.hidden_pickup = Pickup.Kind.COIN if _rng.randf() < 0.7 else Pickup.Kind.HEART
		add_child(rock)
		rock.global_position = _random_spawn_point()

# --- Spawn point helpers ---------------------------------------------------
func _random_spawn_point() -> Vector2:
	# A random interior point kept clear of the centre (player start) and walls.
	for _attempt in 20:
		var margin := 70.0
		var p := Vector2(
			_rng.randf_range(_interior.position.x + margin, _interior.end.x - margin),
			_rng.randf_range(_interior.position.y + margin, _interior.end.y - margin))
		if p.distance_to(_center) > 150.0:
			return p
	return _center + Vector2(120, 120)

# --- Spawn table -----------------------------------------------------------
func _load_spawns() -> void:
	if not _spawns.is_empty():
		return
	var text := FileAccess.get_file_as_string("res://data/spawns.json")
	var parsed = JSON.parse_string(text)
	if typeof(parsed) == TYPE_DICTIONARY:
		_spawns = parsed

func _pick_normal_layout() -> Array:
	var layouts: Array = _spawns.get("normal", [])
	if layouts.is_empty():
		return ["wanderer", "wanderer"]
	return layouts[_rng.randi_range(0, layouts.size() - 1)]

# --- Drawing ---------------------------------------------------------------
func _draw() -> void:
	# Floor: a subtle two-tone checker over the interior.
	var t := float(GameConfig.TILE_SIZE)
	for ty in GameConfig.ROOM_TILES_H:
		for tx in GameConfig.ROOM_TILES_W:
			var col := GameConfig.COL_FLOOR if (tx + ty) % 2 == 0 else GameConfig.COL_FLOOR_ALT
			draw_rect(Rect2(_interior.position + Vector2(tx, ty) * t, Vector2(t, t)), col)

	# Walls.
	for r in _solid_wall_rects():
		draw_rect(r, GameConfig.COL_WALL)

	# Door frames, coloured by state.
	for dir in room.door_dirs():
		var g := _gap_rect(dir)
		var col := GameConfig.COL_DOOR_CLOSED
		if _is_locked(dir):
			col = GameConfig.COL_DOOR_LOCKED
		elif _is_passable(dir):
			col = GameConfig.COL_DOOR_OPEN
		draw_rect(g, col)
