//! The call counter in ~/.qqdocs/usage.json (src/index.ts "Usage tracking").
//!
//! Every successful `tools/call` adds one to today's and this month's count;
//! `usage` shows them against the tier's quota, and every other command ends
//! with a warning once 80% of the day is used.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use crate::env::{Env, HandBack, Res};
use crate::json::{self, Json, Object};

pub struct Limits {
    pub daily: f64,
    pub monthly: f64,
    pub name: &'static str,
}

/// `TIER_LIMITS[tier] ?? TIER_LIMITS.free`, for the tiers there are.
pub fn limits(tier: &str) -> Limits {
    match tier {
        "member" => Limits { daily: 1000.0, monthly: 20000.0, name: "member" },
        "plus" => Limits { daily: 2000.0, monthly: 20000.0, name: "member plus" },
        _ => Limits { daily: 100.0, monthly: 20000.0, name: "free" },
    }
}

fn rank(tier: &str) -> u8 {
    match tier {
        "member" => 1,
        "plus" => 2,
        _ => 0,
    }
}

fn infer_tier(count: f64) -> &'static str {
    if count > 1000.0 {
        "plus"
    } else if count > 100.0 {
        "member"
    } else {
        "free"
    }
}

/// `localDateStr()`: today in the local zone, as `YYYY-MM-DD`.
pub fn today_key() -> String {
    if crate::env::zone_is_utc() {
        chrono::Utc::now().format("%Y-%m-%d").to_string()
    } else {
        chrono::Local::now().format("%Y-%m-%d").to_string()
    }
}

pub fn month_key(today: &str) -> String {
    today.chars().take(7).collect()
}

/// The counter file as the TypeScript's arithmetic expects it.
#[derive(Clone)]
pub struct Usage {
    data: Object,
}

/// What `loadUsage()` gives.
pub enum Loaded {
    /// A file of the expected shape, or none (missing, unreadable, not JSON).
    Usable(Usage),
    /// JSON of another shape. The TypeScript then fails or computes with
    /// whatever is there (a string count gets a "1" appended); not reproduced.
    Odd,
}

pub fn path(env: &Env) -> PathBuf {
    env.state_file("usage.json")
}

pub fn load(path: &Path) -> Loaded {
    let fresh = || {
        let mut data = Object::new();
        data.set("daily", Json::Obj(Object::new()));
        data.set("monthly", Json::Obj(Object::new()));
        Loaded::Usable(Usage { data })
    };
    let Ok(bytes) = fs::read(path) else { return fresh() };
    let data = match json::parse(&String::from_utf8_lossy(&bytes)) {
        Ok(Json::Obj(data)) => data,
        Ok(_) | Err(json::ParseError::Unsupported) => return Loaded::Odd,
        Err(json::ParseError::Syntax) => return fresh(),
    };
    let today = today_key();
    let month = month_key(&today);
    let count_is_plain = |group: &str, key: &str| match data.get(group) {
        Some(Json::Obj(counts)) => matches!(counts.get(key), None | Some(Json::Null) | Some(Json::Num(_))),
        _ => false,
    };
    let tier_is_plain = match data.get("inferredTier") {
        None | Some(Json::Null) => true,
        Some(Json::Str(tier)) => matches!(tier.as_str(), "free" | "member" | "plus"),
        Some(_) => false,
    };
    if count_is_plain("daily", &today) && count_is_plain("monthly", &month) && tier_is_plain {
        Loaded::Usable(Usage { data })
    } else {
        Loaded::Odd
    }
}

impl Usage {
    fn count(&self, group: &str, key: &str) -> f64 {
        match self.data.get(group).and_then(Json::as_object).and_then(|counts| counts.get(key)) {
            Some(Json::Num(n)) => *n,
            _ => 0.0,
        }
    }

    fn set_count(&mut self, group: &str, key: &str, value: f64) {
        let mut counts = self.data.get(group).and_then(Json::as_object).cloned().unwrap_or_default();
        counts.set(key, Json::Num(value));
        self.data.set(group, Json::Obj(counts));
    }

