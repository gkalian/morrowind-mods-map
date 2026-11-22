//! Transport data: carriers and where they go, activators that move the player while the player
//! carries an item (such as propylons), transport offered in dialogue, and the Almsivi and Divine
//! Intervention markers. Everything is read from the plugins; the `[transport]` table of
//! `plugin-sets.toml` adds only what the plugins do not say, such as which classes are carriers.
//!
//! Each Plugin Set gets a file with what its plugins add or change, so that the viewer can
//! apply the sets that are switched on in load order, as the game would.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::Serialize;
use tes3::esp::{
    Activator, Cell, Creature, Dialogue, DialogueInfo, FilterComparison, FilterType, FilterValue, GlobalVariable, MiscItem, Npc,
    ObjectFlags, Plugin, Script, StartScript, TES3Object, TravelDestination,
};

use crate::config::{find_file, LocalPaths, SetsFile, TransportConfig};
use crate::locations::{masters_of, plugin_file, reference_key};
use crate::russian::Russian;

/// Version of the files written here; the viewer refuses others.
const SCHEMA_VERSION: u8 = 2;

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Destination {
    pub position: [f32; 3],
    /// Interior Cell in lower case; empty for the exterior.
    pub cell: String,
}

impl From<&TravelDestination> for Destination {
    fn from(value: &TravelDestination) -> Self {
        Self { position: value.translation, cell: value.cell.to_lowercase() }
    }
}

// ---------------------------------------------------------------------------------------------
// Scripts

/// A condition of an `if` or `elseif` block, as far as the transport data needs to tell.
#[derive(Clone, Debug, PartialEq)]
enum Condition {
    /// A comparison of a variable with a number, by whether it holds when the variable is 1 and 0.
    Variable { name: String, at_one: bool, at_zero: bool },
    /// The player, or whoever runs the script, carries the item.
    Carries(String),
    /// `GetDisabled`: whether the actor itself is enabled, which says nothing of when.
    Disabled,
    Other,
}

impl Condition {
    fn negated(&self) -> Self {
        match self {
            Self::Variable { name, at_one, at_zero } => Self::Variable { name: name.clone(), at_one: !at_one, at_zero: !at_zero },
            Self::Disabled => Self::Disabled,
            _ => Self::Other,
        }
    }

    fn parse(expression: &str) -> Self {
        let lower = expression.to_ascii_lowercase();
        if lower.contains(" and ") || lower.contains(" or ") || lower.contains("&&") || lower.contains("||") {
            return Self::Other;
        }
        let compact: String = lower.chars().filter(|c| !c.is_whitespace() && *c != '(' && *c != ')' && *c != ',').collect();
        if compact.contains("getdisabled") {
            return Self::Disabled;
        }
        let Some((left, operator, number)) = comparison(&compact) else { return Self::Other };
        if let Some(position) = left.find("getitemcount") {
            let item = left[position + "getitemcount".len()..].trim_matches('"').to_string();
            let holds = |count: f64| compare(count, operator, number);
            return if !item.is_empty() && holds(1.0) && !holds(0.0) { Self::Carries(item) } else { Self::Other };
        }
        let name = left.trim_matches('"');
        if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return Self::Other;
        }
        Self::Variable { name: name.to_string(), at_one: compare(1.0, operator, number), at_zero: compare(0.0, operator, number) }
    }
}

/// Splits `left<op>number`, taking the last operator so that `->` stays in `left`.
fn comparison(compact: &str) -> Option<(&str, &'static str, f64)> {
    for operator in ["==", "!=", ">=", "<=", ">", "<"] {
        if let Some((left, right)) = compact.rsplit_once(operator) {
            return right.parse().ok().map(|number| (left, operator, number));
        }
    }
    None
}

fn compare(value: f64, operator: &str, number: f64) -> bool {
    match operator {
        "==" => value == number,
        "!=" => value != number,
        ">=" => value >= number,
        "<=" => value <= number,
        ">" => value > number,
        _ => value < number,
    }
}

/// What a line of a script does, where it matters for transport.
#[derive(Clone, Debug, PartialEq)]
enum Action {
    /// `Player->PositionCell`.
    MovesPlayer(Destination),
    /// `"actor"->PositionCell`.
    MovesActor(String, Destination),
    /// `Enable` (true) or `Disable` (false) of whoever runs the script.
    Shows(bool),
    /// `set name to 1`.
    SetsToOne(String),
    /// `StartScript name`.
    Starts(String),
}

#[derive(Debug)]
struct Statement {
    /// Conditions of the blocks the line stands in, outermost first.
    conditions: Vec<Condition>,
    action: Action,
}

/// The variables a line depends on and whether it runs when each is 1: those for which it
/// runs at 1 and not at 0, or the other way round, the way it would on "is this mod installed".
type Switches = Vec<(String, bool)>;

impl Statement {
    fn items(&self) -> Vec<String> {
        self.conditions.iter().filter_map(|c| if let Condition::Carries(item) = c { Some(item.clone()) } else { None }).collect()
    }

    fn switches(&self) -> Switches {
        self.conditions
            .iter()
            .filter_map(|c| match c {
                Condition::Variable { name, at_one, at_zero } if at_one != at_zero => Some((name.clone(), *at_one)),
                _ => None,
            })
            .collect()
    }

