class_name Shooter
extends Enemy
## Keeps its distance and fires projectiles at the player. Strafes when already
## at its preferred range so it feels alive rather than static.

var _cooldown: float = 0.0
var _strafe_sign: float = 1.0
var preferred_distance: float = 220.0
var fire_cooldown: float = 1.3
var fire_distance: float = 480.0

func configure(p_def: Dictionary) -> void:
	super.configure(p_def)
	preferred_distance = float(p_def.get("preferred_distance", preferred_distance))
	fire_distance = float(p_def.get("fire_distance", fire_distance))
	var pd: Dictionary = p_def.get("projectile", {})
	fire_cooldown = float(pd.get("cooldown", fire_cooldown))

func _ready() -> void:
	super._ready()
	_strafe_sign = 1.0 if rng.randf() < 0.5 else -1.0

func _ai(delta: float) -> void:
	var d := to_player()
	var dist := d.length()
	var dir := d.normalized()
	if dist > preferred_distance + 40.0:
		velocity = dir * speed
	elif dist < preferred_distance - 40.0:
		velocity = -dir * speed
	else:
		velocity = dir.rotated(PI * 0.5) * speed * _strafe_sign * 0.7

	_cooldown -= delta
	if _cooldown <= 0.0 and dist < fire_distance and dist > 1.0:
		shoot_at(dir)
		_cooldown = fire_cooldown
