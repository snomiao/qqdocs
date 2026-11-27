//! JSON and strings with JavaScript's behaviour.
//!
//! The TypeScript reads everything with `JSON.parse` and writes it again with
//! `JSON.stringify` (requests, `--json` output, the files under ~/.qqdocs),
//! so what it sends and stores depends on what JavaScript does with JSON:
//! numbers become doubles and are written the JavaScript way (`1.0` is `1`,
//! `1e21` is `1e+21`), object keys that are array indices move to the front,
//! a repeated key keeps its first place and its last value. A general JSON
//! crate does none of that, so this is a small parser and printer of its own
//! (the same approach as the gchat-cli port), plus the JavaScript string
//! rules the commands rely on.

use std::collections::BTreeMap;
use std::fmt::Write as _;

#[derive(Clone, Debug, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Json>),
    Obj(Object),
}

/// A JavaScript object as `JSON.parse` builds it: keys that are array indices
/// first, in numeric order, then the others in the order they were added.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Object {
    index: BTreeMap<u32, Json>,
    named: Vec<(String, Json)>,
}

/// The number a key stands for if it is an array index: a canonical decimal
/// integer below 2^32 - 1.
fn array_index(key: &str) -> Option<u32> {
    let bytes = key.as_bytes();
    if bytes.is_empty() || bytes.len() > 10 || !bytes.iter().all(u8::is_ascii_digit) {
        return None;
    }
    if bytes.len() > 1 && bytes[0] == b'0' {
        return None;
    }
    key.parse::<u64>().ok().filter(|n| *n < u32::MAX as u64).map(|n| n as u32)
}

impl Object {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get(&self, key: &str) -> Option<&Json> {
        match array_index(key) {
            Some(i) => self.index.get(&i),
            None => self.named.iter().find(|(k, _)| k == key).map(|(_, v)| v),
        }
    }

    /// Sets a property. An existing key keeps its place.
    pub fn set(&mut self, key: &str, value: Json) {
        match array_index(key) {
            Some(i) => {
                self.index.insert(i, value);
            }
            None => match self.named.iter_mut().find(|(k, _)| k == key) {
                Some(slot) => slot.1 = value,
                None => self.named.push((key.to_string(), value)),
            },
        }
    }

    /// `delete object[key]`
    pub fn remove(&mut self, key: &str) {
        match array_index(key) {
            Some(i) => {
                self.index.remove(&i);
            }
            None => self.named.retain(|(k, _)| k != key),
        }
    }

    /// The properties in JavaScript's enumeration order.
    pub fn entries(&self) -> impl Iterator<Item = (String, &Json)> {
        self.index.iter().map(|(k, v)| (k.to_string(), v)).chain(self.named.iter().map(|(k, v)| (k.clone(), v)))
    }

    /// `Object.keys(object)`
    pub fn keys(&self) -> Vec<String> {
        self.entries().map(|(k, _)| k).collect()
    }

    pub fn is_empty(&self) -> bool {
        self.index.is_empty() && self.named.is_empty()
    }
}

/// Builds an object from pairs, like an object literal.
pub fn object<const N: usize>(pairs: [(&str, Json); N]) -> Json {
    let mut out = Object::new();
    for (key, value) in pairs {
        out.set(key, value);
    }
    Json::Obj(out)
}

pub fn string(text: &str) -> Json {
    Json::Str(text.to_string())
}

/// Reading a property of null, a TypeError in JavaScript.
#[derive(Debug, PartialEq)]
pub struct NullAccess;

