use super::*;
use std::fs;
use crate::fixtures::{deleted, exterior, placed, save_plugin, square_model, texture, TempDir};

const SIZE: usize = 64;

/// The game data of the tests: a textured wall, a see-through fence, a grey box without a
/// texture, a marker and a model that is not there, all placed in Cell 0, 0 by `base.esm`.
/// `mod.esp` deletes the wall.
struct Data {
    dir: TempDir,
}

impl Data {
    fn new() -> Self {
        let dir = TempDir::new();
        texture(dir.path(), "textures\\tx_wall.tga", [200, 0, 0, 255], 4);
        texture(dir.path(), "textures\\tx_fence.tga", [0, 0, 200, 0], 4);
        let mesh = |name: &str, bytes: Vec<u8>| {
            let path = dir.join(format!("meshes\\{name}"));
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, bytes).unwrap();
        };
        // The wall is 2048 units wide; at 64 pixels a Cell, that is 16 pixels.
        mesh("x\\wall.nif", square_model(Some("textures\\tx_wall.tga"), false, 1024.0, 500.0));
        mesh("x\\fence.nif", square_model(Some("tx_fence.tga"), true, 1024.0, 900.0));
        mesh("x\\box.nif", square_model(None, false, 512.0, 300.0));
        mesh("marker_travel.nif", square_model(None, false, 4096.0, 5000.0));
        let stat = |id: &str, mesh: &str| Static { id: id.into(), mesh: mesh.into(), ..Static::default() }.into();
        save_plugin(dir.path(), "base.esm", &[], vec![
            stat("wall", "x/wall.nif"),
            stat("fence", "x\\fence.nif"),
            stat("marker", "marker_travel.nif"),
            stat("ghost", "x\\none.nif"),
            Activator { id: "box".into(), mesh: "x\\box.nif".into(), ..Activator::default() }.into(),
            Light { id: "unlit".into(), ..Light::default() }.into(),
            exterior((0, 0), "", None, vec![
                placed(0, 1, "wall", 2048.0, 6144.0),
                placed(0, 2, "fence", 6144.0, 6144.0),
                placed(0, 3, "box", 6144.0, 2048.0),
                placed(0, 4, "marker", 4096.0, 4096.0),
                placed(0, 5, "ghost", 4096.0, 4096.0),
                placed(0, 6, "unlit", 4096.0, 4096.0),
                placed(0, 7, "nothing", 4096.0, 4096.0),
            ]),
        ]);
        save_plugin(dir.path(), "mod.esp", &["base.esm"], vec![exterior((0, 0), "", None, vec![deleted(1, 1)])]);
        Self { dir }
    }

    fn objects(&self, plugin: &str) -> Objects {
        let dirs = vec![self.dir.path().to_path_buf()];
        let assets = Assets::new(dirs.clone());
        let mut objects = Objects::default();
        objects.load_plugin(&self.dir.join(plugin), &dirs, &assets).unwrap();
        objects
    }
}

/// Draws Cell 0, 0 over flat ground at height 0 and returns the colour and height of a pixel.
fn draw(objects: &Objects) -> impl Fn(usize, usize) -> ([f32; 3], f32) {
    let mut color = vec![[10.0f32; 3]; SIZE * SIZE];
    let mut height = vec![0.0f32; SIZE * SIZE];
    objects.draw((0, 0), SIZE, &mut color, &mut height);
    move |x, y| (color[y * SIZE + x], height[y * SIZE + x])
}

#[test]
fn draws_textured_models_from_above_and_leaves_markers_and_hidden_parts_out() {
    let data = Data::new();
    let objects = data.objects("base.esm");
    assert_eq!((objects.placed(), objects.models()), (4, 3), "the marker and the object without a model are not placed");
    assert_eq!(objects.missing_models, vec!["x\\none.nif".to_string()]);
    let at = draw(&objects);
    // The wall stands in the north-west quarter, at 500 units: the far version, the editor
    // marker and the collision shape above it are not drawn.
    assert_eq!(at(16, 16), ([200.0, 0.0, 0.0], 500.0));
    // The box has no texture and is grey.
    assert_eq!(at(48, 48), ([140.0, 140.0, 140.0], 300.0));
    // The fence's texture is see-through, so the ground shows through it.
    assert_eq!(at(48, 16), ([10.0, 10.0, 10.0], 0.0));
    assert_eq!(at(16, 48), ([10.0, 10.0, 10.0], 0.0), "nothing stands in the south-west");
}

#[test]
fn loads_the_masters_first_and_follows_deletions_of_the_plugins_shown() {
    let data = Data::new();
    let mut objects = data.objects("mod.esp");
    assert_eq!(draw(&objects)(16, 16).1, 0.0, "the mod deleted the wall");
    objects.show_only(&["Base.esm".into()]);
    assert_eq!(draw(&objects)(16, 16).1, 500.0, "the wall is back without the mod");
    objects.show_only(&["mod.esp".into(), "unknown.esp".into()]);
    assert_eq!(draw(&objects)(16, 16).1, 0.0);
    let placed = objects.placed();
    let dirs = vec![data.dir.path().to_path_buf()];
    objects.load_plugin(&data.dir.join("base.esm"), &dirs, &Assets::new(dirs.clone())).unwrap();
    assert_eq!(objects.placed(), placed, "a plugin is loaded only once");
}

#[test]
fn draws_nothing_in_a_cell_without_models_and_fails_on_a_missing_master() {
    let data = Data::new();
    let objects = data.objects("base.esm");
    let mut color = vec![[0.0f32; 3]; 4];
    objects.draw((5, 5), 2, &mut color, &mut [0.0; 4]);
    assert_eq!(color, vec![[0.0; 3]; 4]);
    save_plugin(data.dir.path(), "orphan.esp", &["gone.esm"], vec![]);
    let dirs = vec![data.dir.path().to_path_buf()];
    let error = Objects::default().load_plugin(&data.dir.join("orphan.esp"), &dirs, &Assets::new(dirs.clone())).unwrap_err();
    assert!(error.to_string().contains("gone.esm"));
}

#[test]
fn tells_markers_by_their_file_name() {
    assert!(is_marker("marker_travel.nif") && is_marker("x\\editormarker_door.nif"));
    assert!(!is_marker("x\\ex_marker_house.nif"));
}

#[test]
fn keeps_ever_smaller_copies_of_a_texture() {
    let data = Data::new();
    texture(data.dir.path(), "textures\\tx_odd.tga", [9, 9, 9, 255], 3);
    let image = read_image(&Assets::new(vec![data.dir.path().to_path_buf()]), "tx_odd.tga").unwrap();
    assert_eq!(image.levels.iter().map(|level| (level.width, level.height)).collect::<Vec<_>>(), vec![(4, 4), (2, 2), (1, 1)]);
    assert_eq!(image.levels[2].pixels[0], [9, 9, 9, 255]);
}

