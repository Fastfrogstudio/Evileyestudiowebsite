class_name Pickup
extends Area2D
## Floor pickups: hearts, coins, keys, bombs, and the boss-room trapdoor.
## Each just calls into GameState when the player touches it, keeping the
## economy decoupled from the world.

enum Kind { HEART, COIN, KEY, BOMB, TRAPDOOR }

var kind: int = Kind.COIN
var _radius: float = GameConfig.pickup_radius

static func spawn(parent: Node, kind: int, position: Vector2) -> Pickup:
	var p := Pickup.new()
	p.kind = kind
	parent.add_child(p)
	p.global_position = position
	return p

func _ready() -> void:
	add_to_group("pickups")
	set_collision_mask_value(2, true)     # detect the player (layer 2)
	monitoring = true

	if kind == Kind.TRAPDOOR:
		_radius = GameConfig.TILE_SIZE * 0.7

	var shape := CircleShape2D.new()
	shape.radius = _radius
	var cs := CollisionShape2D.new()
	cs.shape = shape
	add_child(cs)

	_build_visual()
	body_entered.connect(_on_body_entered)

func _build_visual() -> void:
	var sprite_name := ""
	var col := Color.WHITE
	var shape := Placeholder.Shape.CIRCLE
	match kind:
		Kind.HEART:
			sprite_name = "items/heart.png"; col = GameConfig.COL_HEART
		Kind.COIN:
			sprite_name = "items/coin.png"; col = GameConfig.COL_COIN
		Kind.KEY:
			sprite_name = "items/key.png"; col = GameConfig.COL_KEY; shape = Placeholder.Shape.ROUND_RECT
		Kind.BOMB:
			sprite_name = "items/bomb.png"; col = GameConfig.COL_BOMB
		Kind.TRAPDOOR:
			sprite_name = "tiles/trapdoor.png"; col = GameConfig.COL_TRAPDOOR; shape = Placeholder.Shape.ROUND_RECT

	var spr := Assets.sprite(sprite_name, _radius * 2.0, false)
	if spr != null:
		add_child(spr)
		return
	if shape == Placeholder.Shape.CIRCLE:
		add_child(Placeholder.new().setup(shape, col, _radius))
	else:
		add_child(Placeholder.new().setup(shape, col, Vector2(_radius * 1.8, _radius * 1.8)))

func _on_body_entered(body: Node) -> void:
	if not body.is_in_group("player"):
		return
	match kind:
		Kind.HEART:
			if GameState.current_health >= GameState.stats.max_health:
				return  # leave full hearts on the ground, Isaac-style
			GameState.heal(2)
		Kind.COIN:
			GameState.add_coins(1)
		Kind.KEY:
			GameState.add_keys(1)
		Kind.BOMB:
			GameState.add_bombs(1)
		Kind.TRAPDOOR:
			GameState.descend()
			return
	queue_free()
