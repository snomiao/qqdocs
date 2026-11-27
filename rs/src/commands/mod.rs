//! The ported commands, and what they share.
//!
//! A command first decides from the arguments alone whether the invocation
//! is one it reproduces (`parse`: `None` hands it back). It then runs to its
//! end without printing or writing anything: output, the calls to count and
//! the document to remember are collected in `Effects`, which `main` carries
//! out only once the command has succeeded. Until then any `HandBack` leaves
//! the machine as it was, and the JavaScript does the work.
//!
//! Two commands write a file themselves, as their last step: `usage
//! calibrate` (the counter) and `sync` (the list of documents). There a
//! failed write is an error the TypeScript reports, so it has to be known
//! before anything is printed.

pub mod canvas;
pub mod info;
pub mod ls;
pub mod perm;
pub mod raw;
pub mod read;
pub mod search;
pub mod space;
pub mod sync;
pub mod tools;
pub mod usage;

use crate::env::{Env, HandBack, Res, OBJECT_MEMBERS};
use crate::json::{self, Json};
use crate::mcp::Mcp;

pub enum Command {
    Tools(tools::Args),
    Ls(ls::Args),
    Search(search::Args),
    Read(read::Args),
    Info(info::Args),
    Usage(usage::Args),
    Calibrate(usage::CalibrateArgs),
    PermGet(perm::Args),
    SpaceList(space::ListArgs),
    SpaceLs(space::LsArgs),
    CanvasRead(canvas::ReadArgs),
    CanvasFind(canvas::FindArgs),
    Raw(raw::Args),
    Sync(sync::Args),
}

/// The command line, if Rust runs it itself.
pub fn parse(args: &[String]) -> Option<Command> {
    // yargs prints a command's help when the last word that is not an
    // option or an option's value is `help` (`qqdocs search help`). Which
    // word that is depends on how much it knows about the options at each
    // of its passes, so the word anywhere on the line is left to it.
    if args.iter().any(|arg| arg == "help") {
        return None;
    }
    let (command, rest) = args.split_first()?;
    match command.as_str() {
        "tools" => tools::parse(rest).map(Command::Tools),
        "ls" | "list" => ls::parse(rest).map(Command::Ls),
        "search" => search::parse(rest).map(Command::Search),
        "read" => read::parse(rest).map(Command::Read),
        "info" => info::parse(rest).map(Command::Info),
        "usage" if rest.first().map(String::as_str) == Some("calibrate") => usage::parse_calibrate(&rest[1..]).map(Command::Calibrate),
        "usage" => usage::parse(rest).map(Command::Usage),
        "raw" => raw::parse(rest).map(Command::Raw),
        "sync" => sync::parse(rest).map(Command::Sync),
        // Subcommands: the word after the command decides, nothing may stand
        // between the two.
        "perm" | "space" | "canvas" => {
            let (sub, rest) = rest.split_first()?;
            match (command.as_str(), sub.as_str()) {
                ("perm", "get") => perm::parse_get(rest).map(Command::PermGet),
                ("space", "list") => space::parse_list(rest).map(Command::SpaceList),
                ("space", "ls") => space::parse_ls(rest).map(Command::SpaceLs),
                ("canvas", "read") => canvas::parse_read(rest).map(Command::CanvasRead),
                ("canvas", "find") => canvas::parse_find(rest).map(Command::CanvasFind),
                _ => None,
            }
        }
        _ => None,
    }
}

impl Command {
    pub fn run(&self, env: &Env) -> Res<Effects> {
        match self {
            Command::Usage(args) => usage::run(env, args),
            Command::Calibrate(args) => usage::calibrate(env, args),
            Command::Tools(args) => online(env, |mcp, effects| tools::run(mcp, args, effects)),
            Command::Ls(args) => online(env, |mcp, effects| ls::run(mcp, args, effects)),
            Command::Search(args) => online(env, |mcp, effects| search::run(mcp, args, effects)),
            Command::Read(args) => online(env, |mcp, effects| read::run(env, mcp, args, effects)),
            Command::Info(args) => online(env, |mcp, effects| info::run(mcp, args, effects)),
            Command::PermGet(args) => online(env, |mcp, effects| perm::run(mcp, args, effects)),
            Command::SpaceList(args) => online(env, |mcp, effects| space::list(mcp, args, effects)),
            Command::SpaceLs(args) => online(env, |mcp, effects| space::ls(mcp, args, effects)),
            Command::CanvasRead(args) => online(env, |mcp, effects| canvas::read(mcp, args, effects)),
            Command::CanvasFind(args) => online(env, |mcp, effects| canvas::find(mcp, args, effects)),
            Command::Raw(args) => online(env, |mcp, effects| raw::run(mcp, args, effects)),
            Command::Sync(_) => online(env, |mcp, effects| sync::run(env, mcp, effects)),
        }
    }
}