impl Json {
    /// JavaScript truthiness.
    pub fn truthy(&self) -> bool {
        match self {
            Json::Null => false,
            Json::Bool(b) => *b,
            Json::Num(n) => *n != 0.0 && !n.is_nan(),
            Json::Str(s) => !s.is_empty(),
            Json::Arr(_) | Json::Obj(_) => true,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Json::Str(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_object(&self) -> Option<&Object> {
        match self {
            Json::Obj(o) => Some(o),
            _ => None,
        }
    }

    /// `value.key` for a key that no string, number or list has of its own.
    /// `Err` where JavaScript throws (a property of null); `None` for
    /// undefined.
    pub fn prop(&self, key: &str) -> Result<Option<&Json>, NullAccess> {
        match self {
            Json::Null => Err(NullAccess),
            Json::Obj(o) => Ok(o.get(key)),
            _ => Ok(None),
        }
    }

    /// `value.key` where a missing key and a null are the same (`??`, `?.`).
    pub fn prop_nullish(&self, key: &str) -> Result<Option<&Json>, NullAccess> {
        Ok(self.prop(key)?.filter(|v| !matches!(v, Json::Null)))
    }

    /// What a template literal makes of a value that is not a list or an
    /// object. (Those have their own rules, which nothing here needs: `None`.)
    pub fn to_js_string(&self) -> Option<String> {
        match self {
            Json::Null => Some("null".to_string()),
            Json::Bool(b) => Some(b.to_string()),
            Json::Num(n) => Some(number_to_string(*n)),
            Json::Str(s) => Some(s.clone()),
            Json::Arr(_) | Json::Obj(_) => None,
        }
    }

    /// `JSON.stringify(value)`
    pub fn compact(&self) -> String {
        let mut out = String::new();
        write_value(&mut out, self, None, 0);
        out
    }

    /// `JSON.stringify(value, null, 2)`
    pub fn pretty(&self) -> String {
        let mut out = String::new();
        write_value(&mut out, self, Some(2), 0);
        out
    }
}

// ── printing ─────────────────────────────────────────────────────────────────

fn write_value(out: &mut String, value: &Json, indent: Option<usize>, depth: usize) {
    let newline = |out: &mut String, depth: usize| {
        if let Some(width) = indent {
            out.push('\n');
            out.extend(std::iter::repeat_n(' ', width * depth));
        }
    };
    match value {
        Json::Null => out.push_str("null"),
        Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        // JSON has no Infinity; JSON.stringify writes null.
        Json::Num(n) if !n.is_finite() => out.push_str("null"),
        Json::Num(n) => out.push_str(&number_to_string(*n)),
        Json::Str(s) => write_string(out, s),
        Json::Arr(items) => {
            if items.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                newline(out, depth + 1);
                write_value(out, item, indent, depth + 1);
            }
            newline(out, depth);
            out.push(']');
        }
        Json::Obj(object) => {
            if object.is_empty() {
                out.push_str("{}");
                return;
            }
            out.push('{');
            for (i, (key, item)) in object.entries().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                newline(out, depth + 1);
                write_string(out, &key);
                out.push(':');
                if indent.is_some() {
                    out.push(' ');
                }
                write_value(out, item, indent, depth + 1);
            }
            newline(out, depth);
            out.push('}');
        }
    }
}

fn write_string(out: &mut String, text: &str) {
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// Number::toString of ECMAScript: the shortest digits that read back as the
/// same double, laid out by its rules for where the point and exponent go.
pub fn number_to_string(n: f64) -> String {
    if n.is_nan() {
        return "NaN".to_string();
    }
    if n == 0.0 {
        return "0".to_string();
    }
    if n.is_infinite() {
        return if n > 0.0 { "Infinity" } else { "-Infinity" }.to_string();
    }
    // The value is 0.d1d2…dk × 10^point.
    let (digits, point) = shortest_digits(n.abs());
    let k = digits.len() as i32;
    let mut out = String::new();
    if n < 0.0 {
        out.push('-');
    }
    if k <= point && point <= 21 {
        out.push_str(&digits);
        out.extend(std::iter::repeat_n('0', (point - k) as usize));
    } else if 0 < point && point <= 21 {
        out.push_str(&digits[..point as usize]);
        out.push('.');
        out.push_str(&digits[point as usize..]);
    } else if -6 < point && point <= 0 {
        out.push_str("0.");
        out.extend(std::iter::repeat_n('0', (-point) as usize));
        out.push_str(&digits);
    } else {
        let e = point - 1;
        out.push_str(&digits[..1]);
        if k > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        out.push('e');
        out.push(if e < 0 { '-' } else { '+' });
        out.push_str(&e.abs().to_string());
    }
    out
}

/// The digits ECMAScript writes for a positive, finite double, and where the
/// decimal point goes (the value is 0.d1d2…dk × 10^point). By its definition
/// (Number::toString, step 5): as few digits as read back as the same double;
/// of several such spellings the one closest to the double; and of two that
/// are equally close the one whose last digit is even.
///
/// Rust's own shortest formatting (`{:e}`) differs in that last rule, it
/// takes the upper of the two (1459077941253781.25 becomes …81.3 where
/// JavaScript writes …81.2). So this is worked out from the exact decimal
/// expansion instead of taken from there.
fn shortest_digits(x: f64) -> (String, i32) {
    // A whole number below 2^53 is its own shortest spelling: any other
    // decimal that close to it has more digits.
    if x < 9_007_199_254_740_992.0 && x.fract() == 0.0 {
        let text = (x as u64).to_string();
        return (text.trim_end_matches('0').to_string(), text.len() as i32);
    }
    // Every double is a decimal fraction of at most 767 significant digits,
    // and Rust writes as many digits as it is asked for exactly.
    let exact = format!("{x:.770e}");
    let (mantissa, exponent) = exact.split_once('e').expect("exponent form");
    let exact: Vec<u8> = mantissa.bytes().filter(u8::is_ascii_digit).collect();
    let exponent: i32 = exponent.parse().expect("exponent");
    let reads_back = |digits: &[u8], exponent: i32| {
        let text = format!("{}e{}", std::str::from_utf8(digits).expect("digits"), exponent - (digits.len() as i32 - 1));
        text.parse::<f64>() == Ok(x)
    };
    // With k digits there are two candidates, the expansion cut off after k
    // digits and the next number up. Seventeen digits always suffice.
    for k in 1..=17 {
        let (low, rest) = exact.split_at(k);
        if rest.iter().all(|digit| *digit == b'0') {
            return (String::from_utf8(low.to_vec()).expect("digits"), exponent + 1);
        }
        // The next number up; 99…9 becomes 1 with the exponent one higher.
        let mut high = low.to_vec();
        let mut high_exponent = exponent;
        match high.iter().rposition(|digit| *digit != b'9') {
            Some(at) => {
                high[at] += 1;
                high[at + 1..].fill(b'0');
            }
            None => {
                high = vec![b'1'];
                high_exponent += 1;
            }
        }
        let take_high = match (reads_back(low, exponent), reads_back(&high, high_exponent)) {
            (false, false) => continue,
            (true, false) => false,
            (false, true) => true,
            // Both read back: the closer one, and the even one on a tie.
            (true, true) => match rest[0].cmp(&b'5') {
                std::cmp::Ordering::Less => false,
                std::cmp::Ordering::Greater => true,
                std::cmp::Ordering::Equal => rest[1..].iter().any(|digit| *digit != b'0') || (low[k - 1] - b'0') % 2 == 1,
            },
        };
        let (digits, exponent) = if take_high { (high, high_exponent) } else { (low.to_vec(), exponent) };
        let digits = String::from_utf8(digits).expect("digits");
        return (digits.trim_end_matches('0').to_string(), exponent + 1);
    }
    unreachable!("seventeen digits identify every double")
}

/// `Math.round(x)`: halves go up, also below zero.
pub fn js_round(x: f64) -> f64 {
    let floor = x.floor();
    if x - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}

// ── parsing ──────────────────────────────────────────────────────────────────

#[derive(Debug, PartialEq)]
pub enum ParseError {
    /// Not JSON: `JSON.parse` throws a SyntaxError.
    Syntax,
    /// JSON that JavaScript accepts but this module does not reproduce (a
    /// surrogate escape without its pair, extreme nesting).
    Unsupported,
}

/// Nesting beyond this is left to the JavaScript rather than risking the stack.
const MAX_DEPTH: usize = 256;

/// `JSON.parse(text)`
pub fn parse(text: &str) -> Result<Json, ParseError> {
    let mut parser = Parser { bytes: text.as_bytes(), text, at: 0 };
    parser.whitespace();
    let value = parser.value(0)?;
    parser.whitespace();
    if parser.at != parser.bytes.len() {
        return Err(ParseError::Syntax);
    }
    Ok(value)
}

struct Parser<'a> {
    bytes: &'a [u8],
    text: &'a str,
    at: usize,
}

impl Parser<'_> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.at).copied()
    }

    fn whitespace(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.at += 1;
        }
    }

    fn literal(&mut self, word: &str, value: Json) -> Result<Json, ParseError> {
        if self.bytes[self.at..].starts_with(word.as_bytes()) {
            self.at += word.len();
            Ok(value)
        } else {
            Err(ParseError::Syntax)
        }
    }

    fn value(&mut self, depth: usize) -> Result<Json, ParseError> {
        if depth > MAX_DEPTH {
            return Err(ParseError::Unsupported);
        }
        match self.peek().ok_or(ParseError::Syntax)? {
            b'{' => {
                self.at += 1;
                let mut object = Object::new();
                self.whitespace();
                if self.peek() == Some(b'}') {
                    self.at += 1;
                    return Ok(Json::Obj(object));
                }
                loop {
                    self.whitespace();
                    if self.peek() != Some(b'"') {
                        return Err(ParseError::Syntax);
                    }
                    let key = self.string()?;
                    self.whitespace();
                    if self.peek() != Some(b':') {
                        return Err(ParseError::Syntax);
                    }
                    self.at += 1;
                    self.whitespace();
                    let value = self.value(depth + 1)?;
                    // `__proto__` is an ordinary key to JSON.parse, but not to
                    // the code that reads the object afterwards.
                    if key == "__proto__" {
                        return Err(ParseError::Unsupported);
                    }
                    object.set(&key, value);
                    self.whitespace();
                    match self.peek() {
                        Some(b',') => self.at += 1,
                        Some(b'}') => {
                            self.at += 1;
                            return Ok(Json::Obj(object));
                        }
                        _ => return Err(ParseError::Syntax),
                    }
                }
            }
            b'[' => {
                self.at += 1;
                let mut items = Vec::new();
                self.whitespace();
                if self.peek() == Some(b']') {
                    self.at += 1;
                    return Ok(Json::Arr(items));
                }
                loop {
                    self.whitespace();
                    items.push(self.value(depth + 1)?);
                    self.whitespace();
                    match self.peek() {
                        Some(b',') => self.at += 1,
                        Some(b']') => {
                            self.at += 1;
                            return Ok(Json::Arr(items));
                        }
                        _ => return Err(ParseError::Syntax),
                    }
                }
            }
            b'"' => self.string().map(Json::Str),
            b't' => self.literal("true", Json::Bool(true)),
            b'f' => self.literal("false", Json::Bool(false)),
            b'n' => self.literal("null", Json::Null),
            b'-' | b'0'..=b'9' => self.number(),
            _ => Err(ParseError::Syntax),
        }
    }

    fn number(&mut self) -> Result<Json, ParseError> {
        let start = self.at;
        let digits = |p: &mut Self| {
            let from = p.at;
            while matches!(p.peek(), Some(b'0'..=b'9')) {
                p.at += 1;
            }
            p.at - from
        };
        if self.peek() == Some(b'-') {
            self.at += 1;
        }
        match self.peek() {
            Some(b'0') => self.at += 1,
            Some(b'1'..=b'9') => {
                digits(self);
            }
            _ => return Err(ParseError::Syntax),
        }
        if self.peek() == Some(b'.') {
            self.at += 1;
            if digits(self) == 0 {
                return Err(ParseError::Syntax);
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.at += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.at += 1;
            }
            if digits(self) == 0 {
                return Err(ParseError::Syntax);
            }
        }
        // Correctly rounded, as in JavaScript; out of range becomes infinity.
        self.text[start..self.at].parse::<f64>().map(Json::Num).map_err(|_| ParseError::Syntax)
    }

    fn hex4(&mut self) -> Result<u32, ParseError> {
        let digits = self.bytes.get(self.at..self.at + 4).ok_or(ParseError::Syntax)?;
        let mut value = 0;
        for digit in digits {
            value = value * 16 + (*digit as char).to_digit(16).ok_or(ParseError::Syntax)?;
        }
        self.at += 4;
        Ok(value)
    }

    fn string(&mut self) -> Result<String, ParseError> {
        self.at += 1; // the opening quote
        let mut out = String::new();
        loop {
            let start = self.at;
            while matches!(self.peek(), Some(b) if b != b'"' && b != b'\\' && b >= 0x20) {
                self.at += 1;
            }
            out.push_str(&self.text[start..self.at]);
            match self.peek().ok_or(ParseError::Syntax)? {
                b'"' => {
                    self.at += 1;
                    return Ok(out);
                }
                b'\\' => {
                    self.at += 1;
                    let escape = self.peek().ok_or(ParseError::Syntax)?;
                    self.at += 1;
                    match escape {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let unit = self.hex4()?;
                            match unit {
                                0xd800..=0xdbff => {
                                    // A pair only if a low surrogate escape follows directly.
                                    if !self.bytes[self.at..].starts_with(b"\\u") {
                                        return Err(ParseError::Unsupported);
                                    }
                                    self.at += 2;
                                    let low = self.hex4()?;
                                    if !(0xdc00..=0xdfff).contains(&low) {
                                        return Err(ParseError::Unsupported);
                                    }
                                    let code = 0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00);
                                    out.push(char::from_u32(code).ok_or(ParseError::Syntax)?);
                                }
                                0xdc00..=0xdfff => return Err(ParseError::Unsupported),
                                unit => out.push(char::from_u32(unit).ok_or(ParseError::Syntax)?),
                            }
                        }
                        _ => return Err(ParseError::Syntax),
                    }
                }
                // A raw control character.
                _ => return Err(ParseError::Syntax),
            }
        }
    }
}

