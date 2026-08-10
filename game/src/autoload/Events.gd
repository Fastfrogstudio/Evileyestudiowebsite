extends Node
## Global signal bus.
##
## Systems emit and listen here instead of referencing each other directly, so
## room generation, combat, the item system, pickups and the HUD stay
## decoupled. Autoloaded as `Events`.

# --- Run / flow ------------------------------------------------------------
signal run_started
signal player_died
signal run_won
signal floor_generated(floor_model)          # FloorGenerator.FloorModel
signal floor_descended(floor_number: int)

# --- Rooms -----------------------------------------------------------------
signal room_entered(room)                     # RoomModel
signal room_cleared(room)                     # RoomModel
signal minimap_dirty                          # discovery/visited changed

# --- Player / stats --------------------------------------------------------
signal stats_changed                          # StatBlock recomputed
signal health_changed(current: int, maximum: int)  # half-hearts
signal player_hit(amount: int)

# --- Economy / inventory ---------------------------------------------------
signal inventory_changed(coins: int, keys: int, bombs: int)
signal item_collected(item_data)              # ItemData

# --- Combat ----------------------------------------------------------------
signal enemy_died(enemy)
signal boss_defeated
