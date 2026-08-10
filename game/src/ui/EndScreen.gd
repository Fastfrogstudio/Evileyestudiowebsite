class_name EndScreen
extends CanvasLayer
## Death / victory screen. Shows the outcome and a short run summary, then
## returns to the title on Enter/R/click (permadeath — the run is over).

signal restart_pressed

var _victory: bool = false

func setup(victory: bool) -> EndScreen:
	_victory = victory
	return self

func _ready() -> void:
	var w := float(GameConfig.window_width())
	var h := float(GameConfig.window_height())

	var bg := ColorRect.new()
	bg.color = Color("101b12") if _victory else Color("1c1014")
	bg.size = Vector2(w, h)
	add_child(bg)

	var title := Label.new()
	title.text = "VICTORY!" if _victory else "YOU DIED"
	title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	title.position = Vector2(0, h * 0.30)
	title.size = Vector2(w, 70)
	title.add_theme_font_size_override("font_size", 56)
	title.add_theme_color_override("font_color",
		Color("9fe0a6") if _victory else Color("e0808a"))
	add_child(title)

	var summary := Label.new()
	summary.text = "Items collected: %d        Coins: %d" \
		% [GameState.items.size(), GameState.coins]
	summary.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	summary.position = Vector2(0, h * 0.46)
	summary.size = Vector2(w, 30)
	add_child(summary)

	var help := Label.new()
	help.text = "Press Enter / R / A to return to the title"
	help.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	help.position = Vector2(0, h * 0.60)
	help.size = Vector2(w, 30)
	add_child(help)

	var button := Button.new()
	button.text = "Back to Title"
	button.size = Vector2(220, 52)
	button.position = Vector2(w * 0.5 - 110, h * 0.52)
	button.pressed.connect(func(): restart_pressed.emit())
	add_child(button)
	button.grab_focus()

func _unhandled_input(event: InputEvent) -> void:
	if event.is_action_pressed("confirm") or event.is_action_pressed("restart"):
		restart_pressed.emit()
