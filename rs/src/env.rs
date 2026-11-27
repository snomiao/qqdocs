//! The machine as the TypeScript finds it when it starts.
//!
//! bin/qqdocs.ts is run by bun, and what it sees is more than the environment
//! the command was started with:
//!
//! 1. bun, before the program starts, loads `.env.development.local`,
//!    `.env.local`, `.env.development` and `.env` from the current directory
//!    into `process.env` (variables already set win; among the files that
//!    order wins), and reads `bunfig.toml`.
//! 2. src/env.ts then reads `.env.local` beside the package, in its two
//!    parent directories, in the current directory and in `~/.qqdocs`, with a
//!    reader of its own, for the token only.
//! 3. src/config.ts reads the first `config.yaml` of four places with a YAML
//!    parser.
//!
//! `startup` reproduces these for the plain cases and returns `HandBack` for
//! every state it does not reproduce (a `.env` file in syntax bun interprets,
//! a YAML file that is more than `key: value` lines, proxy settings, a
//! terminal, …). It runs before anything is printed, sent or written.

use std::fs;
use std::io::{ErrorKind, IsTerminal};
use std::path::{Path, PathBuf};

use crate::json;

/// "Not mine": the invocation has to go to the JavaScript. Only ever returned
/// before the first output and the first change on disk.
#[derive(Debug, PartialEq)]
pub struct HandBack;

pub type Res<T> = Result<T, HandBack>;

/// Variable that replaces the address of the Tencent Docs MCP endpoint. The
/// TypeScript has no such thing (the address is a constant in src/index.ts);
/// this exists so that the parity cases can point the binary at a stand-in,
/// and it is honoured for `http://127.0.0.1:<port>/…` only.
pub const ENDPOINT_OVERRIDE: &str = "QQDOCS_PARITY_MCP_URL";
const ENDPOINT: &str = "https://docs.qq.com/openapi/mcp";

pub struct Env {
    /// `os.homedir()`
    pub home: String,
    /// `process.env.TENCENT_DOCS_TOKEN ?? env.TENCENT_DOCS_TOKEN`, if it is
    /// one a request can be made with.
    pub token: Option<String>,
    /// `config.tier`
    pub tier: Option<String>,
    pub endpoint: String,
}

/// Names for which a lookup in a plain JavaScript object answers with
/// something inherited from Object.prototype instead of an entry.
pub const OBJECT_MEMBERS: [&str; 12] = [
    "constructor",
    "toString",
    "toLocaleString",
    "valueOf",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "__proto__",
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
];

/// The files bun loads when NODE_ENV is unset, strongest first.
const BUN_DOTENV_FILES: [&str; 4] = [".env.development.local", ".env.local", ".env.development", ".env"];

const TOKEN: &str = "TENCENT_DOCS_TOKEN";

impl Env {
    pub fn startup() -> Res<Env> {
        // On a terminal the TypeScript prints links, colours and a list that
        // redraws itself. None of that can be compared by the parity runner.
        if std::io::stdout().is_terminal() || std::io::stderr().is_terminal() {
            return Err(HandBack);
        }
        for (name, _) in std::env::vars_os() {
            let Some(name) = name.to_str() else { continue };
            if steers_the_runtime(&name.to_ascii_uppercase()) {
                return Err(HandBack);
            }
        }
        local_zone_is_reproduced()?;
        let home = home_dir()?;
        let cwd = std::env::current_dir().map_err(|_| HandBack)?;
        let sep = std::path::MAIN_SEPARATOR;

        // bun reads bunfig.toml from the directory and from the user's
        // configuration; it can preload scripts and switch .env loading off.
        let mut bunfigs = vec![cwd.join("bunfig.toml"), PathBuf::from(format!("{home}{sep}.bunfig.toml"))];
        if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
            bunfigs.push(Path::new(&xdg).join(".bunfig.toml"));
        }
        if bunfigs.iter().any(|file| !absent(file)) {
            return Err(HandBack);
        }

        // 1. What bun adds to process.env. Every file has to be readable in
        //    the plain syntax, whether or not it holds the token: it may set
        //    anything.
        let mut token = match std::env::var_os(TOKEN) {
            Some(value) => Some(value.into_string().map_err(|_| HandBack)?),
            None => None,
        };
        for file in BUN_DOTENV_FILES {
            for (key, value) in read_plain_dotenv(&cwd.join(file))? {
                if key == TOKEN && token.is_none() {
                    token = Some(value);
                }
            }
        }

