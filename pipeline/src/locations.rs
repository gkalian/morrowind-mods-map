use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;

use anyhow::{Context, Result};
use serde::Serialize;
use tes3::esp::{Cell, ObjectFlags, Plugin, Region};

use crate::land::Grid;

/// Side of a Cell in game units.
pub const CELL_SIZE: f32 = 8192.0;

/// The Locations of one Plugin Set. Positions are in Cells, east and north.
#[derive(Default, Serialize)]
pub struct Locations {
    pub settlements: Vec<Settlement>,
    pub entrances: Vec<Entrance>,
    pub regions: Vec<RegionArea>,
    /// Cells that an earlier Plugin Set had named and this one renames or leaves nameless.
    pub renamed: Vec<Grid>,
}

#[derive(Serialize)]
pub struct Settlement {
    pub name: String,
    /// The Russian name, where the Russian release has one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ru: Option<String>,
    pub x: f32,
    pub y: f32,
    pub cells: Vec<Grid>,
}

#[derive(Serialize)]
pub struct Entrance {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ru: Option<String>,
    pub x: f32,
    pub y: f32,
}

#[derive(Serialize)]
pub struct RegionArea {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ru: Option<String>,
    pub color: String,
    /// Where the name is written: the middle of the Region's largest connected part.
    pub x: f32,
    pub y: f32,
    pub cells: Vec<Grid>,
    /// Set when an earlier Plugin Set already has a Region of this name: these Cells extend
    /// that Region, and the name is not shown a second time.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub continues: bool,
}

/// Collects Locations from plugins as they load. What a Plugin Set adds or changes belongs to
/// that set; what it merely repeats from an earlier set stays with the earlier one.
#[derive(Default)]
pub struct Collector {
    // The world as it stands after every plugin loaded so far.
    names: HashMap<Grid, String>,
    region_of: HashMap<Grid, String>,
    regions: HashMap<String, (String, [u8; 4])>,
    // What the current Plugin Set has added or changed.
    set_names: HashMap<Grid, String>,
    set_region_of: HashMap<Grid, String>,
    set_doors: BTreeMap<String, Vec<[f32; 2]>>,
    set_renamed: Vec<Grid>,
    // Names of the Regions that the Plugin Sets finished so far have.
    region_names: HashSet<String>,
}

impl Collector {
    pub fn load_plugin(&mut self, path: &Path) -> Result<()> {
        let plugin = Plugin::from_path_filtered(path, |tag| matches!(&tag, b"TES3" | b"CELL" | b"REGN"))
            .with_context(|| format!("loading {}", path.display()))?;

        for region in plugin.objects_of_type::<Region>() {
            self.regions
                .insert(region.id.to_ascii_lowercase(), (region.name.clone(), region.map_color));
        }

        for cell in plugin.objects_of_type::<Cell>() {
            if cell.is_interior() || cell.flags.contains(ObjectFlags::DELETED) {
                continue;
            }
            let grid = cell.data.grid;

            let before = self.names.get(&grid).map_or("", String::as_str);
            if before != cell.name {
                if !before.is_empty() && !self.set_names.contains_key(&grid) {
                    self.set_renamed.push(grid);
                }
                if cell.name.is_empty() {
                    self.names.remove(&grid);
                    self.set_names.remove(&grid);
                } else {
                    self.names.insert(grid, cell.name.clone());
                    self.set_names.insert(grid, cell.name.clone());
                }
            }

            if let Some(region) = &cell.region {
                let region = region.to_ascii_lowercase();
                if self.region_of.get(&grid) != Some(&region) {
                    self.region_of.insert(grid, region.clone());
                    self.set_region_of.insert(grid, region);
                }
            }

            for reference in cell.references.values() {
                if reference.deleted == Some(true) {
                    continue;
                }
                // Only a door into an interior names its destination Cell.
                let Some(destination) = &reference.destination else { continue };
                if destination.cell.is_empty() {
                    continue;
                }
                let [x, y, _] = reference.translation;
                self.set_doors
                    .entry(destination.cell.clone())
                    .or_default()
                    .push([x / CELL_SIZE, y / CELL_SIZE]);
            }
        }
        Ok(())
    }

