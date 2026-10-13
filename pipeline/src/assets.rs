use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use image::imageops::FilterType;
use image::ImageFormat;
use tes3::bsa::Archive;

/// Reads texture and model files the way the game does: loose files first, then archives.
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
        let image = self.decode(file_name)?;
        let small = image.resize_exact(size, size, FilterType::Lanczos3).to_rgb8();
        Ok(small.pixels().map(|p| [p[0] as f32, p[1] as f32, p[2] as f32]).collect())
    }

    /// Loads a texture at its own size, with its transparency.
    pub fn load_image(&self, file_name: &str) -> Result<image::RgbaImage> {
        Ok(self.decode(file_name)?.to_rgba8())
    }

    /// Reads a file by its path inside the data files, such as `meshes\x\ex_vivec_h_01.nif`.
    pub fn read(&self, relative: &str) -> Option<Vec<u8>> {
        for dir in &self.dirs {
            if let Ok(bytes) = fs::read(dir.join(relative)) {
                return Some(bytes);
            }
        }
        // Later archives override earlier ones.
        self.archives
            .iter()
            .rev()
            .find_map(|archive| archive.get(relative))
            .map(|entry| entry.as_bytes().to_vec())
    }

    fn decode(&self, file_name: &str) -> Result<image::DynamicImage> {
        let (bytes, ext) = self
            .find_texture(file_name)
            .with_context(|| format!("texture {file_name} not found"))?;
        let format = match ext.as_str() {
            "dds" => ImageFormat::Dds,
            "tga" => ImageFormat::Tga,
            "bmp" => ImageFormat::Bmp,
            _ => ImageFormat::Png,
        };
        image::load_from_memory_with_format(&bytes, format)
            .or_else(|_| image::load_from_memory(&bytes))
            .with_context(|| format!("decoding texture {file_name}"))
    }

    /// Records name a `.tga`, but the shipped file is usually a `.dds` with the same stem.
    fn find_texture(&self, file_name: &str) -> Option<(Vec<u8>, String)> {
        let name = file_name.replace('/', "\\").to_ascii_lowercase();
        // Models sometimes name their textures with the folder, landscape records never do.
        let name = name.strip_prefix("textures\\").unwrap_or(&name).to_string();
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
