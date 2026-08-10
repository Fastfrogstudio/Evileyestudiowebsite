extends Node
## Loads enemy definitions from game/data/enemies/*.json and acts as a factory.
## Autoloaded as `EnemyDB`. The `ai` field in each JSON selects the behaviour
## class, so new enemy *types* are data where possible and one small class
## where a genuinely new behaviour is needed.

const ENEMY_DIR := "res://data/enemies/"

var _defs: Dictionary = {}          # id -> def dict

func _ready() -> void:
	_load_all()

func _load_all() -> void:
	_defs.clear()
	var dir := DirAccess.open(ENEMY_DIR)
	if dir == null:
		push_warning("EnemyDB: could not open %s" % ENEMY_DIR)
		return
	dir.list_dir_begin()
	var file := dir.get_next()
	while file != "":
		if not dir.current_is_dir() and file.get_extension().to_lower() == "json":
			var text := FileAccess.get_file_as_string(ENEMY_DIR + file)
			var parsed = JSON.parse_string(text)
			if typeof(parsed) == TYPE_DICTIONARY:
				_defs[String(parsed.get("id", file.get_basename()))] = parsed
			else:
				push_warning("EnemyDB: %s is not a JSON object" % file)
		file = dir.get_next()
	dir.list_dir_end()
	print("EnemyDB: loaded %d enemy defs" % _defs.size())

func has(id: String) -> bool:
	return _defs.has(id)

func get_def(id: String) -> Dictionary:
	return _defs.get(id, {})

## Instances (but does NOT add to the tree) an enemy for the given id.
func spawn(id: String) -> Enemy:
	var def: Dictionary = _defs.get(id, {})
	var ai := String(def.get("ai", "wanderer"))
	var e: Enemy
	match ai:
		"chaser": e = Chaser.new()
		"shooter": e = Shooter.new()
		"boss": e = Boss.new()
		_: e = Wanderer.new()
	e.configure(def)
	return e