    /// Returns the Locations of the Plugin Set loaded since the last call.
    /// Regions keep only Cells that have land.
    pub fn finish_set(&mut self, land: &HashSet<Grid>) -> Locations {
        let mut out = Locations::default();

        let mut by_name: BTreeMap<String, Vec<Grid>> = BTreeMap::new();
        for (grid, name) in self.set_names.drain() {
            by_name.entry(name).or_default().push(grid);
        }
        for (name, cells) in by_name {
            // Far-apart groups of Cells that share a name are separate Settlements.
            for mut part in connected_parts(&cells, true) {
                let (x, y) = middle(&part);
                part.sort_unstable();
                out.settlements.push(Settlement { name: name.clone(), ru: None, x, y, cells: part });
            }
        }

        for (name, mut positions) in std::mem::take(&mut self.set_doors) {
            positions.sort_by(|a, b| a[0].total_cmp(&b[0]).then(a[1].total_cmp(&b[1])));
            // Doors of one interior that stand within a Cell's width of each other are one Interior Entrance.
            let mut groups: Vec<Vec<[f32; 2]>> = Vec::new();
            for position in positions {
                let near = groups.iter_mut().find(|group| {
                    let [x, y] = centre(group);
                    (x - position[0]).hypot(y - position[1]) < 1.0
                });
                match near {
                    Some(group) => group.push(position),
                    None => groups.push(vec![position]),
                }
            }
            for group in groups {
                let [x, y] = centre(&group);
                out.entrances.push(Entrance { name: name.clone(), ru: None, x: round(x), y: round(y) });
            }
        }

        let mut by_region: BTreeMap<String, Vec<Grid>> = BTreeMap::new();
        for (grid, region) in self.set_region_of.drain() {
            if land.contains(&grid) {
                by_region.entry(region).or_default().push(grid);
            }
        }
        let mut set_region_names = Vec::new();
        for (id, mut cells) in by_region {
            let Some((name, color)) = self.regions.get(&id) else { continue };
            // Every Region is called "... Region"; the Map says so by how it draws the name.
            let name = name.strip_suffix(" Region").unwrap_or(name).to_string();
            let largest = connected_parts(&cells, false)
                .into_iter()
                .max_by_key(|part| (part.len(), part.iter().min().copied()))
                .unwrap_or_default();
            let (x, y) = middle(&largest);
            cells.sort_unstable();
            out.regions.push(RegionArea {
                id,
                continues: self.region_names.contains(&name),
                name: name.clone(),
                ru: None,
                color: format!("#{:02x}{:02x}{:02x}", color[0], color[1], color[2]),
                x,
                y,
                cells,
            });
            set_region_names.push(name);
        }
        self.region_names.extend(set_region_names);

        out.settlements.sort_by(|a, b| (&a.name, a.x.to_bits()).cmp(&(&b.name, b.x.to_bits())));
        out.entrances.sort_by(|a, b| (&a.name, a.x.to_bits()).cmp(&(&b.name, b.x.to_bits())));
        out.renamed = std::mem::take(&mut self.set_renamed);
        out.renamed.sort_unstable();
        out.renamed.dedup();
        out
    }
}

fn centre(positions: &[[f32; 2]]) -> [f32; 2] {
    let count = positions.len() as f32;
    [
        positions.iter().map(|p| p[0]).sum::<f32>() / count,
        positions.iter().map(|p| p[1]).sum::<f32>() / count,
    ]
}

fn round(value: f32) -> f32 {
    (value * 1000.0).round() / 1000.0
}

/// Middle of a group of Cells, in Cells.
fn middle(cells: &[Grid]) -> (f32, f32) {
    let count = cells.len().max(1) as f32;
    let x = cells.iter().map(|g| g.0 as f32 + 0.5).sum::<f32>() / count;
    let y = cells.iter().map(|g| g.1 as f32 + 0.5).sum::<f32>() / count;
    (round(x), round(y))
}

/// Splits Cells into groups of neighbours. Diagonal neighbours count when `diagonal` is set.
fn connected_parts(cells: &[Grid], diagonal: bool) -> Vec<Vec<Grid>> {
    let mut left: HashSet<Grid> = cells.iter().copied().collect();
    let mut sorted = cells.to_vec();
    sorted.sort_unstable();

    let mut parts = Vec::new();
    for start in sorted {
        if !left.remove(&start) {
            continue;
        }
        let mut part = vec![start];
        let mut next = 0;
        while next < part.len() {
            let (x, y) = part[next];
            next += 1;
            for dy in -1..=1 {
                for dx in -1..=1 {
                    if (dx, dy) == (0, 0) || (!diagonal && dx != 0 && dy != 0) {
                        continue;
                    }
                    let neighbour = (x + dx, y + dy);
                    if left.remove(&neighbour) {
                        part.push(neighbour);
                    }
                }
            }
        }
        parts.push(part);
    }
    parts
}
