//! Who answers: the binary or the JavaScript.
//!
//! The parity cases (rs/parity.json) compare the two implementations. What
//! they cannot set up is checked here, with the binary alone: a package of
//! its own beside the binary (for the `.env.local` files src/env.ts reads
//! there), a terminal, a machine without bun, a project several directories
//! above the current one, the machine's own zone, the second command name,
//! and the binary's own two variables. `bun` is a stand-in that prints the
//! arguments it was given, so a line starting with `JS:` means the
//! invocation was handed back.

#![cfg(unix)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

struct Sandbox {
    dir: PathBuf,
}

impl Sandbox {
    /// `<dir>/a/b/pkg` is the package, `<dir>/bin` holds the stand-in bun,
    /// `<dir>/home` is HOME, `<dir>/cwd` the current directory.
    fn new(name: &str) -> Sandbox {
        let dir = std::env::temp_dir().join(format!("qqdocs-handback-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        for sub in ["a/b/pkg/bin", "bin", "home/.qqdocs", "cwd"] {
            fs::create_dir_all(dir.join(sub)).unwrap();
        }
        fs::write(dir.join("a/b/pkg/package.json"), "{\"name\":\"qqdocs\"}").unwrap();
        fs::write(dir.join("a/b/pkg/bin/qqdocs.ts"), "#!/usr/bin/env bun\n").unwrap();
        let sandbox = Sandbox { dir };
        sandbox.program("bun", "#!/bin/sh\necho \"JS:$*\"\n");
        sandbox
    }

    fn program(&self, name: &str, script: &str) {
        let path = self.dir.join("bin").join(name);
        fs::write(&path, script).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn package(&self) -> PathBuf {
        self.dir.join("a/b/pkg")
    }

    /// The binary, with nothing of this machine's environment.
    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_qqdocs"));
        command
            .args(args)
            .current_dir(self.dir.join("cwd"))
            .env_clear()
            .env("PATH", format!("{}:/usr/bin:/bin", self.dir.join("bin").display()))
            .env("HOME", self.dir.join("home"))
            .env("TZ", "UTC")
            .env("QQDOCS_PACKAGE_ROOT", self.package());
        command
    }

    fn run(&self, args: &[&str]) -> Output {
        self.command(args).output().unwrap()
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

fn handed_back(output: &Output) -> bool {
    stdout(output).starts_with("JS:")
}

#[test]
fn usage_is_answered_by_the_binary() {
    let sandbox = Sandbox::new("usage");
    let output = sandbox.run(&["usage"]);
    assert!(stdout(&output).starts_with("API usage (Tencent Docs MCP):\n"), "{output:?}");
    assert_eq!(output.status.code(), Some(0));
}

#[test]
fn what_is_not_ported_reaches_the_javascript_with_its_arguments() {
    let sandbox = Sandbox::new("unported");
    let script = sandbox.package().join("bin/qqdocs.ts");
    for args in [
        // Starts the default browser: never run by a parity case.
        &["open", "dFzLAbBjFuBr"][..],
        &["create", "A title", "--type", "doc"],
        &["delete", "dFzLAbBjFuBr", "--confirm", "1234"],
        &["perm", "set", "dFzLAbBjFuBr", "link-read"],
        &["--help"],
        &["--version"],
        &[],
    ] {
        let output = sandbox.run(args);
        let expected = std::iter::once(script.display().to_string()).chain(args.iter().map(|a| a.to_string())).collect::<Vec<_>>().join(" ");
        assert_eq!(stdout(&output), format!("JS:{expected}\n"), "{args:?}");
    }
}

#[test]
fn the_no_native_variable_hands_everything_back() {
    let sandbox = Sandbox::new("no-native");
    assert!(handed_back(&sandbox.command(&["usage"]).env("QQDOCS_NO_NATIVE", "1").output().unwrap()));
    assert!(handed_back(&sandbox.command(&["usage", "calibrate", "--today", "1"]).env("QQDOCS_NO_NATIVE", "").output().unwrap()));
    assert!(!sandbox.dir.join("home/.qqdocs/usage.json").exists());
}

/// src/env.ts reads `.env.local` beside the package and in the two
/// directories above it. A token there is not looked for by the binary; it
/// leaves such an installation to the JavaScript.
#[test]
fn an_env_local_beside_or_above_the_package_goes_back() {
    for place in ["a/b/pkg", "a/b", "a"] {
        let sandbox = Sandbox::new(&format!("env-local-{}", place.replace('/', "-")));
        assert!(!handed_back(&sandbox.run(&["usage"])), "before: {place}");
        fs::write(sandbox.dir.join(place).join(".env.local"), "TENCENT_DOCS_TOKEN=fake-token\n").unwrap();
        assert!(handed_back(&sandbox.run(&["usage"])), "{place}");
    }
    // One directory further up is not one of the three.
    let sandbox = Sandbox::new("env-local-above");
    fs::write(sandbox.dir.join(".env.local"), "TENCENT_DOCS_TOKEN=fake-token\n").unwrap();
    assert!(!handed_back(&sandbox.run(&["usage"])));
}

/// The package may be reached through a link (`bun link`, pnpm): bun resolves
/// the script first, so the directories above are those of the real place.
#[test]
fn the_package_is_looked_at_where_it_really_is() {
    let sandbox = Sandbox::new("linked");
    let link = sandbox.dir.join("link");
    std::os::unix::fs::symlink(sandbox.package(), &link).unwrap();
    fs::write(sandbox.dir.join("a/b/.env.local"), "X=1\n").unwrap();
    assert!(handed_back(&sandbox.command(&["usage"]).env("QQDOCS_PACKAGE_ROOT", &link).output().unwrap()));
}

/// On a terminal the TypeScript prints links and colours and redraws its
/// list; the binary leaves a terminal to it. `script` provides one.
#[test]
fn a_terminal_goes_back() {
    if !Path::new("/usr/bin/script").exists() || !cfg!(target_os = "linux") {
        eprintln!("skipped: no util-linux script(1) to provide a terminal");
        return;
    }
    let sandbox = Sandbox::new("terminal");
    let binary = env!("CARGO_BIN_EXE_qqdocs");
    let environment = sandbox.command(&[]);
    let output = Command::new("/usr/bin/script")
        .args(["-qec", &format!("{binary} usage"), "/dev/null"])
        .current_dir(sandbox.dir.join("cwd"))
        .env_clear()
        .envs(environment.get_envs().filter_map(|(key, value)| Some((key.to_owned(), value?.to_owned()))))
        .stdin(std::process::Stdio::null())
        .output()
        .unwrap();
    assert!(handed_back(&output), "{output:?}");
}

/// QQDOCS_PARITY_MCP_URL is the binary's own (the TypeScript's address is a
/// constant). It must not be a way to send the token anywhere else.
#[test]
fn the_endpoint_override_is_for_this_machine_only() {
    let sandbox = Sandbox::new("override");
    for value in ["https://example.com/openapi/mcp", "http://127.0.0.1.example.com:80/x", "http://localhost:8080/x", "http://127.0.0.1/x", "http://127.0.0.1:80", ""] {
        let output = sandbox.command(&["usage"]).env("QQDOCS_PARITY_MCP_URL", value).output().unwrap();
        assert_eq!(output.status.code(), Some(2), "{value}");
        assert_eq!(stdout(&output), "", "{value}");
        assert!(stderr(&output).contains("QQDOCS_PARITY_MCP_URL is for parity tests"), "{value}");
    }
    let output = sandbox.command(&["usage"]).env("QQDOCS_PARITY_MCP_URL", "http://127.0.0.1:9/openapi/mcp").output().unwrap();
    assert!(stdout(&output).starts_with("API usage"), "{output:?}");
    // With QQDOCS_NO_NATIVE the variable is not looked at: it is the JavaScript's turn.
    let output = sandbox.command(&["usage"]).env("QQDOCS_PARITY_MCP_URL", "https://example.com/").env("QQDOCS_NO_NATIVE", "1").output().unwrap();
    assert!(handed_back(&output));
}

/// A binary without the npm package beside it has no JavaScript to hand
/// back to: it answers what it has ported and says so for the rest.
#[test]
fn a_binary_without_the_package() {
    let sandbox = Sandbox::new("standalone");
    let output = sandbox.command(&["usage"]).env_remove("QQDOCS_PACKAGE_ROOT").output().unwrap();
    assert!(stdout(&output).starts_with("API usage"), "{output:?}");
    let output = sandbox.command(&["open", "x"]).env_remove("QQDOCS_PACKAGE_ROOT").output().unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(stderr(&output).contains("not available in the standalone binary"), "{output:?}");
}

/// bin/qqdocs.ts is TypeScript and names bun in its first line. Without bun
/// the binary says so; it does not offer the file to node.
#[test]
fn without_bun_the_javascript_is_not_given_to_node() {
    let sandbox = Sandbox::new("no-bun");
    fs::remove_file(sandbox.dir.join("bin/bun")).unwrap();
    sandbox.program("node", "#!/bin/sh\necho \"NODE:$*\"\n");
    let output = sandbox.command(&["open", "x"]).env("PATH", sandbox.dir.join("bin")).output().unwrap();
    assert_eq!(output.status.code(), Some(127), "{output:?}");
    assert_eq!(stdout(&output), "");
    assert!(stderr(&output).contains("it needs bun"), "{output:?}");
    // What the binary answers itself needs neither.
    let output = sandbox.command(&["usage"]).env("PATH", sandbox.dir.join("bin")).output().unwrap();
    assert!(stdout(&output).starts_with("API usage"), "{output:?}");
}

/// bun reads package.json, tsconfig.json and jsconfig.json of the current
/// directory and of every directory above it, and reports what it finds
/// wrong with them. The binary leaves a directory inside a project to it,
/// however far up the project's files are.
#[test]
fn a_project_file_anywhere_above_the_current_directory_goes_back() {
    for file in ["package.json", "tsconfig.json", "jsconfig.json"] {
        for place in ["cwd/deep/er", "cwd/deep", "cwd", ""] {
            let sandbox = Sandbox::new(&format!("project-{}-{}", file.replace('.', "-"), place.replace('/', "-")));
            let deep = sandbox.dir.join("cwd/deep/er");
            fs::create_dir_all(&deep).unwrap();
            assert!(!handed_back(&sandbox.command(&["usage"]).current_dir(&deep).output().unwrap()), "before: {file} in {place:?}");
            fs::write(sandbox.dir.join(place).join(file), "{}").unwrap();
            assert!(handed_back(&sandbox.command(&["usage"]).current_dir(&deep).output().unwrap()), "{file} in {place:?}");
        }
    }
    // Below the current directory, or beside it, is not above it.
    let sandbox = Sandbox::new("project-elsewhere");
    fs::create_dir_all(sandbox.dir.join("cwd/sub")).unwrap();
    fs::write(sandbox.dir.join("cwd/sub/package.json"), "{ not json").unwrap();
    fs::write(sandbox.dir.join("home/package.json"), "{ not json").unwrap();
    assert!(!handed_back(&sandbox.run(&["usage"])));
}

/// The local day comes from the zone data inside bun. The binary answers
/// only for zones that are a fixed number of hours from UTC by their name.
#[test]
fn only_a_zone_fixed_by_its_name_is_answered() {
    let sandbox = Sandbox::new("zone");
    for zone in ["UTC", "Etc/UTC", "Etc/GMT-8", "Etc/GMT+12", "Etc/GMT-14"] {
        assert!(!handed_back(&sandbox.command(&["usage"]).env("TZ", zone).output().unwrap()), "{zone}");
    }
    for zone in ["Asia/Shanghai", "America/Vancouver", "Europe/London", "Etc/GMT", "Etc/GMT+13", "GMT", "CST-8", ":UTC", "utc", ""] {
        assert!(handed_back(&sandbox.command(&["usage"]).env("TZ", zone).output().unwrap()), "{zone:?}");
    }
    // Without TZ it is the machine's own zone: answered where /etc/localtime
    // links to UTC (and /etc/timezone, if there is one, says the same).
    let is_utc = |name: &str| matches!(name.trim(), "UTC" | "Etc/UTC");
    let linked_to_utc = fs::read_link("/etc/localtime")
        .ok()
        .and_then(|target| target.to_str().and_then(|target| target.split_once("/zoneinfo/")).map(|(_, name)| is_utc(name)))
        .unwrap_or(false);
    let named_utc = fs::read_to_string("/etc/timezone").map(|name| is_utc(&name)).unwrap_or(!Path::new("/etc/timezone").exists());
    let output = sandbox.command(&["usage"]).env_remove("TZ").output().unwrap();
    assert_eq!(handed_back(&output), !(linked_to_utc && named_utc), "{output:?}");
}

/// The package installs the same file under two names, `qqdocs` and `qqdoc`.
/// The binary does not look at its own name: both answer the same, and hand
/// the same script back.
#[test]
fn the_second_command_name_is_the_same_command() {
    let sandbox = Sandbox::new("qqdoc");
    let qqdoc = sandbox.dir.join("bin/qqdoc");
    std::os::unix::fs::symlink(env!("CARGO_BIN_EXE_qqdocs"), &qqdoc).unwrap();
    let as_qqdoc = |args: &[&str]| {
        let mut command = Command::new(&qqdoc);
        let environment = sandbox.command(&[]);
        command.args(args).current_dir(sandbox.dir.join("cwd")).env_clear();
        command.envs(environment.get_envs().filter_map(|(key, value)| Some((key.to_owned(), value?.to_owned()))));
        command.output().unwrap()
    };
    for args in [&["usage"][..], &["usage", "calibrate", "--today", "3"], &["usage", "--tier", "plus"], &["open", "x"], &["--help"], &["qqdoc"]] {
        let (first, second) = (sandbox.run(args), as_qqdoc(args));
        assert_eq!((stdout(&first), stderr(&first), first.status.code()), (stdout(&second), stderr(&second), second.status.code()), "{args:?}");
    }
    assert!(stdout(&as_qqdoc(&["usage"])).contains("3/100"));
    assert!(handed_back(&as_qqdoc(&["open", "x"])));
}

/// yargs prints a command's help when the last word is `help`. The binary
/// leaves the word to yargs wherever it stands on the line.
#[test]
fn the_word_help_goes_back() {
    let sandbox = Sandbox::new("help");
    for args in [&["usage", "help"][..], &["tools", "help"], &["search", "help"], &["search", "help", "--json"], &["ls", "-d", "help"], &["canvas", "find", "help", "q"], &["space", "ls", "S", "--parent", "help"]] {
        assert!(handed_back(&sandbox.run(args)), "{args:?}");
    }
}
