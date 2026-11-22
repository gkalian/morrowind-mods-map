//! The transport data of a whole made-up game, built as the `transport` command builds it.

use super::*;
use crate::fixtures::{game, TempDir};
use serde_json::{json, Value};

fn read(path: &Path) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

fn russian(root: &TempDir) -> Russian {
    let sets = SetsFile::load(&root.join("plugin-sets.toml")).unwrap();
    let paths = LocalPaths::load(&root.join("paths.local.toml")).unwrap();
    Russian::load(&paths.russian_data_files, &sets).unwrap()
}

/// The ids of a list of records in a set file.
fn ids(file: &Value, list: &str) -> Vec<String> {
    file[list].as_array().unwrap().iter().map(|item| item["id"].as_str().unwrap().to_string()).collect()
}

#[test]
fn writes_the_transport_of_every_set_from_the_plugins() {
    let root = game();
    let out = root.join("out/transport");
    build(root.path(), &out, &[], &russian(&root)).unwrap();

    let index = read(&out.join("index.json"));
    assert_eq!(index["schemaVersion"], 2);
    assert_eq!(index["sets"], json!(["morrowind", "tr"]));
    assert_eq!(index["anchors"], json!([{ "cells": "mournhold", "x": 23.5, "y": -27.5, "name": "Mournhold", "ru": "Морнхолд" }]));
    assert_eq!(index["items"], json!({ "index_andra": { "name": "Andasreth Propylon Index", "ru": "Метка пропильона Андасрета" } }));

    let morrowind = read(&out.join("morrowind.json"));
    // The thief has destinations but no mode for his class; Asciene offers transport in dialogue only.
    assert_eq!(ids(&morrowind, "actors"), vec!["darvame", "folsi", "guide", "asciene"]);
    assert_eq!(morrowind["actors"][0]["ru"], "Дарвам Хлеран");
    assert_eq!(morrowind["actors"][3]["mode"], Value::Null);
    assert_eq!(ids(&morrowind, "activators"), vec!["propylon"]);
    assert_eq!(morrowind["scripts"], json!([{ "id": "warp_andra", "deleted": false, "gates": [{
        "to": { "position": [0.0, 0.0, 0.0], "cell": "andasreth, propylon chamber" }, "items": ["index_andra"], "mode": "propylon" }] }]));
    assert_eq!(morrowind["dialogue"], json!([{ "actor": "asciene", "topic": "transport to Mournhold", "mode": "magic",
        "to": { "position": [0.0, 0.0, 0.0], "cell": "mournhold, royal palace" } }]));
    let references: Vec<&str> = morrowind["references"].as_array().unwrap().iter().map(|r| r["key"].as_str().unwrap()).collect();
    // Carriers, the propylon and the doors out of the interiors they stand in or lead to; not the wall.
    for key in ["morrowind.esm:1", "morrowind.esm:6", "morrowind.esm:7", "morrowind.esm:8", "morrowind.esm:9", "morrowind.esm:10", "morrowind.esm:11"] {
        assert!(references.contains(&key), "{key} in {references:?}");
    }
    assert!(!references.contains(&"morrowind.esm:3"));
    let markers: Vec<&str> = morrowind["interventionReferences"].as_array().unwrap().iter().map(|r| r["actor"].as_str().unwrap()).collect();
    assert_eq!(markers, vec!["templemarker", "divinemarker", "templemarker"]);

    let tr = read(&out.join("tr.json"));
    assert_eq!(ids(&tr, "actors"), vec!["boatman"]);
    let scripts: Vec<&Value> = tr["scripts"].as_array().unwrap().iter().collect();
    assert_eq!(scripts.len(), 2);
    assert!(scripts.contains(&&json!({ "id": "boat_sc", "deleted": false, "requires": ["tr"] })));
    // "Old Ebonheart" is not the name of an interior, so the move is to the exterior.
    assert!(scripts.contains(&&json!({ "id": "tr_start", "deleted": false, "moves": [{ "actor": "folsi", "set": "tr",
        "to": { "position": [20480.0, 4096.0, 0.0], "cell": "" } }] })));
}

#[test]
fn joins_the_manifest_that_is_there_and_skips_what_it_is_told_to() {
    let root = game();
    root.write("out/manifest.json", r#"{ "build": 1, "sets": [] }"#);
    let out = root.join("out/transport");
    build(root.path(), &out, &["nothing".to_string()], &Russian::default()).unwrap();
    assert_eq!(read(&root.join("out/manifest.json"))["transport"], "transport/index.json");
    assert_eq!(read(&out.join("index.json"))["sets"], json!(["morrowind"]), "only the Base Set, which cannot be left out");
    assert_eq!(read(&out.join("morrowind.json"))["actors"][0].get("ru"), None);
}

#[test]
fn skips_a_mod_that_is_not_there_but_not_the_base_game() {
    let root = game();
    fs::remove_dir_all(root.join("mods/tr")).unwrap();
    let out = root.join("out/transport");
    build(root.path(), &out, &[], &Russian::default()).unwrap();
    assert_eq!(read(&out.join("index.json"))["sets"], json!(["morrowind"]));
    fs::remove_file(root.join("data/Morrowind.esm")).unwrap();
    let error = build(root.path(), &out, &[], &Russian::default()).unwrap_err();
    assert!(error.to_string().contains("Morrowind.esm was not found"));
}

#[test]
fn says_when_two_files_differ_only_in_case() {
    let dir = TempDir::new();
    dir.write("A.esp", "");
    dir.write("a.ESP", "");
    // Only a file system that tells case apart can hold both.
    if fs::read_dir(dir.path()).unwrap().count() == 2 {
        let error = find_plugin(&[dir.path().to_path_buf()], "A.Esp").unwrap_err();
        assert!(error.to_string().contains("More than one file"));
    }
}
