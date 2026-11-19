# Elderscrolls Morrowind Mods Map

![The map with every mod switched on](./map.jpg)

[MAP](https://tesmap.tesall.club/) | [Mirror](https://tesmap.tesall.ru/)

An interactive web map of Morrowind, Bloodmoon, Tamriel Rebuilt, Project Cyrodiil, Skyrim: Home of the Nords and a few island mods, generated from the plugin files of the game and the mods.

The map data is not in the repository: it is about 1 GB of small WebP tiles rendered ahead of time from the landscape and the models of the game and the mods. Build it with the pipeline, as described below.

Parsing is written in Rust, frontend part in typescript.

## Build the map yourself

### What you need

- [Rust](https://rustup.rs) and [Node.js](https://nodejs.org) 20.19 or newer.
- The Elder Scrolls III: Morrowind with Tribunal and Bloodmoon, installed.
- The mods, unpacked anywhere on the disk. Every one is optional except Tamriel Data, which the other mods take their textures and models from:
  - [Tamriel Data](https://www.nexusmods.com/morrowind/mods/44537)
  - [Tamriel Rebuilt](https://www.tamriel-rebuilt.org)
  - [Project Cyrodiil and Skyrim: Home of the Nords](https://www.project-tamriel.com)
  - [Tamriel](https://www.nexusmods.com/morrowind/mods/58155), the land drawn under the three mods above
  - [Solstheim Tomb of the Snow Prince](https://www.nexusmods.com/morrowind/mods/46810), the `000 Core` folder
  - [Wyrmhaven](https://www.nexusmods.com/morrowind/mods/42933)
  - [White Wolf of Lokken](https://www.nexusmods.com/morrowind/mods/27306)
  - [Lyithdonea: The Azurian Isles](https://www.nexusmods.com/morrowind/mods/43749), with [OAAB_Data](https://www.nexusmods.com/morrowind/mods/49042), the textures and models it uses

Disk space for everything, the game aside:

| What | Size |
|---|---|
| Unpacked mods | 5.9 GB |
| Map data, `web/public/data` | 1.0 GB |
| Built site, `web/dist` (a second copy of the data) | 1.0 GB |
| Rust and npm build files | 0.6 GB |
| **Total** | **about 8.5 GB** |

### 1. Say where the game and the mods are

Copy `paths.example.toml` to `paths.local.toml` in the repository root and put your paths in it. `paths.local.toml` is not committed.

Each mod path is the folder that holds the mod's `.esm` files and its `Textures` and `Meshes` folders. The plugin files that are read, and the mod versions shown on the map, are listed in `plugin-sets.toml`. To leave a mod out, delete its `[[set]]` block there and its id from `backdrop_for` of the Tamriel set; a plugin that is listed but not found stops the build.

### Russian names (optional)

The Map can show its place names in Russian. They come from the Russian releases of the game and the mods: a Russian release keeps the English Cell names inside its plugins and lists the Russian name of each one in a `.cel` file next to the plugin, and the game's Russian plugins also hold the Russian Region names. List the folders with those `.cel` files and plugins under `russian_data_files` in `paths.local.toml`, as in `paths.example.toml`. Without them the Russian Map shows the English names.

### 2. Render the map data

```
cargo run --release --manifest-path pipeline/Cargo.toml -- build
```

A full build of all ten Plugin Sets takes about 12 minutes and writes 162,000 tiles. The first run also compiles the pipeline, a few minutes more. 

| Plugin Set | Tiles |
|---|---|
| Morrowind | 0.15 GB |
| Bloodmoon | 0.03 GB |
| Tamriel Rebuilt | 0.45 GB |
| Project Cyrodiil | 0.05 GB |
| Skyrim: Home of the Nords | 0.09 GB |
| Tamriel | 0.13 GB |
| Solstheim Tomb of the Snow Prince | 0.03 GB |
| Wyrmhaven | 0.01 GB |
| White Wolf of Lokken | 0.005 GB |
| Lyithdonea: The Azurian Isles | 0.06 GB |

To rebuild a part only:

- `--only tr,pc` renders the named Plugin Sets and keeps the tiles of the rest. The ids are in `plugin-sets.toml`.
- `--locations-only` skips the tiles and rewrites the places, regions and doors only, with their Russian names.
- `--area -3,-12,6,-5` renders the Cells inside west,south,east,north only, for trying things out.

The build also creates transport data from the same plugins. To update only the transport data without rerendering the terrain, run:

```
cargo run --release --manifest-path pipeline/Cargo.toml -- transport
```

The map shows direct land, water, sky lantern, guild, magical and propylon services when enabled in the legend. It also includes confirmed restricted transport services from Tamriel Rebuilt. When Tribunal.esm is available, the departure to Mournhold appears at Ebonheart; the destination is an approximate point on the mainland backdrop, not a map of the city itself. Availability can depend on quests, scripts and the versions of the active mods; routes available only during a specific quest are omitted. The lines are schematic and do not show the actual route taken. Propylon links require the destination's index. If an enabled plugin includes the Master Index scripts or Folms Mirel's transport dialogue, confirmed journeys to and from Caldera are also shown. Other services implemented only in scripts or dialogue and carriers with an unrecognised service class are not inferred. Data for missing optional plugin sets is skipped. A map built before transport support keeps working without the transport layer.

The route planner under Transport in the legend finds up to three transport alternatives between named locations or points picked on the map, using the enabled plugin sets and transport modes. It estimates walking as a straight line, allowing up to 8 cells to reach a stop and 1.5 cells for a transfer. It does not account for roads, terrain, water, travel costs, quest progress or items the player carries; route conditions are shown where known.

When both Project Cyrodiil and Tamriel Rebuilt are enabled, the shipmaster for Anvil is shown in Old Ebonheart, as specified by the Cyrodiil installation script. Without Tamriel Rebuilt, the departure is shown in Ebonheart. The corresponding return service changes with the same selection.

To include propylon script overrides, Folms Mirel's transport dialogue and intervention markers from a plugin that is not in `plugin-sets.toml`, put the plugin in one of the configured data directories and add `--propylon-addon` when regenerating transport data, for example `cargo run --release --manifest-path pipeline/Cargo.toml -- transport --propylon-addon MFR.esm`. To include it automatically in subsequent full and transport-only builds, add `transport_addons = ['MFR.esm']` to `paths.local.toml` before the `[mod_data_files]` section. Addons are applied after the enabled map modules for intervention markers; other changes in an addon are not included. The game files are read only.

The Intervention section shows Almsivi and Divine Intervention markers from the enabled modules. Choose a named location or a point on the map to see both estimated destinations and enable either marker type to draw it. The calculation follows the exterior-cell spiral used by OpenMW; interior destinations, blocked teleportation, other plugins and changes made while playing can produce a different result. Mournhold's interior markers are not placed on the exterior map. If the transport data predates intervention support, regenerate it using the command above.

The size and the time depend on `cell_pixels` in `plugin-sets.toml`, the pixels per game Cell at the deepest zoom. It is 1024; doubling it to 2048 gives sharper textures up close at roughly four times the size and three times the time.

### 3. Look at it

```
cd web
npm install
npm run dev
```

and open the address it prints.

## Licence

The code is under the [MIT licence](./LICENSE). The map tiles and location data are derived from The Elder Scrolls III: Morrowind (Bethesda Softworks) and the mods shown, and are not covered by it.
