class_name Projectile
extends Area2D
## A "tear". Travels in a straight line, despawns on impact or when it runs out
## of range (lifetime). Friendly tears damage enemies; hostile ones damage the
## player. Spawn via the static spawn() helper.

var velocity: Vector2 = Vector2.ZERO
var lifetime: float = 1.0
var damage: float = 1.0            # dealt to enemies (friendly tears)
var damage_player: int = 1         # half-hearts dealt to player (hostile tears)
var hostile: bool = false
var radius: float = 9.0

static func spawn(parent: Node, cfg: Dictionary) -> Projectile:
	var p := Projectile.new()
	p.hostile = bool(cfg.get("hostile", false))
	p.radius = float(cfg.get("radius", 9.0))
	p.lifetime = float(cfg.get("lifetime", 1.0))
	p.damage = float(cfg.get("damage", 1.0))
	p.damage_player = int(cfg.get("damage_player", 1))
	var dir: Vector2 = cfg.get("direction", Vector2.RIGHT)
	p.velocity = dir.normalized() * float(cfg.get("speed", 400.0))
	parent.add_child(p)
	p.global_position = cfg.get("position", Vector2.ZERO)
	return p

func _ready() -> void:
	monitoring = true
	# Detect walls (layer 1) plus the appropriate target.
	set_collision_mask_value(1, true)
	if hostile:
		set_collision_mask_value(2, true)   # player
	else:
		set_collision_mask_value(3, true)   # enemies

	var shape := CircleShape2D.new()
	shape.radius = radius
	var cs := CollisionShape2D.new()
	cs.shape = shape
	add_child(cs)

	var col := GameConfig.COL_ENEMY_TEAR if hostile else GameConfig.COL_PLAYER_TEAR
	var sprite_name := "enemies/tear.png" if hostile else "items/tear.png"
	var spr := Assets.sprite(sprite_name, radius * 2.2, false)
	if spr != null:
		add_child(spr)
	else:
		add_child(Placeholder.new().setup(Placeholder.Shape.CIRCLE, col, radius))

	body_entered.connect(_on_body_entered)

func _physics_process(delta: float) -> void:
	global_position += velocity * delta
	lifetime -= delta
	if lifetime <= 0.0:
		queue_free()

func _on_body_entered(body: Node) -> void:
	if body.is_in_group("walls") or body.is_in_group("rocks"):
		queue_free()
		return
	if hostile:
		if body.is_in_group("player") and body.has_method("take_damage"):
			body.take_damage(damage_player)
			queue_free()
	else:
		if body.is_in_group("enemies") and body.has_method("take_damage"):
			body.take_damage(damage)
			queue_free()
