//! `qqdocs info <ref> [--json]` (src/index.ts cmdDocsInfo).

use super::{info_call, print_object, resolve_file_id, Effects};
use crate::args::{self, Flag, Spec};
use crate::env::{HandBack, Res};
use crate::json::Json;
use crate::mcp::Mcp;

pub struct Args {
    reference: String,
    json: bool,
}

pub fn parse(rest: &[String]) -> Option<Args> {
    let parsed = args::parse(rest, &Spec { options: &[], flags: &[Flag { long: "json", short: None }] })?;
    match parsed.positionals.as_slice() {
        [reference] => Some(Args { reference: reference.clone(), json: parsed.flag("json") }),
        _ => None,
    }
}

pub fn run(mcp: &Mcp, args: &Args, effects: &mut Effects) -> Res<()> {
    let file_id = resolve_file_id(mcp, &args.reference)?;
    let (tool, call_args) = info_call(&file_id);
    let info = mcp.call(tool, call_args)?;
    if args.json {
        effects.log(&info.pretty());
        return Ok(());
    }
    // `Object.entries(info)` of anything but an object is not reproduced.
    let Json::Obj(info) = info else { return Err(HandBack) };
    print_object(&info, effects);
    Ok(())
}
