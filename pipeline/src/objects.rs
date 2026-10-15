use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use rayon::prelude::*;
use tes3::esp::{Activator, Cell, Container, Door, Light, ObjectFlags, Plugin, Static};
use tes3::nif::glam::{Affine3A, Mat3, Vec3};
use tes3::nif::{
    NiAVObject, NiGeometry, NiGeometryData, NiKey, NiNode, NiStream, NiType, TextureMap, TextureSource,
};

use crate::assets::Assets;
use crate::config::find_file;
use crate::land::Grid;
use crate::locations::{masters_of, plugin_file, reference_key, ReferenceKey, CELL_SIZE};
use crate::render::shade;

/// Texture pixels below this opacity are left out where a model cuts shapes out of its texture.
const CUTOUT: u8 = 128;
/// Largest side a model texture is kept at; none is ever drawn larger on the Map.
const MAX_TEXTURE: u32 = 512;
/// Colour of a model whose texture could not be loaded.
const UNTEXTURED: [f32; 3] = [140.0, 140.0, 140.0];

/// One textured surface of a model, in the model's own space.
struct Shape {
    positions: Vec<Vec3>,
    /// Empty when the model has none; the surface is then lit by the way each triangle faces.
    normals: Vec<Vec3>,
    uvs: Vec<[f32; 2]>,
    /// Empty when the model has none.
    colors: Vec<[f32; 3]>,
    triangles: Vec<[u32; 3]>,
    texture: Option<u32>,
    /// Whether transparent parts of the texture are holes in the surface.
    cutout: bool,
}

struct Model {
    shapes: Vec<Shape>,
    /// Distance from the model's origin to its farthest point.
    radius: f32,
}

/// A texture with ever smaller copies of itself, so that it can be drawn at any size.
struct Image {
    levels: Vec<Level>,
}

struct Level {
    width: usize,
    height: usize,
    pixels: Vec<[u8; 4]>,
}

/// One model standing in the world.
struct Placed {
    model: u32,
    position: Vec3,
    /// Rotation and scale together.
    matrix: Mat3,
    rotation: Mat3,
    /// Index of the plugin that placed it, into `Objects::files`.
    plugin: u16,
    /// Plugins that have deleted or moved it since.
    removed_by: Vec<u16>,
}

/// Every model placed in the exterior by the plugins loaded so far: buildings, rocks, trees and
/// the like. They are what a top-down view shows besides the landscape itself.
#[derive(Default)]
pub struct Objects {
    /// Object id to its model file, both in lower case.
    mesh_of: HashMap<String, String>,
    model_ids: HashMap<String, u32>,
    models: Vec<Option<Model>>,
    image_ids: HashMap<String, u32>,
    images: Vec<Option<Image>>,
    placed: Vec<Placed>,
    /// An object by the plugin that first placed it and its reference number there.
    by_reference: HashMap<ReferenceKey, u32>,
    by_cell: HashMap<Grid, Vec<u32>>,
    /// The plugins loaded so far, in lower case, and the masters of each.
    files: Vec<(String, Vec<String>)>,
    /// For each of `files`, whether what it places and changes is drawn.
    visible: Vec<bool>,
    pub missing_models: Vec<String>,
}

/// A surface as read from a model file, before its texture is loaded.
struct RawShape {
    shape: Shape,
    texture_name: Option<String>,
}

impl Objects {
    pub fn placed(&self) -> usize {
        self.placed.len()
    }

    pub fn models(&self) -> usize {
        self.models.iter().flatten().count()
    }

    /// Draws from now on only what these plugins and their masters place and change.
    pub fn show_only(&mut self, plugins: &[String]) {
        let mut wanted: Vec<String> = plugins.iter().map(|name| name.to_ascii_lowercase()).collect();
        let mut visible = vec![false; self.files.len()];
        while let Some(name) = wanted.pop() {
            let Some(index) = self.files.iter().position(|(file, _)| *file == name) else { continue };
            if !visible[index] {
                visible[index] = true;
                wanted.extend(self.files[index].1.iter().cloned());
            }
        }
        self.visible = visible;
    }

