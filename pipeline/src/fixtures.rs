//! Builders of made-up game data for tests: plugins, textures, models and archives written to a
//! folder of their own, so that the tests need neither the game nor the mods.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use tes3::esp::{
    Cell, CellFlags, Header, Landscape, LandscapeFlags, LandscapeTexture, Plugin, Reference, TES3Object, TravelDestination,
};
use tes3::nif::glam::{Vec2, Vec3};
use tes3::nif::{
    NiAVObject, NiAlphaProperty, NiLODNode, NiNode, NiObject, NiSourceTexture, NiStream, NiTexturingProperty, NiTriShape,
    NiTriShapeData, RootCollisionNode, TextureMap, TextureSource,
};

/// A folder of its own under the system's temporary one, removed when dropped.
pub struct TempDir(PathBuf);

impl TempDir {
    pub fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!("esmap-test-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }

    pub fn join(&self, relative: impl AsRef<Path>) -> PathBuf {
        self.0.join(relative)
    }

    /// Writes a text file, making the folders on the way.
    pub fn write(&self, relative: &str, text: &str) -> PathBuf {
        let path = self.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, text).unwrap();
        path
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Saves a plugin with these masters and records into `dir`, and returns its path.
pub fn save_plugin(dir: &Path, name: &str, masters: &[&str], objects: Vec<TES3Object>) -> PathBuf {
    let mut plugin = Plugin::new();
    plugin.objects.push(Header { masters: masters.iter().map(|master| (master.to_string(), 0)).collect(), ..Header::default() }.into());
    plugin.objects.extend(objects);
    fs::create_dir_all(dir).unwrap();
    let path = dir.join(name);
    plugin.save_path(&path).unwrap();
    path
}

/// Flat land at `height` game units, with the texture numbers of each of its 16 x 16 squares
/// given row by row from the south (0 is the default texture).
pub fn land(grid: (i32, i32), height: f32, textures: Option<[[u16; 16]; 16]>, color: Option<[u8; 3]>) -> TES3Object {
    let mut land = Landscape { grid, landscape_flags: LandscapeFlags::USES_VERTEX_HEIGHTS_AND_NORMALS, ..Landscape::default() };
    land.vertex_heights.offset = height / 8.0;
    // Every normal points straight up.
    land.vertex_normals.data.iter_mut().flatten().for_each(|normal| *normal = [0, 0, 127]);
    if let Some(textures) = textures {
        land.landscape_flags |= LandscapeFlags::USES_TEXTURES;
        // The record keeps the squares in 4 x 4 blocks of 4 x 4.
        let raw = land.texture_indices.data.as_flattened_mut();
        let mut next = 0;
        for block_y in 0..4 {
            for block_x in 0..4 {
                for y in 0..4 {
                    for x in 0..4 {
                        raw[next] = textures[block_y * 4 + y][block_x * 4 + x];
                        next += 1;
                    }
                }
            }
        }
    }
    if let Some(color) = color {
        land.landscape_flags |= LandscapeFlags::USES_VERTEX_COLORS;
        land.vertex_colors.data.iter_mut().flatten().for_each(|vertex| *vertex = color);
    }
    land.into()
}

pub fn landscape_texture(index: u32, file_name: &str) -> TES3Object {
    LandscapeTexture { id: format!("tex{index}"), index, file_name: file_name.into(), ..LandscapeTexture::default() }.into()
}

/// An exterior Cell, with references numbered from one in the plugin itself.
pub fn exterior(grid: (i32, i32), name: &str, region: Option<&str>, references: Vec<Reference>) -> TES3Object {
    let mut cell = Cell { name: name.into(), region: region.map(Into::into), ..Cell::default() };
    cell.data.grid = grid;
    for reference in references {
        cell.references.insert((reference.mast_index, reference.refr_index), reference);
    }
    cell.into()
}

pub fn interior(name: &str, references: Vec<Reference>) -> TES3Object {
    let mut cell = Cell { name: name.into(), ..Cell::default() };
    cell.data.flags = CellFlags::IS_INTERIOR;
    for reference in references {
        cell.references.insert((reference.mast_index, reference.refr_index), reference);
    }
    cell.into()
}

/// A reference placed by the plugin (`master` 0) or by its `master`-th master.
pub fn placed(master: u32, index: u32, id: &str, x: f32, y: f32) -> Reference {
    Reference { mast_index: master, refr_index: index, id: id.into(), translation: [x, y, 0.0], ..Reference::default() }
}

/// A door leading to `cell` (empty for the exterior) at `to`.
pub fn door(master: u32, index: u32, x: f32, y: f32, cell: &str, to: [f32; 3]) -> Reference {
    Reference {
        destination: Some(TravelDestination { translation: to, cell: cell.into(), ..TravelDestination::default() }),
        ..placed(master, index, "door", x, y)
    }
}

pub fn deleted(master: u32, index: u32) -> Reference {
    Reference { mast_index: master, refr_index: index, deleted: Some(true), ..Reference::default() }
}

/// A one-colour PNG, under whatever name the game would look for.
pub fn texture(dir: &Path, relative: &str, rgba: [u8; 4], side: u32) -> PathBuf {
    let path = dir.join(relative);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let image = image::RgbaImage::from_pixel(side, side, image::Rgba(rgba));
    let mut bytes = Vec::new();
    image.write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageFormat::Png).unwrap();
    fs::write(&path, bytes).unwrap();
    path
}

/// A model: a flat square `half` units from its middle to each side, `height` units up, facing
/// up, with an optional texture and alpha. Next to it the model holds what the Map leaves out:
/// a collision shape, an editor marker, and the far versions of a node with levels of detail.
pub fn square_model(texture: Option<&str>, cutout: bool, half: f32, height: f32) -> Vec<u8> {
    let mut stream = NiStream::new();
    let square = |stream: &mut NiStream, name: &str, z: f32| {
        let mut data = NiTriShapeData::default();
        let geometry = &mut data.base.base;
        geometry.vertices = vec![Vec3::new(-half, -half, z), Vec3::new(half, -half, z), Vec3::new(half, half, z), Vec3::new(-half, half, z)];
        geometry.normals = vec![Vec3::Z; 4];
        geometry.uv_sets = vec![Vec2::new(0.0, 1.0), Vec2::new(1.0, 1.0), Vec2::new(1.0, 0.0), Vec2::new(0.0, 0.0)];
        data.triangles = vec![[0, 1, 2], [0, 2, 3]];
        let data = stream.insert(data);
        let mut shape = NiTriShape::default();
        shape.base.base.geometry_data = data.cast();
        shape.base.base.base.base.name = name.into();
        shape
    };

    // The look of the model: its texture and whether transparent parts are holes.
    let mut properties = Vec::new();
    if let Some(file) = texture {
        let source = stream.insert(NiSourceTexture { source: TextureSource::External(file.into()), ..NiSourceTexture::default() });
        let mut map = tes3::nif::Map::default();
        map.texture = source;
        let texturing = stream.insert(NiTexturingProperty { texture_maps: vec![Some(TextureMap::Map(map))], ..NiTexturingProperty::default() });
        properties.push(texturing.cast());
    }
    if cutout {
        let mut alpha = NiAlphaProperty::default();
        alpha.base.flags = 0x0200;
        properties.push(stream.insert(alpha).cast());
    }
    let mut shape = square(&mut stream, "square", height);
    shape.base.base.base.properties = properties.clone();
    let shape = stream.insert(shape);

    // Left out of the picture: a far, higher version of the square, a marker and a collision shape.
    let far = square(&mut stream, "far", height + 1000.0);
    let far = stream.insert(far);
    let mut near_again = square(&mut stream, "near", height);
    near_again.base.base.base.properties = properties;
    let near_again = stream.insert(near_again);
    let mut lod = NiLODNode::default();
    lod.base.children = vec![near_again.cast(), far.cast()];
    let lod = stream.insert(lod);
    let marker = square(&mut stream, "EditorMarker", height + 2000.0);
    let marker = stream.insert(marker);
    let mut collision = RootCollisionNode::default();
    let solid = square(&mut stream, "collision", height + 3000.0);
    collision.base.children = vec![stream.insert(solid).cast()];
    let collision = stream.insert(collision);

    let mut root = NiNode::default();
    root.children = vec![shape.cast::<NiAVObject>(), lod.cast(), marker.cast(), collision.cast()];
    let root = stream.insert(root);
    stream.roots = vec![root.cast::<NiObject>()];
    stream.save_bytes().unwrap()
}

/// A BSA archive holding the given files.
pub fn archive(path: &Path, files: &[(&str, Vec<u8>)]) {
    let mut builder = tes3::bsa::Builder::new();
    for (name, bytes) in files {
        builder.insert(name.to_string(), bytes.clone()).unwrap();
    }
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    builder.save_path(path).unwrap();
}

/// A made-up game in a folder of its own, laid out like this repository with the game and two
/// mods beside it: the folder holds `plugin-sets.toml` and `paths.local.toml`.
///
/// Morrowind (always on) has land in Cells 0,0 and 1,0 and sea in 0,1; Seyda Neen in 0,0 with
/// a door to its Census Office; a caravaner in Seyda Neen and one in 1,0 who take the player to
/// each other; a guild guide inside the Census Office; a propylon there that needs an index;
/// Asciene Rane, who offers the journey to Mournhold in a configured topic; and the markers of
/// both Interventions. Tamriel Rebuilt (off by default) adds Cell 2,0 with a boat that its start
/// script's global switches on, and moves the caravaner of 1,0. A backdrop lies under it at 5,5.
pub fn game() -> TempDir {
    use tes3::esp::{
        Activator, Class, Creature, Dialogue, DialogueInfo, DialogueType2, GlobalVariable, MiscItem, Npc, Region, Script, StartScript,
        Static,
    };
    let root = TempDir::new();
    let data = root.join("data");
    let tr = root.join("mods/tr");
    let tamriel = root.join("mods/tamriel");
    let ru = root.join("ru");
    let npc = |id: &str, name: &str, class: &str, script: &str, to: &[(f32, f32, &str)]| -> TES3Object {
        let mut npc = Npc { id: id.into(), name: name.into(), class: class.into(), script: script.into(), ..Npc::default() };
        npc.travel_destinations = to
            .iter()
            .map(|&(x, y, cell)| TravelDestination { translation: [x, y, 0.0], cell: cell.into(), ..TravelDestination::default() })
            .collect();
        npc.into()
    };
    let script = |id: &str, text: &str| -> TES3Object { Script { id: id.into(), text: text.into(), ..Script::default() }.into() };

    texture(&data, "textures\\_land_default.tga", [90, 90, 90, 255], 4);
    texture(&data, "textures\\tx_grass.tga", [40, 160, 40, 255], 4);
    texture(&data, "textures\\tx_wall.tga", [200, 50, 50, 255], 4);
    archive(&data.join("Morrowind.bsa"), &[("meshes\\x\\wall.nif", square_model(Some("tx_wall.tga"), false, 1024.0, 900.0))]);
    let mut grass = [[1u16; 16]; 16];
    grass[0][0] = 0;
    save_plugin(&data, "Morrowind.esm", &[], vec![
        landscape_texture(0, "tx_grass.tga"),
        land((0, 0), 200.0, Some(grass), None),
        land((1, 0), 200.0, None, Some([255, 255, 255])),
        land((0, 1), -600.0, None, None),
        Region { id: "Bitter Coast Region".into(), name: "Bitter Coast Region".into(), map_color: [10, 80, 60, 0], ..Region::default() }.into(),
        Static { id: "wall".into(), mesh: "x\\wall.nif".into(), ..Static::default() }.into(),
        Activator { id: "propylon".into(), script: "warp_andra".into(), ..Activator::default() }.into(),
        MiscItem { id: "index_andra".into(), name: "Andasreth Propylon Index".into(), ..MiscItem::default() }.into(),
        npc("darvame", "Darvame Hleran", "Caravaner", "", &[(12288.0, 4096.0, "")]),
        npc("folsi", "Folsi Thendas", "Caravaner", "", &[(4096.0, 4096.0, "")]),
        npc("guide", "Masalinie Merian", "Guild Guide", "", &[(0.0, 0.0, "Andasreth, Propylon Chamber")]),
        npc("asciene", "Asciene Rane", "Noble", "", &[]),
        npc("thief", "Regatto", "Thief", "", &[(0.0, 0.0, "")]),
        Creature {
            id: "daedroth".into(),
            name: "Thazlorakis".into(),
            travel_destinations: vec![TravelDestination { cell: "Andasreth, Propylon Chamber".into(), ..TravelDestination::default() }],
            ..Creature::default()
        }
        .into(),
        Creature { id: "rat".into(), ..Creature::default() }.into(),
        Class { id: "Caravaner".into(), name: "Caravaner".into(), ..Class::default() }.into(),
        script("warp_andra", "if ( OnActivate == 1 )\n  if ( Player->GetItemCount \"Index_Andra\" > 0 )\n    Player->PositionCell 0 0 0 0 \"Andasreth, Propylon Chamber\"\n  endif\nendif"),
        script("MHTransportScript", "Player->PositionCell 0 0 0 0 \"Mournhold, Royal Palace\""),
        Dialogue { id: "transport to Mournhold".into(), dialogue_type: DialogueType2::Topic, ..Dialogue::default() }.into(),
        DialogueInfo { speaker_id: "asciene".into(), script_text: "StartScript MHTransportScript".into(), ..DialogueInfo::default() }.into(),
        exterior((0, 0), "Seyda Neen", Some("Bitter Coast Region"), vec![
            placed(0, 1, "darvame", 4096.0, 4096.0),
            door(0, 2, 2000.0, 2000.0, "Seyda Neen, Census Office", [0.0; 3]),
            placed(0, 3, "wall", 6000.0, 6000.0),
            placed(0, 4, "templemarker", 1000.0, 1000.0),
            placed(0, 5, "divinemarker", 7000.0, 1000.0),
            placed(0, 6, "asciene", 3000.0, 3000.0),
            placed(0, 14, "thief", 500.0, 500.0),
        ]),
        exterior((1, 0), "", Some("Bitter Coast Region"), vec![placed(0, 7, "folsi", 12288.0, 4096.0)]),
        interior("Seyda Neen, Census Office", vec![
            door(0, 8, 0.0, 0.0, "", [2100.0, 2100.0, 0.0]),
            placed(0, 9, "guide", 10.0, 10.0),
            placed(0, 10, "propylon", 20.0, 20.0),
        ]),
        interior("Andasreth, Propylon Chamber", vec![door(0, 11, 0.0, 0.0, "", [-40000.0, 4000.0, 0.0])]),
        interior("Mournhold, Royal Palace", vec![placed(0, 12, "templemarker", 0.0, 0.0)]),
    ]);

    save_plugin(&tr, "TR_Mainland.esm", &["Morrowind.esm"], vec![
        land((2, 0), 100.0, None, None),
        GlobalVariable { id: "T_Glob_Installed_TR".into(), ..GlobalVariable::default() }.into(),
        script("TR_Start", "set T_Glob_Installed_TR to 1\nif ( T_Glob_Installed_TR == 1 )\n  \"folsi\"->PositionCell 20480 4096 0 0 \"Old Ebonheart\"\nendif"),
        StartScript { id: "start".into(), script: "TR_Start".into(), ..StartScript::default() }.into(),
        script("boat_sc", "if ( T_Glob_Installed_TR == 0 )\n  Disable\nendif"),
        npc("boatman", "Boatman", "Shipmaster", "boat_sc", &[(4096.0, 4096.0, "")]),
        exterior((2, 0), "Old Ebonheart", None, vec![placed(0, 1, "boatman", 20480.0, 4096.0), placed(0, 2, "divinemarker", 20000.0, 2000.0)]),
    ]);
    save_plugin(&tamriel, "Tamriel.esm", &[], vec![land((5, 5), 0.0, None, None)]);

    let cel = encoding_rs::WINDOWS_1251.encode("Seyda Neen\tСейда Нин\nMournhold\tМорнхолд\n").0;
    fs::create_dir_all(&ru).unwrap();
    fs::write(ru.join("morrowind.cel"), cel).unwrap();
    let as_read = |text: &str| encoding_rs::WINDOWS_1252.decode(&encoding_rs::WINDOWS_1251.encode(text).0).0.into_owned();
    save_plugin(&ru, "Morrowind.esm", &[], vec![
        Npc { id: "darvame".into(), name: as_read("Дарвам Хлеран"), ..Npc::default() }.into(),
        MiscItem { id: "index_andra".into(), name: as_read("Метка пропильона Андасрета"), ..MiscItem::default() }.into(),
    ]);

    root.write("plugin-sets.toml", PLUGIN_SETS);
    let quoted = |path: &Path| format!("'{}'", path.display());
    root.write(
        "paths.local.toml",
        &format!(
            "game_data_files = {}\nrussian_data_files = [{}]\n[mod_data_files]\ntr = {}\ntamriel = {}\n",
            quoted(&data),
            quoted(&ru),
            quoted(&tr),
            quoted(&tamriel)
        ),
    );
    root
}

const PLUGIN_SETS: &str = r#"
cell_pixels = 256
min_zoom = 6
water = [52, 78, 110]

[[set]]
id = "tamriel"
name = "Tamriel"
plugins = ["Tamriel.esm"]
backdrop_for = ["tr"]
cell_pixels = 128

[[set]]
id = "morrowind"
name = "Morrowind"
plugins = ["Morrowind.esm"]
archives = ["Morrowind.bsa"]
default_on = true
locked = true

[[set]]
id = "tr"
name = "Tamriel Rebuilt"
version = "1.0"
plugins = ["TR_Mainland.esm"]

[transport]
classes = { Caravaner = "land", "Guild Guide" = "guild", Shipmaster = "water" }
gates = { "index_*" = "propylon" }
topics = { "transport to Mournhold" = "magic" }

[[transport.anchor]]
cells = "Mournhold"
position = [23.5, -27.5]
"#;
