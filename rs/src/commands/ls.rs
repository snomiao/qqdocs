//! `qqdocs ls [folder]` / `list`, where standard output is not a terminal
//! (src/index.ts cmdDocsLs: the JSON mode and the "plain mode for non-TTY").

use std::collections::HashMap;

use super::{extension_for_url, info_call, link, looks_like_file_id, prop, template, Effects};
use crate::args::{self, Flag, Kind, Opt, Spec};
use crate::clock;
use crate::env::{HandBack, Res};
use crate::json::{self, Json};
use crate::mcp::{Failed, Mcp};

pub struct Args {
    folder: Option<String>,
    count: f64,
    page: f64,
    json: bool,
    dates: bool,
}

const SPEC: Spec = Spec {
    options: &[Opt { long: "count", short: Some("n"), kind: Kind::Count }, Opt { long: "page", short: Some("p"), kind: Kind::Count }],
    flags: &[Flag { long: "json", short: None }, Flag { long: "dates", short: Some("d") }],
};

pub fn parse(rest: &[String]) -> Option<Args> {
    let parsed = args::parse(rest, &SPEC)?;
    let folder = match parsed.positionals.as_slice() {
        [] => None,
        [folder] => Some(folder.clone()),
        _ => return None,
    };
    Some(Args {
        folder,
        count: parsed.count("count").unwrap_or(20.0),
        page: parsed.count("page").unwrap_or(1.0),
        json: parsed.flag("json"),
        dates: parsed.flag("dates"),
    })
}

pub fn run(mcp: &Mcp, args: &Args, effects: &mut Effects) -> Res<()> {
    match &args.folder {
        Some(folder) => folder_contents(mcp, args, folder, effects),
        None => recent(mcp, args, effects),
    }
}

/// What the plain mode writes to standard error around the first request.
/// Written once the command has succeeded; in a file or a pipe that is the
/// same bytes.
const FETCHING: &str = "fetching…\r          \r";

fn recent(mcp: &Mcp, args: &Args, effects: &mut Effects) -> Res<()> {
    // `listRecent(count, page)`: `r.files ?? r.file ?? []`
    let answer = mcp.call("manage.recent_online_file", json::object([("num", Json::Num(args.page)), ("count", Json::Num(args.count))]))?;
    let files = match answer.prop_nullish("files").map_err(|_| HandBack)? {
        Some(files) => files.clone(),
        None => answer.prop_nullish("file").map_err(|_| HandBack)?.cloned().unwrap_or(Json::Arr(Vec::new())),
    };
    if args.json {
        effects.log(&files.pretty());
        return Ok(());
    }
    effects.stderr.push_str(FETCHING);
    let Json::Arr(files) = files else { return Err(HandBack) };
    if files.is_empty() {
        effects.log("(no recent documents)");
        return Ok(());
    }
    // `docTypeFromUrl(f.file_url)` needs a string.
    let url_of = |file: &Json| match prop(file, "file_url")? {
        Some(Json::Str(url)) => Ok(url.clone()),
        _ => Err(HandBack),
    };
    for file in &files {
        url_of(file)?;
    }
    let dates = if args.dates { fetch_dates(mcp, files.iter().map(|file| prop(file, "file_id")).collect::<Res<_>>()?)? } else { HashMap::new() };
    for file in &files {
        let url = url_of(file)?;
        let date = id_key(prop(file, "file_id")?).and_then(|id| dates.get(&id));
        effects.log(&row(&template(prop(file, "file_name")?)?, &url, extension_for_url(&url), date));
    }
    Ok(())
}

fn folder_contents(mcp: &Mcp, args: &Args, folder: &str, effects: &mut Effects) -> Res<()> {
    let folder_id = resolve_folder_id(mcp, folder)?;
    let (list, finish) = list_folder(mcp, folder_id.as_deref())?;
    if args.json {
        effects.log(&list.pretty());
        return Ok(());
    }
    effects.stderr.push_str(FETCHING);
    let Json::Arr(list) = list else { return Err(HandBack) };
    if list.is_empty() {
        effects.log("(empty folder)");
        return Ok(());
    }
    // `item.url.startsWith(...)` needs a string, for folders too.
    let url_of = |item: &Json| match prop(item, "url")? {
        Some(Json::Str(url)) => Ok(url.clone()),
        _ => Err(HandBack),
    };
    let is_folder = |item: &Json| Ok(prop(item, "is_folder")?.is_some_and(Json::truthy));
    let mut documents = Vec::new();
    for item in &list {
        url_of(item)?;
        if !is_folder(item)? {
            documents.push(prop(item, "id")?);
        }
    }
    let dates = if args.dates { fetch_dates(mcp, documents)? } else { HashMap::new() };
    for item in &list {
        let url = url_of(item)?;
        let extension = if is_folder(item)? { "/" } else { extension_for_url(&url) };
        let url = if url.starts_with("//") { format!("https:{url}") } else { url };
        let date = id_key(prop(item, "id")?).and_then(|id| dates.get(&id));
        effects.log(&row(&template(prop(item, "title")?)?, &url, extension, date));
    }
    if !finish {
        effects.log("  … (more items exist)");
    }
    Ok(())
}

fn row(title: &str, url: &str, extension: &str, date: Option<&String>) -> String {
    let date = date.map(|date| format!("  {date}")).unwrap_or_default();
    format!("  {} {extension}{date}", link(title, url))
}

