use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use encoding_rs::{WINDOWS_1251, WINDOWS_1252};
use serde::Serialize;
use tes3::esp::{
    Activator, Cell, Creature, DialogueInfo, Npc, ObjectFlags, Plugin, Script, TravelDestination,
};

use crate::config::{find_file, LocalPaths, SetsFile};
use crate::locations::{masters_of, plugin_file, reference_key};

#[derive(Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Destination {
    position: [f32; 3],
    cell: String,
}

impl From<&TravelDestination> for Destination {
    fn from(value: &TravelDestination) -> Self {
        Self {
            position: value.translation,
            cell: value.cell.to_lowercase(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Actor {
    id: String,
    name: String,
    class: String,
    script: String,
    deleted: bool,
    destinations: Vec<Destination>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Reference {
    key: String,
    actor: String,
    cell: String,
    position: [f32; 3],
    deleted: bool,
    destination: Option<Destination>,
    #[serde(skip_serializing_if = "Option::is_none")]
    location: Option<String>,
}

#[derive(Serialize)]
struct InterventionAddon {
    name: String,
    references: Vec<Reference>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConditionalRelocation {
    actor: String,
    required_set: &'static str,
    position: [f32; 3],
}

#[derive(Serialize)]
struct PropylonActivator {
    id: String,
    script: String,
    deleted: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PropylonScript {
    id: String,
    destination: Option<Destination>,
    master_destination: Option<Destination>,
    required_index: Option<String>,
    deleted: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SpecialRoute {
    actor: String,
    from: Option<Destination>,
    to: Destination,
    mode: &'static str,
    condition: &'static str,
    from_label: Option<&'static str>,
    to_label: Option<&'static str>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Changes {
    actors: Vec<Actor>,
    references: Vec<Reference>,
    activators: Vec<PropylonActivator>,
    propylon_scripts: Vec<PropylonScript>,
    special_routes: Vec<SpecialRoute>,
    intervention_references: Vec<Reference>,
    intervention_addons: Vec<InterventionAddon>,
    conditional_relocations: Vec<ConditionalRelocation>,
}

fn position_cell(line: &str) -> Option<Destination> {
    let lower = line.to_ascii_lowercase();
    let start = lower.find("positioncell")?;
    let rest = &line[start + "positioncell".len()..];
    let cell = rest.split('"').nth(1)?;
    let coords = rest.split('"').next()?.replace(',', " ");
    let values: Vec<f32> = coords
        .split_whitespace()
        .filter_map(|v| v.parse().ok())
        .collect();
    (values.len() == 4).then(|| Destination {
        position: [values[0], values[1], values[2]],
        cell: cell.to_lowercase(),
    })
}

fn conditional_relocation(script: &Script) -> Option<ConditionalRelocation> {
    if !script.id.eq_ignore_ascii_case("pc_start_installed_sc")
        || script
            .flags
            .intersects(ObjectFlags::IGNORED | ObjectFlags::DELETED)
    {
        return None;
    }
    let lines: Vec<_> = script
        .text
        .lines()
        .map(|line| line.split(';').next().unwrap_or(""))
        .collect();
    if !lines.iter().any(|line| {
        line.to_ascii_lowercase()
            .replace(' ', "")
            .contains("t_glob_installed_tr==1")
    }) {
        return None;
    }
    let destination = lines.iter().find_map(|line| {
        let normalized = line.to_ascii_lowercase().replace(' ', "").replace('"', "");
        normalized
            .contains("pc_m0_tituscorilex->positioncell")
            .then(|| position_cell(line))
            .flatten()
    })?;
    Some(ConditionalRelocation {
        actor: "pc_m0_tituscorilex".into(),
        required_set: "tr",
        position: destination.position,
    })
}

fn read_special_routes(plugin: &Plugin, changes: &mut Changes, propylon_only: bool) {
    let mut mournhold = false;
    let mut mournhold_return = false;
    for info in plugin.objects_of_type::<DialogueInfo>() {
        if info
            .flags
            .intersects(ObjectFlags::IGNORED | ObjectFlags::DELETED)
        {
            continue;
        }
        let speaker = info.speaker_id.to_ascii_lowercase();
        let text = info
            .script_text
            .lines()
            .map(|line| line.split(';').next().unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n")
            .to_ascii_lowercase();
        if speaker == "asciene rane" && text.contains("startscript mhtransportscript") {
            mournhold = true;
        }
        if speaker == "effe_tei" && text.contains("startscript vvtransportscript") {
            mournhold_return = true;
        }
        for line in info
            .script_text
            .lines()
            .map(|line| line.split(';').next().unwrap_or(""))
        {
            if !line.to_ascii_lowercase().contains("player->positioncell") {
                continue;
            }
            let Some(to) = position_cell(line) else {
                continue;
            };
            if speaker == "folms mirel" && to.cell.ends_with(", propylon chamber") {
                let requires_master = info
                    .filters
                    .iter()
                    .any(|filter| filter.id.eq_ignore_ascii_case("index_master"));
                changes.special_routes.push(SpecialRoute {
                    actor: speaker.clone(),
                    from: None,
                    to,
                    mode: "propylon",
                    condition: if requires_master {
                        "folmsMaster"
                    } else {
                        "folms"
                    },
                    from_label: None,
                    to_label: None,
                });
            }
        }
    }
    if mournhold && !propylon_only {
        for script in plugin.objects_of_type::<Script>() {
            if !script.id.eq_ignore_ascii_case("mhtransportscript")
                || script
                    .flags
                    .intersects(ObjectFlags::IGNORED | ObjectFlags::DELETED)
            {
                continue;
            }
            for line in script
                .text
                .lines()
                .map(|line| line.split(';').next().unwrap_or(""))
            {
                if line.to_ascii_lowercase().contains("player->positioncell") {
                    if let Some(to) = position_cell(line) {
                        if to.cell == "mournhold, royal palace: reception area" {
                            changes.special_routes.push(SpecialRoute {
                                actor: "asciene rane".into(),
                                from: None,
                                to,
                                mode: "magic",
                                condition: "mournhold",
                                from_label: None,
                                to_label: Some("transportMournhold"),
                            });
                        }
                    }
                }
            }
        }
    }
    if mournhold_return && !propylon_only {
        for script in plugin.objects_of_type::<Script>() {
            if !script.id.eq_ignore_ascii_case("vvtransportscript")
                || script
                    .flags
                    .intersects(ObjectFlags::IGNORED | ObjectFlags::DELETED)
            {
                continue;
            }
            for line in script
                .text
                .lines()
                .map(|line| line.split(';').next().unwrap_or(""))
            {
                if line.to_ascii_lowercase().contains("player->positioncell") {
                    if let Some(to) = position_cell(line) {
                        if to.cell == "ebonheart, grand council chambers" {
                            changes.special_routes.push(SpecialRoute {
                                actor: "effe_tei".into(),
                                from: None,
                                to,
                                mode: "magic",
                                condition: "mournholdReturn",
                                from_label: Some("transportMournhold"),
                                to_label: None,
                            });
                        }
                    }
                }
            }
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TransportIndex {
    schema_version: u8,
    sets: Vec<String>,
}

fn actor(
    id: &str,
    name: &str,
    class: &str,
    script: &str,
    flags: ObjectFlags,
    destinations: &[TravelDestination],
) -> Actor {
    let (bytes, _, failed) = WINDOWS_1252.encode(name);
    let (decoded, _, invalid) = WINDOWS_1251.decode(&bytes);
    let cyrillic = decoded
        .chars()
        .filter(|ch| ('А'..='я').contains(ch) || *ch == 'ё' || *ch == 'Ё')
        .count();
    let display_name = if !failed && !invalid && cyrillic >= 3 {
        decoded.into_owned()
    } else {
        name.to_owned()
    };
    Actor {
        id: id.to_lowercase(),
        name: display_name,
        class: class.to_lowercase(),
        script: script.to_owned(),
        deleted: flags.contains(ObjectFlags::DELETED),
        destinations: destinations.iter().map(Destination::from).collect(),
    }
}

fn propylon_script(script: &Script) -> Option<PropylonScript> {
    let id = script.id.to_ascii_lowercase();
    if !id.starts_with("warp_") && !id.contains("propylon_") {
        return None;
    }
    let mut indices = Vec::new();
    let mut destinations = Vec::new();
    let mut master_button = false;
    let mut master_destination = None;
    let has_menu = script
        .text
        .to_ascii_lowercase()
        .contains("getbuttonpressed");
    for line in script
        .text
        .lines()
        .map(|line| line.split(';').next().unwrap_or(""))
    {
        let lower = line.to_ascii_lowercase();
        let compact: String = lower
            .chars()
            .filter(|character| !character.is_whitespace())
            .collect();
        if compact.starts_with("elseif(")
            || compact.starts_with("else")
            || compact.starts_with("endif")
        {
            master_button = compact.starts_with("elseif(") && compact.contains("button==1");
        }
        if let Some(start) = lower.find("getitemcount") {
            if let Some(index) = line[start..].split('"').nth(1) {
                if index.to_ascii_lowercase().contains("index") {
                    indices.push(index.to_string());
                }
            }
        }
        if let Some(start) = lower.find("positioncell") {
            let rest = &line[start + "positioncell".len()..];
            if let Some(cell) = rest.split('"').nth(1) {
                let coords = rest.split('"').next().unwrap_or("").replace(',', " ");
                let values: Vec<f32> = coords
                    .split_whitespace()
                    .filter_map(|value| value.parse().ok())
                    .collect();
                if values.len() == 4 {
                    let destination = Destination {
                        position: [values[0], values[1], values[2]],
                        cell: cell.to_lowercase(),
                    };
                    if master_button && destination.cell == "caldera, guild of mages" {
                        master_destination = Some(destination.clone());
                    }
                    destinations.push(destination);
                }
            }
        }
    }
    let has_master = indices
        .iter()
        .any(|index| index.eq_ignore_ascii_case("index_master"));
    if !has_master || !has_menu {
        master_destination = None;
    }
    indices.retain(|index| !index.eq_ignore_ascii_case("index_master"));
    indices.sort();
    indices.dedup();
    let mut unique = Vec::new();
    for destination in destinations {
        if !unique.contains(&destination) {
            unique.push(destination);
        }
    }
    if master_destination.is_some() && unique.len() == 2 {
        unique.retain(|destination| destination.cell != "caldera, guild of mages");
    }
    let destination = if unique.len() == 1 {
        unique.pop()
    } else {
        None
    };
    let required_index = if indices.len() == 1 {
        indices.pop()
    } else {
        None
    };
    Some(PropylonScript {
        id,
        destination,
        master_destination,
        required_index,
        deleted: script.flags.contains(ObjectFlags::DELETED),
    })
}

fn read_plugin(path: &Path, changes: &mut Changes) -> Result<()> {
    let plugin = Plugin::from_path_filtered(path, |tag| {
        matches!(
            &tag,
            b"TES3" | b"CELL" | b"NPC_" | b"CREA" | b"ACTI" | b"SCPT" | b"DIAL" | b"INFO"
        )
    })
    .with_context(|| format!("loading {}", path.display()))?;
    read_special_routes(&plugin, changes, false);
    for item in plugin.objects_of_type::<Activator>() {
        if item.flags.contains(ObjectFlags::IGNORED) {
            continue;
        }
        changes.activators.push(PropylonActivator {
            id: item.id.to_lowercase(),
            script: item.script.to_lowercase(),
            deleted: item.flags.contains(ObjectFlags::DELETED),
        });
    }
    for item in plugin.objects_of_type::<Script>() {
        if item.flags.contains(ObjectFlags::IGNORED) {
            continue;
        }
        if let Some(script) = propylon_script(item) {
            changes.propylon_scripts.push(script);
        }
        if let Some(relocation) = conditional_relocation(item) {
            changes.conditional_relocations.push(relocation);
        }
    }
    for npc in plugin.objects_of_type::<Npc>() {
        if npc.flags.contains(ObjectFlags::IGNORED) {
            continue;
        }
        changes.actors.push(actor(
            &npc.id,
            &npc.name,
            &npc.class,
            &npc.script,
            npc.flags,
            &npc.travel_destinations,
        ));
    }
    for creature in plugin.objects_of_type::<Creature>() {
        if creature.flags.contains(ObjectFlags::IGNORED) {
            continue;
        }
        changes.actors.push(actor(
            &creature.id,
            &creature.name,
            "",
            &creature.script,
            creature.flags,
            &creature.travel_destinations,
        ));
    }
    changes.references.extend(collect_references(&plugin, path));
    Ok(())
}

fn collect_references(plugin: &Plugin, path: &Path) -> Vec<Reference> {
    let file = plugin_file(path);
    let masters = masters_of(plugin);
    let mut result = Vec::new();
    for cell in plugin.objects_of_type::<Cell>() {
        if cell
            .flags
            .intersects(ObjectFlags::DELETED | ObjectFlags::IGNORED)
        {
            continue;
        }
        let cell_name = if cell.is_interior() {
            cell.name.to_lowercase()
        } else {
            String::new()
        };
        let mut references: Vec<_> = cell.references.values().collect();
        references.sort_by_key(|reference| (reference.mast_index, reference.refr_index));
        for reference in references {
            let Some((owner, index)) = reference_key(&file, &masters, reference) else {
                continue;
            };
            result.push(Reference {
                key: format!("{owner}:{index}"),
                actor: reference.id.to_lowercase(),
                cell: cell_name.clone(),
                position: reference.translation,
                deleted: reference.deleted.unwrap_or(false),
                destination: reference.destination.as_ref().map(Destination::from),
                location: (!cell.name.is_empty() && is_intervention(&reference.id))
                    .then(|| cell.name.clone()),
            });
        }
    }
    result
}

fn is_intervention(id: &str) -> bool {
    id.eq_ignore_ascii_case("templemarker") || id.eq_ignore_ascii_case("divinemarker")
}

fn find_plugin(dirs: &[PathBuf], name: &str) -> Result<PathBuf> {
    if let Ok(path) = find_file(dirs, name) {
        return Ok(path);
    }
    for dir in dirs {
        let Ok(entries) = fs::read_dir(dir) else {
            continue;
        };
        let mut matches: Vec<PathBuf> = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                path.is_file()
                    && path
                        .file_name()
                        .is_some_and(|file| file.to_string_lossy().eq_ignore_ascii_case(name))
            })
            .collect();
        matches.sort();
        if matches.len() > 1 {
            bail!("More than one file matches {name} in {}", dir.display());
        }
        if let Some(path) = matches.pop() {
            return Ok(path);
        }
    }
    bail!("{name} was not found in any data directory")
}

pub fn build(root: &Path, out: &Path, only: &[String], propylon_addons: &[String]) -> Result<()> {
    let sets = SetsFile::load(&root.join("plugin-sets.toml"))?;
    let paths = LocalPaths::load(&root.join("paths.local.toml"))?;
    let dirs = paths.data_dirs();
    let mut changes = Vec::new();
    for set in &sets.sets {
        if set.is_backdrop() || (!only.is_empty() && !set.locked && !only.contains(&set.id)) {
            continue;
        }
        let files: Vec<PathBuf> = match set
            .plugins
            .iter()
            .map(|name| find_plugin(&dirs, name))
            .collect::<Result<_>>()
        {
            Ok(files) => files,
            Err(error) if !set.locked => {
                eprintln!("Skipping {}: {error}", set.id);
                continue;
            }
            Err(error) => return Err(error),
        };
        let mut group = Changes::default();
        for path in files {
            println!("Reading {}", path.display());
            read_plugin(&path, &mut group)?;
        }
        if set.locked
            && !set
                .plugins
                .iter()
                .any(|name| name.eq_ignore_ascii_case("Tribunal.esm"))
        {
            if let Ok(path) = find_plugin(&dirs, "Tribunal.esm") {
                println!("Reading {}", path.display());
                read_plugin(&path, &mut group)?;
            }
        }
        changes.push((set.id.clone(), group));
    }
    let mut addons: Vec<&String> = Vec::new();
    for name in paths.transport_addons.iter().chain(propylon_addons) {
        if !addons
            .iter()
            .any(|existing| existing.eq_ignore_ascii_case(name))
        {
            addons.push(name);
        }
    }
    if !addons.is_empty() {
        let base = sets
            .sets
            .iter()
            .find(|set| set.locked)
            .context("No base plugin set")?;
        let (_, group) = changes
            .iter_mut()
            .find(|(id, _)| id == &base.id)
            .context("Base transport data is missing")?;
        for name in addons {
            let path = find_plugin(&dirs, name)?;
            println!("Reading transport additions from {}", path.display());
            let plugin = Plugin::from_path_filtered(&path, |tag| {
                matches!(&tag, b"TES3" | b"CELL" | b"SCPT" | b"DIAL" | b"INFO")
            })
            .with_context(|| format!("loading {}", path.display()))?;
            group.intervention_addons.push(InterventionAddon {
                name: plugin_file(&path),
                references: collect_references(&plugin, &path),
            });
            read_special_routes(&plugin, group, true);
            for item in plugin.objects_of_type::<Script>() {
                if item.flags.contains(ObjectFlags::IGNORED) {
                    continue;
                }
                if let Some(script) = propylon_script(item) {
                    group.propylon_scripts.push(script);
                }
            }
        }
    }
    let marker_keys: HashSet<String> = changes
        .iter()
        .flat_map(|(_, group)| {
            group.references.iter().chain(
                group
                    .intervention_addons
                    .iter()
                    .flat_map(|addon| &addon.references),
            )
        })
        .filter(|reference| is_intervention(&reference.actor))
        .map(|reference| reference.key.clone())
        .collect();
    for (_, group) in &mut changes {
        group.intervention_references = group
            .references
            .iter()
            .filter(|reference| marker_keys.contains(&reference.key))
            .cloned()
            .collect();
        for addon in &mut group.intervention_addons {
            addon
                .references
                .retain(|reference| marker_keys.contains(&reference.key));
        }
    }
    let special_actors: HashSet<String> = changes
        .iter()
        .flat_map(|(_, group)| &group.special_routes)
        .map(|route| route.actor.clone())
        .collect();
    let actors: HashSet<String> = changes
        .iter()
        .flat_map(|(_, group)| &group.actors)
        .filter(|actor| !actor.destinations.is_empty() || special_actors.contains(&actor.id))
        .map(|actor| actor.id.clone())
        .collect();
    let scripts: HashSet<String> = changes
        .iter()
        .flat_map(|(_, group)| &group.propylon_scripts)
        .filter(|script| script.destination.is_some() && script.required_index.is_some())
        .map(|script| script.id.clone())
        .collect();
    let activators: HashSet<String> = changes
        .iter()
        .flat_map(|(_, group)| &group.activators)
        .filter(|item| scripts.contains(&item.script))
        .map(|item| item.id.clone())
        .collect();
    let relevant: HashSet<String> = changes
        .iter()
        .flat_map(|(_, group)| &group.references)
        .filter(|reference| {
            actors.contains(&reference.actor)
                || activators.contains(&reference.actor)
                || reference.destination.is_some()
        })
        .map(|reference| reference.key.clone())
        .collect();
    fs::create_dir_all(out).with_context(|| format!("creating {}", out.display()))?;
    let mut index = TransportIndex {
        schema_version: 1,
        sets: Vec::new(),
    };
    for (id, mut group) in changes {
        group.actors.retain(|actor| actors.contains(&actor.id));
        group
            .activators
            .retain(|item| activators.contains(&item.id));
        group
            .propylon_scripts
            .retain(|script| scripts.contains(&script.id));
        group
            .references
            .retain(|reference| relevant.contains(&reference.key));
        println!(
            "{}: {} carrier records, {} references",
            id,
            group.actors.len(),
            group.references.len()
        );
        fs::write(out.join(format!("{id}.json")), serde_json::to_vec(&group)?)?;
        index.sets.push(id);
    }
    fs::write(out.join("index.json"), serde_json::to_vec(&index)?)?;
    if out.file_name().is_some_and(|name| name == "transport") {
        if let Some(parent) = out.parent() {
            let manifest_path = parent.join("manifest.json");
            if manifest_path.is_file() {
                let mut manifest: serde_json::Value =
                    serde_json::from_slice(&fs::read(&manifest_path)?)?;
                if let Some(object) = manifest.as_object_mut() {
                    object.insert("transport".to_string(), "transport/index.json".into());
                    fs::write(manifest_path, serde_json::to_vec(&manifest)?)?;
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_conditional_shipmaster_relocation() {
        let mut script = Script {
            id: "PC_Start_Installed_sc".into(),
            text: "if ( T_Glob_Installed_TR == 1 )\n\"PC_m0_TitusCorilex\"->positioncell 60894 -143581 338 10000 \"Ebonheart\"\nendif".into(),
            ..Script::default()
        };
        let relocation = conditional_relocation(&script).unwrap();
        assert_eq!(relocation.actor, "pc_m0_tituscorilex");
        assert_eq!(relocation.required_set, "tr");
        assert_eq!(relocation.position, [60894.0, -143581.0, 338.0]);
        script.text = script
            .text
            .replace("T_Glob_Installed_TR == 1", "T_Glob_Installed_TR == 0");
        assert!(conditional_relocation(&script).is_none());
    }

    #[test]
    fn extracts_folms_travel_but_ignores_quest_only_journeys() {
        use tes3::esp::Filter;
        let mut plugin = Plugin::new();
        plugin.objects.push(
            DialogueInfo {
                speaker_id: "Folms Mirel".into(),
                script_text:
                    "Player->PositionCell 540 630 -368 270 \"Andasreth, Propylon Chamber\"".into(),
                filters: vec![Filter {
                    id: "Index_Master".into(),
                    ..Filter::default()
                }],
                ..DialogueInfo::default()
            }
            .into(),
        );
        plugin.objects.push(
            DialogueInfo {
                speaker_id: "TR_FM_SilmDar".into(),
                script_text: "StartScript TR_FM_Travel_sc".into(),
                ..DialogueInfo::default()
            }
            .into(),
        );
        plugin.objects.push(Script {
            id: "TR_FM_Travel_sc".into(),
            text: "player->PositionCell -9798 -72523 126 126 \"Seyda Neen\"\nplayer->PositionCell -51975 -83125 180 40 \"Clambering Moor Region\"".into(),
            ..Script::default()
        }.into());
        plugin.objects.push(DialogueInfo {
            speaker_id: "TR_m3_TT_IlleneBoatguy".into(),
            script_text: "Player->PositionCell 34843 -167383 131 0 \"Mundrethi Plantation, Slave Market\"".into(),
            ..DialogueInfo::default()
        }.into());
        plugin.objects.push(
            DialogueInfo {
                speaker_id: "PC_m1_MasquedCaptain".into(),
                script_text: "StartScript PC_m1_Anv_Bounty_CrypsTravel_sc".into(),
                ..DialogueInfo::default()
            }
            .into(),
        );
        plugin.objects.push(
            Script {
                id: "PC_m1_Anv_Bounty_CrypsTravel_sc".into(),
                text: "player->PositionCell -1016370 -430872 60 154 \"Strident Coast Region\""
                    .into(),
                ..Script::default()
            }
            .into(),
        );
        let mut changes = Changes::default();
        read_special_routes(&plugin, &mut changes, false);
        assert_eq!(changes.special_routes.len(), 1);
        assert!(changes
            .special_routes
            .iter()
            .any(|route| route.condition == "folmsMaster"
                && route.to.cell == "andasreth, propylon chamber"));
        let mut addon = Changes::default();
        read_special_routes(&plugin, &mut addon, true);
        assert_eq!(addon.special_routes.len(), 1);
        assert_eq!(addon.special_routes[0].condition, "folmsMaster");
    }

    #[test]
    fn finds_tribunal_travel_only_with_active_dialogue_and_matching_script() {
        let mut plugin = Plugin::new();
        plugin.objects.push(
            DialogueInfo {
                speaker_id: "Asciene Rane".into(),
                script_text: "StartScript MHTransportScript".into(),
                ..DialogueInfo::default()
            }
            .into(),
        );
        plugin.objects.push(Script {
            id: "MHTransportScript".into(),
            text: "Player->PositionCell 2.73 959.274 -105.817 180 \"Mournhold, Royal Palace: Reception Area\"".into(),
            ..Script::default()
        }.into());
        plugin.objects.push(
            DialogueInfo {
                speaker_id: "effe_tei".into(),
                script_text: "StartScript VVTransportScript".into(),
                ..DialogueInfo::default()
            }
            .into(),
        );
        plugin.objects.push(
            Script {
                id: "VVTransportScript".into(),
                text: "Player->PositionCell 1173 613 -120 0 \"Ebonheart, Grand Council Chambers\""
                    .into(),
                ..Script::default()
            }
            .into(),
        );
        let mut changes = Changes::default();
        read_special_routes(&plugin, &mut changes, false);
        assert_eq!(changes.special_routes.len(), 2);
        assert_eq!(changes.special_routes[0].actor, "asciene rane");
        assert_eq!(changes.special_routes[0].condition, "mournhold");
        assert_eq!(
            changes.special_routes[0].to_label,
            Some("transportMournhold")
        );
        assert!(changes
            .special_routes
            .iter()
            .any(|route| route.actor == "effe_tei" && route.condition == "mournholdReturn"));
        let mut addon = Changes::default();
        read_special_routes(&plugin, &mut addon, true);
        assert!(addon.special_routes.is_empty());
    }

    #[test]
    fn extracts_only_an_unambiguous_index_and_destination() {
        let script = Script {
            id: "Warp_Andra".into(),
            text: "if ( Player->GetItemCount, \"Index_Andra\" > 0 )\nPlayer->PositionCell, 540, 630, -368, 270, \"Andasreth, Propylon Chamber\"".into(),
            ..Script::default()
        };
        let parsed = propylon_script(&script).unwrap();
        assert_eq!(parsed.required_index.as_deref(), Some("Index_Andra"));
        assert_eq!(
            parsed.destination.unwrap().cell,
            "andasreth, propylon chamber"
        );
        let ambiguous = Script {
            text: format!("{}\nPlayer->PositionCell 1 2 3 4 \"Other\"", script.text),
            ..script
        };
        assert!(propylon_script(&ambiguous).unwrap().destination.is_none());
    }

    #[test]
    fn preserves_the_direct_link_in_a_master_index_script() {
        let script = Script {
            id: "Warp_Andra".into(),
            text: "Player->GetItemCount \"Index_Master\"\nPlayer->GetItemCount \"Index_Andra\"\nPlayer->PositionCell 540 630 -368 270 \"Andasreth, Propylon Chamber\"\nset button to GetButtonPressed\nelseif ( button == 0 )\nPlayer->PositionCell 540 630 -368 270 \"Andasreth, Propylon Chamber\"\nelseif ( button == 1 )\nPlayer->PositionCell 763 702 412 60 \"Caldera, Guild of Mages\"".into(),
            ..Script::default()
        };
        let parsed = propylon_script(&script).unwrap();
        assert_eq!(parsed.required_index.as_deref(), Some("Index_Andra"));
        assert_eq!(
            parsed.destination.unwrap().cell,
            "andasreth, propylon chamber"
        );
        assert_eq!(
            parsed.master_destination.unwrap().cell,
            "caldera, guild of mages"
        );
    }

    #[test]
    fn does_not_infer_a_master_destination_without_a_confirmed_menu_branch() {
        let script = Script {
            id: "Warp_Test".into(),
            text: "Player->GetItemCount \"Index_Master\"\nPlayer->GetItemCount \"Index_Test\"\nPlayer->PositionCell 1 2 3 4 \"Test, Propylon Chamber\"\nPlayer->PositionCell 5 6 7 8 \"Caldera, Guild of Mages\"".into(),
            ..Script::default()
        };
        let parsed = propylon_script(&script).unwrap();
        assert!(parsed.master_destination.is_none());
        assert!(parsed.destination.is_none());
    }

    #[test]
    fn reads_russian_provider_names_without_changing_english_names() {
        let russian = actor(
            "id",
            "Ìàñàëèíè Ìåðèàí",
            "guild guide",
            "",
            ObjectFlags::empty(),
            &[],
        );
        let english = actor("id", "Félix", "shipmaster", "", ObjectFlags::empty(), &[]);
        assert_eq!(russian.name, "Масалини Мериан");
        assert_eq!(english.name, "Félix");
    }

    #[test]
    fn finds_plugins_when_extension_case_differs() {
        let dir = std::env::temp_dir().join(format!("esmap-transport-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("Cyr_Main.esm");
        fs::write(&path, b"fixture").unwrap();
        assert_eq!(
            find_plugin(std::slice::from_ref(&dir), "Cyr_Main.ESM").unwrap(),
            path
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn reads_carrier_and_placed_reference_from_a_plugin() {
        use tes3::esp::{Header, Reference as PlacedReference};
        let path = std::env::temp_dir().join(format!(
            "esmap-transport-fixture-{}.esm",
            std::process::id()
        ));
        let mut plugin = Plugin::new();
        plugin.objects.push(Header::default().into());
        let mut npc = Npc {
            id: "carrier".into(),
            name: "Carrier".into(),
            class: "caravaner".into(),
            ..Npc::default()
        };
        npc.travel_destinations.push(TravelDestination {
            translation: [-8192.0, 0.0, 0.0],
            ..TravelDestination::default()
        });
        plugin.objects.push(npc.into());
        let mut cell = Cell::default();
        cell.references.insert(
            (0, 1),
            PlacedReference {
                refr_index: 1,
                id: "carrier".into(),
                translation: [8192.0, 0.0, 0.0],
                ..PlacedReference::default()
            },
        );
        plugin.objects.push(cell.into());
        plugin.save_path(&path).unwrap();
        let mut changes = Changes::default();
        read_plugin(&path, &mut changes).unwrap();
        assert_eq!(changes.actors[0].id, "carrier");
        assert_eq!(changes.actors[0].destinations[0].position[0], -8192.0);
        assert_eq!(changes.references[0].actor, "carrier");
        assert_eq!(changes.references[0].position[0], 8192.0);
        fs::remove_file(path).unwrap();
    }
}
