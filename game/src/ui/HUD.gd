class_name HUD
extends CanvasLayer
## Screen-space overlay: hearts (top-left), coin/key/bomb counts, a minimap
## (top-right), and a boss health bar (bottom) that shows while a boss lives.

var _counts: Label
var _boss_bg: ColorRect
var _boss_fill: ColorRect

func _ready() -> void:
	var w := float(GameConfig.window_width())
	var h := float(GameConfig.window_height())

	var hearts := HeartsBar.new()
	hearts.position = Vector2.ZERO
	hearts.size = Vector2(500, 40)
	add_child(hearts)

	_counts = Label.new()
	_counts.position = Vector2(24, 58)
	add_child(_counts)

	var minimap := Minimap.new()
	minimap.position = Vector2(w - 220, 16)
	minimap.size = Vector2(204, 180)
	add_child(minimap)

	_boss_bg = ColorRect.new()
	_boss_bg.color = Color(0, 0, 0, 0.6)
	_boss_bg.position = Vector2(w * 0.5 - 220, h - 44)
	_boss_bg.size = Vector2(440, 20)
	_boss_bg.visible = false
	add_child(_boss_bg)

	_boss_fill = ColorRect.new()
	_boss_fill.color = GameConfig.COL_BOSS
	_boss_fill.position = _boss_bg.position + Vector2(4, 4)
	_boss_fill.size = Vector2(432, 12)
	_boss_fill.visible = false
	add_child(_boss_fill)

	Events.inventory_changed.connect(_on_inventory)
	_on_inventory(GameState.coins, GameState.keys, GameState.bombs)

func _on_inventory(coins: int, keys: int, bombs: int) -> void:
	_counts.text = "Coins: %d    Keys: %d    Bombs: %d" % [coins, keys, bombs]

func _process(_delta: float) -> void:
	var boss = get_tree().get_first_node_in_group("boss")
	if boss != null and is_instance_valid(boss) and boss.has_method("health_fraction"):
		_boss_bg.visible = true
		_boss_fill.visible = true
		_boss_fill.size = Vector2(432.0 * boss.health_fraction(), 12)
	else:
		_boss_bg.visible = false
		_boss_fill.visible = false