        // 2. src/env.ts. Beside the package and above it: not reproduced, a
        //    token there is for running from a checkout.
        if let Some(root) = crate::js_fallback::package_root() {
            let root = fs::canonicalize(root).map_err(|_| HandBack)?;
            for dir in root.ancestors().take(3) {
                if !absent(&dir.join(".env.local")) {
                    return Err(HandBack);
                }
            }
        }
        //    In the current directory: bun has read that file already, and in
        //    the plain syntax both readers find the same token or none. Then
        //    ~/.qqdocs/.env.local.
        let user_file = PathBuf::from(format!("{home}{sep}.qqdocs{sep}.env.local"));
        // existsSync, then readFileSync: a file that is there but cannot be
        // read (a directory, no permission) ends the TypeScript.
        if fs::metadata(&user_file).is_ok() {
            let text = String::from_utf8_lossy(&fs::read(&user_file).map_err(|_| HandBack)?).into_owned();
            if token.is_none() {
                token = token_of_env_local(&text);
            }
        }

        // 3. src/config.ts: the first file that exists is the configuration.
        let mut tier = None;
        for file in [
            cwd.join(".qqdocs").join("config.yaml"),
            cwd.join(".qqdocs.config.yaml"),
            PathBuf::from(format!("{home}{sep}.qqdocs{sep}config.yaml")),
            PathBuf::from(format!("{home}{sep}.qqdocs.config.yaml")),
        ] {
            if fs::metadata(&file).is_ok() {
                let bytes = fs::read(&file).map_err(|_| HandBack)?;
                tier = plain_config_tier(std::str::from_utf8(&bytes).map_err(|_| HandBack)?)?;
                break;
            }
        }

        Ok(Env { home, token: token.filter(|t| usable_token(t)), tier, endpoint: endpoint()? })
    }

    /// `~/.qqdocs`
    pub fn state_dir(&self) -> PathBuf {
        PathBuf::from(format!("{}{}.qqdocs", self.home, std::path::MAIN_SEPARATOR))
    }

    /// `~/.qqdocs/<name>`
    pub fn state_file(&self, name: &str) -> PathBuf {
        let sep = std::path::MAIN_SEPARATOR;
        PathBuf::from(format!("{}{sep}.qqdocs{sep}{name}", self.home))
    }
}

/// The address requests go to: the real one, or the stand-in of a parity run.
fn endpoint() -> Res<String> {
    let Some(value) = std::env::var_os(ENDPOINT_OVERRIDE) else {
        return Ok(ENDPOINT.to_string());
    };
    let value = value.into_string().unwrap_or_default();
    let on_this_machine = value
        .strip_prefix("http://127.0.0.1:")
        .and_then(|rest| rest.split_once('/'))
        .is_some_and(|(port, _)| !port.is_empty() && port.len() <= 5 && port.bytes().all(|b| b.is_ascii_digit()));
    if !on_this_machine {
        // Rust-only, like the variable itself. Not handed back: the
        // JavaScript does not know the variable and would call the real
        // service, which whoever set it did not want.
        eprintln!("qqdocs: {ENDPOINT_OVERRIDE} is for parity tests and must be http://127.0.0.1:<port>/<path>");
        std::process::exit(2);
    }
    Ok(value)
}

/// Variables that change what bun does before or underneath the program:
/// which files it loads, extra options, how `fetch` connects.
fn steers_the_runtime(upper_name: &str) -> bool {
    upper_name.starts_with("NODE_")
        // BUN_INSTALL is in every bun user's profile and only says where bun lives.
        || (upper_name.starts_with("BUN_") && !upper_name.starts_with("BUN_INSTALL"))
        || matches!(upper_name, "HTTP_PROXY" | "HTTPS_PROXY" | "ALL_PROXY" | "SSL_CERT_FILE" | "SSL_CERT_DIR")
}

