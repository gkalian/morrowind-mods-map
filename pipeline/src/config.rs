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
}

impl SetsFile {
    pub fn load(path: &Path) -> Result<Self> {
        let text = fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
        let file: Self = toml::from_str(&text).with_context(|| format!("parsing {}", path.display()))?;
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
