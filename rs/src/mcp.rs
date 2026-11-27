//! One MCP call: an HTTP POST with a JSON-RPC body (src/index.ts mcpRequest,
//! mcpCall).
//!
//! Only the answer the TypeScript was written for is taken here: HTTP 2xx, a
//! JSON object without `error`. Everything else — no connection, another
//! status (which the TypeScript retries with a back-off, or reports), a body
//! that is not JSON, a JSON-RPC error — is reported by the TypeScript in the
//! words of its runtime, with a stack trace. Such a call is `HandBack`: the
//! commands that run here only read, nothing has been printed or written
//! yet, and the JavaScript does the work again.

use std::sync::atomic::{AtomicU32, Ordering};

use crate::env::{Env, HandBack, Res};
use crate::json::{self, Json};

pub struct Mcp {
    url: String,
    token: String,
    /// Successful `tools/call` requests: what `incrementUsage()` counts.
    calls: AtomicU32,
    #[cfg(feature = "net")]
    agent: ureq::Agent,
}

impl Mcp {
    /// A client for this machine's token. Without a usable token the
    /// TypeScript throws on its first request.
    pub fn new(env: &Env) -> Res<Mcp> {
        let token = env.token.clone().ok_or(HandBack)?;
        Ok(Mcp {
            url: env.endpoint.clone(),
            token,
            calls: AtomicU32::new(0),
            #[cfg(feature = "net")]
            agent: agent(),
        })
    }

    pub fn calls(&self) -> u32 {
        self.calls.load(Ordering::SeqCst)
    }

    /// `mcpRequest(url, method, params)`: `j.result`, which may be missing.
    fn request(&self, method: &str, params: Json) -> Res<Option<Json>> {
        let body = json::object([("jsonrpc", json::string("2.0")), ("id", Json::Num(1.0)), ("method", json::string(method)), ("params", params)]);
        let text = self.post(&body.compact())?;
        let Ok(Json::Obj(answer)) = json::parse(&text) else { return Err(HandBack) };
        if answer.get("error").is_some_and(Json::truthy) {
            return Err(HandBack);
        }
        Ok(answer.get("result").cloned())
    }

    /// `mcpListTools(url)`: `result?.tools ?? []`
    pub fn list_tools(&self) -> Res<Option<Json>> {
        let result = self.request("tools/list", Json::Obj(json::Object::new()))?;
        Ok(match result {
            Some(Json::Obj(result)) => result.get("tools").filter(|tools| !matches!(tools, Json::Null)).cloned(),
            _ => None,
        })
    }

    /// `mcpCall(url, tool, args)`: the tool's answer, from
    /// `structuredContent` or from the JSON text in `content[0].text`.
    pub fn call(&self, tool: &str, args: Json) -> Res<Json> {
        let params = json::object([("name", json::string(tool)), ("arguments", args)]);
        let result = self.request("tools/call", params)?;
        self.calls.fetch_add(1, Ordering::SeqCst);
        let result = match result {
            // `j.structuredContent` of undefined or null throws.
            None | Some(Json::Null) => return Err(HandBack),
            Some(Json::Obj(result)) => result,
            // No number, string or list has either property: `JSON.parse("{}")`.
            Some(_) => return Ok(Json::Obj(json::Object::new())),
        };
        if let Some(structured) = result.get("structuredContent") {
            return Ok(structured.clone());
        }
        // `j.content?.[0]?.text ?? "{}"`
        let first = match result.get("content") {
            Some(Json::Arr(items)) => items.first(),
            Some(Json::Obj(content)) => content.get("0"),
            // A string has a first character, which has no `text`.
            _ => None,
        };
        let text = match first {
            Some(Json::Obj(first)) => match first.get("text") {
                None | Some(Json::Null) => "{}",
                Some(Json::Str(text)) => text.as_str(),
                // JSON.parse turns anything else into a string first.
                Some(_) => return Err(HandBack),
            },
            _ => "{}",
        };
        json::parse(text).map_err(|_| HandBack)
    }

    /// Calls made at the same time (`Promise.all`), answers in the same order.
    pub fn call_together(&self, calls: Vec<(&str, Json)>) -> Vec<Res<Json>> {
        std::thread::scope(|scope| {
            let running: Vec<_> = calls.into_iter().map(|(tool, args)| scope.spawn(move || self.call(tool, args))).collect();
            running.into_iter().map(|call| call.join().unwrap_or(Err(HandBack))).collect()
        })
    }

    /// The body of a 2xx answer, as text.
    #[cfg(feature = "net")]
    fn post(&self, body: &str) -> Res<String> {
        let mut response = self
            .agent
            .post(&self.url)
            .header("Content-Type", "application/json")
            .header("Authorization", &self.token)
            .send(body.as_bytes())
            .map_err(|_| HandBack)?;
        if !response.status().is_success() {
            return Err(HandBack);
        }
        let bytes = response.body_mut().with_config().limit(MAX_BODY).read_to_vec().map_err(|_| HandBack)?;
        let text = String::from_utf8(bytes).map_err(|_| HandBack)?;
        // `res.text()` has its own rule for a byte order mark.
        if text.starts_with('\u{feff}') {
            return Err(HandBack);
        }
        Ok(text)
    }

    #[cfg(not(feature = "net"))]
    fn post(&self, _body: &str) -> Res<String> {
        let _ = (&self.url, &self.token);
        Err(HandBack)
    }
}

/// Larger answers than this are left to the JavaScript.
#[cfg(feature = "net")]
const MAX_BODY: u64 = 256 * 1024 * 1024;

/// An HTTP client that does what `fetch` does for the plain case and nothing
/// of its own: no proxy from the environment (a machine with proxy variables
/// is handed back before this), no redirects followed (a redirect is not a
/// 2xx answer, so it is handed back), no status turned into an error.
#[cfg(feature = "net")]
fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .http_status_as_error(false)
        .max_redirects(0)
        .proxy(None)
        .user_agent(concat!("qqdocs/", env!("CARGO_PKG_VERSION")))
        // bun gives up on a silent server after five minutes.
        .timeout_global(Some(std::time::Duration::from_secs(300)))
        .build()
        .new_agent()
}
