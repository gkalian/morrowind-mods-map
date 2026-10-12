# Elderscrolls Morrowind Mods Map

An interactive web map of the Morrowind game world and its large landmass mods, generated from the game's own plugin files.

## Language

### World

**Map**:
The single shared view of every landmass, laid out on the one cell grid that Morrowind and its landmass mods all use.
_Avoid_: World (UESP's per-mod "worlds" do not exist here)

**Cell**:
One square of the exterior grid, addressed by integer grid coordinates.
_Avoid_: Tile (a Tile is an image, not a piece of the game world)

**Terrain**:
The textured top-down picture of the land itself: landscape textures, vertex colour and relief shading, with water shown separately.
_Avoid_: Base map, background, imagery

**Plugin Set**:
A group of plugin files that the viewer switches on or off as one unit in the legend, such as Tamriel Rebuilt. A Plugin Set brings both its Terrain and its Locations; where it is off, the Map shows open water.
_Avoid_: Mod, addon, world, layer

**Base Set**:
The Morrowind Plugin Set, which is always on and cannot be switched off.
_Avoid_: Vanilla, MTB (Bloodmoon is its own Plugin Set and can be switched off)

**Backdrop Set**:
A Plugin Set that only fills in Terrain where other sets have none, such as the old landmass of the whole continent. It has no Locations and no switch of its own: it is shown while any of the Plugin Sets it lies under is on, and always beneath every other set.
_Avoid_: Background, base map, filler

### Locations

**Location**:
A named place shown on the Map and found by search, whether or not its Plugin Set is currently on. A Location belongs to the Plugin Set that added it or last changed it.
_Avoid_: Marker, POI, place

**Settlement**:
A Location that is a named exterior Cell, such as a town or village.
_Avoid_: City, town

**Interior Entrance**:
A Location that marks where an interior is entered from the exterior, named after that interior. Doors of one interior that stand close together are a single Interior Entrance. The interior itself is never drawn.
_Avoid_: Door, dungeon, interior

**Region**:
A Location that is a named area of the exterior spanning many Cells. It is shown by its name when the Map is zoomed far out, and as a colour tint over its Cells when the viewer switches that tint on in the legend.
_Avoid_: Zone, area, biome
