class_name Player
extends CharacterBody2D
## The player. Twin-input: WASD/left-stick to move, arrow keys/right-stick to
## shoot in four directions. All numbers come from GameState.stats, so items
## change how the player feels without touching this script.

var _fire_cd: float = 0.0
var _invincible: float = 0.0
var _hurtbox: Area2D
var _visual: Node2D

func _ready() -> void:
	add_to_group("player")
	set_collision_layer_value(2, true)   # player layer
	set_collision_mask_value(1, true)    # collide with walls only

	var shape := CircleShape2D.new()
	shape.radius = GameConfig.player_radius
	var cs := CollisionShape2D.new()
	cs.shape = shape
	add_child(cs)

	var spr := Assets.sprite("player/player.png", GameConfig.player_radius * 2.6)
	if spr != null:
		_visual = spr
	else:
		_visual = Placeholder.new().setup(Placeholder.Shape.CIRCLE,
			GameConfig.COL_PLAYER, GameConfig.player_radius)
	add_child(_visual)

	# Separate area that senses enemy bodies for contact damage.
	_hurtbox = Area2D.new()
	_hurtbox.collision_layer = 0
	_hurtbox.set_collision_mask_value(3, true)   # enemies
	_hurtbox.monitoring = true
	var hcs := CollisionShape2D.new()
	var hshape := CircleShape2D.new()
	hshape.radius = GameConfig.player_radius * 0.9
	hcs.shape = hshape
	_hurtbox.add_child(hcs)
	add_child(_hurtbox)

func _physics_process(delta: float) -> void:
	if GameState.is_dead:
		velocity = Vector2.ZERO
		return

	# --- Move ---
	var move := Input.get_vector("move_left", "move_right", "move_up", "move_down")
	velocity = move * GameState.stats.move_speed
	move_and_slide()

	# --- Shoot ---
	_fire_cd = maxf(0.0, _fire_cd - delta)
	var aim := Input.get_vector("shoot_left", "shoot_right", "shoot_up", "shoot_down")
	if aim.length() > 0.3 and _fire_cd <= 0.0:
		_fire(aim)
		_fire_cd = GameState.stats.fire_delay()

	# --- Bomb ---
	if Input.is_action_just_pressed("bomb") and GameState.use_bomb():
		Bomb.spawn(_room(), global_position)

	# --- I-frames / contact damage ---
	if _invincible > 0.0:
		_invincible = maxf(0.0, _invincible - delta)
		_visual.modulate.a = 0.4 if int(_invincible * 20.0) % 2 == 0 else 1.0
		if _invincible == 0.0:
			_visual.modulate.a = 1.0
	else:
		_check_contact()

func _fire(aim: Vector2) -> void:
	var dir := aim.normalized()
	if GameConfig.SHOOTING_SNAP_TO_4DIR:
		dir = _snap4(aim)
	var st := GameState.stats
	Projectile.spawn(_room(), {
		"hostile": false,
		"position": global_position + dir * (GameConfig.player_radius + 4.0),
		"direction": dir,
		"speed": st.shot_speed,
		"damage": st.damage,
		"lifetime": st.tear_lifetime(),
		"radius": GameConfig.projectile_radius,
	})

func _snap4(v: Vector2) -> Vector2:
	if absf(v.x) >= absf(v.y):
		return Vector2(signf(v.x), 0.0)
	return Vector2(0.0, signf(v.y))

func _check_contact() -> void:
	for body in _hurtbox.get_overlapping_bodies():
		if body.is_in_group("enemies"):
			var dmg := 1
			if "touch_damage" in body:
				dmg = body.touch_damage
			take_damage(dmg)
			return

func take_damage(amount: int) -> void:
	if _invincible > 0.0 or GameState.is_dead:
		return
	GameState.apply_damage(amount)
	_invincible = GameConfig.PLAYER_IFRAMES

## The node new projectiles/bombs are parented to: the current room, so they
## are cleaned up automatically on a room transition.
func _room() -> Node:
	var r := get_tree().get_first_node_in_group("room_root")
	return r if r != null else get_parent()
