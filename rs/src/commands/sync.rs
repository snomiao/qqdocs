//! `qqdocs sync` (src/index.ts cmdDocsSync, syncDocs): the recent documents
//! and those in the root folder, written to ~/.qqdocs/cache.json.

use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

use super::{prop, Effects};
use crate::args::{self, Spec};
use crate::env::{Env, HandBack, Res};
use crate::json::{self, Json, Object};
use crate::mcp::Mcp;

pub struct Args;

pub fn parse(rest: &[String]) -> Option<Args> {
    let parsed = args::parse(rest, &Spec { options: &[], flags: &[] })?;
    parsed.positionals.is_empty().then_some(Args)
}

pub fn run(env: &Env, mcp: &Mcp, effects: &mut Effects) -> Res<()> {
    // Before ~/.qqdocs exists the counts of two calls made at the same time
    // overwrite each other in the TypeScript (see `read`).
    if !env.state_dir().is_dir() {
        return Err(HandBack);
    }
    // `Promise.all([listRecent(100), listFolderContents(undefined)])`
    let recent = ("manage.recent_online_file", json::object([("num", Json::Num(1.0)), ("count", Json::Num(100.0))]));
    let root = ("manage.folder_list", Json::Obj(Object::new()));
    let mut answers = mcp.call_together(vec![recent, root]).into_iter();
    let recent = answers.next().ok_or(HandBack)??;
    let root = answers.next().ok_or(HandBack)??;
    let list_of = |answer: &Json, first: &str, second: Option<&str>| -> Res<Vec<Json>> {
        let mut found = answer.prop_nullish(first).map_err(|_| HandBack)?;
        if let (None, Some(second)) = (found, second) {
            found = answer.prop_nullish(second).map_err(|_| HandBack)?;
        }
        match found {
            None => Ok(Vec::new()),
            Some(Json::Arr(items)) => Ok(items.clone()),
            Some(_) => Err(HandBack),
        }
    };
    // The ids go into a Set and the entries into JSON; text and missing
    // values are what both keep as they are.
    let id_of = |item: &Json, key: &str| match prop(item, key)? {
        Some(Json::Str(id)) => Ok(id.clone()),
        _ => Err(HandBack),
    };
    let mut seen: Vec<String> = Vec::new();
    let mut entries = Vec::new();
    // `{ file_id, title, url }`: JSON.stringify leaves out what is undefined.
    let entry = |id: &str, title: Option<&Json>, url: Option<Json>| {
        let mut entry = Object::new();
        entry.set("file_id", json::string(id));
        if let Some(title) = title {
            entry.set("title", title.clone());
        }
        if let Some(url) = url {
            entry.set("url", url);
        }
        Json::Obj(entry)
    };
    for file in list_of(&recent, "files", Some("file"))? {
        let id = id_of(&file, "file_id")?;
        if !seen.contains(&id) {
            entries.push(entry(&id, prop(&file, "file_name")?, prop(&file, "file_url")?.cloned()));
            seen.push(id);
        }
    }
    for item in list_of(&root, "list", None)? {
        if prop(&item, "is_folder")?.is_some_and(Json::truthy) {
            continue;
        }
        let id = id_of(&item, "id")?;
        if seen.contains(&id) {
            continue;
        }
        // `item.url.startsWith("//")` needs a string.
        let Some(Json::Str(url)) = prop(&item, "url")? else { return Err(HandBack) };
        let url = if url.starts_with("//") { format!("https:{url}") } else { url.clone() };
        entries.push(entry(&id, prop(&item, "title")?, Some(json::string(&url))));
        seen.push(id);
    }
    let count = entries.len();
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| HandBack)?.as_millis() as f64;
    let cache = json::object([("syncedAt", Json::Num(now)), ("entries", Json::Arr(entries))]);
    // The one write that is not allowed to fail: the TypeScript reports the
    // failure. Nothing has been printed yet, so it can still do that.
    let path = env.state_file("cache.json");
    fs::create_dir_all(env.state_dir()).map_err(|_| HandBack)?;
    fs::write(&path, cache.pretty()).map_err(|_| HandBack)?;
    // `process.stdout.write("Syncing…")` before, `\r✓ Synced …` after.
    effects.stdout.push_str(&format!("Syncing…\r✓ Synced {count} documents to {}\n", path.display()));
    Ok(())
}
