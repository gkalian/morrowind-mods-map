use super::*;
use crate::fixtures::{land, landscape_texture, save_plugin, texture, TempDir};
use tes3::esp::TES3Object;

fn world(data: &TempDir, objects: Vec<TES3Object>) -> (World, Vec<Grid>) {
    let path = save_plugin(data.path(), "test.esp", &[], objects);
    let assets = Assets::new(vec![data.path().to_path_buf()]);
    let mut world = World::new(2);
    let defined = world.load_plugin(&path, &assets).unwrap();
    (world, defined)
}

#[test]
fn reads_heights_colours_and_the_texture_of_every_square() {
    let data = TempDir::new();
    texture(data.path(), "textures\\_land_default.tga", [10, 10, 10, 255], 2);
    texture(data.path(), "textures\\tx_grass.tga", [0, 200, 0, 255], 2);
    let mut squares = [[0u16; 16]; 16];
    squares[0][0] = 1;
    squares[15][3] = 1;
    squares[5][5] = 9;
    let (world, defined) = world(&data, vec![landscape_texture(0, "tx_grass.tga"), land((2, -3), 400.0, Some(squares), Some([255, 0, 0]))]);
    assert_eq!(defined, vec![(2, -3)]);
    let cell = &world.cells[&(2, -3)];
    assert_eq!((cell.heights[0][0], cell.heights[64][64]), (400.0, 400.0));
    assert_eq!(cell.colors.as_ref().unwrap()[10][10], [255, 0, 0]);
    let grass = cell.textures[0][0];
    assert_eq!(world.textures[grass as usize].pixels[0], [0.0, 200.0, 0.0]);
    assert_eq!(cell.textures[15][3], grass);
    // An unknown texture number falls back to the default texture, as zero does.
    assert_eq!(cell.textures[5][5], cell.textures[1][1]);
    assert_ne!(cell.textures[1][1], grass);
    assert!(world.missing_textures.is_empty());
}

#[test]
fn draws_a_missing_texture_grey_and_skips_land_without_heights_or_deleted() {
    let data = TempDir::new();
    let mut no_heights = land((1, 0), 0.0, None, None);
    if let TES3Object::Landscape(land) = &mut no_heights {
        land.landscape_flags = LandscapeFlags::empty();
    }
    let mut gone = land((2, 0), 0.0, None, None);
    if let TES3Object::Landscape(land) = &mut gone {
        land.flags = ObjectFlags::DELETED;
    }
    let (world, defined) = world(&data, vec![land((0, 0), -100.0, None, None), no_heights, gone]);
    assert_eq!(defined, vec![(0, 0)]);
    assert!(world.cells[&(0, 0)].colors.is_none());
    assert_eq!(world.missing_textures, vec![DEFAULT_TEXTURE.to_string()]);
    assert_eq!(world.textures[0].pixels, vec![[128.0, 128.0, 128.0]; 4]);
}

#[test]
fn says_which_plugin_it_could_not_read() {
    let data = TempDir::new();
    let error = World::new(2).load_plugin(&data.join("none.esp"), &Assets::new(vec![])).unwrap_err();
    assert!(format!("{error:#}").contains("none.esp"));
}
