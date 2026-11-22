use super::*;
use crate::assets::Assets;
use crate::fixtures::{land, landscape_texture, save_plugin, texture, TempDir};
use tes3::esp::TES3Object;

const WATER: [u8; 3] = [0, 0, 200];

/// A world of the given land records, with a red default texture and a green one numbered 1.
fn world(objects: Vec<TES3Object>) -> World {
    let data = TempDir::new();
    texture(data.path(), "textures\\_land_default.tga", [200, 0, 0, 255], 4);
    texture(data.path(), "textures\\tx_grass.tga", [0, 200, 0, 255], 4);
    let mut records = vec![landscape_texture(0, "tx_grass.tga")];
    records.extend(objects);
    let path = save_plugin(data.path(), "test.esp", &[], records);
    let mut world = World::new(4);
    world.load_plugin(&path, &Assets::new(vec![data.path().to_path_buf()])).unwrap();
    world
}

fn pixel(image: &[u8], size: usize, x: usize, y: usize) -> [u8; 4] {
    let at = (y * size + x) * 4;
    [image[at], image[at + 1], image[at + 2], image[at + 3]]
}

#[test]
fn shades_slopes_by_the_light_from_the_north_west() {
    assert_eq!(shade([0.0, 0.0, 0.0]), 1.0);
    assert!((shade([0.0, 0.0, 1.0]) - 1.0).abs() < 1e-6, "flat ground keeps its colour");
    assert!(shade([-1.0, 1.0, 1.0]) > 1.0, "facing the light");
    assert_eq!(shade([1.0, -1.0, 0.1]), 0.3, "turned away, but never black");
}

#[test]
fn fades_only_towards_open_neighbours() {
    assert_eq!(opacity(&[], 0.0, 0.0), 1.0);
    assert_eq!(opacity(&[(-1, 0)], 0.0, 0.5), 0.0, "at the open western edge");
    assert_eq!(opacity(&[(-1, 0)], 0.5, 0.5), 1.0, "far enough inside");
    assert_eq!(opacity(&[(1, 1)], 1.0, 1.0), 0.0, "at the open north-eastern corner");
    let half = opacity(&[(0, -1)], 0.5, 0.2);
    assert!(half > 0.0 && half < 1.0);
}

#[test]
fn renders_land_in_its_texture_and_sea_under_water() {
    let world = world(vec![land((0, 0), 200.0, None, None), land((1, 0), -900.0, None, None), land((2, 0), -100.0, None, None)]);
    let size = 64;
    assert_eq!(pixel(&render_cell(&world, None, (0, 0), size as u32, WATER, None), size, 10, 10), [200, 0, 0, 255]);
    assert_eq!(pixel(&render_cell(&world, None, (1, 0), size as u32, WATER, None), size, 10, 10), [0, 0, 200, 255], "deep water hides the sea bed");
    let shallow = pixel(&render_cell(&world, None, (2, 0), size as u32, WATER, None), size, 10, 10);
    assert!(shallow[0] > 0 && shallow[2] > 0, "shallow water shows the sea bed through it: {shallow:?}");
}

#[test]
fn blends_textures_across_squares_and_cells_and_tints_by_vertex_colour() {
    let mut east_half = [[0u16; 16]; 16];
    for row in &mut east_half {
        row[8..].fill(1);
    }
    let world = world(vec![land((0, 0), 100.0, Some(east_half), Some([255, 255, 0])), land((1, 0), 100.0, Some([[1; 16]; 16]), None)]);
    let size = 64;
    let image = render_cell(&world, None, (0, 0), size as u32, WATER, None);
    assert_eq!(pixel(&image, size, 2, 30), [200, 0, 0, 255], "red in the west");
    assert_eq!(pixel(&image, size, 60, 30), [0, 200, 0, 255], "green in the east, as in the next Cell");
    let middle = pixel(&image, size, 32, 30);
    assert!(middle[0] > 0 && middle[1] > 0, "blended where they meet: {middle:?}");
    // The Cell to the east has no vertex colours, the tinted one keeps its yellow tint: red and green, no blue.
    assert_eq!(pixel(&image, size, 2, 30)[2], 0);
}

#[test]
fn fades_the_edge_of_land_towards_cells_without_any() {
    let world = world(vec![land((0, 0), 100.0, None, None), land((1, 0), 100.0, None, None)]);
    let solid: HashSet<Grid> = [(0, 0), (1, 0)].into();
    let size = 64;
    let image = render_cell(&world, None, (0, 0), size as u32, WATER, Some(&solid));
    assert_eq!(pixel(&image, size, 0, 32)[3], 0, "the western neighbour has no land");
    assert_eq!(pixel(&image, size, 63, 32)[3], 255, "the eastern one has");
    assert_eq!(pixel(&image, size, 32, 32)[3], 255);
}
