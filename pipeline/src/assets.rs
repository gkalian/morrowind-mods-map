use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use image::imageops::FilterType;
use image::ImageFormat;
use tes3::bsa::Archive;

/// Reads landscape texture files the way the game does: loose files first, then archives.
pub struct Assets {
    dirs: Vec<PathBuf>,
    archives: Vec<Archive<'static>>,
}

impl Assets {
    pub fn new(dirs: Vec<PathBuf>) -> Self {
        Self { dirs, archives: Vec::new() }
    }

    pub fn add_archive(&mut self, path: &Path) -> Result<()> {
        let archive = Archive::from_path(path).with_context(|| format!("opening {}", path.display()))?;
        self.archives.push(archive);
        Ok(())
    }

    /// Loads a landscape texture and shrinks it to `size` x `size` RGB pixels.
    pub fn load_texture(&self, file_name: &str, size: u32) -> Result<Vec<[f32; 3]>> {
        let (bytes, ext) = self
            .find_texture(file_name)
            .with_context(|| format!("texture {file_name} not found"))?;
        let format = match ext.as_str() {
            "dds" => ImageFormat::Dds,
            "tga" => ImageFormat::Tga,
            "bmp" => ImageFormat::Bmp,
            _ => ImageFormat::Png,
        };
        let image = image::load_from_memory_with_format(&bytes, format)
            .or_else(|_| image::load_from_memory(&bytes))
            .with_context(|| format!("decoding texture {file_name}"))?;
        let small = image.resize_exact(size, size, FilterType::Lanczos3).to_rgb8();
        Ok(small.pixels().map(|p| [p[0] as f32, p[1] as f32, p[2] as f32]).collect())
    }

    /// Records name a `.tga`, but the shipped file is usually a `.dds` with the same stem.
    fn find_texture(&self, file_name: &str) -> Option<(Vec<u8>, String)> {
        let name = file_name.replace('/', "\\").to_ascii_lowercase();
        let stem = name.rsplit_once('.').map_or(name.as_str(), |(stem, _)| stem);
        let own_ext = name.rsplit_once('.').map_or("", |(_, ext)| ext);

        let mut exts = vec![own_ext, "dds", "tga", "bmp"];
        exts.dedup();

        for ext in exts.iter().filter(|ext| !ext.is_empty()) {
            let relative = format!("textures\\{stem}.{ext}");
            for dir in &self.dirs {
                if let Ok(bytes) = fs::read(dir.join(&relative)) {
                    return Some((bytes, (*ext).to_string()));
                }
            }
        }
        for ext in exts.iter().filter(|ext| !ext.is_empty()) {
            let relative = format!("textures\\{stem}.{ext}");
            // Later archives override earlier ones.
            for archive in self.archives.iter().rev() {
                if let Some(entry) = archive.get(&relative) {
                    return Some((entry.as_bytes().to_vec(), (*ext).to_string()));
                }
            }
        }
        None
    }
}
