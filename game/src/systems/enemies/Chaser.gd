class_name Chaser
extends Enemy
## Moves straight toward the player. Rooms are open boxes, so a direct steering
## chase reads as "pathfinding" here; swap in a NavigationAgent2D later if you
## add interior obstacles that need routing around.

func _ai(_delta: float) -> void:
	var d := to_player()
	velocity = d.normalized() * speed if d.length() > 2.0 else Vector2.ZERO