/// Variables that would change how bun or the program behaves if a `.env`
/// file set them.
fn changes_the_runtime(key: &str) -> bool {
    let key = key.to_ascii_uppercase();
    matches!(key.as_str(), "HOME" | "USERPROFILE" | "PATH" | "TZ" | "TMPDIR" | "TEMP" | "TMP" | "NO_PROXY")
        || key.starts_with("XDG_")
        || key.starts_with("BUN_")
        || key.starts_with("QQDOCS_")
        || steers_the_runtime(&key)
}

/// The usage counter is kept per local day. JavaScript takes the zone from TZ
/// when that names one (anything else is UTC to bun) and from the system
/// otherwise; chrono reads the same two places, but not the same notations.
fn local_zone_is_reproduced() -> Res<()> {
    let Some(tz) = std::env::var_os("TZ") else { return Ok(()) };
    let tz = tz.into_string().map_err(|_| HandBack)?;
    if tz == "UTC" {
        return Ok(());
    }
    let is_zone_name = !tz.is_empty()
        && tz.split('/').all(|part| {
            part.starts_with(|c: char| c.is_ascii_alphabetic()) && part.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '+' | '-'))
        })
        && tz.contains('/');
    if cfg!(unix) && is_zone_name && Path::new("/usr/share/zoneinfo").join(&tz).is_file() {
        return Ok(());
    }
    Err(HandBack)
}

/// True when TZ is the one spelling that needs no zone file.
pub fn zone_is_utc() -> bool {
    std::env::var_os("TZ").is_some_and(|tz| tz == "UTC")
}

fn absent(path: &Path) -> bool {
    matches!(fs::symlink_metadata(path), Err(err) if matches!(err.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory))
}

/// `os.homedir()` where it is simply the variable; anything else goes back.
fn home_dir() -> Res<String> {
    let name = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    let home = std::env::var_os(name).ok_or(HandBack)?.into_string().map_err(|_| HandBack)?;
    let path = Path::new(&home);
    let plain = path.is_absolute()
        && path.components().all(|c| !matches!(c, std::path::Component::ParentDir | std::path::Component::CurDir));
    // Unix: must already be in the form node's path.resolve would give it.
    if !plain || (cfg!(unix) && (home.contains("//") || (home.len() > 1 && home.ends_with('/')) || home.contains("/./") || home.ends_with("/."))) {
        return Err(HandBack);
    }
    if cfg!(windows) && (home.contains('/') || home.ends_with('\\')) {
        return Err(HandBack);
    }
    Ok(home)
}

/// A token `fetch` sends as it stands: visible ASCII, blanks only inside.
/// (Empty is "not set" to the TypeScript; anything else is for the runtime's
/// header rules.)
fn usable_token(token: &str) -> bool {
    !token.is_empty() && token.bytes().all(|b| (0x20..=0x7e).contains(&b)) && !token.starts_with(' ') && !token.ends_with(' ')
}

/// src/env.ts on one file: the first line `TENCENT_DOCS_TOKEN=value` decides,
/// read with `/^([^#=]+)=(.*)$/` and both sides trimmed. Quotes stay.
fn token_of_env_local(text: &str) -> Option<String> {
    let text = text.replace('\r', "");
    for line in text.split('\n') {
        let Some((key, value)) = line.split_once('=') else { continue };
        // `[^#=]+` and `.*$`: no `#` before the `=`, and nothing after it
        // that `.` does not match.
        if key.is_empty() || key.contains('#') || value.contains(['\u{2028}', '\u{2029}']) {
            continue;
        }
        if json::js_trim(key) == TOKEN {
            return Some(json::js_trim(value).to_string());
        }
    }
    None
}

/// `config.tier`, if the file is YAML of the plainest kind: blank lines,
/// `#` lines, and `key: value` with a bare word on each side, no key twice.
/// `tier` has to be one of the three tiers. Everything else YAML can say
/// (quotes, lists, nesting, anchors, a tier that is a number or null) is left
/// to the YAML parser the TypeScript uses.
fn plain_config_tier(text: &str) -> Res<Option<String>> {
    let mut keys: Vec<&str> = Vec::new();
    let mut tier = None;
    for line in text.split('\n') {
        if line.is_empty() {
            continue;
        }
        if line.starts_with('#') {
            if line.chars().any(char::is_control) {
                return Err(HandBack);
            }
            continue;
        }
        let (key, value) = line.split_once(": ").ok_or(HandBack)?;
        let key_is_plain = key.starts_with(|c: char| c.is_ascii_alphabetic()) && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
        let value_is_plain = value.starts_with(|c: char| c.is_ascii_alphanumeric())
            && value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '/' | '-'));
        if !key_is_plain || !value_is_plain || keys.contains(&key) {
            return Err(HandBack);
        }
        keys.push(key);
        if key == "tier" {
            if !matches!(value, "free" | "member" | "plus") {
                return Err(HandBack);
            }
            tier = Some(value.to_string());
        }
    }
    Ok(tier)
}

