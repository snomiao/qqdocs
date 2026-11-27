//! qqdocs — Rust entry point.
//!
//! Installed from npm, this binary is the command users run. A command runs
//! here once it has been ported and a parity test shows it behaves like the
//! TypeScript; until then it is handed back to the JavaScript the package
//! still ships, so nothing changes for users.

mod args;
mod commands;
mod env;
mod js_fallback;
mod json;
mod mcp;
mod usage;

use std::io::Write as _;

use commands::{Command, Effects};
use env::{Env, HandBack};

/// The package's JavaScript entry, relative to the package root: what `bin`
/// in the published package.json names, run by bun (`#!/usr/bin/env bun`).
const JS_ENTRY: &str = "bin/qqdocs.ts";

/// `QQDOCS_NO_NATIVE=1` hands every command back to the JavaScript: the way
/// out for a user if a ported command misbehaves.
fn native() -> bool {
    std::env::var_os("QQDOCS_NO_NATIVE").is_none()
}

fn main() {
    // Arguments that are not Unicode are for the JavaScript to deal with.
    let args: Option<Vec<String>> = std::env::args_os().skip(1).map(|arg| arg.into_string().ok()).collect();
    if let Some(args) = args.filter(|_| native()) {
        // One arm per ported command in `commands::parse`, added once its
        // parity cases (rs/parity.json) pass. `None` is every other command
        // and every spelling of a ported one that yargs has to answer.
        if let Some(command) = commands::parse(&args) {
            // bin/qqdocs.ts: no quota warning when any argument is "usage".
            let warns = !args.iter().any(|arg| arg == "usage");
            run(&command, warns);
        }
    }
    js_fallback::run(JS_ENTRY)
}

/// Runs a ported command to its end, or returns for the invocation to be
/// handed back. Nothing has been printed or written when it returns.
///
/// A bug in a ported command must not cost the user their command: a panic
/// before the effects are carried out hands the invocation back too.
fn run(command: &Command, warns: bool) {
    let report = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let outcome = std::panic::catch_unwind(|| {
        let env = Env::startup()?;
        let effects = command.run(&env)?;
        Ok::<_, HandBack>((env, effects))
    });
    std::panic::set_hook(report);
    if let Ok(Ok((env, effects))) = outcome {
        finish(&env, &effects, warns);
    }
}

/// Carries out what a successful command leaves to be done, in the order the
/// TypeScript gets to it, and ends the process.
fn finish(env: &Env, effects: &Effects, warns: bool) -> ! {
    // `incrementUsage()` after each call, then `setCachedDoc()`.
    usage::record_calls(env, effects.calls);
    if let Some(document) = &effects.remember {
        commands::read::remember(env, document);
    }
    // A closed pipe is ignored, as bun ignores it.
    let _ = std::io::stderr().write_all(effects.stderr.as_bytes());
    let mut stdout = std::io::stdout().lock();
    let _ = stdout.write_all(effects.stdout.as_bytes()).and_then(|_| stdout.flush());
    drop(stdout);
    if warns {
        // `printUsageWarningIfNeeded(config.tier)`
        let _ = std::io::stderr().write_all(usage::warning(env).as_bytes());
    }
    std::process::exit(0)
}