// ── JavaScript strings ───────────────────────────────────────────────────────

/// WhiteSpace and LineTerminator of ECMAScript: what `trim()` removes and
/// `\s` matches. (Not Rust's `char::is_whitespace`: U+FEFF is in, U+0085 out.)
pub fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{9}'..='\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// `text.trim()`
pub fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

/// `text.length`: UTF-16 code units.
pub fn js_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// `text.slice(0, end)` in UTF-16 code units, if the cut does not fall in the
/// middle of a character. (Half a character is something only JavaScript
/// strings can hold.)
pub fn js_prefix(text: &str, end: usize) -> Option<&str> {
    let mut units = 0;
    for (at, c) in text.char_indices() {
        if units == end {
            return Some(&text[..at]);
        }
        units += c.len_utf16();
        if units > end {
            return None;
        }
    }
    Some(text)
}

/// `text.replace(/\s+/g, " ").trim()`
pub fn collapse_whitespace(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_space = false;
    for c in text.chars() {
        if is_js_whitespace(c) {
            in_space = true;
        } else {
            if in_space && !out.is_empty() {
                out.push(' ');
            }
            in_space = false;
            out.push(c);
        }
    }
    out
}

/// `text.toLowerCase()` for text whose lower case is not in doubt: ASCII, and
/// characters that have no case at all (Chinese, digits, punctuation). `None`
/// for any other cased character, where JavaScript's tables decide.
pub fn js_lowercase(text: &str) -> Option<String> {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if c.is_ascii() {
            out.push(c.to_ascii_lowercase());
        } else if c.is_lowercase() || c.is_uppercase() || c.to_lowercase().next() != Some(c) || c.to_uppercase().next() != Some(c) {
            return None;
        } else {
            out.push(c);
        }
    }
    Some(out)
}

