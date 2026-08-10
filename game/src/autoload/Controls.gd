extends Node
## Registers all input actions in code (keyboard + gamepad) so project.godot
## stays simple and the bindings live next to their documentation.
##
## Movement:  WASD              or  left stick
## Shooting:  Arrow keys        or  right stick   (twin-stick, Isaac-style)
## Bomb:      E                 or  gamepad X/Square
## Confirm:   Enter/Space       or  gamepad A/Cross
## Restart:   R (on end screen)

func _ready() -> void:
	_axis("move_left", "move_right", 0)     # left stick X
	_axis("move_up", "move_down", 1)        # left stick Y
	_axis("shoot_left", "shoot_right", 2)   # right stick X
	_axis("shoot_up", "shoot_down", 3)      # right stick Y

	_key("move_left", KEY_A)
	_key("move_right", KEY_D)
	_key("move_up", KEY_W)
	_key("move_down", KEY_S)

	_key("shoot_left", KEY_LEFT)
	_key("shoot_right", KEY_RIGHT)
	_key("shoot_up", KEY_UP)
	_key("shoot_down", KEY_DOWN)

	_ensure("bomb")
	_key("bomb", KEY_E)
	_joy_button("bomb", JOY_BUTTON_X)

	_ensure("confirm")
	_key("confirm", KEY_ENTER)
	_key("confirm", KEY_SPACE)
	_joy_button("confirm", JOY_BUTTON_A)

	_ensure("restart")
	_key("restart", KEY_R)
	_joy_button("restart", JOY_BUTTON_Y)

	_ensure("pause")
	_key("pause", KEY_ESCAPE)
	_joy_button("pause", JOY_BUTTON_START)

func _ensure(action: StringName) -> void:
	if not InputMap.has_action(action):
		InputMap.add_action(action)

## Bind a negative/positive stick axis pair to two actions.
func _axis(neg_action: StringName, pos_action: StringName, axis: int) -> void:
	_ensure(neg_action)
	_ensure(pos_action)
	var neg := InputEventJoypadMotion.new()
	neg.axis = axis
	neg.axis_value = -1.0
	InputMap.action_add_event(neg_action, neg)
	var pos := InputEventJoypadMotion.new()
	pos.axis = axis
	pos.axis_value = 1.0
	InputMap.action_add_event(pos_action, pos)

func _key(action: StringName, keycode: int) -> void:
	_ensure(action)
	var ev := InputEventKey.new()
	ev.physical_keycode = keycode
	InputMap.action_add_event(action, ev)

func _joy_button(action: StringName, button: int) -> void:
	_ensure(action)
	var ev := InputEventJoypadButton.new()
	ev.button_index = button
	InputMap.action_add_event(action, ev)
