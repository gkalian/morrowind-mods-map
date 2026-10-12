# Elderscrolls Morrowind Mods Map

![The map with every mod switched on](./map.jpg)

An interactive web map of Morrowind, Bloodmoon, Tamriel Rebuilt, Project Cyrodiil and Skyrim: Home of the Nords, generated from the plugin files of the game and the mods.

The repository is large: about 700 MB in some 146,000 files. Almost all of that is map tiles in `web/public/data/tiles`, small WebP images rendered ahead of time from the landscape of the game and the mods, so that the site can be served as plain static files. The code itself is a few hundred kilobytes. Cloning takes a while; `git clone --depth 1` skips the history of earlier tile builds.

Parsing is written in Rust, frontend part in typescript.

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
