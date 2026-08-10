extends Node
## Asset loading helper. Autoloaded as `Assets`.
##
## Every visual first tries to load a real texture from res://assets/... and
## falls back to a coloured placeholder shape if the file is not there yet.
## That means you can drop your Cult of the Lamb-style PNGs into game/assets/
## (== res://assets/) at any time and they replace the placeholders with no
## code changes. See ASSETS.md for the exact filenames and sizes.

const BASE := "res://assets/"

## Returns a Texture2D for a path relative to res://assets/, or null if missing.
func tex(relative_path: String) -> Texture2D:
	var path := BASE + relative_path
	if ResourceLoader.exists(path, "Texture2D"):
		var res := ResourceLoader.load(path)
		if res is Texture2D:
			return res
	return null

## Builds a Sprite2D for `relative_path` scaled so its height matches
## `target_height` px and anchored at the feet (bottom-centre) when requested.
## Returns null if the texture is missing so callers can fall back to a shape.
func sprite(relative_path: String, target_height: float, anchor_feet: bool = true) -> Sprite2D:
	var t := tex(relative_path)
	if t == null:
		return null
	var s := Sprite2D.new()
	s.texture = t
	s.texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR  # smooth, not pixel-art
	var h := float(t.get_height())
	if h > 0.0:
		var scale := target_height / h
		s.scale = Vector2(scale, scale)
	if anchor_feet:
		# Move the pivot to the bottom-centre so characters "stand" at their
		# world position (matching the storybook 3/4 look).
		s.offset = Vector2(0, -t.get_height() * 0.5)
	return s
