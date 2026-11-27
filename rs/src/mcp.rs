//! One MCP call: an HTTP POST with a JSON-RPC body (src/index.ts
//! fetchWithRetry, mcpRequest, mcpCall).
//!
//! The answer the TypeScript was written for is HTTP 2xx with a JSON object
//! that has no `error`. For everything else it throws, and what becomes of
//! that depends on who called:
//!
//! - Almost everywhere the error ends the command, and the TypeScript
//!   reports it in the words of its runtime, with a stack trace. Such a call
//!   is `HandBack`: the commands that run here only read, nothing has been
//!   printed or written yet, and the JavaScript does the work again.
//! - In two places the TypeScript catches the error and goes on: the dates
//!   of `ls --dates` (a date is left out) and the title of `read` (no title
//!   line). There the failure has to be the same one, after the same
//!   requests: `call_caught` says `Failed::Thrown` when it is, and makes the
//!   retries the TypeScript makes before it gives up.

use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

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

/// A call that gave no answer.
#[derive(Debug, PartialEq)]
pub enum Failed {
    /// `mcpCall` throws here in the TypeScript as well, having sent the same
    /// requests and counted the same calls.
    Thrown,
    /// Something this client does not reproduce (no connection, a redirect,
    /// an answer only JavaScript reads the same way).
    NotReproduced,
}

/// What to do about a status the TypeScript asks again for (`fetchWithRetry`).
#[derive(Clone, Copy, PartialEq)]
enum Retries {
    /// Leave them to the JavaScript: the first such answer hands back. Used
    /// where a call that fails in the end is reported by the TypeScript
    /// anyway, so that the service is asked once more and not four times.
    Left,
    /// Make them here, as the TypeScript does: up to four attempts.
    Made,
}

/// An HTTP answer: status, the `Retry-After` headers, the body if it could
/// be read as text.
struct Answer {
    status: u16,
    retry_after: Vec<String>,
    body: Option<String>,
}

/// `RETRYABLE_FETCH_STATUS_CODES`
const RETRYABLE: [u16; 7] = [408, 425, 429, 500, 502, 503, 504];
/// `DEFAULT_FETCH_RETRY_MAX_ATTEMPTS`
const MAX_ATTEMPTS: u32 = 4;

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

    /// `fetchWithRetry(url, init)`: the answer `mcpRequest` goes on with.
    fn fetch(&self, body: &str, retries: Retries) -> Result<Answer, Failed> {
        let mut attempt = 1;
        loop {
            // A fetch that fails is tried again by the TypeScript as well,
            // but which failures those are is its runtime's to say.
            let answer = self.post(body).map_err(|_| Failed::NotReproduced)?;
            if !RETRYABLE.contains(&answer.status) || attempt == MAX_ATTEMPTS {
                return Ok(answer);
            }
            if retries == Retries::Left {
                return Err(Failed::NotReproduced);
            }
            std::thread::sleep(retry_delay(attempt, &answer.retry_after).ok_or(Failed::NotReproduced)?);
            attempt += 1;
        }
    }

    /// `mcpRequest(url, method, params)`: `j.result`, which may be missing.
    fn request(&self, method: &str, params: Json, retries: Retries) -> Result<Option<Json>, Failed> {
        let body = json::object([("jsonrpc", json::string("2.0")), ("id", Json::Num(1.0)), ("method", json::string(method)), ("params", params)]);
        let answer = self.fetch(&body.compact(), retries)?;
        // fetch follows a redirect by rules of its own; 1xx is not an answer.
        if !(200..300).contains(&answer.status) && !(400..600).contains(&answer.status) {
            return Err(Failed::NotReproduced);
        }
        // `await res.text()`, then `parseJsonResponseBody(body)`.
        let text = answer.body.ok_or(Failed::NotReproduced)?;
        let parsed = match json::parse(&text) {
            Ok(parsed) => Some(parsed),
            Err(json::ParseError::Syntax) => None,
            Err(json::ParseError::Unsupported) => return Err(Failed::NotReproduced),
        };
        // `if (!res.ok) throw …`
        if !(200..300).contains(&answer.status) {
            return Err(Failed::Thrown);
        }
        // Anything but an object: "Invalid MCP response JSON".
        let Some(Json::Obj(answer)) = parsed else { return Err(Failed::Thrown) };
        // `if (j.error) throw …`
        if answer.get("error").is_some_and(Json::truthy) {
            return Err(Failed::Thrown);
        }
        Ok(answer.get("result").cloned())
    }

    /// `mcpListTools(url)`: `result?.tools ?? []`
    pub fn list_tools(&self) -> Res<Option<Json>> {
        let result = self.request("tools/list", Json::Obj(json::Object::new()), Retries::Left).map_err(|_| HandBack)?;
        Ok(match result {
            Some(Json::Obj(result)) => result.get("tools").filter(|tools| !matches!(tools, Json::Null)).cloned(),
            _ => None,
        })
    }

    /// `mcpCall(url, tool, args)`: the tool's answer, from
    /// `structuredContent` or from the JSON text in `content[0].text`.
    fn call_with(&self, tool: &str, args: Json, retries: Retries) -> Result<Json, Failed> {
        let params = json::object([("name", json::string(tool)), ("arguments", args)]);
        let result = self.request("tools/call", params, retries)?;
        // `await incrementUsage()`, before the answer is looked at.
        self.calls.fetch_add(1, Ordering::SeqCst);
        let result = match result {
            // `j.structuredContent` of undefined or null throws.
            None | Some(Json::Null) => return Err(Failed::Thrown),
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
                Some(_) => return Err(Failed::NotReproduced),
            },
            _ => "{}",
        };
        // Text that is not JSON: "returned non-JSON content".
        json::parse(text).map_err(|error| match error {
            json::ParseError::Syntax => Failed::Thrown,
            json::ParseError::Unsupported => Failed::NotReproduced,
        })
    }

    /// A call whose failure the TypeScript reports: any failure hands back.
    pub fn call(&self, tool: &str, args: Json) -> Res<Json> {
        self.call_with(tool, args, Retries::Left).map_err(|_| HandBack)
    }

    /// A call whose failure the TypeScript catches (`.catch(() => null)`,
    /// `Promise.allSettled`): `Failed::Thrown` is that failure.
    pub fn call_caught(&self, tool: &str, args: Json) -> Result<Json, Failed> {
        self.call_with(tool, args, Retries::Made)
    }

    /// Calls made at the same time (`Promise.all`, `Promise.allSettled`),
    /// answers in the same order. `caught` says for each call whether the
    /// TypeScript catches its failure.
    pub fn call_together(&self, calls: Vec<(&str, Json, bool)>) -> Vec<Result<Json, Failed>> {
        std::thread::scope(|scope| {
            let running: Vec<_> = calls
                .into_iter()
                .map(|(tool, args, caught)| scope.spawn(move || if caught { self.call_caught(tool, args) } else { self.call_with(tool, args, Retries::Left) }))
                .collect();
            running.into_iter().map(|call| call.join().unwrap_or(Err(Failed::NotReproduced))).collect()
        })
    }

    /// One POST: the status, and the body as text.
    #[cfg(feature = "net")]
    fn post(&self, body: &str) -> Res<Answer> {
        let mut response = self
            .agent
            .post(&self.url)
            .header("Content-Type", "application/json")
            .header("Authorization", &self.token)
            .send(body.as_bytes())
            .map_err(|_| HandBack)?;
        let status = response.status().as_u16();
        let retry_after = response.headers().get_all("retry-after").iter().map(|value| String::from_utf8_lossy(value.as_bytes()).into_owned()).collect();
        // `res.text()` has its own rules for bytes that are not UTF-8 and
        // for a byte order mark.
        let body = response
            .body_mut()
            .with_config()
            .limit(MAX_BODY)
            .read_to_vec()
            .ok()
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .filter(|text| !text.starts_with('\u{feff}'));
        Ok(Answer { status, retry_after, body })
    }

    #[cfg(not(feature = "net"))]
    fn post(&self, _body: &str) -> Res<Answer> {
        let _ = (&self.url, &self.token);
        Err(HandBack)
    }
}

