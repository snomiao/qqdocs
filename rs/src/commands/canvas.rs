//! `qqdocs canvas read <ref>` and `qqdocs canvas find <ref> <query>`
//! (src/index.ts cmdCanvasRead, readCanvasAll, cmdCanvasFind). `canvas edit`
//! changes the document and stays in the JavaScript.

use super::{prop, resolve_file_id, template, Effects};
use crate::args::{self, Flag, Kind, Opt, Spec};
use crate::env::{HandBack, Res};
use crate::json::{self, Json};
use crate::mcp::Mcp;

pub struct ReadArgs {
    reference: String,
    page: Option<String>,
    size: Option<f64>,
    next: Option<String>,
    all: bool,
}

pub fn parse_read(rest: &[String]) -> Option<ReadArgs> {
    const SPEC: Spec = Spec {
        options: &[
            Opt { long: "page", short: None, kind: Kind::Text },
            Opt { long: "size", short: None, kind: Kind::Count },
            Opt { long: "next", short: None, kind: Kind::Text },
        ],
        flags: &[Flag { long: "all", short: None }],
    };
    let parsed = args::parse(rest, &SPEC)?;
    match parsed.positionals.as_slice() {
        [reference] => Some(ReadArgs {
            reference: reference.clone(),
            page: parsed.value("page").map(String::from),
            size: parsed.count("size"),
            next: parsed.value("next").map(String::from),
            all: parsed.flag("all"),
        }),
        _ => None,
    }
}

/// `readCanvas(fileId, { pageId, size, nextToken })`
fn read_page(mcp: &Mcp, file_id: &str, args: &ReadArgs, next: Option<&str>) -> Res<Json> {
    let mut call_args = json::Object::new();
    call_args.set("file_id", json::string(file_id));
    if let Some(page) = &args.page {
        call_args.set("page_id", json::string(page));
    }
    if let Some(size) = args.size {
        call_args.set("size", Json::Num(size));
    }
    if let Some(next) = next {
        call_args.set("next_token", json::string(next));
    }
    mcp.call("smartcanvas.read", Json::Obj(call_args))
}

/// A field that is text, or is not there (missing, null or empty).
fn text_or_nothing<'a>(value: &'a Json, key: &str) -> Res<Option<&'a str>> {
    match prop(value, key)? {
        None | Some(Json::Null) => Ok(None),
        Some(Json::Str(text)) if text.is_empty() => Ok(None),
        Some(Json::Str(text)) => Ok(Some(text)),
        Some(_) => Err(HandBack),
    }
}

pub fn read(mcp: &Mcp, args: &ReadArgs, effects: &mut Effects) -> Res<()> {
    let file_id = resolve_file_id(mcp, &args.reference)?;
    if args.all {
        // readCanvasAll: follow next_token, a hundred pages at most.
        let mut content = String::new();
        let mut next: Option<String> = None;
        for _ in 0..100 {
            let page = read_page(mcp, &file_id, args, next.as_deref())?;
            // `if (page.error) throw …`
            if prop(&page, "error")?.is_some_and(Json::truthy) {
                return Err(HandBack);
            }
            content.push_str(text_or_nothing(&page, "content")?.unwrap_or(""));
            next = text_or_nothing(&page, "next_token")?.map(String::from);
            if next.is_none() {
                break;
            }
        }
        effects.log(&content);
        return Ok(());
    }
    let result = read_page(mcp, &file_id, args, args.next.as_deref())?;
    // `console.log(result.content ?? "")`: only text is printed as it is.
    match prop(&result, "content")? {
        None | Some(Json::Null) => effects.log(""),
        Some(Json::Str(content)) => effects.log(content),
        Some(_) => return Err(HandBack),
    }
    if let Some(next) = prop(&result, "next_token")?.filter(|next| next.truthy()) {
        effects.log(&format!("Next: {}", template(Some(next))?));
    }
    Ok(())
}

pub struct FindArgs {
    reference: String,
    query: String,
}

pub fn parse_find(rest: &[String]) -> Option<FindArgs> {
    let parsed = args::parse(rest, &Spec { options: &[], flags: &[] })?;
    match parsed.positionals.as_slice() {
        [reference, query] => Some(FindArgs { reference: reference.clone(), query: query.clone() }),
        _ => None,
    }
}

pub fn find(mcp: &Mcp, args: &FindArgs, effects: &mut Effects) -> Res<()> {
    let file_id = resolve_file_id(mcp, &args.reference)?;
    let result = mcp.call("smartcanvas.find", json::object([("file_id", json::string(&file_id)), ("query", json::string(&args.query))]))?;
    let blocks = match result.prop_nullish("blocks").map_err(|_| HandBack)? {
        None => Vec::new(),
        Some(Json::Arr(blocks)) => blocks.clone(),
        Some(_) => return Err(HandBack),
    };
    if blocks.is_empty() {
        effects.log("(no matching blocks)");
        return Ok(());
    }
    for (index, block) in blocks.iter().enumerate() {
        effects.log(&format!("ID: {}", template(prop(block, "id")?)?));
        // `console.log(block.content)`: only text is printed as it is.
        match prop(block, "content")? {
            None => effects.log("undefined"),
            Some(Json::Str(content)) => effects.log(content),
            Some(_) => return Err(HandBack),
        }
        if index < blocks.len() - 1 {
            effects.log("");
        }
    }
    Ok(())
}
