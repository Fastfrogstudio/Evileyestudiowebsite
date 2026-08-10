extends Node
## Loads every item definition from game/data/items/*.json at startup.
## Autoloaded as `ItemDB`. Adding items = dropping in new JSON files.

const ITEM_DIR := "res://data/items/"

var _items: Array = []              # Array[ItemData]
var _by_id: Dictionary = {}

func _ready() -> void:
	_load_all()

func _load_all() -> void:
	_items.clear()
	_by_id.clear()
	var dir := DirAccess.open(ITEM_DIR)
	if dir == null:
		push_warning("ItemDB: could not open %s" % ITEM_DIR)
		return
	dir.list_dir_begin()
	var file := dir.get_next()
	while file != "":
		if not dir.current_is_dir() and file.get_extension().to_lower() == "json":
			var item := _load_file(ITEM_DIR + file)
			if item != null:
				_items.append(item)
				_by_id[item.id] = item
		file = dir.get_next()
	dir.list_dir_end()
	# Stable order regardless of filesystem enumeration.
	_items.sort_custom(func(a, b): return a.id < b.id)
	print("ItemDB: loaded %d items" % _items.size())

func _load_file(path: String) -> ItemData:
	var text := FileAccess.get_file_as_string(path)
	if text == "":
		push_warning("ItemDB: empty or unreadable file %s" % path)
		return null
	var parsed = JSON.parse_string(text)
	if typeof(parsed) != TYPE_DICTIONARY:
		push_warning("ItemDB: %s is not a JSON object" % path)
		return null
	return ItemData.from_dict(parsed)

func all() -> Array:
	return _items

func get_item(id: String) -> ItemData:
	return _by_id.get(id, null)

func count() -> int:
	return _items.size()

## Returns a random item, optionally excluding ids already picked. `rng` lets
## floor generation stay deterministic per seed.
func random_item(rng: RandomNumberGenerator, exclude_ids: Array = []) -> ItemData:
	var pool := _items.filter(func(it): return not exclude_ids.has(it.id))
	if pool.is_empty():
		pool = _items
	if pool.is_empty():
		return null
	return pool[rng.randi_range(0, pool.size() - 1)]
