//! `qqdocs usage` and `qqdocs usage calibrate` (src/index.ts cmdDocsUsage,
//! cmdDocsUsageCalibrate). Neither talks to the service.

use super::Effects;
use crate::args::{self, Kind, Opt, Spec};
use crate::env::{Env, HandBack, Res};
use crate::json;
use crate::usage::{self, Loaded};

const TIERS: &[&str] = &["free", "member", "plus"];

pub struct Args {
    tier: Option<String>,
}

pub fn parse(rest: &[String]) -> Option<Args> {
    let parsed = args::parse(rest, &Spec { options: &[Opt { long: "tier", short: None, kind: Kind::Choice(TIERS) }], flags: &[] })?;
    parsed.positionals.is_empty().then(|| Args { tier: parsed.value("tier").map(String::from) })
}

pub fn run(env: &Env, args: &Args) -> Res<Effects> {
    let Loaded::Usable(data) = usage::load(&usage::path(env)) else { return Err(HandBack) };
    // `override ?? config.tier ?? data.inferredTier ?? "free"`
    let tier = args.tier.as_deref().or(env.tier.as_deref()).or(data.inferred_tier()).unwrap_or("free");
    let mut effects = Effects::default();
    effects.log("API usage (Tencent Docs MCP):");
    for line in usage::lines(&data, &usage::limits(tier))? {
        effects.log(&line);
    }
    if let Some(inferred) = data.inferred_tier().filter(|tier| *tier != "free") {
        effects.log(&format!("  (tier auto-detected: {inferred})"));
    }
    effects.log("");
    effects.log("  Tier limits — free: 100/day  member: 1000/day  member plus: 2000/day  (all: 20000/month)");
    effects.log("  Calibrate: qqdocs usage calibrate --today <n> [--month <n>] [--tier free|member|plus]");
    if env.tier.is_none() {
        effects.log("  Set tier in ~/.qqdocs/config.yaml:  tier: member");
    }
    effects.log("  Upgrade: https://docs.qq.com/vip");
    Ok(effects)
}

pub struct CalibrateArgs {
    today: Option<f64>,
    month: Option<f64>,
    tier: Option<String>,
}

pub fn parse_calibrate(rest: &[String]) -> Option<CalibrateArgs> {
    const SPEC: Spec = Spec {
        options: &[
            Opt { long: "today", short: None, kind: Kind::Count },
            Opt { long: "month", short: None, kind: Kind::Count },
            Opt { long: "tier", short: None, kind: Kind::Choice(TIERS) },
        ],
        flags: &[],
    };
    let parsed = args::parse(rest, &SPEC)?;
    parsed.positionals.is_empty().then(|| CalibrateArgs {
        today: parsed.count("today"),
        month: parsed.count("month"),
        tier: parsed.value("tier").map(String::from),
    })
}

/// The one ported command that writes before it prints: the counter file,
/// under its lock. If the file cannot be written nothing has been printed
/// yet, and the JavaScript reports the failure.
pub fn calibrate(env: &Env, args: &CalibrateArgs) -> Res<Effects> {
    usage::with_lock(env, || {
        let Loaded::Usable(mut data) = usage::load(&usage::path(env)) else { return Err(HandBack) };
        data.calibrate(args.today, args.month, args.tier.as_deref());
        data.write(env).map_err(|_| HandBack)?;
        let mut effects = Effects::default();
        let n = json::number_to_string;
        effects.log(&format!(
            "Calibrated: today={}  month={}  inferredTier={}",
            n(data.today()),
            n(data.this_month()),
            data.inferred_tier().unwrap_or("free")
        ));
        Ok(effects)
    })
}
