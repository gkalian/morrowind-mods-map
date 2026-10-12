use std::collections::HashMap;
use std::fs;
use std::path::Path;

use anyhow::{Context, Result};
use rayon::prelude::*;

/// Side of a map tile in pixels.
pub const TILE: usize = 256;
const HALF: usize = TILE / 2;
const QUALITY: f32 = 82.0;

/// Tile column and row; rows grow southwards.
pub type TileXY = (i32, i32);

/// A tile shrunk to half its side, ready to become a quarter of its parent tile.
pub type Quarter = Vec<u8>;

pub fn write_tile(dir: &Path, zoom: u8, (x, y): TileXY, rgba: &[u8]) -> Result<()> {
    let folder = dir.join(zoom.to_string()).join(x.to_string());
    fs::create_dir_all(&folder).with_context(|| format!("creating {}", folder.display()))?;
    let encoded = webp::Encoder::from_rgba(rgba, TILE as u32, TILE as u32).encode(QUALITY);
    let path = folder.join(format!("{y}.webp"));
    fs::write(&path, &*encoded).with_context(|| format!("writing {}", path.display()))
}

/// Zoom level at which one Cell is exactly one tile.
pub const CELL_ZOOM: u8 = 8;

/// Cuts a rendered Cell into tiles at every zoom level from `zoom` down to the one where the
/// Cell is a single tile, and returns that tile's quarter. Returns the number of tiles written too.
pub fn write_cell(dir: &Path, grid: (i32, i32), mut image: Vec<u8>, zoom: u8) -> Result<(TileXY, Quarter, usize)> {
    let mut written = 0;
    for level in (CELL_ZOOM..=zoom).rev() {
        let across = 1usize << (level - CELL_ZOOM);
        let side = across * TILE;
        let left = grid.0 * across as i32;
        let top = -(grid.1 + 1) * across as i32;
        let mut tile = vec![0u8; TILE * TILE * 4];
        for ty in 0..across {
            for tx in 0..across {
                for row in 0..TILE {
                    let from = ((ty * TILE + row) * side + tx * TILE) * 4;
                    tile[row * TILE * 4..(row + 1) * TILE * 4].copy_from_slice(&image[from..from + TILE * 4]);
                }
                write_tile(dir, level, (left + tx as i32, top + ty as i32), &tile)?;
                written += 1;
            }
        }
        image = halve(&image, side);
    }
    Ok(((grid.0, -(grid.1 + 1)), image, written))
}

/// Shrinks a square RGBA image to half its side, weighting colour by opacity.
pub fn halve(rgba: &[u8], side: usize) -> Quarter {
    let half = side / 2;
    let mut out = vec![0u8; half * half * 4];
    for y in 0..half {
        for x in 0..half {
            let mut sum = [0u32; 3];
            let mut alpha = 0u32;
            for (dy, dx) in [(0, 0), (0, 1), (1, 0), (1, 1)] {
                let at = ((y * 2 + dy) * side + x * 2 + dx) * 4;
                let a = rgba[at + 3] as u32;
                for c in 0..3 {
                    sum[c] += rgba[at + c] as u32 * a;
                }
                alpha += a;
            }
            let at = (y * half + x) * 4;
            if alpha > 0 {
                for c in 0..3 {
                    out[at + c] = ((sum[c] + alpha / 2) / alpha) as u8;
                }
            }
            out[at + 3] = ((alpha + 2) / 4) as u8;
        }
    }
    out
}

/// Builds every zoom level from `zoom` down to `min_zoom` out of the quarters of the level below
/// `zoom`, and returns how many tiles it wrote.
pub fn build_levels(dir: &Path, mut quarters: HashMap<TileXY, Quarter>, zoom: u8, min_zoom: u8) -> Result<usize> {
    let mut written = 0;
    for level in (min_zoom..=zoom).rev() {
        let mut parents: HashMap<TileXY, [Option<&Quarter>; 4]> = HashMap::new();
        for (&(x, y), quarter) in &quarters {
            let slot = (y.rem_euclid(2) * 2 + x.rem_euclid(2)) as usize;
            parents.entry((x.div_euclid(2), y.div_euclid(2))).or_default()[slot] = Some(quarter);
        }

        let next: Vec<(TileXY, Quarter)> = parents
            .par_iter()
            .map(|(&xy, children)| {
                let mut tile = vec![0u8; TILE * TILE * 4];
                for (slot, child) in children.iter().enumerate() {
                    let Some(child) = child else { continue };
                    let (left, top) = ((slot % 2) * HALF, (slot / 2) * HALF);
                    for row in 0..HALF {
                        let from = row * HALF * 4;
                        let to = ((top + row) * TILE + left) * 4;
                        tile[to..to + HALF * 4].copy_from_slice(&child[from..from + HALF * 4]);
                    }
                }
                write_tile(dir, level, xy, &tile)?;
                Ok((xy, halve(&tile, TILE)))
            })
            .collect::<Result<_>>()?;

        written += next.len();
        quarters = next.into_iter().collect();
    }
    Ok(written)
}
