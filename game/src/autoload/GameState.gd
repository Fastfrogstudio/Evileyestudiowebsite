extends Node
## The single source of truth for a run: stats, health, inventory, items, and
## which floor/room the player is in. Autoloaded as `GameState`.
##
## Systems read and mutate run state here and react through the Events bus, so
## nothing needs a direct reference to anything else. Permadeath = this is
## wiped and regenerated on every new run.

var stats: StatBlock = StatBlock.new()
var items: Array = []               # Array[ItemData], order picked up

var current_health: int = 0         # half-hearts
var coins: int = 0
var keys: int = 0
var bombs: int = 0

var floor_number: int = 1
var floor_model: FloorModel
var current_cell: Vector2i
var _unlocked: Dictionary = {}      # cell -> true (locked doors opened this floor)

var is_dead: bool = false
var rng := RandomNumberGenerator.new()

# --- Run lifecycle ---------------------------------------------------------
func start_run() -> void:
	is_dead = false
	items = []
	stats = StatBlock.new()
	stats.recompute(items)
	current_health = stats.max_health
	coins = GameConfig.PLAYER_START_COINS
	keys = GameConfig.PLAYER_START_KEYS
	bombs = GameConfig.PLAYER_START_BOMBS
	floor_number = 1
	rng.randomize()
	_generate_floor()
	Events.run_started.emit()
	Events.stats_changed.emit()
	Events.health_changed.emit(current_health, stats.max_health)
	Events.inventory_changed.emit(coins, keys, bombs)

func _generate_floor() -> void:
	_unlocked.clear()
	floor_model = FloorGenerator.generate(floor_number, rng)
	current_cell = floor_model.start_cell
	Events.floor_generated.emit(floor_model)

## Advance to the next floor, or win if this was the last one (Milestone 1 = 1).
func descend() -> void:
	if floor_number >= GameConfig.FLOORS_PER_RUN:
		Events.run_won.emit()
		return
	floor_number += 1
	_generate_floor()
	Events.floor_descended.emit(floor_number)

# --- Rooms -----------------------------------------------------------------
func current_room() -> RoomModel:
	return floor_model.get_room(current_cell)

func enter_room(cell: Vector2i) -> void:
	current_cell = cell
	var room := current_room()
	if room == null:
		return
	room.visited = true
	room.discovered = true
	for dir in room.connections.keys():
		(room.connections[dir] as RoomModel).discovered = true
	Events.room_entered.emit(room)
	Events.minimap_dirty.emit()

func clear_current_room() -> void:
	var room := current_room()
	if room == null or room.cleared:
		return
	room.cleared = true
	Events.room_cleared.emit(room)
	Events.minimap_dirty.emit()

func is_room_unlocked(cell: Vector2i) -> bool:
	return _unlocked.has(cell)

func unlock_room(cell: Vector2i) -> void:
	_unlocked[cell] = true

# --- Health ----------------------------------------------------------------
func apply_damage(amount: int) -> void:
	if is_dead:
		return
	current_health = maxi(0, current_health - amount)
	Events.player_hit.emit(amount)
	Events.health_changed.emit(current_health, stats.max_health)
	if current_health <= 0:
		is_dead = true
		Events.player_died.emit()

func heal(amount: int) -> void:
	current_health = mini(stats.max_health, current_health + amount)
	Events.health_changed.emit(current_health, stats.max_health)

# --- Economy ---------------------------------------------------------------
func add_coins(n: int) -> void:
	coins += n
	Events.inventory_changed.emit(coins, keys, bombs)

func spend_coins(n: int) -> bool:
	if coins < n:
		return false
	coins -= n
	Events.inventory_changed.emit(coins, keys, bombs)
	return true

func add_keys(n: int) -> void:
	keys += n
	Events.inventory_changed.emit(coins, keys, bombs)

func use_key() -> bool:
	if keys <= 0:
		return false
	keys -= 1
	Events.inventory_changed.emit(coins, keys, bombs)
	return true

func add_bombs(n: int) -> void:
	bombs += n
	Events.inventory_changed.emit(coins, keys, bombs)

func use_bomb() -> bool:
	if bombs <= 0:
		return false
	bombs -= 1
	Events.inventory_changed.emit(coins, keys, bombs)
	return true

# --- Items -----------------------------------------------------------------
func add_item(item: ItemData) -> void:
	if item == null:
		return
	var old_max := stats.max_health
	items.append(item)
	stats.recompute(items)
	# A max-health increase also fills the new hearts (Isaac behaviour).
	var delta := stats.max_health - old_max
	if delta > 0:
		current_health += delta
	current_health = mini(current_health, stats.max_health)
	Events.item_collected.emit(item)
	Events.stats_changed.emit()
	Events.health_changed.emit(current_health, stats.max_health)