    /// Whether the line also depends on something that is neither a switch nor `GetDisabled`.
    fn has_other_conditions(&self) -> bool {
        self.conditions.iter().any(|c| match c {
            Condition::Disabled => false,
            Condition::Variable { at_one, at_zero, .. } => at_one == at_zero,
            _ => true,
        })
    }
}

/// Removes a `;` comment, unless the semicolon is inside quotes.
fn without_comment(line: &str) -> &str {
    let mut quoted = false;
    for (index, character) in line.char_indices() {
        match character {
            '"' => quoted = !quoted,
            ';' if !quoted => return &line[..index],
            _ => {}
        }
    }
    line
}

/// `x y z rotation "Cell"` after `PositionCell`.
fn position_cell(arguments: &str) -> Option<Destination> {
    let mut parts = arguments.splitn(3, '"');
    let numbers = parts.next()?.replace(',', " ");
    let cell = parts.next()?;
    let values: Vec<f32> = numbers.split_whitespace().filter_map(|value| value.parse().ok()).collect();
    (values.len() >= 3).then(|| Destination { position: [values[0], values[1], values[2]], cell: cell.to_lowercase() })
}

fn action(line: &str) -> Option<Action> {
    let lower = line.to_ascii_lowercase();
    if let Some(position) = lower.find("positioncell") {
        let destination = position_cell(&line[position + "positioncell".len()..])?;
        let target = lower[..position].trim().trim_end_matches("->").trim().trim_matches('"').trim();
        return match target {
            "" => None,
            "player" => Some(Action::MovesPlayer(destination)),
            actor => Some(Action::MovesActor(actor.to_string(), destination)),
        };
    }
    let words: Vec<&str> = lower.split(|c: char| c.is_whitespace() || c == ',').filter(|w| !w.is_empty()).collect();
    match words.as_slice() {
        ["enable"] => Some(Action::Shows(true)),
        ["disable"] => Some(Action::Shows(false)),
        ["set", name, "to", "1"] => Some(Action::SetsToOne(name.to_string())),
        ["startscript", ..] => {
            let name = lower.trim()["startscript".len()..].trim_start_matches([' ', '\t', ',']).trim().trim_matches('"').trim();
            (!name.is_empty()).then(|| Action::Starts(name.to_string()))
        }
        _ => None,
    }
}

/// The lines of a script that matter, each with the conditions of the blocks it stands in.
/// An `elseif` stands for its own condition only, not for the failed ones before it.
fn statements(text: &str) -> Vec<Statement> {
    let mut blocks: Vec<Condition> = Vec::new();
    let mut result = Vec::new();
    for raw in text.lines() {
        let line = without_comment(raw).trim();
        let lower = line.to_ascii_lowercase();
        let keyword = |word: &str| lower.strip_prefix(word).filter(|rest| rest.is_empty() || rest.starts_with([' ', '\t', '('])).map(str::trim);
        if let Some(expression) = keyword("elseif") {
            if let Some(last) = blocks.last_mut() {
                *last = Condition::parse(expression);
            }
        } else if keyword("else").is_some() {
            if let Some(last) = blocks.last_mut() {
                *last = last.negated();
            }
        } else if keyword("endif").is_some() {
            blocks.pop();
        } else if let Some(expression) = keyword("if") {
            blocks.push(Condition::parse(expression));
        } else if let Some(action) = action(line) {
            result.push(Statement { conditions: blocks.clone(), action });
        }
    }
    result
}

/// A move of the player that needs an item: where to, which items and the configured mode.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Gate {
    pub to: Destination,
    pub items: Vec<String>,
    pub mode: String,
}

/// What a script says about transport, before global variables are matched to Plugin Sets.
#[derive(Debug, Default)]
struct ScriptFacts {
    id: String,
    deleted: bool,
    /// `Enable` (true) or `Disable` of whoever runs the script, the switches it depends on,
    /// and whether it depends on anything else as well.
    shows: Vec<(bool, Switches, bool)>,
    /// Actors moved, on the switches the move depends on.
    moves: Vec<(String, Switches, Destination)>,
    gates: Vec<Gate>,
    /// Every move of the player, for scripts started from dialogue.
    player_moves: Vec<Destination>,
    /// Variables set to 1 outside of any condition.
    sets_to_one: Vec<String>,
}

fn script_facts(script: &Script, config: &TransportConfig) -> ScriptFacts {
    let mut facts = ScriptFacts {
        id: script.id.to_ascii_lowercase(),
        deleted: script.flags.contains(ObjectFlags::DELETED),
        ..ScriptFacts::default()
    };
    for statement in statements(&script.text) {
        match &statement.action {
            Action::MovesPlayer(destination) => {
                facts.player_moves.push(destination.clone());
                let items = statement.items();
                if let Some(mode) = items.iter().find_map(|item| config.gate_mode(item)) {
                    let gate = Gate { to: destination.clone(), items, mode: mode.to_string() };
                    if !facts.gates.contains(&gate) {
                        facts.gates.push(gate);
                    }
                }
            }
            Action::MovesActor(actor, destination) => facts.moves.push((actor.clone(), statement.switches(), destination.clone())),
            Action::Shows(enable) => facts.shows.push((*enable, statement.switches(), statement.has_other_conditions())),
            Action::SetsToOne(name) if statement.conditions.is_empty() => facts.sets_to_one.push(name.clone()),
            _ => {}
        }
    }
    facts
}

