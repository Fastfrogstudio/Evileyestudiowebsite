class_name ItemPedestal
extends Area2D
## Holds an item the player can pick up. Free in treasure rooms; costs coins in
## a shop. Grants the item via GameState (which recomputes stats) on touch.

signal taken(item)

var item: ItemData
var for_sale: bool = false
var _radius: float = 30.0

func setup(p_item: ItemData, p_for_sale: bool) -> ItemPedestal:
	item = p_item
	for_sale = p_for_sale
	return self

func _ready() -> void:
	set_collision_mask_value(2, true)
	monitoring = true

	var shape := CircleShape2D.new()
	shape.radius = _radius
	var cs := CollisionShape2D.new()
	cs.shape = shape
	add_child(cs)

	# Pedestal base.
	add_child(Placeholder.new().setup(Placeholder.Shape.ROUND_RECT,
		GameConfig.COL_PEDESTAL, Vector2(_radius * 1.8, _radius * 0.8)))

	# The item itself, floating above the base.
	if item != null:
		var spr := Assets.sprite(item.sprite, _radius * 1.4, false)
		if spr != null:
			spr.position = Vector2(0, -_radius * 0.9)
			add_child(spr)
		else:
			var blob := Placeholder.new().setup(Placeholder.Shape.CIRCLE,
				Color("cfc0e0"), _radius * 0.7)
			blob.position = Vector2(0, -_radius * 0.9)
			add_child(blob)

	_add_label()
	body_entered.connect(_on_body_entered)

func _add_label() -> void:
	var label := Label.new()
	var text := item.name if item != null else "?"
	if for_sale and item != null:
		text += "  (%dc)" % item.price
	label.text = text
	label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	label.position = Vector2(-70, -_radius * 2.2)
	label.size = Vector2(140, 20)
	add_child(label)

func _on_body_entered(body: Node) -> void:
	if item == null or not body.is_in_group("player"):
		return
	if for_sale:
		if GameState.coins >= item.price:
			GameState.spend_coins(item.price)
			GameState.add_item(item)
			taken.emit(item)
			queue_free()
		# else: not enough coins — leave it on the shelf.
	else:
		GameState.add_item(item)
		taken.emit(item)
		queue_free()
