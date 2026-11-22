use super::*;
use crate::fixtures::{archive, texture, TempDir};

#[test]
fn finds_a_texture_by_its_stem_in_folders_first_then_in_the_later_archive() {
    let data = TempDir::new();
    // A landscape record names a .tga; the folder has a .dds of that stem, really a PNG.
    texture(data.path(), "textures\\tx_sand.dds", [200, 100, 50, 255], 4);
    let mut png = Vec::new();
    image::RgbaImage::from_pixel(2, 2, image::Rgba([1, 2, 3, 255])).write_to(&mut std::io::Cursor::new(&mut png), ImageFormat::Png).unwrap();
    archive(&data.join("first.bsa"), &[("textures\\tx_rock.tga", png.clone()), ("meshes\\a.nif", b"first".to_vec())]);
    archive(&data.join("second.bsa"), &[("meshes\\a.nif", b"second".to_vec())]);
    let mut assets = Assets::new(vec![data.join("missing"), data.path().to_path_buf()]);
    assets.add_archive(&data.join("first.bsa")).unwrap();
    assets.add_archive(&data.join("second.bsa")).unwrap();

    assert_eq!(assets.load_texture("TX_Sand.tga", 2).unwrap(), vec![[200.0, 100.0, 50.0]; 4]);
    assert_eq!(assets.load_image("textures/tx_rock.tga").unwrap().get_pixel(0, 0).0, [1, 2, 3, 255]);
    assert_eq!(assets.read("meshes\\a.nif").unwrap(), b"second");
    assert!(assets.read("meshes\\b.nif").is_none());
    assert!(assets.load_texture("tx_none.tga", 2).unwrap_err().to_string().contains("not found"));
    assert!(assets.add_archive(&data.join("none.bsa")).is_err());
}

#[test]
fn reads_loose_files_and_reports_one_it_cannot_decode() {
    let data = TempDir::new();
    data.write("meshes\\x\\model.nif", "loose");
    data.write("textures\\broken.bmp", "not an image");
    let assets = Assets::new(vec![data.path().to_path_buf()]);
    assert_eq!(assets.read("meshes\\x\\model.nif").unwrap(), b"loose");
    assert!(assets.load_image("broken.bmp").unwrap_err().to_string().contains("decoding texture broken.bmp"));
}
