use super::*;
use crate::fixtures::{deleted, door, exterior, interior, placed, save_plugin, TempDir};
use tes3::esp::{Reference, TES3Object};

fn region(id: &str, name: &str, color: [u8; 4]) -> TES3Object {
    Region { id: id.into(), name: name.into(), map_color: color, ..Region::default() }.into()
}

/// What a door into "Balmora, Temple" moved by a later plugin looks like.
fn moved(master: u32, index: u32, x: f32, y: f32) -> Reference {
    door(master, index, x, y, "Balmora, Temple", [0.0; 3])
}

/// `base.esm` names two Settlements called Balmora far apart, places doors into the temple and
/// colours two Regions; `mod.esp` renames, clears and extends what `base.esm` has.
fn data() -> TempDir {
    let dir = TempDir::new();
    let mut gone_cell = exterior((9, 9), "Gone", None, vec![]);
    if let TES3Object::Cell(cell) = &mut gone_cell {
        cell.flags = ObjectFlags::DELETED;
    }
    save_plugin(dir.path(), "base.esm", &[], vec![
        region("west gash region", "West Gash Region", [10, 20, 30, 0]),
        region("ashlands region", "Ashlands", [200, 0, 0, 0]),
        exterior((0, 0), "Balmora", Some("West Gash Region"), vec![
            door(0, 1, 100.0, 100.0, "Balmora, Temple", [0.0; 3]),
            door(0, 2, 2000.0, 2000.0, "Balmora, Temple", [0.0; 3]),
            door(0, 3, 300.0, 300.0, "", [5.0, 5.0, 0.0]),
            placed(0, 4, "chair", 50.0, 50.0),
            Reference { deleted: Some(true), ..door(0, 5, 10.0, 10.0, "Hidden", [0.0; 3]) },
        ]),
        exterior((1, 0), "Balmora", Some("West Gash Region"), vec![door(0, 6, 12000.0, 100.0, "Balmora, Temple", [0.0; 3])]),
        exterior((5, 5), "Balmora", None, vec![]),
        exterior((2, 2), "", Some("Ashlands Region"), vec![]),
        exterior((3, 3), "", Some("Unknown Region"), vec![]),
        gone_cell,
        interior("Balmora, Temple", vec![door(0, 7, 0.0, 0.0, "", [0.0; 3])]),
    ]);
    save_plugin(dir.path(), "mod.esp", &["base.esm"], vec![
        exterior((0, 0), "New Balmora", Some("West Gash Region"), vec![deleted(1, 1), moved(1, 2, 2200.0, 2200.0)]),
        exterior((1, 0), "", Some("West Gash Region"), vec![]),
        exterior((2, 2), "", Some("West Gash Region"), vec![]),
        exterior((8, 8), "Fresh", Some("West Gash Region"), vec![]),
    ]);
    dir
}

fn land() -> HashSet<Grid> {
    [(0, 0), (1, 0), (2, 2), (3, 3), (5, 5), (8, 8)].into()
}

#[test]
fn finds_settlements_interior_entrances_and_regions_of_a_set() {
    let dir = data();
    let mut collector = Collector::default();
    collector.load_plugin(&dir.join("base.esm")).unwrap();
    let base = collector.finish_set(&land());

    let settlements: Vec<_> = base.settlements.iter().map(|s| (s.name.as_str(), s.x, s.y, s.cells.clone())).collect();
    assert_eq!(settlements, vec![("Balmora", 1.0, 0.5, vec![(0, 0), (1, 0)]), ("Balmora", 5.5, 5.5, vec![(5, 5)])], "far apart, they are two");

    // Two doors of the temple close together are one entrance; the third, a Cell away, is another.
    let entrances: Vec<_> = base.entrances.iter().map(|e| (e.name.as_str(), e.x, e.y)).collect();
    assert_eq!(entrances, vec![("Balmora, Temple", 0.128, 0.128), ("Balmora, Temple", 1.465, 0.012)]);

    let regions: Vec<_> = base.regions.iter().map(|r| (r.name.as_str(), r.color.as_str(), r.cells.clone(), r.continues)).collect();
    assert_eq!(regions, vec![("Ashlands", "#c80000", vec![(2, 2)], false), ("West Gash", "#0a141e", vec![(0, 0), (1, 0)], false)]);
    assert!(base.renamed.is_empty() && base.cleared.is_empty());
}

#[test]
fn credits_a_later_set_with_what_it_renames_clears_and_extends() {
    let dir = data();
    let mut collector = Collector::default();
    collector.load_plugin(&dir.join("base.esm")).unwrap();
    collector.finish_set(&land());
    collector.load_plugin(&dir.join("mod.esp")).unwrap();
    let changed = collector.finish_set(&land());

    let settlements: Vec<_> = changed.settlements.iter().map(|s| (s.name.as_str(), s.cells.clone())).collect();
    assert_eq!(settlements, vec![("Fresh", vec![(8, 8)]), ("New Balmora", vec![(0, 0)])], "only what the set added or changed");
    assert_eq!(changed.renamed, vec![(0, 0), (1, 0)], "renamed, and left nameless");
    // One door deleted and one moved, both where base.esm had them.
    assert_eq!(changed.cleared, vec![(0, 0)]);
    let entrances: Vec<_> = changed.entrances.iter().map(|e| (e.x, e.y)).collect();
    assert_eq!(entrances, vec![(0.269, 0.269)], "the moved door, where it stands now");
    // West Gash goes on in this set: its two new Cells are apart, the name goes on the larger
    // part, here the last of two of a size.
    let regions: Vec<_> = changed.regions.iter().map(|r| (r.name.as_str(), r.cells.clone(), r.x, r.continues)).collect();
    assert_eq!(regions, vec![("West Gash", vec![(2, 2), (8, 8)], 8.5, true)]);
}

#[test]
fn keys_references_by_the_plugin_that_placed_them() {
    let masters = vec!["morrowind.esm".to_string()];
    let own = Reference { mast_index: 0, refr_index: 7, ..Reference::default() };
    let theirs = Reference { mast_index: 1, ..own.clone() };
    let unknown = Reference { mast_index: 2, ..own.clone() };
    assert_eq!(reference_key("mod.esp", &masters, &own), Some(("mod.esp".to_string(), 7)));
    assert_eq!(reference_key("mod.esp", &masters, &theirs), Some(("morrowind.esm".to_string(), 7)));
    assert_eq!(reference_key("mod.esp", &masters, &unknown), None);
    assert_eq!(plugin_file(Path::new("Data Files/Mod.ESP")), "mod.esp");
}

#[test]
fn says_which_plugin_it_could_not_read() {
    let error = Collector::default().load_plugin(Path::new("missing.esp")).unwrap_err();
    assert!(error.to_string().contains("missing.esp"));
}
