//! `qqdocs read <ref>` and the document cache it keeps in
//! ~/.qqdocs/doc-cache.json (src/index.ts cmdDocsRead, getCachedDoc,
//! setCachedDoc).

use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

use super::{info_call, link, resolve_file_id, template, Effects};
use crate::args::{self, Spec};
use crate::env::{Env, HandBack, Res};
use crate::json::{self, Json, Object};
use crate::mcp::Mcp;

pub struct Args {
    reference: String,
}

pub fn parse(rest: &[String]) -> Option<Args> {
    let parsed = args::parse(rest, &Spec { options: &[], flags: &[] })?;
    match parsed.positionals.as_slice() {
        [reference] => Some(Args { reference: reference.clone() }),
        _ => None,
    }
}

/// A document to put into the cache once the command has succeeded.
pub struct Remember {
    file_id: String,
    content: String,
    info: Json,
}

/// `DOC_CACHE_TTL_MS`: five minutes.
const TTL_MS: f64 = 300_000.0;

fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|since| since.as_millis() as f64).unwrap_or(0.0)
}

pub fn run(env: &Env, mcp: &Mcp, args: &Args, effects: &mut Effects) -> Res<()> {
    let file_id = resolve_file_id(mcp, &args.reference)?;
    let (info, content) = match cached(env, &file_id)? {
        Some(entry) => entry,
        None => {
            // Before ~/.qqdocs exists the TypeScript cannot take the
            // counter's lock, and the counts of two calls made at the same
            // time overwrite each other. That first run is left to it.
            if mcp.calls() == 0 && !env.state_dir().is_dir() {
                return Err(HandBack);
            }
            // `Promise.all([getDocInfo(fileId).catch(() => null), readDoc(fileId)])`.
            // The TypeScript goes on without a title when the first fails;
            // here any failed call hands the command back.
            let get_content = ("get_content", json::object([("file_id", json::string(&file_id))]));
            let mut answers = mcp.call_together(vec![info_call(&file_id), get_content]).into_iter();
            let info = answers.next().ok_or(HandBack)??;
            let answer = answers.next().ok_or(HandBack)??;
            // `typeof r?.content !== "string"` is an error.
            let content = match &answer {
                Json::Obj(answer) => match answer.get("content") {
                    Some(Json::Str(content)) => content.clone(),
                    _ => return Err(HandBack),
                },
                _ => return Err(HandBack),
            };
            effects.remember = Some(Remember { file_id, content: content.clone(), info: info.clone() });
            (Some(info), content)
        }
    };
    // `info?.title ?? info?.file_name`, `info?.url ?? info?.file_url`
    let field = |first: &str, second: &str| {
        let Some(Json::Obj(info)) = &info else { return None };
        info.get(first).filter(|value| !matches!(value, Json::Null)).or_else(|| info.get(second))
    };
    if let (Some(title), Some(url)) = (field("title", "file_name"), field("url", "file_url")) {
        if title.truthy() && url.truthy() {
            effects.log(&format!("# {}\n", link(&template(Some(title))?, &template(Some(url))?)));
        }
    }
    effects.log(&content);
    Ok(())
}

/// `loadDocCache()`: the file as JSON, or nothing when it cannot be read as such.
fn load(env: &Env) -> Res<Option<Json>> {
    let Ok(bytes) = fs::read(env.state_file("doc-cache.json")) else { return Ok(None) };
    match json::parse(&String::from_utf8_lossy(&bytes)) {
        Ok(cache) => Ok(Some(cache)),
        Err(json::ParseError::Syntax) => Ok(None),
        Err(json::ParseError::Unsupported) => Err(HandBack),
    }
}

/// `getCachedDoc(fileId)`: the document's `info` and `content`, if it was
/// read less than five minutes ago.
fn cached(env: &Env, file_id: &str) -> Res<Option<(Option<Json>, String)>> {
    let cache = match load(env)? {
        None => return Ok(None),
        Some(Json::Obj(cache)) => cache,
        // Not what the TypeScript ever writes there.
        Some(_) => return Err(HandBack),
    };
    // Entries of another shape than the TypeScript writes make its
    // arithmetic do things that are not reproduced (when it prunes them, too).
    for (_, entry) in cache.entries() {
        if let Json::Obj(entry) = entry {
            if !matches!(entry.get("cachedAt"), None | Some(Json::Num(_))) {
                return Err(HandBack);
            }
        }
    }
    match cache.get(file_id) {
        None => Ok(None),
        Some(entry) if !entry.truthy() => Ok(None),
        Some(Json::Obj(entry)) => {
            let Some(Json::Num(cached_at)) = entry.get("cachedAt") else { return Err(HandBack) };
            if now_ms() - cached_at > TTL_MS {
                return Ok(None);
            }
            match entry.get("content") {
                Some(Json::Str(content)) => Ok(Some((entry.get("info").cloned(), content.clone()))),
                _ => Err(HandBack),
            }
        }
        Some(_) => Err(HandBack),
    }
}

/// `setCachedDoc(fileId, content, info).catch(() => {})`: failures are
/// ignored, as there.
pub fn remember(env: &Env, document: &Remember) {
    let mut cache = match load(env) {
        Ok(None) => Object::new(),
        Ok(Some(Json::Obj(cache))) => cache,
        // `Object.entries` or the assignment throws; nothing is written.
        _ => return,
    };
    let now = now_ms();
    // Entries older than five minutes go.
    for (id, entry) in cache.clone().entries() {
        match entry {
            // `entry.cachedAt` of null throws; nothing is written.
            Json::Null => return,
            Json::Obj(entry) => {
                if matches!(entry.get("cachedAt"), Some(Json::Num(cached_at)) if now - cached_at > TTL_MS) {
                    cache.remove(&id);
                }
            }
            _ => {}
        }
    }
    let entry = json::object([("content", json::string(&document.content)), ("info", document.info.clone()), ("cachedAt", Json::Num(now))]);
    cache.set(&document.file_id, entry);
    if fs::create_dir_all(env.state_dir()).is_ok() {
        let _ = fs::write(env.state_file("doc-cache.json"), Json::Obj(cache).pretty());
    }
}