// ── the files bun loads ──────────────────────────────────────────────────────

/// Reads one of the files bun loads, if it is written in the subset of bun's
/// syntax where a value is simply the text that stands there:
///
/// - blank lines, and lines starting with `#`;
/// - `KEY=value`: KEY made of letters, digits and `_`, no space before `=`.
///   The value runs to the end of the line or to the first `#`, without the
///   spaces and tabs around it;
/// - `KEY="value"` and `KEY='value'`: the text between the quotes, kept as it
///   is. After the closing quote only spaces and a `#` comment may follow.
///
/// A value, quoted or not, must hold no quote character, `$`, backslash
/// (inside quotes) or control character: those are where bun starts to
/// interpret (expansion, escapes, values over several lines). Anything else —
/// `export`, indentation, a line without `=`, a BOM, the same key twice in a
/// file, a variable that steers bun itself — is `HandBack`.
///
/// The rules were read off bun 1.4.0 for the genvx port and are held here by
/// the `token:` parity cases.
fn read_plain_dotenv(path: &Path) -> Res<Vec<(String, String)>> {
    let meta = match fs::metadata(path) {
        Ok(meta) => meta,
        Err(err) if matches!(err.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) => return Ok(Vec::new()),
        Err(_) => return Err(HandBack),
    };
    if !meta.is_file() {
        return Err(HandBack);
    }
    let bytes = fs::read(path).map_err(|_| HandBack)?;
    parse_plain_dotenv(std::str::from_utf8(&bytes).map_err(|_| HandBack)?)
}

const BLANKS: [char; 2] = [' ', '\t'];

/// True for text bun takes literally wherever it stands.
fn literal(text: &str) -> bool {
    text.chars().all(|c| !c.is_control() && !matches!(c, '"' | '\'' | '`' | '$') && (c == ' ' || !json::is_js_whitespace(c)))
}

/// The value bun gives to what follows `=` on a line.
fn plain_value(raw: &str) -> Res<&str> {
    let raw = raw.trim_start_matches(BLANKS);
    let (value, rest) = match raw.chars().next() {
        Some(quote @ ('"' | '\'')) => {
            let (inner, rest) = raw[1..].split_once(quote).ok_or(HandBack)?;
            if inner.contains('\\') {
                return Err(HandBack);
            }
            (inner, rest.trim_start_matches(BLANKS))
        }
        _ => match raw.find('#') {
            Some(at) => (raw[..at].trim_end_matches(BLANKS), &raw[at..]),
            None => (raw.trim_end_matches(BLANKS), ""),
        },
    };
    let rest_is_comment = rest.is_empty() || (rest.starts_with('#') && literal(rest) && !rest.contains('\\'));
    if literal(value) && rest_is_comment {
        Ok(value)
    } else {
        Err(HandBack)
    }
}

