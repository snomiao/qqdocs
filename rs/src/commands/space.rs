//! `qqdocs space list` and `qqdocs space ls <space>` (src/index.ts
//! cmdSpaceList, cmdSpaceLs). The other `space` commands change something
//! and stay in the JavaScript.

use super::{perm::policy_label, prop, template, Effects};
use crate::args::{self, Flag, Kind, Opt, Spec};
use crate::env::{HandBack, Res};
use crate::json::{self, Json};
use crate::mcp::Mcp;

pub struct ListArgs {
    page: f64,
    scope: Option<f64>,
    order: Option<f64>,
    ascending: bool,
}

pub fn parse_list(rest: &[String]) -> Option<ListArgs> {
    const SPEC: Spec = Spec {
        options: &[
            Opt { long: "page", short: Some("p"), kind: Kind::Count },
            Opt { long: "scope", short: None, kind: Kind::Choice(&["all", "mine", "joined"]) },
            Opt { long: "order", short: None, kind: Kind::Choice(&["preview", "edited", "created"]) },
        ],
        flags: &[Flag { long: "asc", short: None }],
    };
    let parsed = args::parse(rest, &SPEC)?;
    let position = |words: &[&str], word: &str| words.iter().position(|w| *w == word).map(|i| i as f64);
    parsed.positionals.is_empty().then(|| ListArgs {
        page: parsed.count("page").unwrap_or(0.0),
        // normalizeSpaceListScope, normalizeSpaceListOrder
        scope: parsed.value("scope").and_then(|scope| position(&["all", "mine", "joined"], scope)),
        order: parsed.value("order").and_then(|order| position(&["preview", "edited", "created"], order)).map(|i| i + 1.0),
        ascending: parsed.flag("asc"),
    })
}

pub fn list(mcp: &Mcp, args: &ListArgs, effects: &mut Effects) -> Res<()> {
    let mut call_args = json::Object::new();
    call_args.set("num", Json::Num(args.page));
    if let Some(scope) = args.scope {
        call_args.set("query_by", Json::Num(scope));
    }
    if let Some(order) = args.order {
        call_args.set("order_by", Json::Num(order));
    }
    if args.ascending {
        call_args.set("descending", Json::Bool(false));
    }
    let result = mcp.call("query_space_list", Json::Obj(call_args))?;
    let spaces = match result.prop_nullish("spaces").map_err(|_| HandBack)? {
        None => Vec::new(),
        Some(Json::Arr(spaces)) => spaces.clone(),
        Some(_) => return Err(HandBack),
    };
    if spaces.is_empty() {
        effects.log("(no spaces)");
        return Ok(());
    }
    for space in &spaces {
        // `typeof space.policy === "number" ? describe(space.policy) : "unknown"`
        let policy = match prop(space, "policy")? {
            Some(policy @ Json::Num(_)) => policy_label(Some(policy))?,
            _ => "unknown",
        };
        let owner = if prop(space, "is_owner")?.is_some_and(Json::truthy) { "owner" } else { "member" };
        // `space.file_cnt ?? 0`
        let count = |key: &str| match space.prop_nullish(key).map_err(|_| HandBack)? {
            None => Ok("0".to_string()),
            Some(count) => template(Some(count)),
        };
        effects.log(&format!(
            "  [{policy:<16}] {}  {}  files={} members={} {owner}",
            template(prop(space, "title")?)?,
            template(prop(space, "space_id")?)?,
            count("file_cnt")?,
            count("member_cnt")?,
        ));
    }
    if prop(&result, "has_next")?.is_some_and(Json::truthy) {
        effects.log("  has_next: true");
    }
    Ok(())
}

pub struct LsArgs {
    space: String,
    parent: Option<String>,
    page: f64,
}

pub fn parse_ls(rest: &[String]) -> Option<LsArgs> {
    const SPEC: Spec = Spec {
        options: &[Opt { long: "parent", short: None, kind: Kind::Text }, Opt { long: "page", short: Some("p"), kind: Kind::Count }],
        flags: &[],
    };
    let parsed = args::parse(rest, &SPEC)?;
    match parsed.positionals.as_slice() {
        [space] => Some(LsArgs { space: space.clone(), parent: parsed.value("parent").map(String::from), page: parsed.count("page").unwrap_or(0.0) }),
        _ => None,
    }
}

pub fn ls(mcp: &Mcp, args: &LsArgs, effects: &mut Effects) -> Res<()> {
    let mut call_args = json::Object::new();
    call_args.set("space_id", json::string(&args.space));
    if let Some(parent) = &args.parent {
        call_args.set("parent_id", json::string(parent));
    }
    call_args.set("num", Json::Num(args.page));
    let result = mcp.call("query_space_node", Json::Obj(call_args))?;
    let nodes = match result.prop_nullish("children").map_err(|_| HandBack)? {
        None => Vec::new(),
        Some(Json::Arr(nodes)) => nodes.clone(),
        Some(_) => return Err(HandBack),
    };
    if nodes.is_empty() {
        effects.log("(no nodes)");
        return Ok(());
    }
    for node in &nodes {
        // describeSpaceNodeKind(node); `kind.padEnd` needs a string.
        let kind = match prop(node, "node_type")? {
            Some(Json::Str(kind)) if kind == "wiki_folder" => "folder".to_string(),
            Some(Json::Str(kind)) if kind == "wiki_file" => match prop(node, "doc_type")? {
                Some(doc_type) if doc_type.truthy() => doc_type.as_str().ok_or(HandBack)?.to_string(),
                _ => "file".to_string(),
            },
            Some(Json::Str(kind)) => kind.clone(),
            _ => return Err(HandBack),
        };
        let padding = " ".repeat(10usize.saturating_sub(json::js_len(&kind)));
        let suffix = if prop(node, "has_child")?.is_some_and(Json::truthy) { " +" } else { "" };
        let url = match prop(node, "url")? {
            Some(url) if url.truthy() => format!("  {}", template(Some(url))?),
            _ => String::new(),
        };
        effects.log(&format!("  [{kind}{padding}] {}{suffix}  {}{url}", template(prop(node, "title")?)?, template(prop(node, "node_id")?)?));
    }
    if prop(&result, "has_next")?.is_some_and(Json::truthy) {
        effects.log("  has_next: true");
    }
    Ok(())
}
