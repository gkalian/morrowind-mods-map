use super::*;
use crate::fixtures::game;
use serde_json::Value;

#[test]
fn reports_what_the_transport_rules_are_checked_against() {
    let root = game();
    let out = root.join("audit.json");
    run(root.path(), &out).unwrap();
    let report: Value = serde_json::from_slice(&fs::read(&out).unwrap()).unwrap();
    let names = |list: &str, field: &str| -> Vec<String> {
        report[list].as_array().unwrap().iter().map(|item| item[field].as_str().unwrap().to_string()).collect()
    };
    // Every character with destinations, the thief whose class has no mode among them.
    assert_eq!(names("carriers", "id"), vec!["darvame", "folsi", "guide", "thief", "daedroth", "boatman"]);
    assert_eq!(report["carriers"][4]["class"], "<creature>");
    assert_eq!(names("classes", "id"), vec!["Caravaner"]);
    assert_eq!(report["carriers"][2]["destinations"][0], "Andasreth, Propylon Chamber");
    assert_eq!(report["carriers"][0]["destinations"][0], "12288,4096");
    assert_eq!(names("dialogue_travel", "speaker"), vec!["asciene"]);
    assert_eq!(report["dialogue_travel"][0]["topic"], "transport to Mournhold");
    assert_eq!(names("scripts", "id"), vec!["warp_andra", "MHTransportScript", "TR_Start", "boat_sc"]);
    assert_eq!(names("globals", "id"), vec!["T_Glob_Installed_TR"]);
}
