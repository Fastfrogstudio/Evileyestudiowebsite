class_name FloorGenerator
extends RefCounted
## Procedural floor generation, Binding of Isaac-style.
##
## ALGORITHM (grid accretion / random walk):
##   1. Place the START room at the centre of a FLOOR_GRID x FLOOR_GRID grid.
##   2. Grow outward from a queue of placed rooms. For each room we try its four
##      neighbours in random order and place a new room there IF:
##        - the cell is empty and in bounds, AND
##        - the candidate touches at most ONE existing room (this keeps the
##          floor branchy and corridor-like instead of a solid blob), AND
##        - a coin-flip passes (random branching), AND
##        - we still need more rooms.
##      Newly placed rooms join the queue, so growth spreads organically.
##   3. If we undershot the target room count, top up by repeatedly placing a
##      room in any empty cell that touches exactly one room.
##   4. Connect every pair of orthogonally-adjacent rooms with a door.
##   5. Compute BFS distance from the start room to every room.
##   6. Assign SPECIAL rooms to dead-ends (rooms with a single door):
##        - BOSS      = the dead-end FARTHEST from start,
##        - TREASURE  = the next-farthest remaining dead-end,
##        - SHOP      = another dead-end if one is left.
##      If there aren't enough dead-ends, fall back to the farthest normal rooms
##      so a boss and a treasure room are always guaranteed.

static func generate(floor_number: int, rng: RandomNumberGenerator) -> FloorModel:
	var fm := FloorModel.new()
	fm.floor_number = floor_number

	var target := rng.randi_range(GameConfig.ROOMS_MIN, GameConfig.ROOMS_MAX)
	var center := Vector2i(GameConfig.FLOOR_GRID / 2, GameConfig.FLOOR_GRID / 2)

	var start := RoomModel.new(center, RoomModel.Type.START)
	fm.rooms[center] = start
	fm.start_cell = center

	# --- Step 2: organic growth from a queue ------------------------------
	var queue: Array = [center]
	while not queue.is_empty() and fm.rooms.size() < target:
		var cell: Vector2i = queue.pop_front()
		var dirs := RoomModel.DIRS.duplicate()
		_shuffle(dirs, rng)
		for dir in dirs:
			if fm.rooms.size() >= target:
				break
			var ncell: Vector2i = cell + dir
			if not _in_bounds(ncell) or fm.rooms.has(ncell):
				continue
			if _occupied_neighbours(fm, ncell) > 1:
				continue
			if rng.randf() < 0.5:
				continue
			fm.rooms[ncell] = RoomModel.new(ncell, RoomModel.Type.NORMAL)
			queue.append(ncell)

	# --- Step 3: top up to the target if branching stalled ----------------
	var guard := 0
	while fm.rooms.size() < target and guard < 500:
		guard += 1
		var candidates := _candidate_cells(fm)
		if candidates.is_empty():
			break
		var pick: Vector2i = candidates[rng.randi_range(0, candidates.size() - 1)]
		fm.rooms[pick] = RoomModel.new(pick, RoomModel.Type.NORMAL)

	# --- Step 4: doors between adjacent rooms -----------------------------
	_connect_all(fm)
	# --- Step 5: distances -------------------------------------------------
	_bfs_distances(fm)
	# --- Step 6: special rooms --------------------------------------------
	_assign_special(fm, rng)

	return fm

# --- helpers ---------------------------------------------------------------
static func _in_bounds(cell: Vector2i) -> bool:
	return cell.x >= 0 and cell.y >= 0 \
		and cell.x < GameConfig.FLOOR_GRID and cell.y < GameConfig.FLOOR_GRID

static func _occupied_neighbours(fm: FloorModel, cell: Vector2i) -> int:
	var n := 0
	for dir in RoomModel.DIRS:
		if fm.rooms.has(cell + dir):
			n += 1
	return n

## Empty, in-bounds cells that touch exactly one existing room.
static func _candidate_cells(fm: FloorModel) -> Array:
	var seen := {}
	var out: Array = []
	for cell in fm.rooms.keys():
		for dir in RoomModel.DIRS:
			var c: Vector2i = cell + dir
			if seen.has(c) or fm.rooms.has(c) or not _in_bounds(c):
				continue
			seen[c] = true
			if _occupied_neighbours(fm, c) == 1:
				out.append(c)
	return out

static func _connect_all(fm: FloorModel) -> void:
	for cell in fm.rooms.keys():
		var room: RoomModel = fm.rooms[cell]
		for dir in RoomModel.DIRS:
			var neighbour: RoomModel = fm.rooms.get(cell + dir, null)
			if neighbour != null:
				room.connect_to(neighbour, dir)

static func _bfs_distances(fm: FloorModel) -> void:
	var start: RoomModel = fm.rooms[fm.start_cell]
	for r in fm.rooms.values():
		r.distance = -1
	start.distance = 0
	var queue: Array = [start]
	while not queue.is_empty():
		var room: RoomModel = queue.pop_front()
		for dir in room.connections.keys():
			var nb: RoomModel = room.connections[dir]
			if nb.distance == -1:
				nb.distance = room.distance + 1
				queue.append(nb)

static func _assign_special(fm: FloorModel, rng: RandomNumberGenerator) -> void:
	# Prefer dead-ends (single door), farthest first.
	var dead_ends: Array = []
	for r in fm.rooms.values():
		if r.type == RoomModel.Type.NORMAL and r.connections.size() == 1:
			dead_ends.append(r)
	dead_ends.sort_custom(func(a, b): return a.distance > b.distance)

	# Fallback pool: any normal room, farthest first, if we lack dead-ends.
	var normals: Array = []
	for r in fm.rooms.values():
		if r.type == RoomModel.Type.NORMAL:
			normals.append(r)
	normals.sort_custom(func(a, b): return a.distance > b.distance)

	var pool := dead_ends if dead_ends.size() >= 2 else normals

	# BOSS: farthest available room.
	if not pool.is_empty():
		var boss: RoomModel = pool.pop_front()
		boss.type = RoomModel.Type.BOSS
		fm.boss_cell = boss.cell

	# TREASURE: next farthest.
	if not pool.is_empty():
		var treasure: RoomModel = pool.pop_front()
		treasure.type = RoomModel.Type.TREASURE

	# SHOP: another if available (prefer a closer one for a "hub" feel).
	if not pool.is_empty():
		var shop: RoomModel = pool.back()
		pool.pop_back()
		shop.type = RoomModel.Type.SHOP

static func _shuffle(arr: Array, rng: RandomNumberGenerator) -> void:
	for i in range(arr.size() - 1, 0, -1):
		var j := rng.randi_range(0, i)
		var tmp = arr[i]
		arr[i] = arr[j]
		arr[j] = tmp