    /// Loads the objects a plugin defines and the places where it puts them in the exterior,
    /// after those of its masters, which are looked for in `dirs`. A plugin is loaded only once.
    pub fn load_plugin(&mut self, path: &Path, dirs: &[PathBuf], assets: &Assets) -> Result<()> {
        let file = plugin_file(path);
        if self.files.iter().any(|(loaded, _)| *loaded == file) {
            return Ok(());
        }
        let plugin = Plugin::from_path_filtered(path, |tag| {
            matches!(&tag, b"TES3" | b"STAT" | b"ACTI" | b"CONT" | b"DOOR" | b"LIGH" | b"CELL")
        })
        .with_context(|| format!("loading {}", path.display()))?;
        let masters = masters_of(&plugin);
        for master in &masters {
            self.load_plugin(&find_file(dirs, master)?, dirs, assets)?;
        }
        let index = self.files.len() as u16;
        self.files.push((file.clone(), masters.clone()));
        self.visible.push(true);

        let mut define = |id: &str, mesh: &str| {
            if !mesh.is_empty() {
                self.mesh_of.insert(id.to_ascii_lowercase(), mesh.replace('/', "\\").to_ascii_lowercase());
            }
        };
        plugin.objects_of_type::<Static>().for_each(|o| define(&o.id, &o.mesh));
        plugin.objects_of_type::<Activator>().for_each(|o| define(&o.id, &o.mesh));
        plugin.objects_of_type::<Container>().for_each(|o| define(&o.id, &o.mesh));
        plugin.objects_of_type::<Door>().for_each(|o| define(&o.id, &o.mesh));
        plugin.objects_of_type::<Light>().for_each(|o| define(&o.id, &o.mesh));

        let first_model = self.models.len();
        let first_placed = self.placed.len();
        for cell in plugin.objects_of_type::<Cell>() {
            if cell.is_interior() || cell.flags.contains(ObjectFlags::DELETED) {
                continue;
            }
            for reference in cell.references.values() {
                let Some(key) = reference_key(&file, &masters, reference) else { continue };
                // A plugin that deletes or moves an object of an earlier one takes it from where it stood.
                if let Some(&earlier) = self.by_reference.get(&key) {
                    self.placed[earlier as usize].removed_by.push(index);
                }
                if reference.deleted == Some(true) {
                    continue;
                }
                let Some(mesh) = self.mesh_of.get(&reference.id.to_ascii_lowercase()) else { continue };
                if is_marker(mesh) {
                    continue;
                }
                let next = self.model_ids.len() as u32;
                let model = *self.model_ids.entry(mesh.clone()).or_insert(next);
                let [x, y, z] = reference.rotation;
                // The game turns objects clockwise, about X first, then Y, then Z.
                let rotation = Mat3::from_rotation_z(-z) * Mat3::from_rotation_y(-y) * Mat3::from_rotation_x(-x);
                self.by_reference.entry(key).or_insert(self.placed.len() as u32);
                self.placed.push(Placed {
                    model,
                    position: Vec3::from(reference.translation),
                    matrix: rotation * reference.scale.unwrap_or(1.0),
                    rotation,
                    plugin: index,
                    removed_by: Vec::new(),
                });
            }
        }

        // Read the models that appeared with this plugin, then the textures they use.
        let mut names: Vec<(&String, u32)> = self.model_ids.iter().map(|(name, &id)| (name, id)).collect();
        names.retain(|&(_, id)| id as usize >= first_model);
        names.sort_by_key(|&(_, id)| id);
        let raw: Vec<Option<Vec<RawShape>>> = names.par_iter().map(|(name, _)| read_model(assets, name)).collect();

        for ((name, _), shapes) in names.iter().zip(&raw) {
            if shapes.is_none() {
                self.missing_models.push((*name).clone());
            }
        }
        let mut wanted: Vec<String> = raw
            .iter()
            .flatten()
            .flatten()
            .filter_map(|shape| shape.texture_name.clone())
            .filter(|name| !self.image_ids.contains_key(name))
            .collect();
        wanted.sort();
        wanted.dedup();
        let loaded: Vec<Option<Image>> = wanted.par_iter().map(|name| read_image(assets, name)).collect();
        for (name, image) in wanted.into_iter().zip(loaded) {
            self.image_ids.insert(name, self.images.len() as u32);
            self.images.push(image);
        }

        for shapes in raw {
            self.models.push(shapes.map(|shapes| {
                let shapes: Vec<Shape> = shapes
                    .into_iter()
                    .map(|raw| Shape {
                        texture: raw.texture_name.and_then(|name| self.image_ids.get(&name).copied()),
                        ..raw.shape
                    })
                    .collect();
                let radius = shapes
                    .iter()
                    .flat_map(|shape| &shape.positions)
                    .map(|position| position.length())
                    .fold(0.0, f32::max);
                Model { shapes, radius }
            }));
        }

        // A model is drawn in every Cell it reaches into.
        for index in first_placed..self.placed.len() {
            let placed = &self.placed[index];
            let Some(model) = &self.models[placed.model as usize] else { continue };
            let reach = model.radius * placed.matrix.x_axis.length();
            let cell = |value: f32| (value / CELL_SIZE).floor() as i32;
            for y in cell(placed.position.y - reach)..=cell(placed.position.y + reach) {
                for x in cell(placed.position.x - reach)..=cell(placed.position.x + reach) {
                    self.by_cell.entry((x, y)).or_default().push(index as u32);
                }
            }
        }
        Ok(())
    }

