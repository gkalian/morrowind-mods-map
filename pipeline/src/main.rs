mod assets;
mod config;
mod land;
mod locations;
mod objects;
mod render;
mod tiles;

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use rayon::prelude::*;
use serde::Serialize;

use crate::assets::Assets;
use crate::config::{find_file, LocalPaths, PluginSet, SetsFile};
use crate::land::{Grid, World, TEX_SQUARES};
use crate::locations::Collector;
use crate::objects::Objects;
use crate::tiles::{Quarter, TileXY, CELL_ZOOM};

#[derive(Parser)]
#[command(about = "Builds map tiles and location data from Morrowind plugin files")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Builds the Terrain tiles and the Locations of every Plugin Set.
    Build {
        /// Repository root, holding plugin-sets.toml and paths.local.toml.
        #[arg(long, default_value = ".")]
        root: PathBuf,
        /// Output directory, relative to the root.
        #[arg(long, default_value = "web/public/data")]
        out: PathBuf,
        /// Rebuild the Locations and leave the existing Terrain tiles as they are.
        #[arg(long)]
        locations_only: bool,
        /// Render the Terrain of these Plugin Sets only, by id; the rest keep their tiles.
        #[arg(long, value_delimiter = ',')]
        only: Vec<String>,
        /// For trying things out: render only the Cells inside west,south,east,north.
        #[arg(long, value_delimiter = ',', allow_hyphen_values = true)]
        area: Vec<i32>,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    /// Changes with every build, so that browsers drop the tiles they cached from the previous one.
    build: u64,
    /// Side of a Cell in game units.
    cell_size: u32,
    min_zoom: u8,
    max_native_zoom: u8,
    water: String,
    sets: Vec<ManifestSet>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ManifestSet {
    id: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    default_on: bool,
    locked: bool,
    /// The Plugin Sets this one lies under as their Backdrop Set.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    backdrop_for: Vec<String>,
    tiles: String,
    /// Deepest zoom level this set has tiles for.
    max_native_zoom: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    locations: Option<String>,
    cells: usize,
    /// Cell grid extent, inclusive: west, south, east, north.
    bounds: [i32; 4],
    /// The Cells this set has tiles for, as x, y, x, y, ...
    land: Vec<i32>,
}

fn main() -> Result<()> {
    match Cli::parse().command {
        Command::Build { root, out, locations_only, only, area } => build(&root, &root.join(out), locations_only, &only, &area),
    }
}

fn build(root: &PathBuf, out: &PathBuf, locations_only: bool, only: &[String], area: &[i32]) -> Result<()> {
    let in_area = |grid: &Grid| match area {
        [west, south, east, north] => (*west..=*east).contains(&grid.0) && (*south..=*north).contains(&grid.1),
        _ => true,
    };
    let sets = SetsFile::load(&root.join("plugin-sets.toml"))?;
    let paths = LocalPaths::load(&root.join("paths.local.toml"))?;
    let dirs = paths.data_dirs();
    let total = Instant::now();
    println!("{} Plugin Sets, {} pixels per Cell, zoom {}..{}", sets.sets.len(), sets.cell_pixels, sets.min_zoom, sets.max_zoom());
    for dir in &dirs {
        println!("data files: {}", dir.display());
    }

    let mut assets = Assets::new(dirs.clone());
    for archive in sets.sets.iter().flat_map(|set| &set.archives) {
        let path = find_file(&dirs, archive)?;
        println!("archive: {}", path.display());
        assets.add_archive(&path)?;
    }

    let mut manifest = Manifest {
        build: SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs(),
        cell_size: 8192,
        min_zoom: sets.min_zoom,
        max_native_zoom: sets.max_zoom(),
        water: format!("#{:02x}{:02x}{:02x}", sets.water[0], sets.water[1], sets.water[2]),
        sets: Vec::new(),
    };
    let mut entries: Vec<Option<ManifestSet>> = sets.sets.iter().map(|_| None).collect();
    let mut missing_textures: Vec<String> = Vec::new();
    let mut step = 0;
    let wanted = |set: &PluginSet| !locations_only && (only.is_empty() || only.contains(&set.id));

    let mut world = World::new(sets.cell_pixels / TEX_SQUARES as u32);
    let mut collector = Collector::default();
    let mut objects = Objects::default();
    // Cells of the sets that cannot be switched off.
    let mut always_shown: HashSet<Grid> = HashSet::new();
    for (index, set) in sets.sets.iter().enumerate() {
        if set.is_backdrop() {
            continue;
        }
        let started = Instant::now();
        step += 1;
        println!("\n[{step}/{}] {}", sets.sets.len(), set.name);
        let defined = load_land(&mut world, set, &dirs, &assets)?;
        if set.locked {
            always_shown.extend(&defined);
        }
        if wanted(set) {
            for plugin in &set.plugins {
                objects.load_plugin(&find_file(&dirs, plugin)?, &assets)?;
            }
            println!("  {} models placed {} times so far", objects.models(), objects.placed());
        }

        let written = if wanted(set) {
            // Land that is there whenever this set is shown; towards anything else its edge fades out.
            let solid: HashSet<Grid> = always_shown.iter().chain(&defined).copied().collect();
            let cells: Vec<Grid> = defined.iter().copied().filter(in_area).collect();
            render_terrain(&world, Some(&objects), &cells, Some(&solid), &out.join("tiles").join(&set.id), &sets, sets.cell_pixels, started)?
        } else {
            println!("  Terrain tiles kept as they are");
            0
        };
        let bounds = bounds_of(&defined);
        println!(
            "  {} cells, {} tiles written, x {}..{}, y {}..{}, {:.1}s",
            defined.len(),
            written,
            bounds[0],
            bounds[2],
            bounds[1],
            bounds[3],
            started.elapsed().as_secs_f32()
        );

        for plugin in &set.plugins {
            collector.load_plugin(&find_file(&dirs, plugin)?)?;
        }
        let land: HashSet<Grid> = world.cells.keys().copied().collect();
        let locations = collector.finish_set(&land);
        println!(
            "  {} settlements, {} interior entrances, {} regions and {} extended from earlier sets",
            locations.settlements.len(),
            locations.entrances.len(),
            locations.regions.iter().filter(|region| !region.continues).count(),
            locations.regions.iter().filter(|region| region.continues).count()
        );
        let locations_dir = out.join("locations");
        fs::create_dir_all(&locations_dir).with_context(|| format!("creating {}", locations_dir.display()))?;
        let locations_path = locations_dir.join(format!("{}.json", set.id));
        fs::write(&locations_path, serde_json::to_string(&locations)?)
            .with_context(|| format!("writing {}", locations_path.display()))?;
        println!("  wrote {}", locations_path.display());

        entries[index] = Some(manifest_set(set, sets.max_zoom(), &defined, Some(format!("locations/{}.json", set.id))));
    }
    missing_textures.append(&mut world.missing_textures);
    drop(world);
    objects.missing_models.sort();
    println!("\n{} models could not be read", objects.missing_models.len());
    for name in objects.missing_models.iter().take(20) {
        println!("  {name}");
    }

    // A Backdrop Set is rendered on its own, so that it changes nothing in the sets it lies under.
    for (index, set) in sets.sets.iter().enumerate() {
        if !set.is_backdrop() {
            continue;
        }
        let started = Instant::now();
        step += 1;
        println!("\n[{step}/{}] {} (backdrop for {})", sets.sets.len(), set.name, set.backdrop_for.join(", "));
        let pixels = sets.cell_pixels_of(set);
        let mut world = World::new(pixels / TEX_SQUARES as u32);
        let defined = load_land(&mut world, set, &dirs, &assets)?;

        let written = if wanted(set) {
            render_terrain(&world, None, &defined, None, &out.join("tiles").join(&set.id), &sets, pixels, started)?
        } else {
            println!("  Terrain tiles kept as they are");
            0
        };
        let bounds = bounds_of(&defined);
        println!(
            "  {} cells at {pixels} pixels each, {} tiles written, x {}..{}, y {}..{}, {:.1}s",
            defined.len(),
            written,
            bounds[0],
            bounds[2],
            bounds[1],
            bounds[3],
            started.elapsed().as_secs_f32()
        );
        entries[index] = Some(manifest_set(set, pixels.ilog2() as u8, &defined, None));
        missing_textures.append(&mut world.missing_textures);
    }
    manifest.sets = entries.into_iter().flatten().collect();

    println!();
    missing_textures.sort();
    missing_textures.dedup();
    for name in &missing_textures {
        println!("warning: texture {name} could not be loaded, drawn grey");
    }

    fs::create_dir_all(out).with_context(|| format!("creating {}", out.display()))?;
    let manifest_path = out.join("manifest.json");
    fs::write(&manifest_path, serde_json::to_string(&manifest)?)
        .with_context(|| format!("writing {}", manifest_path.display()))?;
    println!("wrote {}", manifest_path.display());
    println!("done in {:.1}s", total.elapsed().as_secs_f32());
    Ok(())
}

/// Loads the landscape of a Plugin Set into the world and returns the Cells the set defines.
fn load_land(world: &mut World, set: &PluginSet, dirs: &[PathBuf], assets: &Assets) -> Result<Vec<Grid>> {
    let mut defined: Vec<Grid> = Vec::new();
    for plugin in &set.plugins {
        let path = find_file(dirs, plugin)?;
        let cells = world.load_plugin(&path, assets)?;
        println!("  {}: {} cells with landscape, {} textures so far", path.display(), cells.len(), world.textures.len());
        defined.extend(cells);
    }
    defined.sort_unstable();
    defined.dedup();
    Ok(defined)
}

/// Renders the Terrain of the given Cells into a tile folder, replacing what was there,
/// and returns how many tiles it wrote. With `solid` given, land fades out towards Cells outside it.
fn render_terrain(
    world: &World,
    objects: Option<&Objects>,
    cells: &[Grid],
    solid: Option<&HashSet<Grid>>,
    tiles_dir: &Path,
    sets: &SetsFile,
    pixels: u32,
    started: Instant,
) -> Result<usize> {
    if tiles_dir.exists() {
        fs::remove_dir_all(tiles_dir).with_context(|| format!("clearing {}", tiles_dir.display()))?;
    }
    let max_zoom = pixels.ilog2() as u8;
    println!("  rendering {} cells into {}", cells.len(), tiles_dir.display());
    let done = AtomicUsize::new(0);
    let step = (cells.len() / 10).max(1);
    let rendered: Vec<(TileXY, Quarter, usize)> = cells
        .par_iter()
        .map(|&grid| {
            let image = render::render_cell(world, objects, grid, pixels, sets.water, solid);
            let cell = tiles::write_cell(tiles_dir, grid, image, max_zoom);
            let count = done.fetch_add(1, Ordering::Relaxed) + 1;
            if count % step == 0 || count == cells.len() {
                println!("  rendered {count}/{} cells ({}%), {:.1}s", cells.len(), count * 100 / cells.len(), started.elapsed().as_secs_f32());
            }
            cell
        })
        .collect::<Result<_>>()?;

    let mut written: usize = rendered.iter().map(|cell| cell.2).sum();
    let quarters: HashMap<TileXY, Quarter> = rendered.into_iter().map(|(xy, quarter, _)| (xy, quarter)).collect();
    println!("  {written} tiles at zoom {CELL_ZOOM}..{max_zoom}, building zoom {}..{}", sets.min_zoom, CELL_ZOOM - 1);
    written += tiles::build_levels(tiles_dir, quarters, CELL_ZOOM - 1, sets.min_zoom)?;
    Ok(written)
}

/// Cell grid extent, inclusive: west, south, east, north.
fn bounds_of(cells: &[Grid]) -> [i32; 4] {
    [
        cells.iter().map(|g| g.0).min().unwrap_or(0),
        cells.iter().map(|g| g.1).min().unwrap_or(0),
        cells.iter().map(|g| g.0).max().unwrap_or(0),
        cells.iter().map(|g| g.1).max().unwrap_or(0),
    ]
}

fn manifest_set(set: &PluginSet, max_native_zoom: u8, cells: &[Grid], locations: Option<String>) -> ManifestSet {
    ManifestSet {
        id: set.id.clone(),
        name: set.name.clone(),
        version: set.version.clone(),
        default_on: set.default_on,
        locked: set.locked,
        backdrop_for: set.backdrop_for.clone(),
        tiles: format!("tiles/{}", set.id),
        max_native_zoom,
        locations,
        cells: cells.len(),
        bounds: bounds_of(cells),
        land: cells.iter().flat_map(|grid| [grid.0, grid.1]).collect(),
    }
}
