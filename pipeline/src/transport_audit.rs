//! A read-only report of everything in the plugins that the transport data is derived from:
//! carriers, travel started from dialogue, scripts that move or toggle actors under a condition,
//! global variables and classes. It is for checking the derivation rules against real data.

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use anyhow::{Context, Result};
use serde::Serialize;
use tes3::esp::{Class, Creature, Dialogue, DialogueInfo, GlobalVariable, Plugin, TES3Object};

use crate::config::{LocalPaths, SetsFile};
use crate::locations::plugin_file;
use crate::transport::find_plugin;

#[derive(Serialize)]
struct Carrier {
    set: String,
    plugin: String,
    id: String,
    name: String,
    class: String,
    script: String,
    destinations: Vec<String>,
}

#[derive(Serialize)]
struct FilterRow {
    kind: String,
    function: String,
    id: String,
    comparison: String,
    value: f32,
}

#[derive(Serialize)]
struct DialogueTravel {
    set: String,
    plugin: String,
    topic: String,
    topic_type: String,
    speaker: String,
    speaker_class: String,
    speaker_cell: String,
    filters: Vec<FilterRow>,
    script: String,
}

#[derive(Serialize)]
struct ScriptRow {
    set: String,
    plugin: String,
    id: String,
    text: String,
}

#[derive(Serialize)]
struct GlobalRow {
    set: String,
    plugin: String,
    id: String,
    value: f32,
}

#[derive(Serialize)]
struct ClassRow {
    set: String,
    plugin: String,
    id: String,
    name: String,
}

#[derive(Default, Serialize)]
struct Report {
    carriers: Vec<Carrier>,
    dialogue_travel: Vec<DialogueTravel>,
    scripts: Vec<ScriptRow>,
    globals: Vec<GlobalRow>,
    classes: Vec<ClassRow>,
}

fn interesting_script(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("positioncell") || lower.contains("t_glob_installed") || lower.contains("getitemcount") || lower.contains("disable") || lower.contains("journal")
}

fn read(set: &str, path: &Path, report: &mut Report) -> Result<()> {
    let plugin = Plugin::from_path_filtered(path, |tag| {
        matches!(&tag, b"TES3" | b"NPC_" | b"CREA" | b"SCPT" | b"DIAL" | b"INFO" | b"GLOB" | b"CLAS")
    })
    .with_context(|| format!("loading {}", path.display()))?;
    let file = plugin_file(path);
    let mut topic: Option<&Dialogue> = None;
    for object in &plugin.objects {
        match object {
            TES3Object::Dialogue(dialogue) => topic = Some(dialogue),
            TES3Object::DialogueInfo(info) => dialogue_travel(set, &file, topic, info, report),
            TES3Object::Npc(npc) => carrier(set, &file, npc.id.as_str(), &npc.name, &npc.class, &npc.script, &npc.travel_destinations, report),
            TES3Object::Creature(creature) => creature_carrier(set, &file, creature, report),
            TES3Object::Script(script) => {
                if interesting_script(&script.text) {
                    report.scripts.push(ScriptRow { set: set.into(), plugin: file.clone(), id: script.id.clone(), text: script.text.clone() });
                }
            }
            TES3Object::GlobalVariable(global) => global_row(set, &file, global, report),
            TES3Object::Class(class) => class_row(set, &file, class, report),
            _ => {}
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn carrier(set: &str, file: &str, id: &str, name: &str, class: &str, script: &str, destinations: &[tes3::esp::TravelDestination], report: &mut Report) {
    if destinations.is_empty() {
        return;
    }
    report.carriers.push(Carrier {
        set: set.into(),
        plugin: file.into(),
        id: id.into(),
        name: name.into(),
        class: class.into(),
        script: script.into(),
        destinations: destinations.iter().map(|d| if d.cell.is_empty() { format!("{:.0},{:.0}", d.translation[0], d.translation[1]) } else { d.cell.clone() }).collect(),
    });
}

fn creature_carrier(set: &str, file: &str, creature: &Creature, report: &mut Report) {
    if creature.travel_destinations.is_empty() {
        return;
    }
    report.carriers.push(Carrier {
        set: set.into(),
        plugin: file.into(),
        id: creature.id.clone(),
        name: creature.name.clone(),
        class: "<creature>".into(),
        script: creature.script.clone(),
        destinations: creature.travel_destinations.iter().map(|d| d.cell.clone()).collect(),
    });
}

fn dialogue_travel(set: &str, file: &str, topic: Option<&Dialogue>, info: &DialogueInfo, report: &mut Report) {
    let lower = info.script_text.to_ascii_lowercase();
    if !lower.contains("positioncell") && !lower.contains("startscript") {
        return;
    }
    report.dialogue_travel.push(DialogueTravel {
        set: set.into(),
        plugin: file.into(),
        topic: topic.map(|t| t.id.clone()).unwrap_or_default(),
        topic_type: topic.map(|t| format!("{:?}", t.dialogue_type)).unwrap_or_default(),
        speaker: info.speaker_id.clone(),
        speaker_class: info.speaker_class.clone(),
        speaker_cell: info.speaker_cell.clone(),
        filters: info
            .filters
            .iter()
            .map(|f| FilterRow {
                kind: format!("{:?}", f.filter_type),
                function: format!("{:?}", f.function),
                id: f.id.clone(),
                comparison: format!("{:?}", f.comparison),
                value: match f.value {
                    tes3::esp::FilterValue::Float(v) => v,
                    tes3::esp::FilterValue::Integer(v) => v as f32,
                },
            })
            .collect(),
        script: info.script_text.clone(),
    });
}

fn global_row(set: &str, file: &str, global: &GlobalVariable, report: &mut Report) {
    if global.id.to_ascii_lowercase().contains("installed") {
        report.globals.push(GlobalRow { set: set.into(), plugin: file.into(), id: global.id.clone(), value: global.value.to_f32() });
    }
}

fn class_row(set: &str, file: &str, class: &Class, report: &mut Report) {
    report.classes.push(ClassRow { set: set.into(), plugin: file.into(), id: class.id.clone(), name: class.name.clone() });
}

pub fn run(root: &Path, out: &Path) -> Result<()> {
    let sets = SetsFile::load(&root.join("plugin-sets.toml"))?;
    let paths = LocalPaths::load(&root.join("paths.local.toml"))?;
    let dirs = paths.data_dirs();
    let mut report = Report::default();
    let mut seen: HashMap<String, ()> = HashMap::new();
    let mut files: Vec<(String, String)> = Vec::new();
    for set in &sets.sets {
        if set.is_backdrop() {
            continue;
        }
        for name in &set.plugins {
            files.push((set.id.clone(), name.clone()));
        }
    }
    files.push(("tribunal".into(), "Tribunal.esm".into()));
    for (set, name) in files {
        if seen.insert(name.to_ascii_lowercase(), ()).is_some() {
            continue;
        }
        match find_plugin(&dirs, &name) {
            Ok(path) => {
                println!("Reading {}", path.display());
                read(&set, &path, &mut report)?;
            }
            Err(error) => eprintln!("Skipping {name}: {error}"),
        }
    }
    fs::write(out, serde_json::to_vec_pretty(&report)?)?;
    println!(
        "{} carriers, {} dialogue lines, {} scripts, {} globals, {} classes",
        report.carriers.len(),
        report.dialogue_travel.len(),
        report.scripts.len(),
        report.globals.len(),
        report.classes.len()
    );
    Ok(())
}