    /// Draws the models that reach into a Cell over its landscape, seen from straight above.
    /// `color` and `height` hold the picture and the height of what it shows, `size` pixels a side,
    /// north at the top; both are updated wherever a model is the highest thing.
    pub fn draw(&self, grid: Grid, size: usize, color: &mut [[f32; 3]], height: &mut [f32]) {
        let Some(indices) = self.by_cell.get(&grid) else { return };
        let scale = size as f32 / CELL_SIZE;
        let west = grid.0 as f32 * CELL_SIZE;
        let north = (grid.1 + 1) as f32 * CELL_SIZE;

        let mut points: Vec<[f32; 3]> = Vec::new();
        let mut shades: Vec<f32> = Vec::new();
        for &index in indices {
            let placed = &self.placed[index as usize];
            if !self.visible[placed.plugin as usize] || placed.removed_by.iter().any(|&by| self.visible[by as usize]) {
                continue;
            }
            let Some(model) = &self.models[placed.model as usize] else { continue };
            for shape in &model.shapes {
                points.clear();
                points.extend(shape.positions.iter().map(|&position| {
                    let world = placed.position + placed.matrix * position;
                    [(world.x - west) * scale, (north - world.y) * scale, world.z]
                }));
                shades.clear();
                shades.extend(shape.normals.iter().map(|&normal| shade((placed.rotation * normal).to_array())));
                let image = shape.texture.and_then(|id| self.images[id as usize].as_ref());

                for triangle in &shape.triangles {
                    let [a, b, c] = triangle.map(|i| i as usize);
                    let (Some(&pa), Some(&pb), Some(&pc)) = (points.get(a), points.get(b), points.get(c)) else {
                        continue;
                    };
                    let area = edge(pa, pb, pc);
                    if area.abs() < 1e-6 {
                        continue;
                    }
                    let left = pa[0].min(pb[0]).min(pc[0]).floor().max(0.0) as usize;
                    let top = pa[1].min(pb[1]).min(pc[1]).floor().max(0.0) as usize;
                    let right = (pa[0].max(pb[0]).max(pc[0]).ceil() as isize).min(size as isize);
                    let bottom = (pa[1].max(pb[1]).max(pc[1]).ceil() as isize).min(size as isize);
                    if right <= left as isize || bottom <= top as isize {
                        continue;
                    }

                    let uv = |i: usize| shape.uvs.get(i).copied().unwrap_or([0.0, 0.0]);
                    let (ta, tb, tc) = (uv(a), uv(b), uv(c));
                    // The copy of the texture whose pixels are about as large as the Map's.
                    let level = image.map(|image| {
                        let spread = ((tb[0] - ta[0]) * (tc[1] - ta[1]) - (tb[1] - ta[1]) * (tc[0] - ta[0])).abs();
                        let full = &image.levels[0];
                        let texels = spread * (full.width * full.height) as f32 / area.abs();
                        let step = (0.5 * texels.max(1.0).log2()).round() as usize;
                        &image.levels[step.min(image.levels.len() - 1)]
                    });

                    let lit = match (shades.get(a), shades.get(b), shades.get(c)) {
                        (Some(&sa), Some(&sb), Some(&sc)) => [sa, sb, sc],
                        _ => {
                            // No normals in the model: light the triangle by the way it faces.
                            let (va, vb, vc) = (shape.positions[a], shape.positions[b], shape.positions[c]);
                            let mut facing = placed.rotation * (vb - va).cross(vc - va);
                            if facing.z < 0.0 {
                                facing = -facing;
                            }
                            [shade(facing.to_array()); 3]
                        }
                    };
                    let tint = |i: usize| shape.colors.get(i).copied().unwrap_or([1.0; 3]);
                    let (ca, cb, cc) = (tint(a), tint(b), tint(c));

                    for y in top..bottom as usize {
                        for x in left..right as usize {
                            let point = [x as f32 + 0.5, y as f32 + 0.5, 0.0];
                            let wa = edge(pb, pc, point) / area;
                            let wb = edge(pc, pa, point) / area;
                            let wc = 1.0 - wa - wb;
                            if wa < 0.0 || wb < 0.0 || wc < 0.0 {
                                continue;
                            }
                            let at = y * size + x;
                            let z = wa * pa[2] + wb * pb[2] + wc * pc[2];
                            if z <= height[at] {
                                continue;
                            }
                            let texel = match level {
                                Some(level) => {
                                    let u = wa * ta[0] + wb * tb[0] + wc * tc[0];
                                    let v = wa * ta[1] + wb * tb[1] + wc * tc[1];
                                    let column = ((u - u.floor()) * level.width as f32) as usize;
                                    let row = ((v - v.floor()) * level.height as f32) as usize;
                                    let [r, g, b, alpha] =
                                        level.pixels[row.min(level.height - 1) * level.width + column.min(level.width - 1)];
                                    if shape.cutout && alpha < CUTOUT {
                                        continue;
                                    }
                                    [r as f32, g as f32, b as f32]
                                }
                                None => UNTEXTURED,
                            };
                            let light = wa * lit[0] + wb * lit[1] + wc * lit[2];
                            for channel in 0..3 {
                                let tint = wa * ca[channel] + wb * cb[channel] + wc * cc[channel];
                                color[at][channel] = (texel[channel] * tint * light).min(255.0);
                            }
                            height[at] = z;
                        }
                    }
                }
            }
        }
    }
}

