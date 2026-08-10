class_name TitleScreen
extends CanvasLayer
## Simple title screen. Press Enter/Space, click Start, or press the gamepad
## A button to begin a run.

signal start_pressed

func _ready() -> void:
	var w := float(GameConfig.window_width())
	var h := float(GameConfig.window_height())

	var bg := ColorRect.new()
	bg.color = Color("1a1626")
	bg.size = Vector2(w, h)
	add_child(bg)

	var title := Label.new()
	title.text = "UNTITLED ROGUELIKE"
	title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	title.position = Vector2(0, h * 0.28)
	title.size = Vector2(w, 60)
	title.add_theme_font_size_override("font_size", 48)
	add_child(title)

	var sub := Label.new()
	sub.text = "Milestone 1 — vertical slice"
	sub.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	sub.position = Vector2(0, h * 0.28 + 64)
	sub.size = Vector2(w, 30)
	add_child(sub)

	var help := Label.new()
	help.text = "Move: WASD / Left Stick        Shoot: Arrow Keys / Right Stick\n" \
		+ "Bomb: E / X        Start: Enter / Space / A"
	help.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	help.position = Vector2(0, h * 0.62)
	help.size = Vector2(w, 60)
	add_child(help)

	var button := Button.new()
	button.text = "Start Run"
	button.size = Vector2(200, 52)
	button.position = Vector2(w * 0.5 - 100, h * 0.46)
	button.pressed.connect(func(): start_pressed.emit())
	add_child(button)
	button.grab_focus()

func _unhandled_input(event: InputEvent) -> void:
	if event.is_action_pressed("confirm"):
		start_pressed.emit()
