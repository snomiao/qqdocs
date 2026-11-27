//! Recognizes the command lines Rust runs itself.
//!
//! The TypeScript parses its arguments with yargs, which accepts far more
//! spellings than anyone types (`--no-json`, `-n5`, `--count=0x10`, options
//! given twice that turn into lists) and answers mistakes with its own,
//! localized text. This is not a second yargs. It accepts the plain spellings
//! whose meaning is not in doubt and returns `None` for everything else, and
//! the caller then hands the invocation back to the JavaScript untouched.

pub enum Kind {
    /// One of a fixed set of words.
    Choice(&'static [&'static str]),
    /// A whole number, written plainly: `0`, `25`.
    Count,
    /// Any text.
    Text,
}

/// An option that takes a value.
pub struct Opt {
    pub long: &'static str,
    pub short: Option<&'static str>,
    pub kind: Kind,
}

/// An option that is on when present.
pub struct Flag {
    pub long: &'static str,
    pub short: Option<&'static str>,
}

pub struct Spec {
    pub options: &'static [Opt],
    pub flags: &'static [Flag],
}

pub struct Parsed {
    pub positionals: Vec<String>,
    values: Vec<(&'static str, String)>,
    flags: Vec<&'static str>,
}

impl Parsed {
    pub fn value(&self, long: &str) -> Option<&str> {
        self.values.iter().find(|(name, _)| *name == long).map(|(_, value)| value.as_str())
    }

    /// The value of a `Kind::Count` option.
    pub fn count(&self, long: &str) -> Option<f64> {
        self.value(long).and_then(|value| value.parse::<u32>().ok()).map(f64::from)
    }

    pub fn flag(&self, long: &str) -> bool {
        self.flags.contains(&long)
    }
}

fn is_count(text: &str) -> bool {
    (1..=9).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_digit()) && (text == "0" || !text.starts_with('0'))
}

fn fits(kind: &Kind, value: &str) -> bool {
    match kind {
        Kind::Choice(words) => words.contains(&value),
        Kind::Count => is_count(value),
        Kind::Text => true,
    }
}

/// The arguments after the command name, if they are in the plain form:
/// positionals that do not start with a dash, `--name value`, `--name=value`,
/// `-n value`, `--flag`, `-f`, each option once.
pub fn parse(rest: &[String], spec: &Spec) -> Option<Parsed> {
    let mut parsed = Parsed { positionals: Vec::new(), values: Vec::new(), flags: Vec::new() };
    let mut i = 0;
    while i < rest.len() {
        let token = rest[i].as_str();
        i += 1;
        if token.is_empty() {
            return None;
        }
        if !token.starts_with('-') {
            parsed.positionals.push(token.to_string());
            continue;
        }
        let (name, inline, is_long) = match token.strip_prefix("--") {
            Some(long) => match long.split_once('=') {
                Some((name, value)) => (name, Some(value), true),
                None => (long, None, true),
            },
            None => (&token[1..], None, false),
        };
        let names = |long: &'static str, short: Option<&'static str>| if is_long { long == name } else { short == Some(name) };
        if let Some(flag) = spec.flags.iter().find(|f| names(f.long, f.short)) {
            // yargs reads a following `true`/`false` as the flag's value.
            if inline.is_some() || parsed.flags.contains(&flag.long) || matches!(rest.get(i).map(String::as_str), Some("true" | "false")) {
                return None;
            }
            parsed.flags.push(flag.long);
            continue;
        }
        let option = spec.options.iter().find(|o| names(o.long, o.short))?;
        let value = match inline {
            Some(value) => value,
            None => {
                let value = rest.get(i)?.as_str();
                i += 1;
                // A value that starts with a dash is an option to yargs.
                if value.starts_with('-') {
                    return None;
                }
                value
            }
        };
        // yargs strips a pair of quotes from an option's value.
        if value.is_empty() || value.starts_with(['"', '\'']) || !fits(&option.kind, value) || parsed.value(option.long).is_some() {
            return None;
        }
        parsed.values.push((option.long, value.to_string()));
    }
    Some(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SPEC: Spec = Spec {
        options: &[
            Opt { long: "count", short: Some("n"), kind: Kind::Count },
            Opt { long: "tier", short: None, kind: Kind::Choice(&["free", "member", "plus"]) },
            Opt { long: "parent", short: None, kind: Kind::Text },
        ],
        flags: &[Flag { long: "json", short: None }, Flag { long: "dates", short: Some("d") }],
    };

    fn parse_words(words: &[&str]) -> Option<Parsed> {
        parse(&words.iter().map(|w| w.to_string()).collect::<Vec<_>>(), &SPEC)
    }

    #[test]
    fn takes_the_plain_spellings() {
        let p = parse_words(&["root", "-n", "5", "--tier=plus", "--json", "two words", "--parent", "1e5", "-d"]).unwrap();
        assert_eq!(p.positionals, ["root", "two words"]);
        assert_eq!(p.count("count"), Some(5.0));
        assert_eq!(p.value("tier"), Some("plus"));
        assert_eq!(p.value("parent"), Some("1e5"));
        assert!(p.flag("json") && p.flag("dates"));
        assert_eq!(parse_words(&["--count=0"]).unwrap().count("count"), Some(0.0));
        assert!(!parse_words(&[]).unwrap().flag("json"));
    }

    #[test]
    fn leaves_everything_else_to_yargs() {
        for words in [
            &["--help"][..],
            &["-h"],
            &["--version"],
            &["--unknown"],
            &["-n5"],
            &["-n=5"],
            &["--n", "5"],
            &["-count", "5"],
            &["--count", "abc"],
            &["--count", "1e3"],
            &["--count", "05"],
            &["--count", "-1"],
            &["--count", "1.5"],
            &["--count", "1234567890"],
            &["--count"],
            &["--count=5", "-n", "6"],
            &["--tier", "gold"],
            &["--tier=\"plus\""],
            &["--parent", "-x"],
            &["--parent="],
            &["--parent", "'x'"],
            &["--json", "true"],
            &["--json=true"],
            &["--no-json"],
            &["--json", "--json"],
            &["--dates", "-d"],
            &["--d"],
            &["-json"],
            &["--"],
            &["-"],
            &[""],
            &["-x"],
        ] {
            assert!(parse_words(words).is_none(), "{words:?}");
        }
    }
}
