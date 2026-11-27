//! `qqdocs tools [pattern]` (src/index.ts cmdTools, listTools).

use super::{prop, summarize, template, Effects};
use crate::args::{self, Spec};
use crate::env::{HandBack, Res};
use crate::json::{self, Json};
use crate::mcp::Mcp;

pub struct Args {
    pattern: Option<String>,
}

pub fn parse(rest: &[String]) -> Option<Args> {
    let parsed = args::parse(rest, &Spec { options: &[], flags: &[] })?;
    match parsed.positionals.as_slice() {
        [] => Some(Args { pattern: None }),
        [pattern] => Some(Args { pattern: Some(pattern.clone()) }),
        _ => None,
    }
}

pub fn run(mcp: &Mcp, args: &Args, effects: &mut Effects) -> Res<()> {
    let tools = match mcp.list_tools()? {
        None => Vec::new(),
        Some(Json::Arr(tools)) => tools,
        Some(_) => return Err(HandBack),
    };
    let mut shown = Vec::new();
    match &args.pattern {
        None => shown.extend(tools.iter()),
        Some(pattern) => {
            let wanted = json::js_lowercase(json::js_trim(pattern)).ok_or(HandBack)?;
            for tool in &tools {
                // `${t.name} ${t.description ?? ""}`
                let description = match tool.prop_nullish("description").map_err(|_| HandBack)? {
                    Some(description) => template(Some(description))?,
                    None => String::new(),
                };
                let text = format!("{} {description}", template(prop(tool, "name")?)?);
                if json::js_lowercase(&text).ok_or(HandBack)?.contains(&wanted) {
                    shown.push(tool);
                }
            }
        }
    }
    if shown.is_empty() {
        match &args.pattern {
            Some(pattern) => effects.log(&format!("(no tools matching \"{pattern}\")")),
            None => effects.log("(no tools)"),
        }
        return Ok(());
    }
    for tool in shown {
        // `summarizeText(tool.description ?? "")`: only a string has `replace`.
        let description = match tool.prop_nullish("description").map_err(|_| HandBack)? {
            None => "",
            Some(Json::Str(description)) => description.as_str(),
            Some(_) => return Err(HandBack),
        };
        effects.log(&format!("  {}  {}", template(prop(tool, "name")?)?, summarize(description)?));
    }
    Ok(())
}
