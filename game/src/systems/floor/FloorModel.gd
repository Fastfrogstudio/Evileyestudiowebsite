class_name FloorModel
extends RefCounted
## The generated floor: a map of grid cells to RoomModels plus some lookups the
## world and minimap need.

var rooms: Dictionary = {}          # Vector2i cell -> RoomModel
var start_cell: Vector2i
var boss_cell: Vector2i
var floor_number: int = 1

func get_room(cell: Vector2i) -> RoomModel:
	return rooms.get(cell, null)

func all_rooms() -> Array:
	return rooms.values()

## Inclusive grid bounds of the placed rooms (for drawing the minimap).
func bounds() -> Rect2i:
	var min_c := Vector2i(9999, 9999)
	var max_c := Vector2i(-9999, -9999)
	for cell in rooms.keys():
		min_c.x = mini(min_c.x, cell.x)
		min_c.y = mini(min_c.y, cell.y)
		max_c.x = maxi(max_c.x, cell.x)
		max_c.y = maxi(max_c.y, cell.y)
	return Rect2i(min_c, max_c - min_c)