/// What a command that succeeded leaves to be done.
#[derive(Default)]
pub struct Effects {
    pub stdout: String,
    pub stderr: String,
    /// Successful `tools/call` requests, each counted in usage.json.
    pub calls: u32,
    /// `setCachedDoc(fileId, content, info)`
    pub remember: Option<read::Remember>,
}

impl Effects {
    /// `console.log(line)`
    pub fn log(&mut self, line: &str) {
        self.stdout.push_str(line);
        self.stdout.push('\n');
    }
}

/// Runs a command that talks to the service.
fn online(env: &Env, command: impl FnOnce(&Mcp, &mut Effects) -> Res<()>) -> Res<Effects> {
    // A counter file of a shape the TypeScript's arithmetic was not written
    // for: what happens to it after each call is not reproduced.
    if matches!(crate::usage::load(&crate::usage::path(env)), crate::usage::Loaded::Odd) {
        return Err(HandBack);
    }
    let mcp = Mcp::new(env)?;
    let mut effects = Effects::default();
    command(&mcp, &mut effects)?;
    effects.calls = mcp.calls();
    Ok(effects)
}

// ── helpers of src/index.ts ──────────────────────────────────────────────────

/// `${value}` in a template literal, for a property that may be missing.
pub fn template(value: Option<&Json>) -> Res<String> {
    match value {
        None => Ok("undefined".to_string()),
        Some(value) => value.to_js_string().ok_or(HandBack),
    }
}

/// `value.key`, where reading a property of null ends the TypeScript.
pub fn prop<'a>(value: &'a Json, key: &str) -> Res<Option<&'a Json>> {
    value.prop(key).map_err(|_| HandBack)
}

/// `value.first ?? value.second`
pub fn either<'a>(value: &'a Json, first: &str, second: &str) -> Res<Option<&'a Json>> {
    let found = value.prop_nullish(first).map_err(|_| HandBack)?;
    match found {
        Some(found) => Ok(Some(found)),
        None => prop(value, second),
    }
}

/// `formatLink(text, url)` where standard output is not a terminal.
pub fn link(text: &str, url: &str) -> String {
    format!("[{text}]({url})")
}

/// `docTypeExt(docTypeFromUrl(url))`
pub fn extension_for_url(url: &str) -> &'static str {
    for (part, extension) in [
        ("/sheet/", ".xlsx"),
        ("/smartsheet/", ".ssheet"),
        ("/slide/", ".pptx"),
        ("/form/", ".form"),
        ("/pdf/", ".pdf"),
        ("/mind/", ".mind"),
        ("/flowchart/", ".flow"),
    ] {
        if url.contains(part) {
            return extension;
        }
    }
    ".docx"
}

/// `summarizeText(text, 100)`
pub fn summarize(text: &str) -> Res<String> {
    let normalized = json::collapse_whitespace(text);
    if json::js_len(&normalized) <= 100 {
        return Ok(normalized);
    }
    Ok(format!("{}...", json::js_prefix(&normalized, 97).ok_or(HandBack)?))
}

/// `printObject(obj)`
pub fn print_object(object: &json::Object, effects: &mut Effects) {
    for (key, value) in object.entries() {
        let text = match value {
            Json::Null => continue,
            Json::Str(text) if text.is_empty() => continue,
            Json::Arr(_) | Json::Obj(_) => value.compact(),
            other => other.to_js_string().expect("not a list or an object"),
        };
        effects.log(&format!("  {key}: {text}"));
    }
}

