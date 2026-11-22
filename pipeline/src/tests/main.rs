//! The whole build, run on a made-up game as the `build` command runs it.

use super::*;
use crate::fixtures::game;
use serde_json::{json, Value};

fn read(path: &Path) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

fn run(root: &crate::fixtures::TempDir, locations_only: bool, only: &[&str], area: &[i32]) -> Value {
    let only: Vec<String> = only.iter().map(|id| id.to_string()).collect();
    build(&root.path().to_path_buf(), &root.join("out"), locations_only, &only, area).unwrap();
    read(&root.join("out/manifest.json"))
}

fn sets(manifest: &Value) -> Vec<(String, Value)> {
    manifest["sets"].as_array().unwrap().iter().map(|set| (set["id"].as_str().unwrap().to_string(), set["land"].clone())).collect()
}

#[test]
fn builds_tiles_locations_transport_and_the_manifest() {
    let root = game();
    let manifest = run(&root, false, &[], &[]);
    assert_eq!(
        (&manifest["cellSize"], &manifest["minZoom"], &manifest["maxNativeZoom"], &manifest["water"], &manifest["transport"]),
        (&json!(8192), &json!(6), &json!(8), &json!("#344e6e"), &json!("transport/index.json"))
    );
    // In the order of plugin-sets.toml; the backdrop has its own zoom and no Locations.
    assert_eq!(sets(&manifest), vec![
        ("tamriel".to_string(), json!([5, 5])),
        ("morrowind".to_string(), json!([0, 0, 0, 1, 1, 0])),
        ("tr".to_string(), json!([2, 0])),
    ]);
    let tamriel = &manifest["sets"][0];
    assert_eq!((&tamriel["maxNativeZoom"], &tamriel["backdropFor"], tamriel.get("locations")), (&json!(7), &json!(["tr"]), None));
    let morrowind = &manifest["sets"][1];
    assert_eq!((&morrowind["locked"], &morrowind["bounds"], &morrowind["locations"]), (&json!(true), &json!([0, 0, 1, 1]), &json!("locations/morrowind.json")));
    assert_eq!(manifest["sets"][2]["version"], "1.0");

    // A Cell is one tile at zoom 8; the levels below are built from it.
    for tile in ["morrowind/8/0/-1.webp", "morrowind/8/1/-1.webp", "morrowind/8/0/-2.webp", "morrowind/7/0/-1.webp", "morrowind/6/0/-1.webp", "tr/8/2/-1.webp", "tamriel/7/2/-3.webp", "tamriel/6/1/-2.webp"] {
        assert!(root.join("out/tiles").join(tile).is_file(), "{tile}");
    }

    let locations = read(&root.join("out/locations/morrowind.json"));
    assert_eq!(locations["settlements"][0]["name"], "Seyda Neen");
    assert_eq!(locations["settlements"][0]["ru"], "Сейда Нин");
    assert_eq!(locations["entrances"][0]["name"], "Seyda Neen, Census Office");
    assert_eq!(locations["regions"][0]["name"], "Bitter Coast");
    assert_eq!(read(&root.join("out/locations/tr.json"))["settlements"][0]["name"], "Old Ebonheart");
    assert_eq!(read(&root.join("out/transport/index.json"))["sets"], json!(["morrowind", "tr"]));
}

#[test]
fn rebuilds_a_part_and_keeps_the_rest() {
    let root = game();
    run(&root, false, &[], &[]);
    let kept = root.join("out/tiles/morrowind/8/0/-1.webp");
    fs::write(&kept, b"kept").unwrap();

    // Only Tamriel Rebuilt: Morrowind keeps its tiles as they are.
    run(&root, false, &["tr"], &[]);
    assert_eq!(fs::read(&kept).unwrap(), b"kept");
    // Only one Cell of every set: the other tiles of a set rendered anew are gone.
    run(&root, false, &[], &[0, 0, 0, 0]);
    assert_ne!(fs::read(&kept).unwrap(), b"kept");
    assert!(!root.join("out/tiles/morrowind/8/1/-1.webp").exists());
}

#[test]
fn leaves_off_the_map_what_has_no_tiles() {
    let root = game();
    run(&root, false, &[], &[]);
    fs::remove_dir_all(root.join("out/tiles/tr")).unwrap();
    fs::remove_file(root.join("out/tiles/morrowind/8/1/-1.webp")).unwrap();
    // The Locations are written anew; the tiles are what they are.
    let manifest = run(&root, true, &[], &[]);
    assert_eq!(sets(&manifest), vec![("tamriel".to_string(), json!([5, 5])), ("morrowind".to_string(), json!([0, 0, 0, 1]))]);
    assert_eq!((&manifest["sets"][1]["cells"], &manifest["sets"][1]["bounds"]), (&json!(2), &json!([0, 0, 0, 1])));
}

#[test]
fn stops_when_an_archive_or_a_plugin_is_missing() {
    let root = game();
    fs::remove_file(root.join("data/Morrowind.bsa")).unwrap();
    let error = build(&root.path().to_path_buf(), &root.join("out"), false, &[], &[]).unwrap_err();
    assert!(error.to_string().contains("Morrowind.bsa"));
}

#[test]
fn tells_the_extent_of_a_group_of_cells() {
    assert_eq!(bounds_of(&[]), [0, 0, 0, 0]);
    assert_eq!(bounds_of(&[(3, -1), (-2, 4)]), [-2, -1, 3, 4]);
}
