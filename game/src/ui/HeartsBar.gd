class_name HeartsBar
extends Control
## Draws the player's health as full / half / empty hearts (half-heart units,
## Isaac-style). Tries assets/ui heart art first; falls back to drawn shapes.

const R := 13.0
const SPACING := 34.0
const PAD := Vector2(16, 14)

func _ready() -> void:
	Events.health_changed.connect(func(_c, _m): queue_redraw())
	Events.stats_changed.connect(queue_redraw)

func _draw() -> void:
	var maxh := GameState.stats.max_health
	var cur := GameState.current_health
	var slots := int(ceil(maxh / 2.0))
	for i in slots:
		var pos := PAD + Vector2(i * SPACING + R, R)
		var v := clampi(cur - i * 2, 0, 2)
		_draw_heart(pos, v)

func _draw_heart(pos: Vector2, value: int) -> void:
	# Empty base.
	draw_circle(pos, R, Color(0.16, 0.14, 0.2))
	if value == 2:
		draw_circle(pos, R, GameConfig.COL_HEART)
	elif value == 1:
		draw_colored_polygon(_left_half(pos, R), GameConfig.COL_HEART)
	draw_arc(pos, R, 0, TAU, 24, Color(0, 0, 0, 0.4), 2.0, true)

func _left_half(center: Vector2, r: float) -> PackedVector2Array:
	var pts := PackedVector2Array()
	# Arc sweeping the left side of the circle (90° to 270°).
	for i in 13:
		var a := PI * 0.5 + PI * (float(i) / 12.0)
		pts.append(center + Vector2(cos(a), sin(a)) * r)
	return pts