/// `tryExtractFileIdFromUrl(input)`: the id in a docs.qq.com address.
pub fn file_id_from_url(input: &str) -> Option<String> {
    const HOST: &str = "docs.qq.com/";
    const KINDS: [&str; 9] = ["doc", "sheet", "slide", "smartsheet", "form", "pdf", "mind", "flowchart", "aio"];
    let id_at = |text: &str| {
        let end = text.find(|c: char| !c.is_ascii_alphanumeric()).unwrap_or(text.len());
        (end > 0).then(|| text[..end].to_string())
    };
    let after_host = || input.match_indices(HOST).map(|(at, _)| &input[at + HOST.len()..]);
    // /docs\.qq\.com\/(?:doc|sheet|…|aio)\/([A-Za-z0-9]+)/
    for rest in after_host() {
        for kind in KINDS {
            if let Some(id) = rest.strip_prefix(kind).and_then(|rest| rest.strip_prefix('/')).and_then(id_at) {
                return Some(id);
            }
        }
    }
    // /docs\.qq\.com\/[^/]+\/([A-Za-z0-9]+)/
    for rest in after_host() {
        if let Some(id) = rest.find('/').filter(|slash| *slash > 0).and_then(|slash| id_at(&rest[slash + 1..])) {
            return Some(id);
        }
    }
    None
}

