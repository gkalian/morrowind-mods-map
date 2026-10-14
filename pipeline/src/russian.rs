use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use encoding_rs::{WINDOWS_1251, WINDOWS_1252};
use tes3::esp::{Plugin, Region};

use crate::config::SetsFile;
use crate::locations::Locations;

/// Russian names of the Locations, taken from the Russian releases of the game and the mods.
///
/// A Russian release keeps the English Cell names in its plugins, so that scripts still find
/// them, and lists the Russian name of each Cell in a `.cel` file next to the plugin: one
/// `English<TAB>Russian` line per name, in Windows-1251. Region names are translated in the
/// plugins themselves in the game, and only in the `.cel` files in the mods.
#[derive(Default)]
pub struct Russian {
    /// By the English name in lower case.
    cells: HashMap<String, String>,
    /// By Region id in lower case.
    regions: HashMap<String, String>,
}

impl Russian {
    /// Reads every `.cel` file in the directories, and the Regions of those plugins of the
    /// Plugin Sets that the directories hold in Russian. Earlier directories win.
    pub fn load(dirs: &[PathBuf], sets: &SetsFile) -> Result<Self> {
        let mut russian = Self::default();
        for dir in dirs {
            let entries = fs::read_dir(dir).with_context(|| format!("reading {}", dir.display()))?;
            let mut files: Vec<PathBuf> = entries.filter_map(|entry| entry.ok().map(|entry| entry.path())).collect();
            files.sort();
            for path in files.iter().filter(|path| has_extension(path, "cel")) {
                let count = russian.read_cel(path)?;
                println!("russian names: {}, {count} names", path.display());
            }
            for plugin in sets.sets.iter().flat_map(|set| &set.plugins) {
                let Some(path) = files.iter().find(|path| file_name_is(path, plugin)) else { continue };
                let count = russian.read_regions(path)?;
                println!("russian names: {}, {count} regions", path.display());
            }
        }
        Ok(russian)
    }

    fn read_cel(&mut self, path: &Path) -> Result<usize> {
        let bytes = fs::read(path).with_context(|| format!("reading {}", path.display()))?;
        let (text, _, _) = WINDOWS_1251.decode(&bytes);
        let mut count = 0;
        for line in text.lines() {
            let Some((english, russian)) = line.split_once('\t') else { continue };
            let russian = russian.trim();
            if !russian.is_empty() {
                self.cells.entry(english.trim().to_lowercase()).or_insert_with(|| russian.to_string());
                count += 1;
            }
        }
        Ok(count)
    }

    fn read_regions(&mut self, path: &Path) -> Result<usize> {
        let plugin = Plugin::from_path_filtered(path, |tag| matches!(&tag, b"TES3" | b"REGN"))
            .with_context(|| format!("loading {}", path.display()))?;
        let mut count = 0;
        for region in plugin.objects_of_type::<Region>() {
            // The plugin reader takes every text for Windows-1252; turned back into bytes, it is Windows-1251.
            let (bytes, _, _) = WINDOWS_1252.encode(&region.name);
            let (name, _, _) = WINDOWS_1251.decode(&bytes);
            // A mod's Russian plugin keeps the English Region names.
            if name.chars().any(|c| ('\u{0400}'..='\u{04ff}').contains(&c)) {
                self.regions.entry(region.id.to_ascii_lowercase()).or_insert_with(|| name.into_owned());
                count += 1;
            }
        }
        Ok(count)
    }

    fn cell(&self, english: &str) -> Option<String> {
        self.cells.get(&english.to_lowercase()).cloned()
    }

    /// Adds the Russian names it has to the Locations of a Plugin Set.
    pub fn translate(&self, locations: &mut Locations) {
        for settlement in &mut locations.settlements {
            settlement.ru = self.cell(&settlement.name);
        }
        for entrance in &mut locations.entrances {
            entrance.ru = self.cell(&entrance.name);
        }
        for region in &mut locations.regions {
            // The English name has lost its " Region"; the Russian one keeps its «Район»,
            // as what is left of it would be in the wrong case.
            region.ru = self
                .regions
                .get(&region.id)
                .cloned()
                .or_else(|| self.cell(&format!("{} Region", region.name)))
                .or_else(|| self.cell(&region.name));
        }
    }

    /// How many Locations of a Plugin Set have no Russian name.
    pub fn untranslated(locations: &Locations) -> usize {
        locations.settlements.iter().filter(|s| s.ru.is_none()).count()
            + locations.entrances.iter().filter(|e| e.ru.is_none()).count()
            + locations.regions.iter().filter(|r| r.ru.is_none()).count()
    }
}

fn has_extension(path: &Path, extension: &str) -> bool {
    path.extension().is_some_and(|found| found.eq_ignore_ascii_case(extension))
}

fn file_name_is(path: &Path, name: &str) -> bool {
    path.file_name().is_some_and(|found| found.eq_ignore_ascii_case(name))
}
