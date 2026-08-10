class_name Enemy
extends CharacterBody2D
## Base enemy. Movement lives in _ai() which each subclass overrides; this base
## handles stats, health, hit flashing, contact damage exposure and death.
## Enemies are configured from data (see EnemyDB / game/data/enemies/*.json),
## so tuning them is a config change, not a code change.

signal died(enemy)

var def: Dictionary = {}
var hp: float = 10.0
var speed: float = 100.0
var touch_damage: int = 1          # half-hearts dealt on contact
var radius: float = 24.0
var color: Color = Color.WHITE
var coin_drop_chance: float = 0.12

var _visual: Node2D
var _flash: float = 0.0
var rng := RandomNumberGenerator.new()

func _ready() -> void:
	rng.randomize()
	add_to_group("enemies")
	# Enemies collide only with walls (layer 1); they pass through each other
	# and the player (contact damage is handled by the player scanning overlaps).
	set_collision_layer_value(3, true)
	set_collision_mask_value(1, true)
	_build_body()

## Called by the spawner before _ready runs work that needs the def. Safe to
## call before or after adding to the tree.
func configure(p_def: Dictionary) -> void:
	def = p_def
	hp = float(def.get("hp", hp))
	speed = float(def.get("speed", speed))
	touch_damage = int(def.get("touch_damage", touch_damage))
	radius = float(def.get("radius", radius))
	coin_drop_chance = float(def.get("coin_drop_chance", coin_drop_chance))
	if def.has("color"):
		color = Color(String(def["color"]))
	if is_inside_tree() and _visual == null:
		_build_body()

func _build_body() -> void:
	var shape := CircleShape2D.new()
	shape.radius = radius
	var cs := CollisionShape2D.new()
	cs.shape = shape
	add_child(cs)

	var spr := Assets.sprite("enemies/%s.png" % String(def.get("id", "enemy")), radius * 2.4)
	if spr != null:
		_visual = spr
	else:
		_visual = Placeholder.new().setup(Placeholder.Shape.CIRCLE, color, radius)
	add_child(_visual)

func _physics_process(delta: float) -> void:
	if _flash > 0.0:
		_flash = maxf(0.0, _flash - delta)
		if _visual:
			_visual.modulate = Color(2, 2, 2) if _flash > 0.0 else Color.WHITE
	_ai(delta)
	move_and_slide()

## Override in subclasses to set `velocity` (and shoot, etc.).
func _ai(_delta: float) -> void:
	pass

func take_damage(amount: float) -> void:
	hp -= amount
	_flash = 0.08
	if hp <= 0.0:
		_die()

func _die() -> void:
	if rng.randf() < coin_drop_chance:
		Pickup.spawn(get_parent(), Pickup.Kind.COIN, global_position)
	died.emit(self)
	Events.enemy_died.emit(self)
	queue_free()

# --- Helpers for subclasses ------------------------------------------------
func player() -> Node2D:
	return get_tree().get_first_node_in_group("player") as Node2D

func to_player() -> Vector2:
	var p := player()
	if p == null:
		return Vector2.ZERO
	return (p.global_position - global_position)

func shoot_at(dir: Vector2) -> void:
	var pd: Dictionary = def.get("projectile", {})
	Projectile.spawn(get_parent(), {
		"hostile": true,
		"position": global_position,
		"direction": dir.normalized(),
		"speed": float(pd.get("speed", 240.0)),
		"damage_player": int(pd.get("damage", 1)),
		"lifetime": float(pd.get("lifetime", 2.2)),
		"radius": float(pd.get("radius", 10.0)),
	})