/// `looksLikeFileId(input)`, for input that is trimmed already.
pub fn looks_like_file_id(trimmed: &str) -> bool {
    trimmed.len() >= 10 && trimmed.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// `searchDocs(query)`: `r.list ?? []`
pub fn search_docs(mcp: &Mcp, query: &str) -> Res<Json> {
    let answer = mcp.call("manage.search_file", json::object([("search_key", json::string(query))]))?;
    Ok(answer.prop_nullish("list").map_err(|_| HandBack)?.cloned().unwrap_or(Json::Arr(Vec::new())))
}

/// `getDocInfo(fileId)`'s request.
pub fn info_call(file_id: &str) -> (&'static str, Json) {
    ("manage.query_file_info", json::object([("file_id", json::string(file_id))]))
}

/// `resolveFileId(input)`: an address, an id, or a title to search for.
pub fn resolve_file_id(mcp: &Mcp, input: &str) -> Res<String> {
    let id = match file_id_from_url(input) {
        Some(id) => id,
        None => {
            let trimmed = json::js_trim(input);
            if looks_like_file_id(trimmed) {
                trimmed.to_string()
            } else {
                picked_file_id(trimmed, &search_docs(mcp, trimmed)?)?
            }
        }
    };
    // The id becomes a key of a plain JavaScript object (the document cache).
    if OBJECT_MEMBERS.contains(&id.as_str()) {
        return Err(HandBack);
    }
    Ok(id)
}

/// `pickFileFromSearchResults(name, results).file_id`. No document of that
/// name, or several, are errors the TypeScript reports.
fn picked_file_id(name: &str, results: &Json) -> Res<String> {
    let Json::Arr(results) = results else { return Err(HandBack) };
    let mut exact = Vec::new();
    for file in results {
        // `f.file_name ?? f.title ?? ""`
        let title = match file.prop_nullish("file_name").map_err(|_| HandBack)? {
            Some(title) => Some(title),
            None => file.prop_nullish("title").map_err(|_| HandBack)?,
        };
        let is_exact = match title {
            Some(Json::Str(title)) => title == name,
            Some(_) => false,
            None => name.is_empty(),
        };
        if is_exact {
            exact.push(file);
        }
    }
    let pool: Vec<&Json> = if exact.is_empty() { results.iter().collect() } else { exact };
    match pool.as_slice() {
        [only] => match prop(only, "file_id")? {
            Some(Json::Str(id)) => Ok(id.clone()),
            _ => Err(HandBack),
        },
        _ => Err(HandBack),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn taken(words: &[&str]) -> bool {
        parse(&words.iter().map(|w| w.to_string()).collect::<Vec<_>>()).is_some()
    }

    #[test]
    fn only_the_ported_commands_are_taken() {
        for words in [
            &["tools"][..],
            &["ls"],
            &["list", "root", "--json"],
            &["search", "x"],
            &["read", "x"],
            &["info", "x"],
            &["usage"],
            &["usage", "calibrate", "--today", "1"],
            &["perm", "get", "x"],
            &["space", "list"],
            &["space", "ls", "s"],
            &["canvas", "read", "x", "--all"],
            &["canvas", "find", "x", "q"],
            &["raw", "get_content"],
            &["sync"],
        ] {
            assert!(taken(words), "{words:?}");
        }
        for words in [
            &[][..],
            // Starts the default browser.
            &["open", "x"],
            // Everything that creates, changes or deletes.
            &["rename", "x", "t"],
            &["mv", "x", "t"],
            &["cp", "x"],
            &["copy", "x"],
            &["delete", "x"],
            &["rm", "x"],
            &["import", "f.md"],
            &["upload", "f.md"],
            &["create", "t"],
            &["flowchart", "t", "--mermaid", "graph TD"],
            &["perm", "set", "x", "link-read"],
            &["perm"],
            &["space"],
            &["space", "create", "t"],
            &["space", "mkdir", "s", "t"],
            &["space", "mkdoc", "s", "t"],
            &["space", "link", "s", "t", "u"],
            &["space", "rm", "s", "n"],
            &["space", "move", "x", "s"],
            &["canvas"],
            &["canvas", "edit", "x", "delete", "--id", "b"],
            &["raw", "manage.create_file"],
            &["raw", "manage.delete_file"],
            &["raw"],
            // yargs's own.
            &["--help"],
            &["-h"],
            &["--version"],
            &["completion"],
            &["usage", "--help"],
            &["usage", "calibrate", "--help"],
            &["ls", "--version"],
            &["--json", "ls"],
            &["LS"],
            &["unknown"],
        ] {
            assert!(!taken(words), "{words:?}");
        }
    }

    #[test]
    fn ids_are_found_in_addresses() {
        for (input, id) in [
            ("https://docs.qq.com/doc/DZEZ6TEFiQmpGdUJy", Some("DZEZ6TEFiQmpGdUJy")),
            ("https://docs.qq.com/aio/DZEZ6TEFiQmpGdUJy?p=abc", Some("DZEZ6TEFiQmpGdUJy")),
            ("docs.qq.com/smartsheet/abc-def", Some("abc")),
            ("see https://docs.qq.com/sheet/S1 and https://docs.qq.com/doc/D2", Some("S1")),
            // The second pattern: any one path segment.
            ("https://docs.qq.com/desktop/mydoc", Some("mydoc")),
            ("https://docs.qq.com/document/Dabc", Some("Dabc")),
            // The first pattern wins wherever it matches.
            ("https://docs.qq.com/x/first https://docs.qq.com/doc/second", Some("second")),
            ("https://docs.qq.com/slide/ https://docs.qq.com/y/z", Some("z")),
            ("https://docs.qq.com/doc/", None),
            ("https://docs.qq.com//abc", None),
            ("https://docs.qq.com/abc", None),
            ("https://docsxqq.com/doc/abc", None),
            ("dFzLAbBjFuBr", None),
        ] {
            assert_eq!(file_id_from_url(input).as_deref(), id, "{input}");
        }
    }

    #[test]
    fn extensions_follow_the_address() {
        assert_eq!(extension_for_url("https://docs.qq.com/sheet/x"), ".xlsx");
        assert_eq!(extension_for_url("https://docs.qq.com/smartsheet/x"), ".ssheet");
        assert_eq!(extension_for_url("https://docs.qq.com/doc/x"), ".docx");
        assert_eq!(extension_for_url("https://docs.qq.com/aio/x"), ".docx");
        assert_eq!(extension_for_url("https://docs.qq.com/flowchart/x"), ".flow");
    }

    #[test]
    fn summaries() {
        assert_eq!(summarize(" a \n b ").unwrap(), "a b");
        assert_eq!(summarize(&"x".repeat(100)).unwrap(), "x".repeat(100));
        assert_eq!(summarize(&"x".repeat(101)).unwrap(), format!("{}...", "x".repeat(97)));
        // The cut would fall inside a character outside the basic plane.
        assert_eq!(summarize(&format!("{}😀{}", "x".repeat(96), "y".repeat(10))), Err(HandBack));
    }
}