    /// `data.daily[todayKey()] ?? 0`
    pub fn today(&self) -> f64 {
        self.count("daily", &today_key())
    }

    pub fn this_month(&self) -> f64 {
        self.count("monthly", &month_key(&today_key()))
    }

    /// `data.inferredTier`, when it is set.
    pub fn inferred_tier(&self) -> Option<&str> {
        self.data.get("inferredTier").and_then(Json::as_str)
    }

    fn raise_tier_for(&mut self, count: f64) {
        let observed = infer_tier(count);
        if rank(observed) > rank(self.inferred_tier().unwrap_or("free")) {
            self.data.set("inferredTier", json::string(observed));
        }
    }

    /// The body of `incrementUsage()`.
    fn increment(&mut self) {
        let today = today_key();
        let month = month_key(&today);
        let day_count = self.count("daily", &today) + 1.0;
        self.set_count("daily", &today, day_count);
        self.set_count("monthly", &month, self.count("monthly", &month) + 1.0);
        // The tier is inferred from the count and never goes down.
        self.raise_tier_for(day_count);
        // Keep the last 7 days and the last 3 months.
        self.keep_last("daily", 7);
        self.keep_last("monthly", 3);
    }

    fn keep_last(&mut self, group: &str, count: usize) {
        let counts = self.data.get(group).and_then(Json::as_object).cloned().unwrap_or_default();
        let mut keys = counts.keys();
        keys.sort_by(|a, b| json::js_compare(a, b));
        let mut kept = Object::new();
        for key in &keys[keys.len().saturating_sub(count)..] {
            kept.set(key, counts.get(key).cloned().unwrap_or(Json::Null));
        }
        self.data.set(group, Json::Obj(kept));
    }

    /// The body of `cmdDocsUsageCalibrate()`, up to the file being written.
    pub fn calibrate(&mut self, today_count: Option<f64>, month_count: Option<f64>, tier: Option<&str>) {
        let today = today_key();
        let month = month_key(&today);
        if let Some(value) = today_count {
            let delta = value - self.count("daily", &today);
            self.set_count("daily", &today, value);
            if month_count.is_none() {
                self.set_count("monthly", &month, (self.count("monthly", &month) + delta).max(0.0));
            }
        }
        if let Some(value) = month_count {
            self.set_count("monthly", &month, value);
        }
        if let Some(tier) = tier {
            self.data.set("inferredTier", json::string(tier));
        }
        if today_count.is_some() && tier.is_none() {
            self.raise_tier_for(self.count("daily", &today));
        }
    }

    pub fn write(&self, env: &Env) -> std::io::Result<()> {
        fs::create_dir_all(env.state_dir())?;
        fs::write(path(env), Json::Obj(self.data.clone()).pretty())
    }
}