/// `computeRetryDelayMs(attempt, { retryAfterHeader })`: the seconds the
/// service asked for, or half a second doubled with each attempt plus up to
/// a quarter of that at random. `None` for a `Retry-After` in a form only
/// JavaScript reads the same way (a date, several headers).
fn retry_delay(attempt: u32, retry_after: &[String]) -> Option<Duration> {
    match retry_after {
        [] => {}
        [value] => {
            let value = json::js_trim(value);
            if !value.is_empty() {
                // `/^\d+$/`, and few enough digits for a timer.
                if value.len() > 6 || !value.bytes().all(|b| b.is_ascii_digit()) {
                    return None;
                }
                return Some(Duration::from_secs(value.parse().ok()?));
            }
        }
        _ => return None,
    }
    let backoff = (500u64 << (attempt - 1)).min(10_000);
    let jitter_range = (backoff + 2) / 4; // Math.round(backoff * 0.25)
    // `Math.floor(Math.random() * (jitterRange + 1))`
    let random = std::hash::BuildHasher::hash_one(&std::collections::hash_map::RandomState::new(), attempt);
    Some(Duration::from_millis(backoff + random % (jitter_range + 1)))
}

/// Larger answers than this are left to the JavaScript.
#[cfg(feature = "net")]
const MAX_BODY: u64 = 256 * 1024 * 1024;

/// An HTTP client that does what `fetch` does for the plain case and nothing
/// of its own: no proxy from the environment (a machine with proxy variables
/// is handed back before this), no redirects followed (a redirect is handed
/// back), no status turned into an error.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_delays() {
        let header = |text: &str| vec![text.to_string()];
        assert_eq!(retry_delay(1, &header("0")), Some(Duration::ZERO));
        assert_eq!(retry_delay(3, &header(" 7 ")), Some(Duration::from_secs(7)));
        assert_eq!(retry_delay(1, &header("999999")), Some(Duration::from_secs(999_999)));
        // A date, a fraction, a sign, too many digits, two headers: JavaScript's to read.
        for odd in ["Wed, 21 Oct 2026 07:28:00 GMT", "1.5", "-1", "+1", "1000000", "1 2"] {
            assert_eq!(retry_delay(1, &header(odd)), None, "{odd}");
        }
        assert_eq!(retry_delay(1, &[String::from("1"), String::from("2")]), None);
        // No header, or an empty one: the back-off.
        for (attempt, base) in [(1, 500), (2, 1000), (3, 2000)] {
            for retry_after in [vec![], header(""), header("  ")] {
                let delay = retry_delay(attempt, &retry_after).unwrap().as_millis() as u64;
                assert!((base..=base + base / 4).contains(&delay), "{attempt}: {delay}");
            }
        }
    }
}
