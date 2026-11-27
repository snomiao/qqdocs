//! `qqdocs perm get <ref>` (src/index.ts cmdDocsPermission). `perm set`
//! changes the document and stays in the JavaScript.

use super::{print_object, resolve_file_id, Effects};
use crate::args::{self, Spec};
use crate::env::{HandBack, Res, OBJECT_MEMBERS};
use crate::json::{self, Json};
use crate::mcp::Mcp;

pub struct Args {
    reference: String,
}

pub fn parse_get(rest: &[String]) -> Option<Args> {
    let parsed = args::parse(rest, &Spec { options: &[], flags: &[] })?;
    match parsed.positionals.as_slice() {
        [reference] => Some(Args { reference: reference.clone() }),
        _ => None,
    }
}

pub fn run(mcp: &Mcp, args: &Args, effects: &mut Effects) -> Res<()> {
    let file_id = resolve_file_id(mcp, &args.reference)?;
    let answer = mcp.call("manage.get_privilege", json::object([("file_id", json::string(&file_id))]))?;
    // `{ ...permission, policy: describeDocPermissionPolicy(permission.policy) }`
    let Json::Obj(mut permission) = answer else { return Err(HandBack) };
    let label = policy_label(permission.get("policy"))?;
    permission.set("policy", json::string(label));
    print_object(&permission, effects);
    Ok(())
}

/// `DOC_PERMISSION_LABELS[policy] ?? "unknown"`: the policy is used as a key
/// of an object, so the text "2" finds the same label as the number 2.
pub fn policy_label(policy: Option<&Json>) -> Res<&'static str> {
    let key = match policy {
        None => "undefined".to_string(),
        Some(policy) => policy.to_js_string().ok_or(HandBack)?,
    };
    Ok(match key.as_str() {
        "0" => "private",
        "1" => "partially shared",
        "2" => "link-read",
        "3" => "link-edit",
        key if OBJECT_MEMBERS.contains(&key) => return Err(HandBack),
        _ => "unknown",
    })
}
