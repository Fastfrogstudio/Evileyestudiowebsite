class_name Wanderer
extends Enemy
## Wanders in random directions, changing course on a timer or when it bumps
## a wall. Harmless-ish filler that still deals contact damage.

var _dir: Vector2 = Vector2.ZERO
var _timer: float = 0.0

func _ai(delta: float) -> void:
	_timer -= delta
	if _timer <= 0.0 or get_slide_collision_count() > 0:
		_dir = Vector2.RIGHT.rotated(rng.randf() * TAU)
		_timer = rng.randf_range(0.6, 1.5)
	velocity = _dir * speed
