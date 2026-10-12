# Elderscrolls Morrowind Mods Map

![The map with every mod switched on](./map.jpg)

An interactive web map of Morrowind, Bloodmoon, Tamriel Rebuilt, Project Cyrodiil and Skyrim: Home of the Nords, generated from the plugin files of the game and the mods.

## Run the site

```
cd web
npm install
npm run dev
```

## Rebuild the map data

Needs Morrowind and the mods installed. Copy `paths.example.toml` to `paths.local.toml` in the repository root and put their locations in it. `paths.local.toml` is not committed.

Then run:

```
cargo run --release --manifest-path pipeline/Cargo.toml -- build
```

`--only tr,pc` renders the named Plugin Sets only; `--locations-only` skips the tiles. The Plugin Sets are listed in `plugin-sets.toml`.

## Licence

The code is under the [MIT licence](./LICENSE). The map tiles and location data are derived from The Elder Scrolls III: Morrowind (Bethesda Softworks) and the mods shown, and are not covered by it.