// ---------------------------------------------------------------------------------------------
// What a Plugin Set adds or changes

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Actor {
    id: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    ru: Option<String>,
    /// `None` for one that only offers transport in dialogue.
    mode: Option<String>,
    script: String,
    deleted: bool,
    destinations: Vec<Destination>,
    #[serde(skip)]
    class: String,
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
    /// The name of the exterior Cell, for Intervention markers.
    #[serde(skip_serializing_if = "Option::is_none")]
    location: Option<String>,
}

#[derive(Serialize)]
struct ActivatorRecord {
    id: String,
    script: String,
    deleted: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Move {
    actor: String,
    /// The Plugin Set that has to be switched on for the move.
    set: String,
    to: Destination,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScriptRecord {
    id: String,
    deleted: bool,
    /// Plugin Sets the actor running the script needs switched on.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    requires: Vec<String>,
    /// Plugin Sets that make the actor running the script go away.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    excluded_by: Vec<String>,
    /// The actor comes and goes with the game, such as the stage of a quest.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    conditional: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    moves: Vec<Move>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    gates: Vec<Gate>,
}

impl ScriptRecord {
    fn says_something(&self) -> bool {
        self.conditional || !self.requires.is_empty() || !self.excluded_by.is_empty() || !self.moves.is_empty() || !self.gates.is_empty()
    }
}

/// An answer in a configured dialogue topic that moves the player, itself or by a script.
struct DialogueTravel {
    actor: String,
    topic: String,
    mode: String,
    moves: Vec<Destination>,
    started: Vec<String>,
    items: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DialogueRoute {
    actor: String,
    topic: String,
    mode: String,
    to: Destination,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    items: Vec<String>,
}

#[derive(Default)]
struct Group {
    actors: Vec<Actor>,
    references: Vec<Reference>,
    activators: Vec<ActivatorRecord>,
    scripts: Vec<ScriptFacts>,
    dialogue: Vec<DialogueTravel>,
    globals: HashSet<String>,
    /// Scripts the game runs from the start.
    start_scripts: HashSet<String>,
    /// Names of the interior Cells, in lower case.
    interiors: HashSet<String>,
    items: HashMap<String, String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SetFile {
    actors: Vec<Actor>,
    references: Vec<Reference>,
    activators: Vec<ActivatorRecord>,
    scripts: Vec<ScriptRecord>,
    dialogue: Vec<DialogueRoute>,
    intervention_references: Vec<Reference>,
}

#[derive(Serialize)]
struct AnchorRecord {
    cells: String,
    x: f32,
    y: f32,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    ru: Option<String>,
}

#[derive(Serialize)]
struct ItemRecord {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    ru: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TransportIndex {
    schema_version: u8,
    sets: Vec<String>,
    anchors: Vec<AnchorRecord>,
    items: BTreeMap<String, ItemRecord>,
}

fn active(flags: ObjectFlags) -> bool {
    !flags.contains(ObjectFlags::IGNORED)
}

fn actor(id: &str, name: &str, class: &str, script: &str, flags: ObjectFlags, destinations: &[TravelDestination], config: &TransportConfig) -> Actor {
    Actor {
        id: id.to_lowercase(),
        name: name.to_string(),
        ru: None,
        mode: config.carrier_mode(id, class).map(str::to_string),
        script: script.to_lowercase(),
        deleted: flags.contains(ObjectFlags::DELETED),
        destinations: destinations.iter().map(Destination::from).collect(),
        class: class.to_string(),
    }
}

fn is_intervention(id: &str) -> bool {
    id.eq_ignore_ascii_case("templemarker") || id.eq_ignore_ascii_case("divinemarker")
}

fn dialogue_travel(topic: &Dialogue, info: &DialogueInfo, config: &TransportConfig) -> Option<DialogueTravel> {
    let mode = config.topic_mode(&topic.id)?;
    if info.flags.intersects(ObjectFlags::IGNORED | ObjectFlags::DELETED) || info.speaker_id.is_empty() {
        return None;
    }
    let mut moves = Vec::new();
    let mut started = Vec::new();
    for statement in statements(&info.script_text) {
        match statement.action {
            Action::MovesPlayer(destination) => moves.push(destination),
            Action::Starts(script) => started.push(script),
            _ => {}
        }
    }
    let items = info
        .filters
        .iter()
        .filter(|filter| filter.filter_type == FilterType::Item)
        .filter(|filter| {
            let value = match filter.value {
                FilterValue::Float(value) => value as f64,
                FilterValue::Integer(value) => value as f64,
            };
            let operator = match filter.comparison {
                FilterComparison::Equal => "==",
                FilterComparison::NotEqual => "!=",
                FilterComparison::Greater => ">",
                FilterComparison::GreaterEqual => ">=",
                FilterComparison::Less => "<",
                FilterComparison::LessEqual => "<=",
            };
            compare(1.0, operator, value) && !compare(0.0, operator, value)
        })
        .map(|filter| filter.id.to_ascii_lowercase())
        .collect();
    Some(DialogueTravel { actor: info.speaker_id.to_lowercase(), topic: topic.id.clone(), mode: mode.to_string(), moves, started, items })
}

fn read_plugin(path: &Path, config: &TransportConfig, group: &mut Group) -> Result<()> {
    let plugin = Plugin::from_path_filtered(path, |tag| {
        matches!(&tag, b"TES3" | b"CELL" | b"NPC_" | b"CREA" | b"ACTI" | b"SCPT" | b"DIAL" | b"INFO" | b"GLOB" | b"MISC" | b"SSCR")
    })
    .with_context(|| format!("loading {}", path.display()))?;
    let mut topic: Option<&Dialogue> = None;
    for object in &plugin.objects {
        match object {
            TES3Object::Dialogue(dialogue) => topic = Some(dialogue),
            TES3Object::DialogueInfo(info) => {
                if let Some(travel) = topic.and_then(|topic| dialogue_travel(topic, info, config)) {
                    group.dialogue.push(travel);
                }
            }
            TES3Object::Npc(Npc { flags, id, name, class, script, travel_destinations, .. }) if active(*flags) => {
                group.actors.push(actor(id, name, class, script, *flags, travel_destinations, config));
            }
            TES3Object::Creature(Creature { flags, id, name, script, travel_destinations, .. }) if active(*flags) => {
                group.actors.push(actor(id, name, "", script, *flags, travel_destinations, config));
            }
            TES3Object::Activator(Activator { flags, id, script, .. }) if active(*flags) => {
                group.activators.push(ActivatorRecord { id: id.to_lowercase(), script: script.to_lowercase(), deleted: flags.contains(ObjectFlags::DELETED) });
            }
            TES3Object::Script(script) if active(script.flags) => group.scripts.push(script_facts(script, config)),
            TES3Object::GlobalVariable(GlobalVariable { flags, id, .. }) if active(*flags) => {
                group.globals.insert(id.to_ascii_lowercase());
            }
            TES3Object::StartScript(StartScript { flags, script, .. }) if active(*flags) => {
                group.start_scripts.insert(script.to_ascii_lowercase());
            }
            TES3Object::MiscItem(MiscItem { flags, id, name, .. }) if active(*flags) => {
                group.items.insert(id.to_ascii_lowercase(), name.clone());
            }
            _ => {}
        }
    }
    for cell in plugin.objects_of_type::<Cell>() {
        if cell.is_interior() {
            group.interiors.insert(cell.name.to_lowercase());
        }
    }
    group.references.extend(collect_references(&plugin, path));
    Ok(())
}

fn collect_references(plugin: &Plugin, path: &Path) -> Vec<Reference> {
    let file = plugin_file(path);
    let masters = masters_of(plugin);
    let mut result = Vec::new();
    for cell in plugin.objects_of_type::<Cell>() {
        if cell.flags.intersects(ObjectFlags::DELETED | ObjectFlags::IGNORED) {
            continue;
        }
        let cell_name = if cell.is_interior() { cell.name.to_lowercase() } else { String::new() };
        let mut references: Vec<_> = cell.references.values().collect();
        references.sort_by_key(|reference| (reference.mast_index, reference.refr_index));
        for reference in references {
            let Some((owner, index)) = reference_key(&file, &masters, reference) else { continue };
            result.push(Reference {
                key: format!("{owner}:{index}"),
                actor: reference.id.to_lowercase(),
                cell: cell_name.clone(),
                position: reference.translation,
                deleted: reference.deleted.unwrap_or(false),
                destination: reference.destination.as_ref().map(Destination::from),
                location: (!cell.name.is_empty() && is_intervention(&reference.id)).then(|| cell.name.clone()),
            });
        }
    }
    result
}

/// Finds a plugin by name, also where the case of its name differs on disk.
pub fn find_plugin(dirs: &[PathBuf], name: &str) -> Result<PathBuf> {
    if let Ok(path) = find_file(dirs, name) {
        return Ok(path);
    }
    for dir in dirs {
        let Ok(entries) = fs::read_dir(dir) else { continue };
        let mut matches: Vec<PathBuf> = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.is_file() && path.file_name().is_some_and(|file| file.to_string_lossy().eq_ignore_ascii_case(name)))
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

/// Matches "is this mod installed" global variables to the Plugin Sets that set them: a variable
/// declared in some plugin that a start script of exactly one set sets to 1 outside of any condition.
fn installed_globals(groups: &[(String, Group)]) -> HashMap<String, String> {
    let declared: HashSet<&String> = groups.iter().flat_map(|(_, group)| &group.globals).collect();
    let starts: HashSet<&String> = groups.iter().flat_map(|(_, group)| &group.start_scripts).collect();
    let mut setters: HashMap<String, HashSet<String>> = HashMap::new();
    for (id, group) in groups {
        for name in group.scripts.iter().filter(|script| starts.contains(&script.id)).flat_map(|script| &script.sets_to_one) {
            if declared.contains(name) {
                setters.entry(name.clone()).or_default().insert(id.clone());
            }
        }
    }
    setters.into_iter().filter(|(_, sets)| sets.len() == 1).filter_map(|(name, sets)| sets.into_iter().next().map(|set| (name, set))).collect()
}

fn script_record(facts: &ScriptFacts, globals: &HashMap<String, String>) -> ScriptRecord {
    let mut record = ScriptRecord {
        id: facts.id.clone(),
        deleted: facts.deleted,
        requires: Vec::new(),
        excluded_by: Vec::new(),
        conditional: false,
        moves: Vec::new(),
        gates: facts.gates.clone(),
    };
    fn installed<'a>(switches: &'a Switches, globals: &HashMap<String, String>) -> Option<(&'a String, String, bool)> {
        switches.iter().find_map(|(name, at_one)| globals.get(name).map(|set| (name, set.clone(), *at_one)))
    }
    let installed = |switches| installed(switches, globals);
    for (enable, switches, other) in &facts.shows {
        match installed(switches) {
            Some((name, set, at_one)) => {
                // Enabled once the mod is installed, or disabled while it is not: it needs the mod.
                if *enable == at_one { record.requires.push(set) } else { record.excluded_by.push(set) }
                if *other || switches.iter().any(|(other_name, _)| other_name != name) {
                    record.conditional = true;
                }
            }
            // Comes and goes with a variable of the game, such as the stage of a quest.
            None => record.conditional = true,
        }
    }
    for (actor, switches, to) in &facts.moves {
        if let Some((_, set, true)) = installed(switches) {
            record.moves.push(Move { actor: actor.clone(), set, to: to.clone() });
        }
    }
    for list in [&mut record.requires, &mut record.excluded_by] {
        list.sort();
        list.dedup();
    }
    record
}

pub fn build(root: &Path, out: &Path, only: &[String], russian: &Russian) -> Result<()> {
    let sets = SetsFile::load(&root.join("plugin-sets.toml"))?;
    let config = &sets.transport;
    let paths = LocalPaths::load(&root.join("paths.local.toml"))?;
    let dirs = paths.data_dirs();
    let mut groups: Vec<(String, Group)> = Vec::new();
    for set in &sets.sets {
        if set.is_backdrop() || (!only.is_empty() && !set.locked && !only.contains(&set.id)) {
            continue;
        }
        let files: Vec<PathBuf> = match set.plugins.iter().map(|name| find_plugin(&dirs, name)).collect::<Result<_>>() {
            Ok(files) => files,
            Err(error) if !set.locked => {
                eprintln!("Skipping {}: {error}", set.id);
                continue;
            }
            Err(error) => return Err(error),
        };
        let mut group = Group::default();
        for path in files {
            println!("Reading {}", path.display());
            read_plugin(&path, config, &mut group)?;
        }
        groups.push((set.id.clone(), group));
    }

    // `PositionCell` names an exterior Cell too, by the name of its place; such a move is to the exterior.
    let interior_names: HashSet<String> = groups.iter().flat_map(|(_, group)| group.interiors.iter().cloned()).collect();
    let outside = |destination: &mut Destination| {
        if !interior_names.contains(&destination.cell) {
            destination.cell.clear();
        }
    };
    for (_, group) in &mut groups {
        for script in &mut group.scripts {
            script.player_moves.iter_mut().for_each(outside);
            script.gates.iter_mut().for_each(|gate| outside(&mut gate.to));
            script.moves.iter_mut().for_each(|(_, _, to)| outside(to));
        }
        for travel in &mut group.dialogue {
            travel.moves.iter_mut().for_each(outside);
        }
    }

    let globals = installed_globals(&groups);
    let mut matched: Vec<_> = globals.iter().map(|(name, set)| format!("{name} = {set}")).collect();
    matched.sort();
    println!("Installed-mod globals: {}", matched.join(", "));

    // Moves of the player by script, as the last set defines the script, for dialogue that starts one.
    let mut player_moves: HashMap<String, Vec<Destination>> = HashMap::new();
    for (_, group) in &groups {
        for script in &group.scripts {
            player_moves.insert(script.id.clone(), script.player_moves.clone());
        }
    }
    let started = |travel: &DialogueTravel| -> Vec<Destination> {
        let by_script = travel.started.iter().flat_map(|script| player_moves.get(script).cloned().unwrap_or_default());
        travel.moves.iter().cloned().chain(by_script).collect()
    };

    // Carriers, and those who offer transport in dialogue.
    let speakers: HashSet<String> = groups.iter().flat_map(|(_, group)| group.dialogue.iter().map(|travel| travel.actor.clone())).collect();
    let mut carriers: HashSet<String> = HashSet::new();
    for actor in groups.iter().flat_map(|(_, group)| &group.actors) {
        if speakers.contains(&actor.id) || (!actor.destinations.is_empty() && actor.mode.is_some()) {
            carriers.insert(actor.id.clone());
        }
    }
    let mut unknown: Vec<String> = groups
        .iter()
        .flat_map(|(_, group)| &group.actors)
        .filter(|actor| !actor.destinations.is_empty() && !actor.deleted && !carriers.contains(&actor.id))
        .map(|actor| format!("{} ({})", actor.id, if actor.class.is_empty() { "creature" } else { &actor.class }))
        .collect();
    unknown.sort();
    unknown.dedup();
    if !unknown.is_empty() {
        println!("Left out, as [transport] in plugin-sets.toml gives no mode for them: {}", unknown.join(", "));
    }

    // Scripts that say something about a carrier, gates, or moves of actors.
    let records: Vec<Vec<ScriptRecord>> = groups.iter().map(|(_, group)| group.scripts.iter().map(|facts| script_record(facts, &globals)).collect()).collect();
    let carrier_scripts: HashSet<&String> =
        groups.iter().flat_map(|(_, group)| &group.actors).filter(|actor| carriers.contains(&actor.id)).map(|actor| &actor.script).collect();
    let all_records = || records.iter().flatten().filter(|record| !record.deleted);
    let scripts: HashSet<String> = all_records()
        .filter(|record| !record.gates.is_empty() || !record.moves.is_empty() || (carrier_scripts.contains(&record.id) && record.says_something()))
        .map(|record| record.id.clone())
        .collect();
    let gated: HashSet<&String> = all_records().filter(|record| !record.gates.is_empty()).map(|record| &record.id).collect();
    let activators: HashSet<String> =
        groups.iter().flat_map(|(_, group)| &group.activators).filter(|item| gated.contains(&item.script)).map(|item| item.id.clone()).collect();

    // Interiors whose way out the viewer has to find, and every interior on the way.
    let mut cells: Vec<String> = Vec::new();
    for (_, group) in &groups {
        for reference in &group.references {
            if carriers.contains(&reference.actor) || activators.contains(&reference.actor) {
                cells.push(reference.cell.clone());
            }
        }
        for actor in group.actors.iter().filter(|actor| carriers.contains(&actor.id)) {
            cells.extend(actor.destinations.iter().map(|d| d.cell.clone()));
        }
        for travel in &group.dialogue {
            cells.extend(started(travel).into_iter().map(|d| d.cell));
        }
    }
    for record in all_records() {
        cells.extend(record.gates.iter().map(|gate| gate.to.cell.clone()));
        cells.extend(record.moves.iter().map(|m| m.to.cell.clone()));
    }
    let mut doors: HashMap<&str, Vec<&str>> = HashMap::new();
    for reference in groups.iter().flat_map(|(_, group)| &group.references) {
        if let (Some(destination), false) = (&reference.destination, reference.cell.is_empty()) {
            doors.entry(&reference.cell).or_default().push(&destination.cell);
        }
    }
    let mut interiors: HashSet<String> = HashSet::new();
    while let Some(cell) = cells.pop() {
        if cell.is_empty() || interiors.contains(&cell) {
            continue;
        }
        cells.extend(doors.get(cell.as_str()).into_iter().flatten().map(|next| next.to_string()));
        interiors.insert(cell);
    }
    let relevant: HashSet<String> = groups
        .iter()
        .flat_map(|(_, group)| &group.references)
        .filter(|reference| {
            carriers.contains(&reference.actor)
                || activators.contains(&reference.actor)
                || (reference.destination.is_some() && interiors.contains(&reference.cell))
        })
        .map(|reference| reference.key.clone())
        .collect();
    let markers: HashSet<String> =
        groups.iter().flat_map(|(_, group)| &group.references).filter(|reference| is_intervention(&reference.actor)).map(|reference| reference.key.clone()).collect();

    // Names of the items that gates and dialogue ask for.
    let mut item_ids: HashSet<String> = all_records().flat_map(|record| record.gates.iter().flat_map(|gate| gate.items.clone())).collect();
    item_ids.extend(groups.iter().flat_map(|(_, group)| group.dialogue.iter().flat_map(|travel| travel.items.clone())));
    let items: BTreeMap<String, ItemRecord> = item_ids
        .into_iter()
        .map(|id| {
            let name = groups.iter().rev().find_map(|(_, group)| group.items.get(&id).cloned()).unwrap_or_else(|| id.clone());
            let ru = russian.item(&id);
            (id, ItemRecord { name, ru })
        })
        .collect();
    let anchors = config
        .anchors
        .iter()
        .map(|anchor| AnchorRecord {
            cells: anchor.cells.to_lowercase(),
            x: anchor.position[0],
            y: anchor.position[1],
            name: anchor.cells.clone(),
            ru: russian.place(&anchor.cells),
        })
        .collect();
    let dialogue: Vec<Vec<DialogueRoute>> = groups
        .iter()
        .map(|(_, group)| {
            let mut routes: Vec<DialogueRoute> = Vec::new();
            for travel in &group.dialogue {
                for to in started(travel) {
                    // Several answers of a topic often lead to the same place.
                    if !routes.iter().any(|route| route.actor == travel.actor && route.to == to && route.items == travel.items) {
                        routes.push(DialogueRoute { actor: travel.actor.clone(), topic: travel.topic.clone(), mode: travel.mode.clone(), to, items: travel.items.clone() });
                    }
                }
            }
            routes
        })
        .collect();

    fs::create_dir_all(out).with_context(|| format!("creating {}", out.display()))?;
    let mut index = TransportIndex { schema_version: SCHEMA_VERSION, sets: Vec::new(), anchors, items };
    for (((id, group), script_list), dialogue) in groups.into_iter().zip(records).zip(dialogue) {
        let mut actors: Vec<Actor> = group.actors.into_iter().filter(|actor| carriers.contains(&actor.id)).collect();
        for actor in &mut actors {
            actor.ru = russian.actor(&actor.id);
        }
        let file = SetFile {
            actors,
            intervention_references: group.references.iter().filter(|reference| markers.contains(&reference.key)).cloned().collect(),
            references: group.references.into_iter().filter(|reference| relevant.contains(&reference.key)).collect(),
            activators: group.activators.into_iter().filter(|item| activators.contains(&item.id)).collect(),
            scripts: script_list.into_iter().filter(|record| scripts.contains(&record.id)).collect(),
            dialogue,
        };
        println!(
            "{id}: {} carriers, {} references, {} scripts, {} dialogue routes, {} intervention markers",
            file.actors.len(),
            file.references.len(),
            file.scripts.len(),
            file.dialogue.len(),
            file.intervention_references.len()
        );
        fs::write(out.join(format!("{id}.json")), serde_json::to_vec(&file)?)?;
        index.sets.push(id);
    }
    fs::write(out.join("index.json"), serde_json::to_vec(&index)?)?;
    // Run on its own, the transport data joins the manifest that is already there.
    if out.file_name().is_some_and(|name| name == "transport") {
        if let Some(parent) = out.parent() {
            let manifest_path = parent.join("manifest.json");
            if manifest_path.is_file() {
                let mut manifest: serde_json::Value = serde_json::from_slice(&fs::read(&manifest_path)?)?;
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

    fn config() -> TransportConfig {
        toml::from_str(
            r#"
            classes = { shipmaster = "water", caravaner = "land" }
            gates = { "index_*" = "propylon" }
            topics = { "transport to Mournhold" = "magic" }
            "#,
        )
        .unwrap()
    }

    fn facts(text: &str) -> ScriptFacts {
        script_facts(&Script { id: "test".into(), text: text.into(), ..Script::default() }, &config())
    }

    fn globals() -> HashMap<String, String> {
        HashMap::from([("t_glob_installed_tr".to_string(), "tr".to_string()), ("t_glob_installed_pc".to_string(), "pc".to_string())])
    }

    #[test]
    fn reads_positions_and_cells_with_or_without_commas() {
        assert_eq!(
            action("Player->PositionCell, 540, 630, -368, 270, \"Andasreth, Propylon Chamber\""),
            Some(Action::MovesPlayer(Destination { position: [540.0, 630.0, -368.0], cell: "andasreth, propylon chamber".into() }))
        );
        assert_eq!(
            action("\"PC_m0_TitusCorilex\"->positioncell 60894 -143581 338 10000 \"Ebonheart\""),
            Some(Action::MovesActor("pc_m0_tituscorilex".into(), Destination { position: [60894.0, -143581.0, 338.0], cell: "ebonheart".into() }))
        );
        assert_eq!(action("StartScript, \"MHTransportScript\""), Some(Action::Starts("mhtransportscript".into())));
        assert_eq!(action("set T_Glob_Installed_TR to 1"), Some(Action::SetsToOne("t_glob_installed_tr".into())));
        assert_eq!(action("PositionCell 1 2 3 0 \"Self\""), None);
        assert_eq!(without_comment("MessageBox \"a; b\" ; note"), "MessageBox \"a; b\" ");
    }

    #[test]
    fn keeps_the_conditions_of_nested_blocks() {
        let found = statements(
            "if ( OnActivate == 1 )\n  if ( Player->GetItemCount, \"Index_Master\" > 0 )\n    if ( button == 1 ) ; inner\n    endif\n    Player->PositionCell 1 2 3 0 \"Caldera, Guild of Mages\"\n  else\n    Player->PositionCell 4 5 6 0 \"Elsewhere\"\n  endif\nendif\nPlayer->PositionCell 7 8 9 0 \"After\"",
        );
        assert_eq!(found.len(), 3);
        assert_eq!(found[0].items(), vec!["index_master".to_string()]);
        assert!(found[1].items().is_empty(), "the else branch is for players without the index");
        assert!(found[2].conditions.is_empty());
    }

    #[test]
    fn finds_gates_by_the_configured_items() {
        let found = facts(
            "if ( OnActivate == 1 )\n\tif (  Player->GetItemCount, \"Index_Andra\" > 0 )\n\t\tPlayer->PositionCell, 540, 630, -368, 270, \"Andasreth, Propylon Chamber\"\n\telse\n\t\tMessageBox \"No\"\n\tendif\nendif",
        );
        assert_eq!(found.gates, vec![Gate {
            to: Destination { position: [540.0, 630.0, -368.0], cell: "andasreth, propylon chamber".into() },
            items: vec!["index_andra".into()],
            mode: "propylon".into(),
        }]);
        assert!(facts("if ( Player->GetItemCount \"key_hircine1\" > 0 )\nPlayer->PositionCell 1 2 3 0 \"Maze\"\nendif").gates.is_empty());
    }

    #[test]
    fn tells_install_conditions_from_conditions_of_the_game() {
        // PC_m1_KaltanDoralisTR_sc: shown only with Tamriel Rebuilt.
        let tr = script_record(&facts("if ( GetDisabled == 0 )\n\tif ( T_Glob_Installed_TR == 0 )\n\t\tDisable\n\tendif\nelseif ( T_Glob_Installed_TR == 1 )\n\tEnable\nendif"), &globals());
        assert_eq!((tr.requires.as_slice(), tr.excluded_by.is_empty(), tr.conditional), (["tr".to_string()].as_slice(), true, false));
        // PC_m1_KaltanDoralis_sc: goes away with Tamriel Rebuilt.
        let vanilla = script_record(&facts("if ( GetDisabled )\n\tif ( T_Glob_Installed_TR == 0 )\n\t\tEnable\n\tendif\nelseif ( T_Glob_Installed_TR == 1 )\n\tDisable\nendif"), &globals());
        assert_eq!((vanilla.requires.is_empty(), vanilla.excluded_by.as_slice()), (true, ["tr".to_string()].as_slice()));
        // ColonyVeresa: shown from a stage of the Raven Rock quest on.
        let colony = script_record(&facts("if ( ColonyState < 3 )\n\tif ( GetDisabled == 0 )\n\t\tDisable\n\tendif\nelseif ( ColonyState >= 3 )\n\tEnable\nendif"), &globals());
        assert!(colony.conditional && colony.requires.is_empty() && colony.excluded_by.is_empty());
        // A quest switch that looks like an install switch, but no set sets it.
        let quest = script_record(&facts("if ( TR_m4_FG_UshuFree == 1 )\n\tenable\nendif"), &globals());
        assert!(quest.conditional && quest.requires.is_empty());
    }

    #[test]
    fn moves_an_actor_only_under_an_install_condition() {
        let found = facts("set T_Glob_Installed_PC to 1\nif ( doonce != -1 )\n\tif ( T_Glob_Installed_TR == 1 )\n\t\t\"PC_m0_TitusCorilex\"->positioncell 60894 -143581 338 10000 \"Ebonheart\"\n\tendif\nendif\nif ( OnActivate == 1 )\n\t\"Someone\"->PositionCell 1 2 3 0 \"Quest\"\nendif\nif ( doOnce == 0 )\n\tset doOnce to 1\nendif");
        assert_eq!(found.sets_to_one, vec!["t_glob_installed_pc".to_string()]);
        let record = script_record(&found, &globals());
        assert_eq!(record.moves.len(), 1);
        assert_eq!((record.moves[0].actor.as_str(), record.moves[0].set.as_str()), ("pc_m0_tituscorilex", "tr"));
    }

    #[test]
    fn matches_globals_to_the_one_set_that_sets_them() {
        let group = |sets_to_one: &[&str], quest: &[&str], declared: &[&str]| Group {
            scripts: vec![
                ScriptFacts { id: "start".into(), sets_to_one: sets_to_one.iter().map(|s| s.to_string()).collect(), ..ScriptFacts::default() },
                ScriptFacts { id: "quest".into(), sets_to_one: quest.iter().map(|s| s.to_string()).collect(), ..ScriptFacts::default() },
            ],
            globals: declared.iter().map(|s| s.to_string()).collect(),
            start_scripts: HashSet::from(["start".to_string()]),
            ..Group::default()
        };
        let groups = vec![
            ("tr".to_string(), group(&["t_glob_installed_tr", "shared"], &["quest_stage"], &["t_glob_installed_tr", "t_glob_installed_pc", "shared", "quest_stage"])),
            ("pc".to_string(), group(&["t_glob_installed_pc", "shared", "local_variable"], &[], &[])),
        ];
        let found = installed_globals(&groups);
        assert_eq!(found, globals());
    }

    #[test]
    fn takes_transport_from_configured_dialogue_topics_only() {
        use tes3::esp::Filter;
        let topic = Dialogue { id: "Transport to Mournhold".into(), ..Dialogue::default() };
        let info = DialogueInfo {
            speaker_id: "Asciene Rane".into(),
            script_text: "StartScript MHTransportScript".into(),
            filters: vec![
                Filter { filter_type: FilterType::Item, id: "Ticket".into(), comparison: FilterComparison::GreaterEqual, value: FilterValue::Integer(1), ..Filter::default() },
                Filter { filter_type: FilterType::Item, id: "Contraband".into(), comparison: FilterComparison::Equal, value: FilterValue::Integer(0), ..Filter::default() },
            ],
            ..DialogueInfo::default()
        };
        let travel = dialogue_travel(&topic, &info, &config()).unwrap();
        assert_eq!(travel.actor, "asciene rane");
        assert_eq!(travel.mode, "magic");
        assert_eq!(travel.started, vec!["mhtransportscript".to_string()]);
        assert_eq!(travel.items, vec!["ticket".to_string()]);
        let other = Dialogue { id: "must be stopped".into(), ..Dialogue::default() };
        assert!(dialogue_travel(&other, &info, &config()).is_none());
    }

    #[test]
    fn finds_plugins_when_extension_case_differs() {
        let dir = std::env::temp_dir().join(format!("esmap-transport-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("Cyr_Main.esm");
        fs::write(&path, b"fixture").unwrap();
        // On a file system that ignores case the name comes back as asked for.
        let found = find_plugin(std::slice::from_ref(&dir), "Cyr_Main.ESM").unwrap();
        assert!(found.to_string_lossy().eq_ignore_ascii_case(&path.to_string_lossy()));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn reads_carrier_and_placed_reference_from_a_plugin() {
        use tes3::esp::{Header, Reference as PlacedReference};
        let path = std::env::temp_dir().join(format!("esmap-transport-fixture-{}.esm", std::process::id()));
        let mut plugin = Plugin::new();
        plugin.objects.push(Header::default().into());
        let mut npc = Npc { id: "carrier".into(), name: "Carrier".into(), class: "Caravaner".into(), ..Npc::default() };
        npc.travel_destinations.push(TravelDestination { translation: [-8192.0, 0.0, 0.0], ..TravelDestination::default() });
        plugin.objects.push(npc.into());
        let mut cell = Cell::default();
        cell.references.insert((0, 1), PlacedReference { refr_index: 1, id: "carrier".into(), translation: [8192.0, 0.0, 0.0], ..PlacedReference::default() });
        plugin.objects.push(cell.into());
        plugin.save_path(&path).unwrap();
        let mut group = Group::default();
        read_plugin(&path, &config(), &mut group).unwrap();
        assert_eq!(group.actors[0].id, "carrier");
        assert_eq!(group.actors[0].mode.as_deref(), Some("land"));
        assert_eq!(group.actors[0].destinations[0].position[0], -8192.0);
        assert_eq!(group.references[0].actor, "carrier");
        assert_eq!(group.references[0].position[0], 8192.0);
        fs::remove_file(path).unwrap();
    }
}

#[cfg(test)]
#[path = "tests/transport.rs"]
mod end_to_end;
