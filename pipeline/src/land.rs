use std::collections::HashMap;
use std::path::Path;

use anyhow::{Context, Result};
use tes3::esp::{Landscape, LandscapeFlags, LandscapeTexture, ObjectFlags, Plugin};

use crate::assets::Assets;

pub type Grid = (i32, i32);

/// Number of landscape texture squares along one side of a Cell.
pub const TEX_SQUARES: usize = 16;
/// Number of height samples along one side of a Cell.
pub const VERTS: usize = 65;

const DEFAULT_TEXTURE: &str = "_land_default.tga";

/// The landscape of one Cell. Rows run south to north, columns west to east.
pub struct CellLand {
    pub heights: Box<[[f32; VERTS]; VERTS]>,
    pub normals: Box<[[[i8; 3]; VERTS]; VERTS]>,
    pub colors: Option<Box<[[[u8; 3]; VERTS]; VERTS]>>,
    /// Indices into `World::textures`.
    pub textures: [[u16; TEX_SQUARES]; TEX_SQUARES],
}

/// A landscape texture shrunk to the size one texture square takes on the Map.
pub struct Texture {
    pub pixels: Vec<[f32; 3]>,
}

/// Every Cell's landscape as it stands after the plugins loaded so far.
pub struct World {
    pub cells: HashMap<Grid, CellLand>,
    pub textures: Vec<Texture>,
    texture_ids: HashMap<String, u16>,
    texture_pixels: u32,
    pub missing_textures: Vec<String>,
}

impl World {
    /// `texture_pixels` is the side of one texture square in output pixels.
    pub fn new(texture_pixels: u32) -> Self {
        Self {
            cells: HashMap::new(),
            textures: Vec::new(),
            texture_ids: HashMap::new(),
            texture_pixels,
            missing_textures: Vec::new(),
        }
    }

    /// Loads one plugin's landscape over what is already there and returns the Cells it defines.
    pub fn load_plugin(&mut self, path: &Path, assets: &Assets) -> Result<Vec<Grid>> {
        let plugin = Plugin::from_path_filtered(path, |tag| matches!(&tag, b"TES3" | b"LTEX" | b"LAND"))
            .with_context(|| format!("loading {}", path.display()))?;

        // Texture numbers in a landscape record are local to the plugin that holds it.
        let mut local: HashMap<u32, u16> = HashMap::new();
        for ltex in plugin.objects_of_type::<LandscapeTexture>() {
            let id = self.texture_id(&ltex.file_name, assets);
            local.insert(ltex.index, id);
        }
        let default_id = self.texture_id(DEFAULT_TEXTURE, assets);

        let mut defined = Vec::new();
        for land in plugin.objects_of_type::<Landscape>() {
            if land.flags.contains(ObjectFlags::DELETED) {
                continue;
            }
            if !land
                .landscape_flags
                .contains(LandscapeFlags::USES_VERTEX_HEIGHTS_AND_NORMALS)
            {
                continue;
            }

            let mut textures = [[default_id; TEX_SQUARES]; TEX_SQUARES];
            if land.landscape_flags.contains(LandscapeFlags::USES_TEXTURES) {
                // The record stores the squares in 4x4 blocks rather than row by row.
                let raw = land.texture_indices.data.as_flattened();
                let mut next = 0;
                for block_y in 0..4 {
                    for block_x in 0..4 {
                        for y in 0..4 {
                            for x in 0..4 {
                                let value = raw[next];
                                next += 1;
                                // Zero means the default texture, anything else is a texture number plus one.
                                let id = match value {
                                    0 => default_id,
                                    n => local.get(&(u32::from(n) - 1)).copied().unwrap_or(default_id),
                                };
                                textures[block_y * 4 + y][block_x * 4 + x] = id;
                            }
                        }
                    }
                }
            }

            let colors = land
                .landscape_flags
                .contains(LandscapeFlags::USES_VERTEX_COLORS)
                .then(|| land.vertex_colors.data.clone());

            self.cells.insert(
                land.grid,
                CellLand {
                    heights: land.decode_vertex_heights(),
                    normals: land.vertex_normals.data.clone(),
                    colors,
                    textures,
                },
            );
            defined.push(land.grid);
        }
        Ok(defined)
    }

    fn texture_id(&mut self, file_name: &str, assets: &Assets) -> u16 {
        let key = file_name.to_ascii_lowercase();
        if let Some(&id) = self.texture_ids.get(&key) {
            return id;
        }
        let count = (self.texture_pixels * self.texture_pixels) as usize;
        let pixels = assets.load_texture(file_name, self.texture_pixels).unwrap_or_else(|_| {
            self.missing_textures.push(file_name.to_string());
            vec![[128.0, 128.0, 128.0]; count]
        });
        let id = self.textures.len() as u16;
        self.textures.push(Texture { pixels });
        self.texture_ids.insert(key, id);
        id
    }
}
