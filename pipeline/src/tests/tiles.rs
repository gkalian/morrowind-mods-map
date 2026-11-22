use super::*;
use crate::fixtures::TempDir;

fn rgba(side: usize, color: impl Fn(usize, usize) -> [u8; 4]) -> Vec<u8> {
    (0..side).flat_map(|y| (0..side).map(move |x| (x, y))).flat_map(|(x, y)| color(x, y)).collect()
}

/// Reads a tile back with the same library that wrote it.
fn decode(path: &Path) -> image::RgbaImage {
    let bytes = fs::read(path).unwrap();
    let decoded = webp::Decoder::new(&bytes).decode().unwrap();
    let rgba = if decoded.is_alpha() { decoded.to_vec() } else { decoded.chunks(3).flat_map(|p| [p[0], p[1], p[2], 255]).collect() };
    image::RgbaImage::from_raw(decoded.width(), decoded.height(), rgba).unwrap()
}

#[test]
fn halves_an_image_weighting_colour_by_opacity() {
    // Two opaque red pixels and two transparent green ones make a half-transparent red one.
    let image = rgba(2, |x, _| if x == 0 { [255, 0, 0, 255] } else { [0, 255, 0, 0] });
    assert_eq!(halve(&image, 2), vec![255, 0, 0, 128]);
    assert_eq!(halve(&[0; 16], 2), vec![0, 0, 0, 0], "nothing to see stays clear");
}

#[test]
fn cuts_a_cell_into_tiles_at_every_zoom_down_to_one_tile() {
    let dir = TempDir::new();
    // A Cell at zoom 9 is 2 x 2 tiles: red in the north-west, blue elsewhere.
    let side = TILE * 2;
    let image = rgba(side, |x, y| if x < TILE && y < TILE { [255, 0, 0, 255] } else { [0, 0, 255, 255] });
    let (xy, quarter, written) = write_cell(dir.path(), (3, -2), image, 9).unwrap();
    assert_eq!((xy, written, quarter.len()), ((3, 1), 5, HALF * HALF * 4));
    // Rows grow southwards: the Cell's northern half is row 2 at zoom 9.
    // Tiles are compressed with loss: colours come back within a step or two.
    let red = decode(&dir.join("9/6/2.webp")).get_pixel(10, 10).0;
    assert!(red[0] > 250 && red[1] < 5 && red[2] < 5, "{red:?}");
    assert!(decode(&dir.join("9/7/3.webp")).get_pixel(10, 10).0[2] > 200);
    let whole = decode(&dir.join("8/3/1.webp"));
    assert!(whole.get_pixel(10, 10).0[0] > 200 && whole.get_pixel(200, 200).0[2] > 200);
    assert!(write_tile(&dir.join("8/3/1.webp"), 8, (0, 0), &[0; TILE * TILE * 4]).is_err(), "a file stands where a folder should");
}

#[test]
fn builds_the_lower_zoom_levels_from_quarters() {
    let dir = TempDir::new();
    let quarter = |value: u8| vec![value; HALF * HALF * 4];
    // Two neighbouring tiles at zoom 8, and one far away with a negative column.
    let quarters: HashMap<TileXY, Quarter> = [((0, 0), quarter(255)), ((1, 0), quarter(100)), ((-1, 3), quarter(50))].into();
    let written = build_levels(dir.path(), quarters, 7, 6).unwrap();
    assert_eq!(written, 2 + 2);
    let parent = decode(&dir.join("7/0/0.webp"));
    assert!(parent.get_pixel(10, 10).0[3] > 200, "the western child fills the top-left quarter");
    assert!(parent.get_pixel(200, 10).0[0] > 80 && parent.get_pixel(200, 10).0[0] < 120);
    assert_eq!(parent.get_pixel(10, 200).0[3], 0, "no child in the south");
    assert!(dir.join("7/-1/1.webp").is_file() && dir.join("6/-1/0.webp").is_file() && dir.join("6/0/0.webp").is_file());
}
