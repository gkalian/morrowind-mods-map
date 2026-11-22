use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::Deserialize;

/// Contents of `plugin-sets.toml`.
#[derive(Debug, Deserialize)]
pub struct SetsFile {
    pub cell_pixels: u32,
    pub min_zoom: u8,
    pub water: [u8; 3],
    #[serde(rename = "set")]
    pub sets: Vec<PluginSet>,
    #[serde(default)]
    pub transport: TransportConfig,
}

/// Kinds of transport the Map tells apart.
pub const TRANSPORT_MODES: [&str; 6] = ["land", "water", "air", "guild", "magic", "propylon"];

/// What the transport data needs and the plugins do not say: the `[transport]` table.
/// Keys are matched without regard to case.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TransportConfig {
    /// Transport mode of a carrier by its class id.
    #[serde(default)]
    pub classes: BTreeMap<String, String>,
    /// Transport mode of a carrier by its own id, where its class does not tell.
    #[serde(default)]
    pub actors: BTreeMap<String, String>,
    /// Transport mode of an activator that moves the player only while the player carries an
    /// item, by the id of that item; a trailing `*` matches any ending.
    #[serde(default)]
    pub gates: BTreeMap<String, String>,
    /// Dialogue topics whose answers move the player as a transport service, with their mode.
    #[serde(default)]
    pub topics: BTreeMap<String, String>,
    /// Places that exist only as interiors, shown at one point on the Map.
    #[serde(default, rename = "anchor")]
    pub anchors: Vec<Anchor>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Anchor {
    /// The interior Cells of the place: every Cell whose name starts with this.
    pub cells: String,
    /// Where the place is shown, in Cells, east and north.
    pub position: [f32; 2],
}

impl TransportConfig {
    fn validate(&self) -> Result<()> {
        let tables = [("classes", &self.classes), ("actors", &self.actors), ("gates", &self.gates), ("topics", &self.topics)];
        for (table, entries) in tables {
            for (key, mode) in entries {
                if !TRANSPORT_MODES.contains(&mode.as_str()) {
                    bail!("transport.{table}: {key} has the mode {mode}, expected one of {}", TRANSPORT_MODES.join(", "));
                }
            }
        }
        for anchor in &self.anchors {
            if anchor.cells.trim().is_empty() {
                bail!("transport.anchor: cells must name the interior Cells of a place");
            }
        }
        Ok(())
    }

    fn lookup<'a>(table: &'a BTreeMap<String, String>, key: &str) -> Option<&'a str> {
        table.iter().find(|(name, _)| name.eq_ignore_ascii_case(key)).map(|(_, mode)| mode.as_str())
    }

    /// The mode of a carrier: its own entry first, then its class.
    pub fn carrier_mode(&self, id: &str, class: &str) -> Option<&str> {
        Self::lookup(&self.actors, id).or_else(|| Self::lookup(&self.classes, class))
    }

    pub fn topic_mode(&self, topic: &str) -> Option<&str> {
        Self::lookup(&self.topics, topic)
    }

    pub fn gate_mode(&self, item: &str) -> Option<&str> {
        let item = item.to_ascii_lowercase();
        self.gates.iter().find_map(|(pattern, mode)| {
            let pattern = pattern.to_ascii_lowercase();
            let matched = match pattern.strip_suffix('*') {
                Some(prefix) => item.starts_with(prefix),
                None => item == pattern,
            };
            matched.then_some(mode.as_str())
        })
    }
}

#[derive(Debug, Deserialize)]
pub struct PluginSet {
    pub id: String,
    pub name: String,
    /// Release of the mod, shown in the legend.
    pub version: Option<String>,
    pub plugins: Vec<String>,
    #[serde(default)]
    pub archives: Vec<String>,
    #[serde(default)]
    pub default_on: bool,
    #[serde(default)]
    pub locked: bool,
    /// Ids of the Plugin Sets this one is a Backdrop Set for; empty for an ordinary set.
    #[serde(default)]
    pub backdrop_for: Vec<String>,
    /// Pixels per Cell for this set alone, when it differs from the rest.
    pub cell_pixels: Option<u32>,
    /// Exterior Cells that this set names by mistake, as `[x, y]`: they give no Settlement.
    #[serde(default)]
    pub ignore_cell_names: Vec<(i32, i32)>,
}

