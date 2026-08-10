class_name Boss
extends Enemy
## Two-phase boss.
##   Phase 1 (>50% HP): slow chase + periodic radial bullet ring.
##   Phase 2 (<=50% HP): faster, aimed 3-way spreads, and occasional charges.
## Beating it emits Events.boss_defeated, which the world turns into a trapdoor.

var _max_hp: float = 1.0
var _phase: int = 1
var _burst_cd: float = 0.0
var _charge_cd: float = 0.0
var _charge_time: float = 0.0
var _charge_dir: Vector2 = Vector2.ZERO

var burst_interval: float = 2.2
var charge_interval: float = 4.0

func configure(p_def: Dictionary) -> void:
	super.configure(p_def)
	burst_interval = float(p_def.get("burst_interval", burst_interval))
	charge_interval = float(p_def.get("charge_interval", charge_interval))

func _ready() -> void:
	super._ready()
	add_to_group("boss")
	_max_hp = hp
	_burst_cd = burst_interval
	_charge_cd = charge_interval

func health_fraction() -> float:
	return clampf(hp / maxf(_max_hp, 1.0), 0.0, 1.0)

func _ai(delta: float) -> void:
	if _phase == 1 and health_fraction() <= 0.5:
		_phase = 2  # enrage

	if _charge_time > 0.0:
		# Mid-charge: keep flying in the committed direction.
		_charge_time -= delta
		velocity = _charge_dir * speed * 3.2
		return

	var d := to_player()
	var dir := d.normalized()

	if _phase == 1:
		velocity = dir * speed * 0.6
		_burst_cd -= delta
		if _burst_cd <= 0.0:
			_radial_burst(10)
			_burst_cd = burst_interval
	else:
		velocity = dir * speed
		_burst_cd -= delta
		if _burst_cd <= 0.0:
			_spread(dir, 3, 0.28)
			_burst_cd = burst_interval * 0.7
		_charge_cd -= delta
		if _charge_cd <= 0.0 and d.length() > 1.0:
			_charge_dir = dir
			_charge_time = 0.45
			_charge_cd = charge_interval

func _radial_burst(count: int) -> void:
	var offset := rng.randf() * TAU
	for i in count:
		shoot_at(Vector2.RIGHT.rotated(offset + i * TAU / count))

func _spread(dir: Vector2, count: int, spread: float) -> void:
	var start := -spread * (count - 1) * 0.5
	for i in count:
		shoot_at(dir.rotated(start + i * spread))

func _die() -> void:
	Events.boss_defeated.emit()
	super._die()