/// Order of `Array.prototype.sort()` without a comparator: by UTF-16 code units.
pub fn js_compare(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_print_like_javascript() {
        for (n, text) in [
            (1.0, "1"),
            (1.5, "1.5"),
            (1e21, "1e+21"),
            (1e-7, "1e-7"),
            (-0.0, "0"),
            (12345678901234567890.0, "12345678901234567000"),
            (0.1, "0.1"),
            (5e-324, "5e-324"),
            (1.7976931348623157e308, "1.7976931348623157e+308"),
            (123456789012345680000.0, "123456789012345680000"),
            (0.000001, "0.000001"),
            (1.23e-18, "1.23e-18"),
            (9007199254740993.0, "9007199254740992"),
            (1e20, "100000000000000000000"),
            (-1e-7, "-1e-7"),
            (0.30000000000000004, "0.30000000000000004"),
            (-25.0, "-25"),
            (123.456, "123.456"),
            (9007199254740992.0, "9007199254740992"),
            (9007199254740994.0, "9007199254740994"),
            (1152921504606846976.0, "1152921504606847000"),
            (1e23, "1e+23"),
            (2.2250738585072014e-308, "2.2250738585072014e-308"),
            (4.35, "4.35"),
            (100.0, "100"),
            (0.5, "0.5"),
        ] {
            assert_eq!(number_to_string(n), text);
        }
    }

    /// Doubles that lie exactly between two spellings of the shortest length:
    /// JavaScript writes the one whose last digit is even. (Rust's `{:e}`
    /// writes the upper one, e.g. …81.3 for the first.)
    #[test]
    fn a_tie_between_two_spellings_goes_to_the_even_digit() {
        for (exact, text) in [
            ("1459077941253781.25", "1459077941253781.2"),
            ("172237639781087.625", "172237639781087.62"),
            ("-951257392298430.25", "-951257392298430.2"),
            ("247750044800341.125", "247750044800341.12"),
            ("1262661521323025.25", "1262661521323025.2"),
            ("1037828712724149.25", "1037828712724149.2"),
            ("1132576346863060.25", "1132576346863060.2"),
            // The upper one is the even one here.
            ("1459077941253781.75", "1459077941253781.8"),
            ("172237639781087.375", "172237639781087.38"),
            // Not a tie: the closer one.
            ("1459077941253781.5", "1459077941253781.5"),
            ("0.15", "0.15"),
        ] {
            let n: f64 = exact.parse().unwrap();
            assert_eq!(number_to_string(n), text);
            assert_eq!(parse(text), Ok(Json::Num(n)), "{text} reads back");
            assert_eq!(parse(exact).map(|value| value.compact()).as_deref(), Ok(text));
        }
    }

    #[test]
    fn keys_keep_javascript_order() {
        let value = parse(r#"{"b":1,"10":2,"2":3,"a":4,"01":5,"4294967295":8,"b":9}"#).unwrap();
        assert_eq!(value.compact(), r#"{"2":3,"10":2,"b":9,"a":4,"01":5,"4294967295":8}"#);
    }

    #[test]
    fn rejects_what_json_parse_rejects() {
        for text in ["", "{\"a\":1,}", "[01]", "+1", "NaN", "{'a':1}", "\"a\tb\"", "1 2", "\u{feff}1", "[1,]", "1.", ".5", "1e", "\"\\x41\"", "nul"] {
            assert_eq!(parse(text), Err(ParseError::Syntax), "{text:?}");
        }
    }

    #[test]
    fn surrogates() {
        assert_eq!(parse(r#""\ud83d\ude00""#), Ok(string("😀")));
        assert_eq!(parse(r#""\ud800x""#), Err(ParseError::Unsupported));
        assert_eq!(parse(r#""\ud800\u0041""#), Err(ParseError::Unsupported));
        assert_eq!(parse(r#""\udc00""#), Err(ParseError::Unsupported));
        assert_eq!(parse(r#"{"__proto__":1}"#), Err(ParseError::Unsupported));
    }

    #[test]
    fn pretty_printing() {
        let value = parse(r#"{"a":[1,{"b":null}],"c":{},"d":[],"e":"x\ny"}"#).unwrap();
        assert_eq!(value.pretty(), "{\n  \"a\": [\n    1,\n    {\n      \"b\": null\n    }\n  ],\n  \"c\": {},\n  \"d\": [],\n  \"e\": \"x\\ny\"\n}");
    }

    #[test]
    fn javascript_strings() {
        assert_eq!(js_len("a😀"), 3);
        assert_eq!(js_prefix("a😀b", 3), Some("a😀"));
        assert_eq!(js_prefix("a😀b", 2), None);
        assert_eq!(js_prefix("ab", 5), Some("ab"));
        assert_eq!(js_trim("\u{feff}\u{a0} x \u{3000}\n"), "x");
        assert_eq!(collapse_whitespace("  a \n\t b\u{3000}c  "), "a b c");
        assert_eq!(js_lowercase("Hello 世界 1!"), Some("hello 世界 1!".to_string()));
        assert_eq!(js_lowercase("É"), None);
        assert_eq!(js_lowercase("ß"), None);
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!(js_round(0.49999999999999994), 0.0);
        assert_eq!(js_round(79.5), 80.0);
    }
}
