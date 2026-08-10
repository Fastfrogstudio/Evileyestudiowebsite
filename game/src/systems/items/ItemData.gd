class_name ItemData
extends Resource
## One item, loaded from a JSON config file (see game/data/items/*.json).
##
## Items are pure data: adding item #6 through #200 later means dropping in a
## new JSON file, not writing code. `modifiers` maps a stat name to
## {"add": x, "mult": y}; both are optional and STACK across all held items.

@export var id: String = ""
@export var name: String = "Unknown Item"
@export var description: String = ""
@export var sprite: String = ""            # path under assets/, e.g. "items/sad_onion.png"
@export var modifiers: Dictionary = {}     # stat -> {add, mult}
@export var price: int = 15                # cost when sold in a shop
@export var tags: Array = []               # free-form, e.g. ["passive"]

static func from_dict(d: Dictionary) -> ItemData:
	var item := ItemData.new()
	item.id = String(d.get("id", ""))
	item.name = String(d.get("name", "Unknown Item"))
	item.description = String(d.get("description", ""))
	item.sprite = String(d.get("sprite", ""))
	item.modifiers = d.get("modifiers", {})
	item.price = int(d.get("price", 15))
	item.tags = d.get("tags", [])
	return item
