//! `qqdocs raw <tool> [--json '{...}']` (src/index.ts cmdRaw), for the tools
//! that only read.
//!
//! `raw` calls whatever tool it is given. A command runs here only if a
//! failed call can be handed to the JavaScript, which then calls again; that
//! is harmless for a tool that reads and not for one that creates or deletes.
//! So Rust takes the tools the TypeScript itself uses for reading, by name,
//! and every other tool stays in the JavaScript.

use super::Effects;
use crate::args::{self, Kind, Opt, Spec};
use crate::env::{HandBack, Res};
use crate::json::{self, Json};
use crate::mcp::Mcp;

const READING_TOOLS: [&str; 12] = [
    "get_content",
    "manage.folder_list",
    "manage.get_privilege",
    "manage.import_progress",
    "manage.query_file_info",
    "manage.query_folder_meta",
    "manage.recent_online_file",
    "manage.search_file",
    "query_space_list",
    "query_space_node",
    "smartcanvas.find",
    "smartcanvas.read",
];

pub struct Args {
    tool: String,
    json: String,
}

pub fn parse(rest: &[String]) -> Option<Args> {
    let parsed = args::parse(rest, &Spec { options: &[Opt { long: "json", short: None, kind: Kind::Text }], flags: &[] })?;
    match parsed.positionals.as_slice() {
        [tool] if READING_TOOLS.contains(&tool.as_str()) => Some(Args { tool: tool.clone(), json: parsed.value("json").unwrap_or("{}").to_string() }),
        _ => None,
    }
}

pub fn run(mcp: &Mcp, args: &Args, effects: &mut Effects) -> Res<()> {
    // parseJsonObject: anything but a JSON object is an error it reports.
    let Ok(call_args @ Json::Obj(_)) = json::parse(&args.json) else { return Err(HandBack) };
    let result = mcp.call(&args.tool, call_args)?;
    effects.log(&result.pretty());
    Ok(())
}
