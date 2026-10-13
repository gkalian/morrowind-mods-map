use std::collections::HashSet;

use crate::land::{CellLand, Grid, World, TEX_SQUARES, VERTS};
use crate::objects::Objects;

/// Depth in game units at which the sea bed is no longer visible through the water.
const OPAQUE_DEPTH: f32 = 900.0;
/// How much the water hides at the shoreline itself.
const SHORE_OPACITY: f32 = 0.35;

/// Direction towards the light: from the north-west, above the horizon.
const LIGHT: [f32; 3] = [-0.5, 0.5, 0.707];

/// How far into a Cell its Terrain fades out along an open edge, as a share of the Cell's side.
const FADE: f32 = 0.4;

/// How bright a surface is for the way it faces. Flat ground keeps its own brightness.
pub fn shade(normal: [f32; 3]) -> f32 {
    let length = (normal[0] * normal[0] + normal[1] * normal[1] + normal[2] * normal[2]).sqrt();
    if length == 0.0 {
        return 1.0;
    }
    let dot = (normal[0] * LIGHT[0] + normal[1] * LIGHT[1] + normal[2] * LIGHT[2]) / length;
    (0.25 + 0.75 * dot / LIGHT[2]).clamp(0.3, 1.4)
}

/// Renders the Terrain of one Cell as `size` x `size` RGBA pixels, north at the top: the
/// landscape, the models standing on it when `objects` is given, and the water over both.
///
/// With `solid` given, the Cell fades to transparent towards every neighbour that is not in it,
/// so that the edge of a Plugin Set's land blends into whatever lies under it.
pub fn render_cell(
    world: &World,
    objects: Option<&Objects>,
    grid: Grid,
    size: u32,
    water: [u8; 3],
    solid: Option<&HashSet<Grid>>,
) -> Vec<u8> {
    let cell = &world.cells[&grid];
    // Neighbours without land, as steps east and north.
    let open: Vec<(i32, i32)> = match solid {
        Some(solid) => (-1..=1)
            .flat_map(|dy| (-1..=1).map(move |dx| (dx, dy)))
            .filter(|&(dx, dy)| (dx, dy) != (0, 0) && !solid.contains(&(grid.0 + dx, grid.1 + dy)))
            .collect(),
        None => Vec::new(),
    };
    let textures = bordered_textures(world, grid, cell);
    let n = size as usize;
    let tex_px = n / TEX_SQUARES;
    let water = [water[0] as f32, water[1] as f32, water[2] as f32];

    // What is seen from above before the water is laid over it, and how high it stands.
    let mut land = vec![[0.0f32; 3]; n * n];
    let mut heights = vec![0.0f32; n * n];
    for py in 0..n {
        for px in 0..n {
            // Position inside the Cell, 0..1 east and 0..1 north.
            let u = (px as f32 + 0.5) / n as f32;
            let v = 1.0 - (py as f32 + 0.5) / n as f32;

            // Blend the four nearest texture squares, measured from their centres.
            let tu = u * TEX_SQUARES as f32 + 0.5;
            let tv = v * TEX_SQUARES as f32 + 0.5;
            let (ti, tj) = (tu.floor() as usize, tv.floor() as usize);
            let (fu, fv) = (tu - ti as f32, tv - tj as f32);
            let texel = (py % tex_px) * tex_px + (px % tex_px);
            let mut color = [0.0f32; 3];
            for (dj, wj) in [(0, 1.0 - fv), (1, fv)] {
                for (di, wi) in [(0, 1.0 - fu), (1, fu)] {
                    let id = textures[tj + dj][ti + di] as usize;
                    let sample = world.textures[id].pixels[texel];
                    for c in 0..3 {
                        color[c] += sample[c] * wj * wi;
                    }
                }
            }

            let gu = u * (VERTS - 1) as f32;
            let gv = v * (VERTS - 1) as f32;
            let (gi, gj) = ((gu.floor() as usize).min(VERTS - 2), (gv.floor() as usize).min(VERTS - 2));
            let (hu, hv) = (gu - gi as f32, gv - gj as f32);
            let lerp = |get: &dyn Fn(usize, usize) -> f32| {
                let south = get(gj, gi) * (1.0 - hu) + get(gj, gi + 1) * hu;
                let north = get(gj + 1, gi) * (1.0 - hu) + get(gj + 1, gi + 1) * hu;
                south * (1.0 - hv) + north * hv
            };

            if let Some(colors) = &cell.colors {
                for c in 0..3 {
                    color[c] *= lerp(&|j, i| colors[j][i][c] as f32) / 255.0;
                }
            }

            let mut normal = [0.0f32; 3];
            for c in 0..3 {
                normal[c] = lerp(&|j, i| cell.normals[j][i][c] as f32);
            }
            let shade = shade(normal);
            let at = py * n + px;
            for c in 0..3 {
                land[at][c] = (color[c] * shade).min(255.0);
            }
            heights[at] = lerp(&|j, i| cell.heights[j][i]);
        }
    }

    if let Some(objects) = objects {
        objects.draw(grid, n, &mut land, &mut heights);
    }

    let mut out = vec![0u8; n * n * 4];
    for py in 0..n {
        for px in 0..n {
            let u = (px as f32 + 0.5) / n as f32;
            let v = 1.0 - (py as f32 + 0.5) / n as f32;
            let height = heights[py * n + px];
            let water_opacity = if height < 0.0 {
                (SHORE_OPACITY + (1.0 - SHORE_OPACITY) * (-height / OPAQUE_DEPTH)).min(1.0)
            } else {
                0.0
            };

            let at = (py * n + px) * 4;
            for c in 0..3 {
                out[at + c] = (land[py * n + px][c] * (1.0 - water_opacity) + water[c] * water_opacity).round() as u8;
            }
            out[at + 3] = (opacity(&open, u, v) * 255.0).round() as u8;
        }
    }
    out
}

/// Opacity of the point `u` east and `v` north inside a Cell whose `open` neighbours have no land.
fn opacity(open: &[(i32, i32)], u: f32, v: f32) -> f32 {
    let mut nearest = FADE;
    for &(dx, dy) in open {
        // Distance to the neighbour: to its edge, or to its corner for a diagonal one.
        let along = |step: i32, at: f32| match step {
            -1 => at,
            1 => 1.0 - at,
            _ => 0.0,
        };
        nearest = nearest.min(along(dx, u).hypot(along(dy, v)));
    }
    let t = nearest / FADE;
    t * t * (3.0 - 2.0 * t)
}

/// The Cell's texture squares with a one-square border taken from the neighbouring Cells,
/// so that textures blend across Cell edges. A missing neighbour repeats the Cell's own edge.
fn bordered_textures(world: &World, grid: Grid, cell: &CellLand) -> [[u16; TEX_SQUARES + 2]; TEX_SQUARES + 2] {
    let last = TEX_SQUARES as i32 - 1;
    let mut out = [[0u16; TEX_SQUARES + 2]; TEX_SQUARES + 2];
    for j in -1..=last + 1 {
        for i in -1..=last + 1 {
            let neighbour = (grid.0 + i.div_euclid(last + 1), grid.1 + j.div_euclid(last + 1));
            let id = match world.cells.get(&neighbour) {
                Some(other) => other.textures[j.rem_euclid(last + 1) as usize][i.rem_euclid(last + 1) as usize],
                None => cell.textures[j.clamp(0, last) as usize][i.clamp(0, last) as usize],
            };
            out[(j + 1) as usize][(i + 1) as usize] = id;
        }
    }
    out
}
