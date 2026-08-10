extends Node
## Top-level game flow: Title -> Run -> Death/Victory -> back to Title.
## Everything for the current screen lives under _container so switching states
## is just "free the old, build the new".

enum State { TITLE, PLAYING, GAMEOVER, VICTORY }

var state: int = State.TITLE
var _container: Node

func _ready() -> void:
	_container = Node.new()
	_container.name = "Screen"
	add_child(_container)

	Events.player_died.connect(_on_player_died)
	Events.run_won.connect(_on_run_won)

	_show_title()

func _clear() -> void:
	for child in _container.get_children():
		child.queue_free()

func _show_title() -> void:
	_clear()
	state = State.TITLE
	var title := TitleScreen.new()
	_container.add_child(title)
	title.start_pressed.connect(_start_run, CONNECT_ONE_SHOT)

func _start_run() -> void:
	_clear()
	state = State.PLAYING
	GameState.start_run()
	# HUD first so the minimap exists to receive the first room_entered signal
	# emitted while GameWorld builds the starting room.
	_container.add_child(HUD.new())
	_container.add_child(GameWorld.new())

func _on_player_died() -> void:
	if state != State.PLAYING:
		return
	state = State.GAMEOVER
	_show_end(false)

func _on_run_won() -> void:
	if state != State.PLAYING:
		return
	state = State.VICTORY
	_show_end(true)

func _show_end(victory: bool) -> void:
	_clear()
	var end := EndScreen.new().setup(victory)
	_container.add_child(end)
	end.restart_pressed.connect(_show_title, CONNECT_ONE_SHOT)