/// Twice the signed area of a triangle on the picture.
fn edge(a: [f32; 3], b: [f32; 3], c: [f32; 3]) -> f32 {
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}

/// Models that only the editor shows: travel and door markers, sound emitters and the like.
fn is_marker(mesh: &str) -> bool {
    let file = mesh.rsplit('\\').next().unwrap_or(mesh);
    file.starts_with("marker") || file.starts_with("editormarker")
}

fn read_model(assets: &Assets, mesh: &str) -> Option<Vec<RawShape>> {
    let bytes = assets.read(&format!("meshes\\{mesh}"))?;
    let stream = NiStream::from_bytes(&bytes).ok()?;
    let mut shapes = Vec::new();
    for root in &stream.roots {
        walk(&stream, root.key, Affine3A::IDENTITY, None, false, &mut shapes);
    }
    Some(shapes)
}

/// Collects the visible surfaces under one node of a model, moved into the model's own space.
fn walk(stream: &NiStream, key: NiKey, parent: Affine3A, texture: Option<&str>, cutout: bool, out: &mut Vec<RawShape>) {
    let Some(object) = stream.objects.get(key) else { return };
    // Collision shapes and particle effects are not part of what the model looks like.
    if matches!(object, NiType::RootCollisionNode(_) | NiType::NiBSParticleNode(_)) {
        return;
    }
    let Ok(av) = <&NiAVObject>::try_from(object) else { return };
    let name = av.name.to_ascii_lowercase();
    if av.app_culled() || name.contains("editormarker") || name.contains("shadow") {
        return;
    }

    let transform = parent * av.transform();
    let mut texture = texture.map(str::to_string);
    let mut cutout = cutout;
    for property in &av.properties {
        match stream.objects.get(property.key) {
            Some(NiType::NiTexturingProperty(texturing)) => {
                if let Some(Some(TextureMap::Map(map))) = texturing.texture_maps.first() {
                    if let Some(source) = stream.get(map.texture) {
                        if let TextureSource::External(file) = &source.source {
                            texture = Some(file.replace('/', "\\").to_ascii_lowercase());
                        }
                    }
                }
            }
            Some(NiType::NiAlphaProperty(alpha)) => cutout = alpha.alpha_testing() || alpha.alpha_blending(),
            _ => {}
        }
    }

    if let Ok(node) = <&NiNode>::try_from(object) {
        let only = match object {
            // Of the versions made for different distances, the first is the detailed one.
            NiType::NiLODNode(_) => Some(0),
            NiType::NiSwitchNode(switch) => Some(switch.active_index),
            _ => None,
        };
        for (index, child) in node.children.iter().enumerate() {
            if only.is_none_or(|only| only == index) {
                walk(stream, child.key, transform, texture.as_deref(), cutout, out);
            }
        }
        return;
    }

    let Ok(geometry) = <&NiGeometry>::try_from(object) else { return };
    let Some(data) = stream.objects.get(geometry.geometry_data.key) else { return };
    let triangles: Vec<[u32; 3]> = match data {
        NiType::NiTriShapeData(data) => data.triangles.iter().map(|t| t.map(u32::from)).collect(),
        NiType::NiTriStripsData(data) => {
            let mut triangles = Vec::new();
            let mut start = 0;
            for &length in &data.strip_lengths {
                let strip = &data.strips[start..start + length as usize];
                start += length as usize;
                for window in strip.windows(3) {
                    triangles.push([u32::from(window[0]), u32::from(window[1]), u32::from(window[2])]);
                }
            }
            triangles
        }
        _ => return,
    };
    let Ok(data) = <&NiGeometryData>::try_from(data) else { return };
    if data.vertices.is_empty() || triangles.is_empty() {
        return;
    }

    let turn = Mat3::from(transform.matrix3);
    out.push(RawShape {
        shape: Shape {
            positions: data.vertices.iter().map(|&vertex| transform.transform_point3(vertex)).collect(),
            normals: data.normals.iter().map(|&normal| (turn * normal).normalize_or_zero()).collect(),
            uvs: data.uv_set(0).map(|uvs| uvs.iter().map(|uv| [uv.x, uv.y]).collect()).unwrap_or_default(),
            colors: data.vertex_colors.iter().map(|color| [color.x, color.y, color.z]).collect(),
            triangles,
            texture: None,
            cutout,
        },
        texture_name: texture,
    });
}