impl PluginSet {
    pub fn is_backdrop(&self) -> bool {
        !self.backdrop_for.is_empty()
    }
}

/// Contents of `paths.local.toml`.
#[derive(Debug, Deserialize)]
pub struct LocalPaths {
    pub game_data_files: PathBuf,
    #[serde(default)]
    pub mod_data_files: BTreeMap<String, PathBuf>,
    /// Folders of the Russian releases of the game and the mods, for the Russian names of the Locations.
    #[serde(default)]
    pub russian_data_files: Vec<PathBuf>,
}

impl SetsFile {
    pub fn load(path: &Path) -> Result<Self> {
        let text = fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
        let file: Self = toml::from_str(&text).with_context(|| format!("parsing {}", path.display()))?;
        file.transport.validate()?;
        if !matches!(file.cell_pixels, 256 | 512 | 1024 | 2048) {
            bail!("cell_pixels must be 256, 512, 1024 or 2048, got {}", file.cell_pixels);
        }
        for set in &file.sets {
            if let Some(pixels) = set.cell_pixels {
                if !matches!(pixels, 128 | 256 | 512 | 1024 | 2048) || pixels > file.cell_pixels {
                    bail!("cell_pixels of {} must be 128, 256, 512, 1024 or 2048 and at most {}", set.id, file.cell_pixels);
                }
            }
            for id in &set.backdrop_for {
                if !file.sets.iter().any(|other| &other.id == id && !other.is_backdrop()) {
                    bail!("{} is a backdrop for {id}, which is not a Plugin Set of its own", set.id);
                }
            }
        }
        Ok(file)
    }

    /// Zoom level at which one tile pixel is one rendered pixel.
    pub fn max_zoom(&self) -> u8 {
        self.cell_pixels.ilog2() as u8
    }

    pub fn cell_pixels_of(&self, set: &PluginSet) -> u32 {
        set.cell_pixels.unwrap_or(self.cell_pixels)
    }
}

impl LocalPaths {
    pub fn load(path: &Path) -> Result<Self> {
        let text = fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
        toml::from_str(&text).with_context(|| format!("parsing {}", path.display()))
    }

    /// Data directories in lookup order: the game first, then each mod.
    pub fn data_dirs(&self) -> Vec<PathBuf> {
        let mut dirs = vec![self.game_data_files.clone()];
        dirs.extend(self.mod_data_files.values().cloned());
        dirs
    }
}

/// Finds a plugin or archive by file name in the data directories.
pub fn find_file(dirs: &[PathBuf], name: &str) -> Result<PathBuf> {
    for dir in dirs {
        let path = dir.join(name);
        if path.is_file() {
            return Ok(path);
        }
    }
    bail!("{name} was not found in any data directory")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(text: &str) -> TransportConfig {
        toml::from_str(text).unwrap()
    }

    #[test]
    fn finds_carrier_modes_by_actor_before_class() {
        let config = config("classes = { Shipmaster = \"water\" }
actors = { \"Blatta Hateria\" = \"water\", skipper = \"air\" }");
        assert_eq!(config.carrier_mode("someone", "shipmaster"), Some("water"));
        assert_eq!(config.carrier_mode("SKIPPER", "shipmaster"), Some("air"));
        assert_eq!(config.carrier_mode("blatta hateria", "pauper"), Some("water"));
        assert_eq!(config.carrier_mode("someone", "pauper"), None);
    }

    #[test]
    fn matches_gate_items_by_prefix_and_reads_anchors() {
        let config = config("gates = { \"index_*\" = \"propylon\", key_exact = \"magic\" }
[[anchor]]
cells = \"Mournhold\"
position = [23.5, -27.5]");
        assert_eq!(config.gate_mode("Index_Andra"), Some("propylon"));
        assert_eq!(config.gate_mode("key_exact"), Some("magic"));
        assert_eq!(config.gate_mode("key_exact_2"), None);
        assert_eq!(config.anchors[0].cells, "Mournhold");
        assert_eq!(config.anchors[0].position, [23.5, -27.5]);
    }

    #[test]
    fn rejects_unknown_modes() {
        assert!(config("classes = { shipmaster = \"boat\" }").validate().is_err());
    }
}
