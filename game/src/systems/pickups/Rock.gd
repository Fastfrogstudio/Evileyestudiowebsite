class_name Rock
extends StaticBody2D
## A destructible obstacle. Blocks movement and tears; blown up by bombs. May
## hide a pickup underneath, giving bombs a reason to exist.

var _size: float = GameConfig.TILE_SIZE * 0.9
var hidden_pickup: int = -1        # a Pickup.Kind, or -1 for nothing

func _ready() -> void:
	add_to_group("rocks")
	set_collision_layer_value(1, true)   # share the "walls" layer so tears stop
	add_to_group("walls")

	var shape := RectangleShape2D.new()
	shape.size = Vector2(_size, _size)
	var cs := CollisionShape2D.new()
	cs.shape = shape
	add_child(cs)

	var spr := Assets.sprite("tiles/rock.png", _size, false)
	if spr != null:
		add_child(spr)
	else:
		add_child(Placeholder.new().setup(Placeholder.Shape.ROUND_RECT,
			GameConfig.COL_ROCK, Vector2(_size, _size)))

## Called by a bomb blast.
func destroy() -> void:
	if hidden_pickup >= 0:
		Pickup.spawn(get_parent(), hidden_pickup, global_position)
	queue_free()
