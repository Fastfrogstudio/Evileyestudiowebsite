class_name Minimap
extends Control
## Draws discovered rooms as a small grid in the top-right. The current room is
## outlined; special rooms are tinted so the player can navigate the floor.

const CELL := 16.0
const GAP := 4.0

func _ready() -> void:
	Events.minimap_dirty.connect(queue_redraw)
	Events.room_entered.connect(func(_r): queue_redraw())
	Events.floor_generated.connect(func(_f): queue_redraw())

func _draw() -> void:
	var fm := GameState.floor_model
	if fm == null:
		return
	var b := fm.bounds()
	var step := CELL + GAP
	# Anchor the map inside this control's rect (top-right aligned by the HUD).
	for room in fm.all_rooms():
		if not room.discovered:
			continue
		var gx := room.cell.x - b.position.x
		var gy := room.cell.y - b.position.y
		var pos := Vector2(gx * step, gy * step)
		draw_rect(Rect2(pos, Vector2(CELL, CELL)), _room_color(room))
		if room.cell == GameState.current_cell:
			draw_rect(Rect2(pos, Vector2(CELL, CELL)), Color.WHITE, false, 2.0)

func _room_color(room: RoomModel) -> Color:
	match room.type:
		RoomModel.Type.BOSS:
			return GameConfig.COL_BOSS if room.discovered else Color.DIM_GRAY
		RoomModel.Type.TREASURE:
			return GameConfig.COL_DOOR_LOCKED
		RoomModel.Type.SHOP:
			return GameConfig.COL_COIN
		RoomModel.Type.START:
			return Color(0.55, 0.75, 0.95)
		_:
			return Color(0.45, 0.45, 0.55) if room.visited else Color(0.3, 0.3, 0.38)
