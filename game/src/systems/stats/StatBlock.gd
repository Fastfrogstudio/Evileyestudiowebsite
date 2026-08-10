class_name StatBlock
extends RefCounted
## The player's live stats, recomputed from base values plus every item held.
##
## Item modifiers STACK: additive bonuses sum, multiplicative bonuses multiply.
## This keeps the item system data-driven (see ItemData) and decoupled — the
## player only ever reads the final numbers here.

# Final computed stats.
var max_health: int          # half-hearts
var damage: float
var tears: float             # shots per second
var shot_speed: float        # px/s
var range: float             # px of travel
var move_speed: float        # px/s

# Stat keys used by item modifier dictionaries.
const STATS := ["max_health", "damage", "tears", "shot_speed", "range", "move_speed"]

func _init() -> void:
	recompute([])

func _base() -> Dictionary:
	return {
		"max_health": float(GameConfig.PLAYER_START_MAX_HEALTH),
		"damage": GameConfig.PLAYER_BASE_DAMAGE,
		"tears": GameConfig.PLAYER_BASE_TEARS,
		"shot_speed": GameConfig.PLAYER_BASE_SHOT_SPEED,
		"range": GameConfig.PLAYER_BASE_RANGE,
		"move_speed": GameConfig.PLAYER_BASE_MOVE_SPEED,
	}

## Recompute every stat from base + the given list of ItemData.
func recompute(items: Array) -> void:
	var adds := {}
	var mults := {}
	for s in STATS:
		adds[s] = 0.0
		mults[s] = 1.0

	for item in items:
		if item == null:
			continue
		for stat in item.modifiers.keys():
			if not STATS.has(stat):
				continue
			var m: Dictionary = item.modifiers[stat]
			adds[stat] += float(m.get("add", 0.0))
			mults[stat] *= float(m.get("mult", 1.0))

	var base := _base()
	var final := {}
	for s in STATS:
		final[s] = (base[s] + adds[s]) * mults[s]

	# Apply sane clamps so items can't break the game.
	max_health = maxi(2, int(round(final["max_health"])))
	damage = maxf(0.5, final["damage"])
	tears = clampf(final["tears"], 0.5, 12.0)
	shot_speed = maxf(120.0, final["shot_speed"])
	range = maxf(120.0, final["range"])
	move_speed = clampf(final["move_speed"], 80.0, 520.0)

## Seconds between shots.
func fire_delay() -> float:
	return 1.0 / maxf(tears, 0.05)

## How long a tear lives before it despawns (range / speed).
func tear_lifetime() -> float:
	return range / maxf(shot_speed, 1.0)
