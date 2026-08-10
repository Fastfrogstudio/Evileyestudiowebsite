class_name Bomb
extends Node2D
## A placed bomb. Fuses, then damages every enemy, rock and (if too close) the
## player within its blast radius.

static func spawn(parent: Node, position: Vector2) -> Bomb:
	var b := Bomb.new()
	parent.add_child(b)
	b.global_position = position
	return b

func _ready() -> void:
	var spr := Assets.sprite("items/bomb.png", GameConfig.pickup_radius * 2.2, false)
	if spr != null:
		add_child(spr)
	else:
		add_child(Placeholder.new().setup(Placeholder.Shape.CIRCLE,
			GameConfig.COL_BOMB, GameConfig.pickup_radius))
	_fuse()

func _fuse() -> void:
	# Blink faster as the fuse burns down.
	var t := 0.0
	while t < GameConfig.BOMB_FUSE:
		var step := 0.12
		await get_tree().create_timer(step).timeout
		if not is_inside_tree():
			return
		t += step
		modulate = Color(1.6, 0.6, 0.6) if int(t / step) % 2 == 0 else Color.WHITE
	_explode()

func _explode() -> void:
	var r := GameConfig.BOMB_RADIUS
	for enemy in get_tree().get_nodes_in_group("enemies"):
		if is_instance_valid(enemy) and enemy.global_position.distance_to(global_position) <= r:
			if enemy.has_method("take_damage"):
				enemy.take_damage(GameConfig.BOMB_DAMAGE)
	for rock in get_tree().get_nodes_in_group("rocks"):
		if is_instance_valid(rock) and rock.global_position.distance_to(global_position) <= r:
			if rock.has_method("destroy"):
				rock.destroy()
	var p := get_tree().get_first_node_in_group("player")
	if p != null and p.global_position.distance_to(global_position) <= r:
		if p.has_method("take_damage"):
			p.take_damage(GameConfig.BOMB_SELF_DAMAGE)

	_flash()
	queue_free()

func _flash() -> void:
	# Short-lived blast visual that cleans itself up.
	var blast := Placeholder.new().setup(Placeholder.Shape.CIRCLE,
		Color(1.0, 0.7, 0.3, 0.75), GameConfig.BOMB_RADIUS)
	get_parent().add_child(blast)
	blast.global_position = global_position
	var tw := blast.create_tween()
	tw.tween_property(blast, "modulate:a", 0.0, 0.25)
	tw.tween_callback(blast.queue_free)