/// `withUsageLock()`: a lock file beside the counter, taken by creating it.
/// One older than five seconds is from a process that died; a live one is
/// waited for, two seconds at most.
///
/// The TypeScript also waits those two seconds when the file cannot be
/// created at all (the first call ever, before ~/.qqdocs exists). Nothing is
/// being waited for then, and this does not.
pub fn with_lock<T>(env: &Env, body: impl FnOnce() -> T) -> T {
    let lock = env.state_file("usage.json.lock");
    if let Ok(meta) = fs::metadata(&lock) {
        let age = meta.modified().ok().and_then(|at| SystemTime::now().duration_since(at).ok());
        if age.is_some_and(|age| age > Duration::from_millis(5000)) {
            let _ = fs::remove_file(&lock);
        }
    }
    let deadline = Instant::now() + Duration::from_millis(2000);
    loop {
        match fs::OpenOptions::new().write(true).create_new(true).open(&lock) {
            Ok(_) => break,
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists && Instant::now() <= deadline => {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(_) => break,
        }
    }
    let value = body();
    let _ = fs::remove_file(&lock);
    value
}

/// `incrementUsage().catch(() => {})`, once per call made. Failures are
/// ignored, as there.
pub fn record_calls(env: &Env, calls: u32) {
    for _ in 0..calls {
        with_lock(env, || {
            if let Loaded::Usable(mut usage) = load(&path(env)) {
                usage.increment();
                let _ = usage.write(env);
            }
        });
    }
}

/// `progressBar(used, total)`
fn progress_bar(used: f64, total: f64) -> Res<String> {
    let filled = json::js_round((used / total).min(1.0) * 20.0);
    // A negative count makes `"█".repeat()` throw.
    if filled < 0.0 {
        return Err(HandBack);
    }
    let filled = filled as usize;
    Ok(format!("[{}{}]", "█".repeat(filled), "░".repeat(20 - filled)))
}

fn percent(ratio: f64) -> String {
    format!("{}%", json::number_to_string(json::js_round(ratio * 100.0)))
}

/// `formatUsageLines()` where standard output is not a terminal (no colours).
pub fn lines(usage: &Usage, limits: &Limits) -> Res<[String; 2]> {
    let day = usage.today();
    let month = usage.this_month();
    let n = json::number_to_string;
    Ok([
        format!(
            "  Today  {}  {}/{}  {}  ({} tier)",
            progress_bar(day, limits.daily)?,
            n(day),
            n(limits.daily),
            percent(day / limits.daily),
            limits.name
        ),
        format!("  Month  {}  {}/{}  {}", progress_bar(month, limits.monthly)?, n(month), n(limits.monthly), percent(month / limits.monthly)),
    ])
}

/// `printUsageWarningIfNeeded(config.tier)` where standard error is not a
/// terminal: what it writes there, if anything.
///
/// As in the TypeScript, the colour is switched on whether or not there is a
/// terminal, and only the switching off is left out without one.
pub fn warning(env: &Env) -> String {
    let Loaded::Usable(usage) = load(&path(env)) else { return String::new() };
    let tier = env.tier.as_deref().or(usage.inferred_tier()).unwrap_or("free");
    let limits = limits(tier);
    let used = usage.today();
    let ratio = used / limits.daily;
    // `if (pct < 0.8) return`
    if ratio < 0.8 {
        return String::new();
    }
    let colour = if ratio >= 0.95 { "\x1b[31m" } else { "\x1b[33m" };
    let mut text = format!(
        "\n{colour}⚠ API quota: {}/{} calls today ({})\n",
        json::number_to_string(used),
        json::number_to_string(limits.daily),
        percent(ratio)
    );
    if ratio >= 0.95 {
        text.push_str("  Upgrade at https://docs.qq.com/vip\n");
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usage(text: &str) -> Usage {
        match json::parse(text) {
            Ok(Json::Obj(data)) => Usage { data },
            _ => panic!("not an object"),
        }
    }

    #[test]
    fn increments_prune_and_infer() {
        let today = today_key();
        let month = month_key(&today);
        let mut u = usage(&format!(
            r#"{{"note":"kept","daily":{{"2001-01-09":1,"2001-01-01":2,"2001-01-03":3,"2001-01-04":4,"2001-01-05":5,"2001-01-06":6,"2001-01-07":7,"{today}":100}},"monthly":{{"2001-03":1,"2001-01":2,"2001-02":3,"{month}":7}}}}"#
        ));
        u.increment();
        assert_eq!(
            Json::Obj(u.data.clone()).compact(),
            format!(
                r#"{{"note":"kept","daily":{{"2001-01-03":3,"2001-01-04":4,"2001-01-05":5,"2001-01-06":6,"2001-01-07":7,"2001-01-09":1,"{today}":101}},"monthly":{{"2001-02":3,"2001-03":1,"{month}":8}},"inferredTier":"member"}}"#
            )
        );
    }

    #[test]
    fn bars_and_percentages() {
        assert_eq!(progress_bar(0.0, 100.0).unwrap(), format!("[{}]", "░".repeat(20)));
        assert_eq!(progress_bar(50.0, 100.0).unwrap(), format!("[{}{}]", "█".repeat(10), "░".repeat(10)));
        assert_eq!(progress_bar(250.0, 100.0).unwrap(), format!("[{}]", "█".repeat(20)));
        assert_eq!(progress_bar(-30.0, 100.0), Err(HandBack));
        assert_eq!(percent(0.795), "80%");
        assert_eq!(percent(1.5), "150%");
    }
}
