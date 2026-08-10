class_name Placeholder
extends Node2D
## A simple coloured shape used whenever real art has not been added yet.
## Draws a filled circle or rounded rectangle with a soft outline so the
## placeholders read cleanly against the storybook-toned floors.

enum Shape { CIRCLE, ROUND_RECT }

@export var shape: Shape = Shape.CIRCLE
@export var radius: float = 20.0            # used by CIRCLE
@export var rect_size: Vector2 = Vector2(40, 40)  # used by ROUND_RECT
@export var color: Color = Color.WHITE
@export var outline: Color = Color(0, 0, 0, 0.35)
@export var outline_width: float = 3.0

func setup(p_shape: Shape, p_color: Color, p_size) -> Placeholder:
	shape = p_shape
	color = p_color
	if p_shape == Shape.CIRCLE:
		radius = float(p_size)
	else:
		rect_size = p_size
	queue_redraw()
	return self

func _draw() -> void:
	match shape:
		Shape.CIRCLE:
			draw_circle(Vector2.ZERO, radius, color)
			draw_arc(Vector2.ZERO, radius, 0.0, TAU, 32, outline, outline_width, true)
		Shape.ROUND_RECT:
			var r := Rect2(-rect_size * 0.5, rect_size)
			draw_rect(r, color, true)
			draw_rect(r, outline, false, outline_width)
