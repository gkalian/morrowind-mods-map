use super::*;
use crate::fixtures::{save_plugin, TempDir};
use crate::locations::{Entrance, RegionArea, Settlement};
use tes3::esp::TES3Object;

/// A Russian name as the plugin reader gives it: Windows-1251 bytes taken for Windows-1252.
fn as_read(russian: &str) -> String {
    WINDOWS_1252.decode(&WINDOWS_1251.encode(russian).0).0.into_owned()
}

fn sets(plugins: &[&str]) -> SetsFile {
    let list = plugins.iter().map(|name| format!("\"{name}\"")).collect::<Vec<_>>().join(", ");
    toml::from_str(&format!("cell_pixels = 256\nmin_zoom = 2\nwater = [0, 0, 0]\n[[set]]\nid = \"base\"\nname = \"Base\"\nplugins = [{list}]\n")).unwrap()
}

/// A Russian release: a `.cel` file and a plugin with Russian names, as the game has them.
fn release() -> TempDir {
    let dir = TempDir::new();
    let cel = WINDOWS_1251.encode("Balmora\tБалмора\nWest Gash Region\tРайон Западного Нагорья\nno tab here\nPelagiad\t \n").0;
    fs::write(dir.join("morrowind.cel"), cel).unwrap();
    fs::write(dir.join("notes.txt"), "not a .cel").unwrap();
    save_plugin(dir.path(), "Morrowind.esm", &[], vec![
        TES3Object::from(Region { id: "Ascadian Isles Region".into(), name: as_read("Район Аскадианских островов"), ..Region::default() }),
        Region { id: "kept english".into(), name: "Kept English".into(), ..Region::default() }.into(),
        Npc { id: "Darvame Hleran".into(), name: as_read("Дарвам Хлеран"), ..Npc::default() }.into(),
        Creature { id: "guar".into(), name: as_read("Гуар"), ..Creature::default() }.into(),
        MiscItem { id: "Index_Andra".into(), name: as_read("Метка пропильона Андасрета"), ..MiscItem::default() }.into(),
    ]);
    dir
}

#[test]
fn reads_names_from_cel_files_and_russian_plugins() {
    let dir = release();
    let russian = Russian::load(&[dir.path().to_path_buf()], &sets(&["Morrowind.esm", "Bloodmoon.esm"])).unwrap();
    assert_eq!(russian.place("BALMORA").as_deref(), Some("Балмора"));
    assert_eq!(russian.place("Pelagiad"), None, "an empty translation is none");
    assert_eq!(russian.actor("darvame hleran").as_deref(), Some("Дарвам Хлеран"));
    assert_eq!(russian.actor("Guar").as_deref(), Some("Гуар"));
    assert_eq!(russian.item("index_andra").as_deref(), Some("Метка пропильона Андасрета"));
    assert_eq!(russian.actor("nobody"), None);
}

#[test]
fn translates_the_locations_of_a_set_and_counts_what_is_left() {
    let dir = release();
    let russian = Russian::load(&[dir.path().to_path_buf()], &sets(&["Morrowind.esm"])).unwrap();
    let area = |id: &str, name: &str| RegionArea { id: id.into(), name: name.into(), ru: None, color: String::new(), x: 0.0, y: 0.0, cells: vec![], continues: false };
    let mut locations = Locations {
        settlements: vec![Settlement { name: "Balmora".into(), ru: None, x: 0.0, y: 0.0, cells: vec![] }],
        entrances: vec![Entrance { name: "Balmora, Temple".into(), ru: None, x: 0.0, y: 0.0 }],
        regions: vec![area("ascadian isles region", "Ascadian Isles"), area("west gash region", "West Gash"), area("kept english", "Kept English")],
        ..Locations::default()
    };
    russian.translate(&mut locations);
    assert_eq!(locations.settlements[0].ru.as_deref(), Some("Балмора"));
    assert_eq!(locations.entrances[0].ru, None);
    let regions: Vec<_> = locations.regions.iter().map(|region| region.ru.clone()).collect();
    assert_eq!(regions, vec![Some("Район Аскадианских островов".into()), Some("Район Западного Нагорья".into()), None]);
    assert_eq!(Russian::untranslated(&locations), 2);
}

#[test]
fn says_which_folder_it_could_not_read() {
    let Err(error) = Russian::load(&[PathBuf::from("no such folder")], &sets(&[])) else { panic!("read a folder that is not there") };
    assert!(error.to_string().contains("no such folder"));
}