/// `listFolderContents(folderId)`: `{ list: r.list ?? [], finish: r.finish ?? true }`
fn list_folder(mcp: &Mcp, folder_id: Option<&str>) -> Res<(Json, bool)> {
    let mut call_args = json::Object::new();
    if let Some(id) = folder_id {
        call_args.set("folder_id", json::string(id));
    }
    let answer = mcp.call("manage.folder_list", Json::Obj(call_args))?;
    let list = answer.prop_nullish("list").map_err(|_| HandBack)?.cloned().unwrap_or(Json::Arr(Vec::new()));
    let finish = answer.prop_nullish("finish").map_err(|_| HandBack)?.is_none_or(Json::truthy);
    Ok((list, finish))
}

/// `resolveFolderId(input)`: nothing for the root, an id as it is, or a path
/// of folder titles looked up level by level. A title that is not there, or
/// there twice, is an error the TypeScript reports.
fn resolve_folder_id(mcp: &Mcp, input: &str) -> Res<Option<String>> {
    let trimmed = json::js_trim(input);
    if trimmed.is_empty() || trimmed == "root" {
        return Ok(None);
    }
    if !trimmed.contains('/') && looks_like_file_id(trimmed) {
        return Ok(Some(trimmed.to_string()));
    }
    let mut parent: Option<String> = None;
    for segment in trimmed.split('/').map(json::js_trim).filter(|segment| !segment.is_empty()) {
        let (list, _) = list_folder(mcp, parent.as_deref())?;
        let Json::Arr(list) = list else { return Err(HandBack) };
        let mut matches = Vec::new();
        for item in &list {
            let is_folder = prop(item, "is_folder")?.is_some_and(Json::truthy);
            if is_folder && matches!(prop(item, "title")?, Some(Json::Str(title)) if title == segment) {
                matches.push(item);
            }
        }
        parent = match matches.as_slice() {
            // An empty id would list the root again.
            [only] => match prop(only, "id")? {
                Some(Json::Str(id)) if !id.is_empty() => Some(id.clone()),
                _ => return Err(HandBack),
            },
            _ => return Err(HandBack),
        };
    }
    Ok(parent)
}

/// The key a document id is under in the dates map: ids are strings.
fn id_key(id: Option<&Json>) -> Option<String> {
    match id {
        Some(Json::Str(id)) => Some(id.clone()),
        _ => None,
    }
}

/// `fetchDates(ids)`: one `query_file_info` per document, all at once
/// (`Promise.allSettled`), and the last-modified time of each in words. A
/// document whose call fails has no date; the others keep theirs.
fn fetch_dates(mcp: &Mcp, ids: Vec<Option<&Json>>) -> Res<HashMap<String, String>> {
    let ids: Vec<String> = ids.into_iter().map(|id| id_key(id).ok_or(HandBack)).collect::<Res<_>>()?;
    let calls = ids.iter().map(|id| info_call(id)).map(|(tool, call_args)| (tool, call_args, true)).collect();
    let answers = mcp.call_together(calls);
    let now = clock::now_ms().ok_or(HandBack)?;
    let mut dates = HashMap::new();
    for (id, answer) in ids.into_iter().zip(answers) {
        let answer = match answer {
            Ok(answer) => answer,
            // `r.status === "fulfilled"`
            Err(Failed::Thrown) => continue,
            Err(Failed::NotReproduced) => return Err(HandBack),
        };
        // `r.value?.last_modify_time`
        let modified = match &answer {
            Json::Null => None,
            other => prop(other, "last_modify_time")?,
        };
        if let Some(modified) = modified.filter(|modified| modified.truthy()) {
            dates.insert(id, relative_date(modified, now)?);
        }
    }
    Ok(dates)
}

/// `formatRelativeDate(tsMs, now)`
fn relative_date(modified: &Json, now: f64) -> Res<String> {
    let ms = match modified {
        Json::Num(ms) => *ms,
        // `Number(text)` for plain digits; its other notations are not reproduced.
        Json::Str(text) if (1..=15).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_digit()) => text.parse::<f64>().map_err(|_| HandBack)?,
        _ => return Err(HandBack),
    };
    let diff = now - ms;
    let whole = |n: f64| json::number_to_string(n.floor());
    Ok(if diff < 60_000.0 {
        "just now".to_string()
    } else if diff < 3_600_000.0 {
        format!("{}m ago", whole(diff / 60_000.0))
    } else if diff < 86_400_000.0 {
        format!("{}h ago", whole(diff / 3_600_000.0))
    } else if diff < 7.0 * 86_400_000.0 {
        format!("{}d ago", whole(diff / 86_400_000.0))
    } else {
        clock::utc_date(ms).ok_or(HandBack)?
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_in_words() {
        let now = 1_800_000_000_000.0;
        let ago = |ms: f64| relative_date(&Json::Num(now - ms), now).unwrap();
        assert_eq!(ago(0.0), "just now");
        assert_eq!(ago(-5000.0), "just now");
        assert_eq!(ago(59_999.0), "just now");
        assert_eq!(ago(60_000.0), "1m ago");
        assert_eq!(ago(3_599_999.0), "59m ago");
        assert_eq!(ago(3_600_000.0), "1h ago");
        assert_eq!(ago(86_399_999.0), "23h ago");
        assert_eq!(ago(86_400_000.0), "1d ago");
        assert_eq!(ago(7.0 * 86_400_000.0 - 1.0), "6d ago");
        assert_eq!(ago(7.0 * 86_400_000.0), "2027-01-08");
        assert_eq!(relative_date(&json::string("1700000000000"), now).unwrap(), "2023-11-14");
        assert_eq!(relative_date(&json::string("1.7e12"), now), Err(HandBack));
        assert_eq!(relative_date(&Json::Bool(true), now), Err(HandBack));
    }
}
