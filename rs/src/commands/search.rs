//! `qqdocs search <query> [--json]` (src/index.ts cmdDocsSearch).

use super::{either, link, search_docs, template, Effects};
use crate::args::{self, Flag, Spec};
use crate::env::{HandBack, Res};
use crate::json::Json;
use crate::mcp::Mcp;

pub struct Args {
    query: String,
    json: bool,
}

pub fn parse(rest: &[String]) -> Option<Args> {
    let parsed = args::parse(rest, &Spec { options: &[], flags: &[Flag { long: "json", short: None }] })?;
    match parsed.positionals.as_slice() {
        [query] => Some(Args { query: query.clone(), json: parsed.flag("json") }),
        _ => None,
    }
}

pub fn run(mcp: &Mcp, args: &Args, effects: &mut Effects) -> Res<()> {
    let files = search_docs(mcp, &args.query)?;
    if args.json {
        effects.log(&files.pretty());
        return Ok(());
    }
    let Json::Arr(files) = files else { return Err(HandBack) };
    if files.is_empty() {
        effects.log(&format!("(no documents matching \"{}\")", args.query));
        return Ok(());
    }
    for file in &files {
        let title = template(either(file, "title", "file_name")?)?;
        let url = template(either(file, "url", "file_url")?)?;
        effects.log(&format!("  {}", link(&title, &url)));
    }
    Ok(())
}