fn read_image(assets: &Assets, file_name: &str) -> Option<Image> {
    let image = assets.load_image(file_name).ok()?;
    // Sides become powers of two so that each smaller copy is exactly half the one before.
    let side = |value: u32| value.clamp(1, MAX_TEXTURE).next_power_of_two().min(MAX_TEXTURE);
    let (width, height) = (side(image.width()), side(image.height()));
    let image = image::imageops::resize(&image, width, height, image::imageops::FilterType::Triangle);

    let mut levels = vec![Level {
        width: width as usize,
        height: height as usize,
        pixels: image.pixels().map(|pixel| pixel.0).collect(),
    }];
    loop {
        let last = &levels[levels.len() - 1];
        if last.width == 1 && last.height == 1 {
            break;
        }
        let (width, height) = ((last.width / 2).max(1), (last.height / 2).max(1));
        let mut pixels = Vec::with_capacity(width * height);
        for y in 0..height {
            for x in 0..width {
                let mut sum = [0u32; 4];
                for (dy, dx) in [(0, 0), (0, 1), (1, 0), (1, 1)] {
                    let from = last.pixels[(y * 2 + dy).min(last.height - 1) * last.width + (x * 2 + dx).min(last.width - 1)];
                    for channel in 0..4 {
                        sum[channel] += u32::from(from[channel]);
                    }
                }
                pixels.push(sum.map(|value| ((value + 2) / 4) as u8));
            }
        }
        levels.push(Level { width, height, pixels });
    }
    Some(Image { levels })
}