fn parse_plain_dotenv(text: &str) -> Res<Vec<(String, String)>> {
    let mut vars: Vec<(String, String)> = Vec::new();
    for line in text.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.contains('\r') {
            return Err(HandBack);
        }
        if line.trim_matches(BLANKS).is_empty() || line.starts_with('#') {
            continue;
        }
        let (key, raw) = line.split_once('=').ok_or(HandBack)?;
        let key_is_plain =
            key.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_') && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
        if !key_is_plain || changes_the_runtime(key) || vars.iter().any(|(k, _)| k.eq_ignore_ascii_case(key)) {
            return Err(HandBack);
        }
        vars.push((key.to_string(), plain_value(raw)?.to_string()));
    }
    Ok(vars)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pairs(list: &[(&str, &str)]) -> Res<Vec<(String, String)>> {
        Ok(list.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect())
    }

    #[test]
    fn plain_dotenv_lines_are_read() {
        assert_eq!(parse_plain_dotenv(""), pairs(&[]));
        assert_eq!(parse_plain_dotenv("A=1\nB=two words\n"), pairs(&[("A", "1"), ("B", "two words")]));
        assert_eq!(parse_plain_dotenv("# c\r\n\r\nA=1\r\nB= \t padded \t \r\nC="), pairs(&[("A", "1"), ("B", "padded"), ("C", "")]));
        for (line, value) in [("K=\"a b\"", "a b"), ("K='a # b'", "a # b"), ("K=a # c", "a"), ("K=a#c", "a"), ("K=\"x\" # c", "x")] {
            assert_eq!(parse_plain_dotenv(line), pairs(&[("K", value)]), "{line:?}");
        }
    }

    #[test]
    fn anything_bun_would_interpret_goes_back() {
        for text in [
            "A=$HOME/x", "A=\"a\\nb\"", "A=\"unterminated", "A=`x`", "A=it's", "export A=1", " A=1", "A =1", "A", "A.B=1", "A=1\nA=2",
            "\u{feff}A=1", "NODE_ENV=production", "BUN_ENV=test", "PATH=/x", "HOME=/x", "TZ=Asia/Tokyo", "https_proxy=http://x",
            "QQDOCS_NO_NATIVE=1", "NODE_TLS_REJECT_UNAUTHORIZED=0", "XDG_CONFIG_HOME=/x",
        ] {
            assert_eq!(parse_plain_dotenv(text), Err(HandBack), "{text:?}");
        }
    }

    #[test]
    fn env_local_is_read_like_src_env_ts() {
        assert_eq!(token_of_env_local("TENCENT_DOCS_TOKEN=abc\n"), Some("abc".to_string()));
        assert_eq!(token_of_env_local("# c\r\n  TENCENT_DOCS_TOKEN = \"a b\" \r\n"), Some("\"a b\"".to_string()));
        assert_eq!(token_of_env_local("TENCENT_DOCS_TOKEN=one\nTENCENT_DOCS_TOKEN=two"), Some("one".to_string()));
        assert_eq!(token_of_env_local("TENCENT_DOCS_TOKEN=a=b # c"), Some("a=b # c".to_string()));
        assert_eq!(token_of_env_local("\u{feff}TENCENT_DOCS_TOKEN=abc"), Some("abc".to_string()));
        assert_eq!(token_of_env_local("TENCENT_DOCS_TOKEN="), Some(String::new()));
        assert_eq!(token_of_env_local("export TENCENT_DOCS_TOKEN=abc"), None);
        assert_eq!(token_of_env_local("#TENCENT_DOCS_TOKEN=abc"), None);
        assert_eq!(token_of_env_local("TENCENT_DOCS_TOKEN"), None);
        assert_eq!(token_of_env_local("OTHER=1"), None);
    }

    #[test]
    fn only_the_plainest_yaml_is_read() {
        assert_eq!(plain_config_tier(""), Ok(None));
        assert_eq!(plain_config_tier("tier: member\n"), Ok(Some("member".to_string())));
        assert_eq!(plain_config_tier("# 配置\n\ndefaultPerm: link-read\ntier: plus"), Ok(Some("plus".to_string())));
        assert_eq!(plain_config_tier("defaultDocType: smartcanvas\n"), Ok(None));
        for text in [
            "tier: gold", "tier: 1", "tier: null", "tier: \"member\"", "tier:member", "tier:  member", "tier: member ", "tier: member # paid",
            " tier: member", "tier: member\r\n", "tier: free\ntier: plus", "a: [1]", "a:\n  b: c", "---\ntier: member", "\u{feff}tier: member",
            "a: b: c", "tier", "a: -", "a: ~",
        ] {
            assert_eq!(plain_config_tier(text), Err(HandBack), "{text:?}");
        }
    }

    #[test]
    fn tokens_a_request_can_carry() {
        assert!(usable_token("fake-token"));
        assert!(usable_token("Bearer abc"));
        assert!(!usable_token(""));
        assert!(!usable_token(" abc"));
        assert!(!usable_token("abc\t"));
        assert!(!usable_token("令牌"));
    }
}
