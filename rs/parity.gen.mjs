#!/usr/bin/env node
// Writes rs/parity.json, the parity cases for qqdocs (Rust against TypeScript).
//
//   node rs/parity.gen.mjs           # rewrite rs/parity.json
//   node rs/parity.gen.mjs --check   # fail if rs/parity.json is not what this writes
//   node rs/parity.gen.mjs --list    # print the case names
//
// Then, from the repository root (after `bun install` and a release build):
//
//   P=<rustify>/templates/parity/parity.mjs
//   node rs/parity/with-mock.mjs --check
//   node $P --cases rs/parity.json --ts "node rs/parity/with-mock.mjs bun bin/qqdocs.ts" \
//           --rs "env QQDOCS_PACKAGE_ROOT=$PWD node rs/parity/with-mock.mjs rs/target/release/qqdocs"
//   node $P --cases rs/parity.json --rs "node rs/parity/with-mock.mjs rs/target/release/qqdocs" \
//           --handback QQDOCS_PACKAGE_ROOT=bin/qqdocs.ts
//
// (In Git Bash on Windows, $(pwd -W) instead of $PWD.) The first line checks
// that every bun the cases start loads the stand-in's seam; the first run
// compares the two; the second shows which cases the binary answered itself
// (it has to be exactly those marked "handback" for the system it runs on).
// The parity job of CI runs all of it, and cargo test, in parts at once:
//
//   node rs/parity/proof.mjs rs/target/release/qqdocs $P
//
// The same cases run on Linux, macOS and Windows. On Windows the binary hands
// every command back (see WINDOWS below), so there every case is marked
// "handback"; a mark given as text holds on every system. A case that cannot
// mean the same thing on a system carries "skip" for it: the cases that make
// a symbolic link are not run on Windows, where Git Bash's `ln -s` copies the
// file or fails. The probes are scripts for node (rs/parity/home.mjs and
// rs/parity/age.mjs), because macOS has no GNU `stat -c` or `touch -d`.
//
// qqdocs talks to one address, https://docs.qq.com/openapi/mcp. No case
// reaches it: rs/parity/with-mock.mjs starts a stand-in on 127.0.0.1 for
// every run, answers from the case's QQDOCS_PARITY_MOCK, and writes every
// request it received to $TMPDIR/mcp.log, which each case prints afterwards.
// So what each implementation asked for (the exact bytes of the body, the
// Content-Type, the token, which calls went out at the same time) is compared
// along with stdout, stderr, the exit code and everything under ~/.qqdocs
// (names, modes, contents). The token is a made-up one.
//
// A case says who is expected to answer it:
//   add(...)   Rust answers.
//   back(...)  Rust hands it back at once: a command or a spelling that is
//              yargs's to answer, a command that is not ported, a state of
//              the machine Rust does not reproduce.
//   late(...)  Rust hands it back after the service answered with something
//              the TypeScript reports in bun's own words (an HTTP error, a
//              JSON-RPC error, a missing field). The JavaScript then asks
//              again, so these compare which requests were made, not how many.
//
// The cases whose names start with `x ` were written by the independent
// verification of this port (they found the word `help`, numbers that lie
// between two spellings, the project files bun reads, and the zone data);
// they are kept as they were, with those the binary now hands back marked.
//
// Every case sets TZ=UTC unless it is about the zone. One case leaves TZ out
// and expects the binary to answer on Linux: that holds on a machine whose own
// zone is UTC, as the Linux machines of CI are (/etc/localtime links to
// Etc/UTC). On a Linux machine in another zone the binary hands that case
// back, and the hand-back check says so. On macOS the binary takes the zone
// from TZ only, so there that case goes back on every machine.
//
// No case runs `open`: it starts the default browser.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "parity.json");
const TOKEN = "fake-token-for-parity";

const sq = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`;

// ── what a case looks at afterwards ──────────────────────────────────────────

/** Every request the stand-in received, in order. */
const REQUESTS = 'cat "$TMPDIR/mcp.log"';
/** The distinct requests, for cases where the JavaScript repeats what Rust asked. */
const DISTINCT_REQUESTS = 'cut -f3- "$TMPDIR/mcp.log" | sort -u';
/** Everything in the home directory: names, modes and contents. */
const HOME_STATE = "node <REPO>/rs/parity/home.mjs <HOME>";
/** A shell line that leaves a file in HOME (empty if it was not there) last changed this many seconds ago. */
const aged = (file, seconds) => `node <REPO>/rs/parity/age.mjs ${seconds} ${file}`;

/**
 * A shell line that writes a file under <HOME>. In the content, @TODAY@ and
 * @MONTH@ are the local date and month (as `date` sees them under the case's
 * TZ), and @MS-<n>@ is the time n milliseconds ago, in milliseconds.
 */
function homeFile(file, content) {
  const target = `<HOME>/${file}`;
  const edits = [];
  if (content.includes("@TODAY@")) edits.push(`-e "s/@TODAY@/$(date +%F)/g"`);
  if (content.includes("@MONTH@")) edits.push(`-e "s/@MONTH@/$(date +%Y-%m)/g"`);
  const stamps = new Map([...content.matchAll(/@MS-(\d+)@/g)].map((m) => [m[0], m[1]]));
  for (const [stamp, ago] of stamps) edits.push(`-e "s/${stamp}/$(($(date +%s) * 1000 - ${ago}))/g"`);
  const write = edits.length ? `printf '%s' ${sq(content)} | sed ${edits.join(" ")} > ${target}` : `printf '%s' ${sq(content)} > ${target}`;
  return `mkdir -p "$(dirname ${target})" && ${write}`;
}

// ── what the stand-in answers ────────────────────────────────────────────────

const rule = (tool, replies, where) => ({ tool, ...(where ? { where } : {}), replies: [].concat(replies) });
const listRule = (replies) => ({ method: "tools/list", replies: [].concat(replies) });
/** An answer in `structuredContent`. */
const ok = (structured) => ({ structured });
/** An answer as JSON text in `content[0].text`. */
const text = (value) => ({ text: typeof value === "string" ? value : JSON.stringify(value) });
/** An HTTP answer (200 unless said otherwise) whose body is exactly this text. */
const raw = (body, status = 200) => ({ status, headers: { "content-type": "application/json" }, body });
/** The same, around a JSON-RPC result or structured content given as text. */
const rawResult = (resultJson, status = 200) => raw(`{"jsonrpc":"2.0","id":1,"result":${resultJson}}`, status);
const rawStructured = (json, status = 200) => rawResult(`{"structuredContent":${json}}`, status);
/** An HTTP answer of this status, with `Retry-After` if given. */
const http = (status, retryAfter, body = "") => ({ status, headers: retryAfter === undefined ? {} : { "retry-after": String(retryAfter) }, body });
const rpcError = (message, more = {}) => ({ error: { code: -32000, message, ...more } });
const mock = (rules, batches) => ({ rules: [].concat(rules), ...(batches ? { batches } : {}) });

// ── the cases ────────────────────────────────────────────────────────────────

const cases = [];

function make(name, args, o) {
  const env = { TZ: "UTC", TENCENT_DOCS_TOKEN: TOKEN, QQDOCS_PARITY_MOCK: JSON.stringify(o.mock ?? {}), ...(o.env || {}) };
  // null: the variable is not set at all.
  for (const key of Object.keys(env)) if (env[key] === null) delete env[key];
  const setup = [];
  // ~/.qqdocs exists on every machine that has run qqdocs before. (On the
  // very first call the TypeScript waits two seconds for a lock it cannot
  // create; the `first run` cases cover that.)
  if (!o.firstRun) setup.push("mkdir -p <HOME>/.qqdocs");
  for (const [file, content] of Object.entries(o.home || {})) setup.push(homeFile(file, content));
  setup.push(...(o.setup || []));
  if (cases.some((c) => c.name === name)) throw new Error(`two cases are named ${name}`);
  // A mark given as text holds on every system. Every other case is answered
  // by the binary on Linux and macOS (unless its own marks say otherwise for
  // macOS) and handed back on Windows.
  const handback = typeof o.handback === "string" ? o.handback : { ...(o.handback || {}), win32: WINDOWS };
  const skip = { ...(o.skip || {}) };
  if (setup.some((line) => /(^|[;&|] *)ln -s /.test(line))) skip.win32 = SYMLINK;
  return {
    name,
    args,
    env,
    ...(o.files ? { files: o.files } : {}),
    setup,
    after: [o.late ? DISTINCT_REQUESTS : REQUESTS, ...(o.racyCount || o.noHome ? [] : [HOME_STATE]), ...(o.after || [])],
    ...(o.normalize ? { normalize: o.normalize } : {}),
    ...(o.timeout ? { timeout: o.timeout } : {}),
    handback,
    ...(Object.keys(skip).length ? { skip } : {}),
  };
}
const add = (name, args, o = {}) => cases.push(make(name, args, o));
const back = (name, args, why, o = {}) => cases.push(make(name, args, { ...o, handback: why }));
const late = (name, args, why, o = {}) => cases.push(make(name, args, { ...o, handback: why, late: true }));

const YARGS = "yargs answers this";
const NOT_PORTED = "not ported: stays in the JavaScript";
const REPORTED = "the TypeScript reports this error in bun's words";
const HELP = "yargs prints the command's help when the last word is help; the word anywhere on the line is left to it";
const PROJECT = "bun reads package.json, tsconfig.json and jsconfig.json of the current directory and of those above it, and reports on them";
const ZONE = "the local day comes from the zone data inside bun; only zones fixed by their name (UTC, Etc/GMT±N) are worked out here";
const NOT_REPRODUCED = "a failure that is the runtime's to judge (no connection, a redirect, a date to wait for)";
// Per system (the runner's "Platforms"): what goes back only there, or is not run there.
const WINDOWS = "on Windows the binary hands every command back: it cannot tell there that the zone is UTC, and bun reads Windows' zones by rules of its own";
const MAC_ZONE = "on macOS the binary takes the zone from TZ only: reading the system's zone there has not been compared with bun on a Mac set to UTC";
const SYMLINK = "Git Bash's ln -s copies the file it is given and cannot make a link to nowhere";

// Sample data.
const planA = { file_id: "dFzLAbBjFuBr", file_name: "Plan A", file_url: "https://docs.qq.com/doc/DZEZ6TEFiQmpGdUJy" };
const budget = { file_id: "sheetBudget01", file_name: "预算 2026", file_url: "https://docs.qq.com/sheet/DSheetBudget01" };
const kinds = ["doc", "sheet", "smartsheet", "slide", "form", "pdf", "mind", "flowchart", "aio", "desktop"].map((kind, i) => ({
  file_id: `id${kind}00000${i}`,
  file_name: `A ${kind}`,
  file_url: `https://docs.qq.com/${kind}/D${kind}${i}`,
}));
const recent = (files) => rule("manage.recent_online_file", ok({ files }));
const usageAt = (today, more = "") => `{"daily":{"@TODAY@":${today}},"monthly":{"@MONTH@":${today}}${more}}`;

// ── tools ────────────────────────────────────────────────────────────────────

const toolList = [
  { name: "get_content", description: "Read  a   document's\n content\tas text" },
  { name: "manage.search_file", description: "搜索文档 Search documents by KEYWORD" },
  { name: "manage.create_file" },
  { name: "smartcanvas.read", description: null },
  { name: "long", description: `${"word ".repeat(30)}end` },
  { name: "exactly100", description: "x".repeat(100) },
  { name: "just101", description: "y".repeat(101) },
];
const tools = (list) => mock(listRule({ result: { tools: list } }));

add("tools: lists every tool with its description on one line", ["tools"], { mock: tools(toolList) });
add("tools: a pattern is looked for in names and descriptions, whatever the case", ["tools", "SEARCH"], { mock: tools(toolList) });
add("tools: a pattern in Chinese", ["tools", "搜索"], { mock: tools(toolList) });
add("tools: a pattern with blanks around it", ["tools", "  content "], { mock: tools(toolList) });
add("tools: a pattern that matches a name only", ["tools", "manage."], { mock: tools(toolList) });
add("tools: nothing matches the pattern", ["tools", "nothing-like-this"], { mock: tools(toolList) });
add("tools: the service has no tools", ["tools"], { mock: tools([]) });
add("tools: an answer without a tool list", ["tools"], { mock: mock(listRule({ result: {} })) });
add("tools: an answer without a result", ["tools"], { mock: mock(listRule({})) });
add("tools: a null result", ["tools"], { mock: mock(listRule({ result: null })) });
add("tools: names that are not text", ["tools"], { mock: tools([{ name: 42, description: "a number" }, { description: "no name" }, { name: null }, { name: true }]) });
add("tools: is not counted as a call", ["tools"], { mock: tools(toolList), home: { ".qqdocs/usage.json": usageAt(79) } });
add("tools: the quota warning follows when the day is nearly used up", ["tools"], { mock: tools(toolList), home: { ".qqdocs/usage.json": usageAt(80) } });
add("tools: a pattern that is the word usage silences the quota warning", ["tools", "usage"], { mock: tools(toolList), home: { ".qqdocs/usage.json": usageAt(99) } });
add("tools: first run, no ~/.qqdocs yet", ["tools"], { mock: tools(toolList), firstRun: true });
late("tools: a description that is not text", ["tools"], REPORTED, { mock: tools([{ name: "odd", description: 5 }]) });
add("tools: a description that is not text, on a tool the pattern leaves out", ["tools", "plain"], {
  mock: tools([{ name: "odd", description: 5 }, { name: "plain", description: "fine" }]),
});
late("tools: a tool that is null", ["tools"], REPORTED, { mock: tools([null]) });
late("tools: a tool list that is not a list", ["tools"], "the TypeScript iterates whatever it got", { mock: mock(listRule({ result: { tools: "abc" } })) });
late("tools: a description cut inside a character outside the basic plane", ["tools"], "half a character is something only JavaScript strings hold", {
  mock: tools([{ name: "emoji", description: `${"x".repeat(96)}😀${"y".repeat(10)}` }]),
});
add("tools: a long description with a character outside the basic plane before the cut", ["tools"], {
  mock: tools([{ name: "emoji", description: `😀${"x".repeat(110)}` }]),
});
late("tools: a pattern with accented capitals", ["tools", "ÉCOLE"], "JavaScript's own case tables decide", { mock: tools([{ name: "école", description: "École" }]) });
late("tools: a description with accented capitals, when there is a pattern", ["tools", "x"], "JavaScript's own case tables decide", {
  mock: tools([{ name: "t", description: "Ünïcode X" }]),
});
add("tools: a description with accented capitals, when there is no pattern", ["tools"], { mock: tools([{ name: "t", description: "Ünïcode X" }]) });
back("tools: two patterns", ["tools", "a", "b"], YARGS, { mock: tools(toolList) });
back("tools: an option it does not have", ["tools", "--json"], YARGS, { mock: tools(toolList) });
back("tools: a pattern that starts with a dash", ["tools", "-x"], YARGS, { mock: tools(toolList) });
back("tools: an empty pattern", ["tools", ""], "an empty argument is left to yargs", { mock: tools(toolList) });

// ── ls ───────────────────────────────────────────────────────────────────────

add("ls: recent documents, each kind with its extension", ["ls"], { mock: mock(recent([planA, budget, ...kinds])) });
add("ls: list is the same command", ["list"], { mock: mock(recent([planA])) });
add("ls: no recent documents", ["ls"], { mock: mock(recent([])) });
add("ls: an answer as JSON text instead of structured content", ["ls"], { mock: mock(rule("manage.recent_online_file", text({ files: [planA] }))) });
add("ls: an answer that has `file` instead of `files`", ["ls"], { mock: mock(rule("manage.recent_online_file", ok({ files: null, file: [budget] }))) });
add("ls: an answer with neither", ["ls"], { mock: mock(rule("manage.recent_online_file", ok({}))) });
add("ls: an answer without content at all", ["ls"], { mock: mock(rule("manage.recent_online_file", { result: {} })) });
add("ls: an answer whose content is empty", ["ls"], { mock: mock(rule("manage.recent_online_file", { result: { content: [] } })) });
add("ls: an answer that is a list", ["ls"], { mock: mock(rule("manage.recent_online_file", ok([planA]))) });
add("ls: -n and -p", ["ls", "-n", "5", "-p", "2"], { mock: mock(recent([planA])) });
add("ls: --count and --page", ["ls", "--count", "50", "--page", "3"], { mock: mock(recent([planA])) });
add("ls: --count= and --page=", ["ls", "--count=7", "--page=0"], { mock: mock(recent([planA])) });
add("ls: options before and after each other", ["ls", "--json", "-p", "4", "-n", "1"], { mock: mock(recent([planA])) });
add("ls: --json", ["ls", "--json"], { mock: mock(recent([planA, budget])) });
add("ls: --json with nothing to show", ["ls", "--json"], { mock: mock(recent([])) });
add("ls: --json prints whatever `files` is", ["ls", "--json"], { mock: mock(rule("manage.recent_online_file", ok({ files: { not: "a list", n: 1.5 } }))) });
add("ls: --json keeps JavaScript's key order and number format", ["ls", "--json"], {
  mock: mock(
    rule(
      "manage.recent_online_file",
      raw('{"jsonrpc":"2.0","id":1,"result":{"structuredContent":{"files":[{"b":1,"10":2,"2":3,"a":1.0,"big":12345678901234567890,"tiny":1e-7,"huge":1e21,"neg":-0,"b":9,"s":"é\\u00e9\\n\\u0001\\ud83d\\ude00"}]}}}'),
    ),
  ),
});
add("ls: names that are not text", ["ls"], {
  mock: mock(recent([{ file_id: "a", file_url: "https://docs.qq.com/doc/a" }, { file_id: "b", file_name: 12.5, file_url: "https://docs.qq.com/pdf/b" }, { file_id: "c", file_name: null, file_url: "" }])),
});
late("ls: a document without an address", ["ls"], REPORTED, { mock: mock(recent([{ file_id: "a", file_name: "no address" }])) });
late("ls: a document that is null", ["ls"], REPORTED, { mock: mock(recent([null])) });
late("ls: an answer that is null", ["ls"], REPORTED, { mock: mock(rule("manage.recent_online_file", ok(null))) });
late("ls: `files` is not a list", ["ls"], "the TypeScript iterates whatever it got", { mock: mock(rule("manage.recent_online_file", ok({ files: "abc" }))) });
late("ls: a name that is a list", ["ls"], "JavaScript's own text for a list", {
  mock: mock(recent([{ file_id: "a", file_name: ["x", "y"], file_url: "https://docs.qq.com/doc/a" }])),
});

// --dates: one more call per document, all at the same time.
const dated = [planA, budget, { file_id: "third0000001", file_name: "Third", file_url: "https://docs.qq.com/slide/D3" }, { file_id: "fourth000001", file_name: "Fourth", file_url: "https://docs.qq.com/doc/D4" }];
const infoOf = (id, info) => rule("manage.query_file_info", ok(info), { file_id: id });
add("ls: --dates, older than a week", ["ls", "--dates"], {
  mock: mock(
    [
      recent(dated),
      infoOf(planA.file_id, { last_modify_time: 1700000000000 }),
      infoOf(budget.file_id, { last_modify_time: "1600000000000" }),
      infoOf("third0000001", { last_modify_time: 0 }),
      infoOf("fourth000001", { title: "no time" }),
    ],
    [1, 4],
  ),
});
add("ls: -d, minutes, hours and days ago", ["ls", "-d"], {
  mock: mock(
    [
      recent(dated),
      infoOf(planA.file_id, { last_modify_time: "@now-5000" }),
      infoOf(budget.file_id, { last_modify_time: "@now-150000" }),
      infoOf("third0000001", { last_modify_time: "@now-10900000@text" }),
      infoOf("fourth000001", { last_modify_time: "@now-260000000" }),
    ],
    [1, 4],
  ),
});
add("ls: --dates, a time in the future and one before 1970", ["ls", "--dates", "-n", "2"], {
  mock: mock([recent([planA, budget]), infoOf(planA.file_id, { last_modify_time: "@now+86400000" }), infoOf(budget.file_id, { last_modify_time: -86400001 })], [1, 2]),
});
add("ls: --dates with the same document twice", ["ls", "--dates"], {
  mock: mock([recent([planA, planA]), infoOf(planA.file_id, { last_modify_time: 1500000000000 })], [1, 2]),
});
add("ls: --dates with nothing to show asks nothing more", ["ls", "--dates"], { mock: mock(recent([])) });
add("ls: --json --dates asks for no dates", ["ls", "--json", "--dates"], { mock: mock(recent([planA])) });
// A call for a date that fails: the TypeScript leaves that date out
// (Promise.allSettled) and goes on. So does Rust, after the same requests.
add("ls: --dates when one of the calls fails", ["ls", "--dates"], {
  mock: mock([recent([planA, budget]), infoOf(planA.file_id, { last_modify_time: 1700000000000 }), rule("manage.query_file_info", rpcError("no such file"), { file_id: budget.file_id })], [1, 2]),
});
const folderItems0 = [
  { id: "folderAAAA01", is_folder: true, title: "Projects", url: "//docs.qq.com/desktop/folder/folderAAAA01" },
  { id: "docBBBBBB02", is_folder: false, title: "Notes", url: "//docs.qq.com/doc/DdocBBBBBB02" },
  { id: "sheetCCCC03", is_folder: false, title: "Numbers", url: "https://docs.qq.com/sheet/DsheetCCCC03" },
];
const thirty = Array.from({ length: 30 }, (_, i) => ({ file_id: `doc${String(i).padStart(7, "0")}`, file_name: `Doc ${i}`, file_url: `https://docs.qq.com/doc/D${i}` }));
add("ls: --dates on thirty documents when one call fails: thirty-one requests, thirty counted", ["ls", "-n", "30", "--dates"], {
  mock: mock([recent(thirty), rule("manage.query_file_info", rpcError("no such file"), { file_id: "doc0000007" }), rule("manage.query_file_info", ok({ last_modify_time: 1700000000000 }))], [1, 30]),
  home: { ".qqdocs/usage.json": usageAt(40) },
  after: ['wc -l < "$TMPDIR/mcp.log"'],
  timeout: 300,
});
add("ls: --dates when every call fails", ["ls", "--dates"], {
  mock: mock([recent([planA, budget]), rule("manage.query_file_info", rpcError("rate limited", { data: { message: "slow down" } }))], [1, 2]),
  home: { ".qqdocs/usage.json": usageAt(3) },
});
const oneFails = (reply, batches = [1, 2]) => mock([recent([planA, budget]), infoOf(planA.file_id, { last_modify_time: 1700000000000 }), rule("manage.query_file_info", reply, { file_id: budget.file_id })], batches);
for (const [what, reply] of [
  ["answered with HTTP 404", http(404, undefined, "<html>Not Found</html>")],
  ["answered with HTTP 403 and a JSON-RPC error", http(403, undefined, '{"error":{"message":"forbidden"}}')],
  ["answered with HTTP 501, which is not asked again", http(501)],
  ["answered with HTTP 400 and a Retry-After, which is not asked again", http(400, 0)],
  ["answered with a body that is not JSON", raw("<html>maintenance</html>")],
  ["answered with an empty body", raw("")],
  ["answered with a JSON list", raw("[1,2]")],
  ["answered with the JSON text null", raw("null")],
  ["answered with HTTP 204", http(204)],
]) {
  add(`ls: --dates when one call is ${what}`, ["ls", "--dates"], { mock: oneFails(reply), home: { ".qqdocs/usage.json": usageAt(3) } });
}
// These count as calls: the TypeScript counts before it looks at the result.
for (const [what, reply] of [
  ["without a result", {}],
  ["with a null result", { result: null }],
  ["with content text that is not JSON", text("plain words")],
]) {
  add(`ls: --dates when one call is answered ${what}: counted, no date`, ["ls", "--dates"], { mock: oneFails(reply), home: { ".qqdocs/usage.json": usageAt(3) } });
}
// A status the TypeScript asks again for (408, 425, 429, 500, 502, 503, 504):
// up to four attempts, waiting as long as Retry-After says.
add("ls: --dates when one call is answered 503 twice and then properly", ["ls", "--dates"], {
  mock: oneFails([http(503, 0), http(503, 0), ok({ last_modify_time: 1600000000000 })]),
  home: { ".qqdocs/usage.json": usageAt(3) },
});
add("ls: --dates when one call is answered 429 on all four attempts", ["ls", "--dates"], {
  mock: oneFails(http(429, 0, "slow down")),
  home: { ".qqdocs/usage.json": usageAt(3) },
});
for (const status of [408, 425, 500, 502, 504]) {
  add(`ls: --dates when one call is answered ${status} once`, ["ls", "--dates"], { mock: oneFails([http(status, 0), ok({ last_modify_time: 1600000000000 })]) });
}
add("ls: --dates when one call is told to wait a second", ["ls", "--dates"], { mock: oneFails([http(429, " 1 "), ok({ last_modify_time: 1600000000000 })]) });
add("ls: --dates when one call is answered 503 without Retry-After: half a second, then again", ["ls", "--dates"], {
  mock: oneFails([http(503), ok({ last_modify_time: 1600000000000 })]),
});
add("ls: --dates when one call is answered 503 with an empty Retry-After", ["ls", "--dates"], { mock: oneFails([http(503, ""), ok({ last_modify_time: 1600000000000 })]) });
add("ls: a folder with --dates when one call fails", ["ls", "root", "--dates"], {
  mock: mock([rule("manage.folder_list", ok({ list: folderItems0 })), rule("manage.query_file_info", rpcError("gone"), { file_id: "docBBBBBB02" }), rule("manage.query_file_info", ok({ last_modify_time: 1700000000000 }), { file_id: "sheetCCCC03" })], [1, 2]),
});
late("ls: --dates when one call is told to wait until a date", ["ls", "--dates"], NOT_REPRODUCED, {
  mock: oneFails([http(503, "Wed, 21 Oct 2015 07:28:00 GMT"), ok({ last_modify_time: 1600000000000 })]),
});
late("ls: --dates when one call is told to wait in a notation of its own", ["ls", "--dates"], NOT_REPRODUCED, {
  mock: oneFails([http(503, "0.0"), ok({ last_modify_time: 1600000000000 })]),
});
late("ls: --dates when the connection of one call is closed", ["ls", "--dates"], NOT_REPRODUCED, {
  mock: oneFails([{ drop: true }, ok({ last_modify_time: 1600000000000 })]),
});
late("ls: --dates when one call is redirected", ["ls", "--dates"], NOT_REPRODUCED, {
  mock: oneFails({ status: 302, headers: { location: "/openapi/elsewhere" }, body: "" }),
});
late("ls: --dates when one answer starts with a byte order mark", ["ls", "--dates"], "res.text() has its own rule for it", {
  mock: oneFails({ status: 200, body: '\ufeff{"error":{"message":"x"}}' }),
});
late("ls: --dates with a time in another notation", ["ls", "--dates"], "JavaScript's own reading of numbers and dates", {
  mock: mock([recent([planA]), infoOf(planA.file_id, { last_modify_time: "1.7e12" })]),
});
late("ls: --dates with a document id that is not text", ["ls", "--dates"], "ids are text", {
  mock: mock([recent([{ file_id: 7, file_name: "seven", file_url: "https://docs.qq.com/doc/7" }]), rule("manage.query_file_info", ok({}))]),
});

// A folder.
const folderItems = [
  { id: "folderAAAA01", is_folder: true, title: "Projects", url: "//docs.qq.com/desktop/folder/folderAAAA01" },
  { id: "docBBBBBB02", is_folder: false, title: "Notes", url: "//docs.qq.com/doc/DdocBBBBBB02" },
  { id: "sheetCCCC03", is_folder: false, title: "Numbers", url: "https://docs.qq.com/sheet/DsheetCCCC03" },
  { id: "folderDDDD04", is_folder: true, title: "2026", url: "https://docs.qq.com/desktop/folder/folderDDDD04" },
];
const folderList = (answer, where) => rule("manage.folder_list", ok(answer), where);
add("ls: the root folder", ["ls", "root"], { mock: mock(folderList({ list: folderItems, finish: true })) });
add("ls: a folder by id", ["ls", "folderAAAA01"], { mock: mock(folderList({ list: folderItems })) });
add("ls: a folder with more items than were sent", ["ls", "root"], { mock: mock(folderList({ list: folderItems, finish: false })) });
add("ls: an empty folder", ["ls", "root"], { mock: mock(folderList({ list: [] })) });
add("ls: a folder answer without a list", ["ls", "root"], { mock: mock(folderList({})) });
add("ls: a folder by path, looked up level by level", ["ls", "Projects/2026"], {
  mock: mock([
    rule("manage.folder_list", ok({ list: [{ id: "docEEEEEE05", is_folder: false, title: "Deep", url: "https://docs.qq.com/doc/Deep" }] }), { folder_id: "folderDDDD04" }),
    rule("manage.folder_list", ok({ list: [{ id: "folderDDDD04", is_folder: true, title: "2026", url: "u" }, { id: "x", is_folder: false, title: "2026", url: "u" }] }), { folder_id: "folderAAAA01" }),
    folderList({ list: folderItems }),
  ]),
});
add("ls: a folder by a one-word name", ["ls", "Projects"], {
  mock: mock([rule("manage.folder_list", ok({ list: [] }), { folder_id: "folderAAAA01" }), folderList({ list: folderItems })]),
});
add("ls: a path with blanks and empty parts", ["ls", " /Projects/ / "], {
  mock: mock([rule("manage.folder_list", ok({ list: [folderItems[1]] }), { folder_id: "folderAAAA01" }), folderList({ list: folderItems })]),
});
add("ls: a path of slashes is the root", ["ls", "//"], { mock: mock(folderList({ list: folderItems })) });
add("ls: a folder named usage silences the quota warning", ["ls", "usage"], {
  mock: mock([rule("manage.folder_list", ok({ list: [] }), { folder_id: "folderUUUU09" }), folderList({ list: [{ id: "folderUUUU09", is_folder: true, title: "usage", url: "u" }] })]),
  home: { ".qqdocs/usage.json": usageAt(98) },
});
add("ls: a folder, --json", ["ls", "root", "--json"], { mock: mock(folderList({ list: folderItems, finish: false })) });
add("ls: a folder, --json, --count and --page change nothing", ["ls", "--json", "folderAAAA01", "-n", "3", "-p", "9"], { mock: mock(folderList({ list: folderItems })) });
add("ls: a folder with --dates asks about the documents only", ["ls", "root", "--dates"], {
  mock: mock([folderList({ list: folderItems }), infoOf("docBBBBBB02", { last_modify_time: 1700000000000 }), infoOf("sheetCCCC03", { last_modify_time: "@now-7200000" })], [1, 2]),
});
add("ls: titles that are not text, in a folder", ["ls", "root"], {
  mock: mock(folderList({ list: [{ id: "a", url: "//x/doc/a" }, { id: "b", is_folder: 1, title: 5, url: "" }, { id: "c", is_folder: 0, title: false, url: "https://docs.qq.com/mind/c" }] })),
});
late("ls: a folder that is not there", ["ls", "Missing/Sub"], REPORTED, { mock: mock(folderList({ list: folderItems })) });
late("ls: a folder name that two folders have", ["ls", "Twin/x"], REPORTED, {
  mock: mock(folderList({ list: [{ id: "t1", is_folder: true, title: "Twin", url: "u" }, { id: "t2", is_folder: true, title: "Twin", url: "u" }] })),
});
late("ls: a folder item without an address", ["ls", "root"], REPORTED, { mock: mock(folderList({ list: [{ id: "a", is_folder: true, title: "no address" }] })) });

// Counting and the quota warning.
add("ls: one call is counted for the day and the month", ["ls"], { mock: mock(recent([planA])), home: { ".qqdocs/usage.json": usageAt(3) } });
add("ls: first run, no ~/.qqdocs yet", ["ls"], { mock: mock(recent([planA])), firstRun: true });
add("ls: the call that reaches 80% of the day is followed by the warning", ["ls"], { mock: mock(recent([planA])), home: { ".qqdocs/usage.json": usageAt(79) } });
add("ls: just below 80% there is none", ["ls"], { mock: mock(recent([planA])), home: { ".qqdocs/usage.json": usageAt(78) } });
add("ls: at 95% the warning is red and names the upgrade page", ["ls"], { mock: mock(recent([planA])), home: { ".qqdocs/usage.json": usageAt(94) } });
add("ls: over the quota", ["ls", "--json"], { mock: mock(recent([planA])), home: { ".qqdocs/usage.json": usageAt(250) } });
add("ls: the 101st call of a day makes the tier member", ["ls"], { mock: mock(recent([planA])), home: { ".qqdocs/usage.json": usageAt(100) } });
add("ls: the 1001st call of a day makes the tier plus", ["ls"], { mock: mock(recent([planA])), home: { ".qqdocs/usage.json": usageAt(1000, ',"inferredTier":"member"') } });
add("ls: an inferred tier is never lowered, and sets the quota", ["ls"], { mock: mock(recent([planA])), home: { ".qqdocs/usage.json": usageAt(850, ',"inferredTier":"plus"') } });
add("ls: an inferred member tier at 80%", ["ls"], { mock: mock(recent([planA])), home: { ".qqdocs/usage.json": usageAt(799, ',"inferredTier":"member"') } });
add("ls: the tier of config.yaml sets the quota", ["ls"], {
  mock: mock(recent([planA])),
  home: { ".qqdocs/usage.json": usageAt(90), ".qqdocs/config.yaml": "tier: member\n" },
});
add("ls: the tier of config.yaml wins over the inferred one", ["ls"], {
  mock: mock(recent([planA])),
  home: { ".qqdocs/usage.json": usageAt(90, ',"inferredTier":"plus"'), ".qqdocs/config.yaml": "tier: free\n" },
});
add("ls: only the last 7 days and 3 months are kept, other keys stay", ["ls"], {
  mock: mock(recent([planA])),
  home: {
    ".qqdocs/usage.json":
      '{"note":"kept","daily":{"2001-01-09":1,"2001-01-01":2,"2001-01-03":"three","2001-01-04":4,"2001-01-05":5,"2001-01-06":6,"2001-01-07":7,"2001-01-08":8},"extra":[1,2],"monthly":{"2001-03":1,"2001-01":2,"2001-02":3,"2000-12":4}}',
  },
});
add("ls: a counter file that is not JSON is started afresh", ["ls"], { mock: mock(recent([planA])), home: { ".qqdocs/usage.json": "not json {" } });
add("ls: an empty counter file is started afresh", ["ls"], { mock: mock(recent([planA])), home: { ".qqdocs/usage.json": "" } });
add("ls: counts that are null or fractions", ["ls"], { mock: mock(recent([planA])), home: { ".qqdocs/usage.json": '{"daily":{"@TODAY@":null},"monthly":{"@MONTH@":2.5},"inferredTier":null}' } });
add("ls: a stale lock beside the counter is removed", ["ls"], {
  mock: mock(recent([planA])),
  setup: [aged("<HOME>/.qqdocs/usage.json.lock", 10)],
});
add("ls: a lock that is held is waited for, two seconds, then ignored and removed", ["ls"], {
  mock: mock(recent([planA])),
  home: { ".qqdocs/usage.json": usageAt(7) },
  setup: ["touch <HOME>/.qqdocs/usage.json.lock"],
});
back("ls: a counter file without `daily`", ["ls"], "the TypeScript's arithmetic on a file of another shape is not reproduced", {
  mock: mock(recent([planA])),
  home: { ".qqdocs/usage.json": '{"monthly":{}}' },
});
back("ls: a counter file that is a list", ["ls"], "the TypeScript's arithmetic on a file of another shape is not reproduced", {
  mock: mock(recent([planA])),
  home: { ".qqdocs/usage.json": "[]" },
});
back("ls: a count that is text", ["ls"], "the TypeScript appends to it; not reproduced", {
  mock: mock(recent([planA])),
  home: { ".qqdocs/usage.json": '{"daily":{"@TODAY@":"5"},"monthly":{}}' },
});
back("ls: an inferred tier that is not one of the three", ["ls"], "the TypeScript's arithmetic on a file of another shape is not reproduced", {
  mock: mock(recent([planA])),
  home: { ".qqdocs/usage.json": '{"daily":{},"monthly":{},"inferredTier":"gold"}' },
});

// Spellings that are yargs's.
for (const [what, args] of [
  ["-n5", ["ls", "-n5"]],
  ["--count with text", ["ls", "--count", "many"]],
  ["--count with a fraction", ["ls", "--count", "2.5"]],
  ["--count with a leading zero", ["ls", "--count", "05"]],
  ["--count in exponent notation", ["ls", "-n", "1e2"]],
  ["a negative --page", ["ls", "--page", "-1"]],
  ["--count twice", ["ls", "-n", "1", "--count", "2"]],
  ["--count without a value", ["ls", "--count"]],
  ["--no-json", ["ls", "--no-json"]],
  ["--json=true", ["ls", "--json=true"]],
  ["--json true", ["ls", "--json", "true"]],
  ["--json twice", ["ls", "--json", "--json"]],
  ["two folders", ["ls", "a", "b"]],
  ["an unknown option", ["ls", "--all"]],
  ["--help", ["ls", "--help"]],
  ["-h", ["ls", "-h"]],
  ["options before the command", ["--json", "ls"]],
  ["a double dash", ["ls", "--", "root"]],
  ["grouped short options", ["ls", "-dn", "3"]],
]) {
  back(`ls: ${what}`, args, YARGS, { mock: mock([recent([planA]), folderList({ list: folderItems })]) });
}

// ── search ───────────────────────────────────────────────────────────────────

const hits = [
  { file_id: "h1", title: "Quarterly plan", url: "https://docs.qq.com/doc/Dh1" },
  { file_id: "h2", file_name: "季度计划", file_url: "https://docs.qq.com/sheet/Dh2" },
  { file_id: "h3", title: null, file_name: "falls back", url: null, file_url: "https://docs.qq.com/slide/Dh3" },
  { file_id: "h4" },
  { file_id: "h5", title: 2026, url: false },
];
const found = (list) => rule("manage.search_file", ok({ list }));
add("search: prints a link per document", ["search", "plan"], { mock: mock(found(hits)) });
add("search: nothing found", ["search", "nothing"], { mock: mock(found([])) });
add("search: an answer without a list", ["search", "nothing"], { mock: mock(rule("manage.search_file", ok({}))) });
add("search: --json", ["search", "plan", "--json"], { mock: mock(found(hits)) });
add("search: --json before the query", ["search", "--json", "plan"], { mock: mock(found(hits)) });
add("search: --json with nothing found", ["search", "x", "--json"], { mock: mock(found([])) });
add("search: --json prints whatever the list is", ["search", "x", "--json"], { mock: mock(rule("manage.search_file", ok({ list: "text" }))) });
add("search: a query of several words, with quotes and a backslash", ["search", 'the "big" plan\\n'], { mock: mock(found([])) });
add("search: a query in Chinese with an emoji", ["search", "季度计划 📈"], { mock: mock(found([hits[1]])) });
add("search: a query that looks like a number stays text", ["search", "2026"], { mock: mock(found([])) });
add("search: a query that looks like other numbers", ["search", "0x10"], { mock: mock(found([])) });
add("search: a query with a leading zero", ["search", "007"], { mock: mock(found([])) });
add("search: a query that is the word true", ["search", "true"], { mock: mock(found([])) });
add("search: a query in quotes keeps them", ["search", '"exact"'], { mock: mock(found([])) });
add("search: a query with blanks around it keeps them", ["search", "  padded  "], { mock: mock(found([])) });
add("search: a query in decomposed Unicode stays as typed", ["search", "école"], { mock: mock(found([])) });
add("search: a query that is the name of a command", ["search", "ls"], { mock: mock(found([])) });
add("search: the word usage as the query silences the quota warning", ["search", "usage"], { mock: mock(found(hits)), home: { ".qqdocs/usage.json": usageAt(99) } });
add("search: is counted, and warned about", ["search", "plan"], { mock: mock(found(hits)), home: { ".qqdocs/usage.json": usageAt(94) } });
late("search: a hit that is null", ["search", "x"], REPORTED, { mock: mock(found([null])) });
late("search: a list that is not a list", ["search", "x"], "the TypeScript iterates whatever it got", { mock: mock(rule("manage.search_file", ok({ list: { a: 1 } }))) });
late("search: an answer that is null", ["search", "x"], REPORTED, { mock: mock(rule("manage.search_file", ok(null))) });
late("search: a title that is an object", ["search", "x"], "JavaScript's own text for an object", { mock: mock(found([{ title: { a: 1 }, url: "u" }])) });
back("search: without a query", ["search"], YARGS, { mock: mock(found(hits)) });
back("search: two queries", ["search", "a", "b"], YARGS, { mock: mock(found(hits)) });
back("search: a query that starts with a dash", ["search", "-5"], YARGS, { mock: mock(found(hits)) });
back("search: --json=false", ["search", "x", "--json=false"], YARGS, { mock: mock(found(hits)) });
back("search: --help", ["search", "--help"], YARGS, { mock: mock(found(hits)) });

// ── read ─────────────────────────────────────────────────────────────────────

const ID = "dFzLAbBjFuBr";
const docInfo = { file_id: ID, title: "Plan A", url: "https://docs.qq.com/doc/DZEZ6TEFiQmpGdUJy", last_modify_time: 1700000000000, owner_name: "某人" };
const content = (value, where) => rule("get_content", ok({ content: value }), where);
const info = (value, where) => rule("manage.query_file_info", ok(value), where);
const BODY = "# Plan A\n\nFirst line.\n第二行 📄\n";
const readMock = (infoValue = docInfo, body = BODY) => mock([info(infoValue), content(body)], [2]);

add("read: by id, title line then content, and the document is remembered", ["read", ID], { mock: readMock() });
add("read: by address", ["read", "https://docs.qq.com/doc/DZEZ6TEFiQmpGdUJy?from=share"], { mock: readMock() });
add("read: by an aio address", ["read", "https://docs.qq.com/aio/DZEZ6TEFiQmpGdUJy"], { mock: readMock() });
add("read: by an address of another kind of page", ["read", "docs.qq.com/desktop/Dsomething1"], { mock: readMock() });
add("read: an id with blanks around it", ["read", ` ${ID} `], { mock: readMock() });
add("read: by title, searched first", ["read", "Plan A"], {
  mock: mock([found([{ file_id: "other0000001", file_name: "Plan A (old)" }, { file_id: ID, file_name: "Plan A" }, { file_id: "third0000001", title: "Plan A too" }]), info(docInfo), content(BODY)], [1, 2]),
});
add("read: by title, the only hit is taken even if the title differs", ["read", "plan"], { mock: mock([found([{ file_id: ID, title: "Plan A" }]), info(docInfo), content(BODY)], [1, 2]) });
add("read: a short word is a title, not an id", ["read", "Short1"], { mock: mock([found([{ file_id: ID, file_name: "Short1" }]), info(docInfo), content(BODY)], [1, 2]) });
add("read: info that names the document with file_name and file_url", ["read", ID], { mock: readMock({ file_name: "By file name", file_url: "https://docs.qq.com/doc/x" }) });
add("read: info without an address has no title line", ["read", ID], { mock: readMock({ title: "No address" }) });
add("read: info with an empty title has no title line", ["read", ID], { mock: readMock({ title: "", url: "https://docs.qq.com/doc/x" }) });
add("read: info with a null title falls back to file_name", ["read", ID], { mock: readMock({ title: null, file_name: "Fallback", url: "https://docs.qq.com/doc/x" }) });
add("read: info that is null", ["read", ID], { mock: mock([rule("manage.query_file_info", ok(null)), content(BODY)], [2]) });
add("read: info that is a list", ["read", ID], { mock: readMock([1, 2]) });
add("read: a title that is a number", ["read", ID], { mock: readMock({ title: 2026, url: "https://docs.qq.com/doc/x" }) });
add("read: empty content", ["read", ID], { mock: readMock(docInfo, "") });
add("read: content without a final newline, with tabs and carriage returns", ["read", ID], { mock: readMock(docInfo, "a\tb\r\nc") });
add("read: both calls are counted", ["read", ID], { mock: readMock(), home: { ".qqdocs/usage.json": usageAt(78) } });
// Without ~/.qqdocs the TypeScript cannot create the counter's lock, so the
// counts of the two calls it makes at the same time overwrite each other:
// usage.json says 1, or 2 when they happen not to collide. Not compared.
back("read: first run, no ~/.qqdocs yet", ["read", ID], "the TypeScript's two counts cannot take a lock yet and overwrite each other; left to it", { mock: readMock(), firstRun: true, racyCount: true });
add("read: first run, by title: the search is counted first, then the two calls", ["read", "Plan A"], {
  mock: mock([found([{ file_id: ID, file_name: "Plan A" }]), info(docInfo), content(BODY)], [1, 2]),
  firstRun: true,
});
add("ls: first run with --dates: the list is counted first, then the calls for the dates", ["ls", "--dates"], {
  mock: mock([recent([planA, budget]), infoOf(planA.file_id, { last_modify_time: 1700000000000 }), infoOf(budget.file_id, { last_modify_time: 1700000000000 })], [1, 2]),
  firstRun: true,
});
add("read: an id of ten digits goes first in the cache file", ["read", "1234567890"], {
  mock: readMock(),
  home: { ".qqdocs/doc-cache.json": '{"zzzzzzzzzzzz":{"content":"z","info":null,"cachedAt":@MS-1000@}}' },
});

// The cache: five minutes.
const cacheOf = (age, more = "") => `{"${ID}":{"content":"cached content\\n","info":{"title":"Cached title","url":"https://docs.qq.com/doc/cached","n":1.50},"cachedAt":@MS-${age}@}${more}}`;
add("read: a document read 10 seconds ago comes from the cache, nothing is asked", ["read", ID], { mock: readMock(), home: { ".qqdocs/doc-cache.json": cacheOf(10000) } });
add("read: a document read 4m50s ago comes from the cache", ["read", ID], { mock: readMock(), home: { ".qqdocs/doc-cache.json": cacheOf(290000) } });
add("read: a document read 5m10s ago is asked for again, and stale entries go", ["read", ID], {
  mock: readMock(),
  home: { ".qqdocs/doc-cache.json": cacheOf(310000, `,"staleOther00":{"content":"old","info":null,"cachedAt":@MS-900000@},"freshOther00":{"content":"new","info":{"a":[1,{"b":2}]},"cachedAt":@MS-60000@}`) },
});
add("read: a cache entry from the future counts as fresh", ["read", ID], {
  mock: readMock(),
  home: { ".qqdocs/doc-cache.json": `{"${ID}":{"content":"from the future","info":null,"cachedAt":99999999999999}}` },
});
add("read: a cached document without info has no title line", ["read", ID], {
  mock: readMock(),
  home: { ".qqdocs/doc-cache.json": `{"${ID}":{"content":"bare","cachedAt":@MS-1000@}}` },
});
add("read: another document's cache entry is kept, with its odd values", ["read", ID], {
  mock: readMock(),
  home: { ".qqdocs/doc-cache.json": '{"otherDoc0001":{"content":5,"info":"x","cachedAt":@MS-1000@,"extra":true},"noStamp00001":{"content":"kept"},"aNumber":7,"aList":[1]}' },
});
add("read: a cache file that is not JSON is started afresh", ["read", ID], { mock: readMock(), home: { ".qqdocs/doc-cache.json": "{ not json" } });
add("read: a cache with a null entry is read but never rewritten", ["read", ID], { mock: readMock(), home: { ".qqdocs/doc-cache.json": '{"gone":null}' } });
add("read: what the TypeScript cached is read back", ["read", ID], {
  mock: readMock(),
  setup: ["node <REPO>/rs/parity/with-mock.mjs bun <REPO>/bin/qqdocs.ts read dFzLAbBjFuBr > /dev/null 2>&1"],
});
back("read: a cache file that is a list", ["read", ID], "not what the TypeScript ever writes; what it does with it is not reproduced", {
  mock: readMock(),
  home: { ".qqdocs/doc-cache.json": "[]" },
});
back("read: a cache entry whose time is text", ["read", ID], "JavaScript's arithmetic on text is not reproduced", {
  mock: readMock(),
  home: { ".qqdocs/doc-cache.json": '{"otherDoc0001":{"content":"x","cachedAt":"1700000000000"}}' },
});
back("read: a cached document whose content is not text", ["read", ID], "what console.log makes of it is bun's", {
  mock: readMock(),
  home: { ".qqdocs/doc-cache.json": `{"${ID}":{"content":{"a":1},"cachedAt":@MS-1000@}}` },
});
back("read: a document id that is a member of every JavaScript object", ["read", "hasOwnProperty"], "the cache lookup finds Object.prototype's", { mock: readMock() });
late("read: no document of that title", ["read", "No such title"], REPORTED, { mock: mock(found([])) });
late("read: several documents of that title", ["read", "Twin"], REPORTED, {
  mock: mock(found([{ file_id: "t1", file_name: "Twin", file_url: "u1" }, { file_id: "t2", title: "Twin", url: "u2" }])),
});
// In these two the TypeScript ends on the content call's error while the info
// call's count may still be waiting for the counter's lock: from one run to
// the next usage.json says 1 or 2, and the lock file is left behind or not.
// So the home directory is not compared here (`racyCount`).
late("read: the service has no content for the document", ["read", ID], REPORTED, { mock: mock([info(docInfo), rule("get_content", ok({ error: "no permission" }))], [2]), racyCount: true });
late("read: content that is not text", ["read", ID], REPORTED, { mock: mock([info(docInfo), rule("get_content", ok({ content: 5 }))], [2]), racyCount: true });
// The information is asked for with `.catch(() => null)`: when that call
// fails the document is printed without its title line, and remembered so.
add("read: the info call fails, the content call does not", ["read", ID], {
  mock: mock([rule("manage.query_file_info", rpcError("not allowed")), content(BODY)], [2]),
});
for (const [what, reply] of [
  ["is answered with HTTP 403", http(403, undefined, "Forbidden")],
  ["is answered with a body that is not JSON", raw("<html></html>")],
  ["is answered 500 on all four attempts", http(500, 0, "boom")],
  ["is answered 503 once and then properly", [http(503, 0), ok(docInfo)]],
  ["is answered without a result, which is counted", {}],
  ["is answered with content text that is not JSON, which is counted", text("not json")],
]) {
  add(`read: the info call ${what}`, ["read", ID], { mock: mock([rule("manage.query_file_info", reply), content(BODY)], [2]), home: { ".qqdocs/usage.json": usageAt(5) } });
}
add("read: by title, when the info call fails", ["read", "Plan A"], {
  mock: mock([found([{ file_id: ID, file_name: "Plan A" }]), rule("manage.query_file_info", rpcError("not allowed")), content(BODY)], [1, 2]),
});
late("read: the connection of the info call is closed", ["read", ID], NOT_REPRODUCED, {
  mock: mock([rule("manage.query_file_info", [{ drop: true }, ok(docInfo)]), content(BODY)], [2]),
});
// The other way round the TypeScript reports the error (and Rust leaves the
// asking again to it: the content call is not one whose failure is caught).
late("read: the content call is answered 503 once", ["read", ID], "a status the TypeScript retries; Rust leaves the retrying to it", {
  mock: mock([info(docInfo), rule("get_content", [http(503, 0), ok({ content: BODY })])], [2]),
});
back("read: without a document", ["read"], YARGS, { mock: readMock() });
back("read: two documents", ["read", ID, "x"], YARGS, { mock: readMock() });
back("read: --json, which it does not have", ["read", ID, "--json"], YARGS, { mock: readMock() });

// ── info ─────────────────────────────────────────────────────────────────────

const fullInfo = {
  file_id: ID,
  title: "Plan A",
  url: "https://docs.qq.com/doc/DZEZ6TEFiQmpGdUJy",
  empty: "",
  nothing: null,
  zero: 0,
  no: false,
  yes: true,
  last_modify_time: 1700000000000,
  ratio: 0.1,
  owner: { name: "某人", ids: [1, 2, { deep: null }] },
  tags: ["a", "b c"],
  none: [],
  blank: {},
};
add("info: one line per field, empty ones left out, nested ones as JSON", ["info", ID], { mock: mock(info(fullInfo)) });
add("info: --json", ["info", ID, "--json"], { mock: mock(info(fullInfo)) });
add("info: --json before the document", ["info", "--json", ID], { mock: mock(info(fullInfo)) });
add("info: by address", ["info", "https://docs.qq.com/sheet/DSheetBudget01#tab=1"], { mock: mock(info(fullInfo)) });
add("info: by title", ["info", "预算 2026"], { mock: mock([found([budget]), info(fullInfo)]) });
add("info: an empty answer prints nothing", ["info", ID], { mock: mock(info({})) });
add("info: JavaScript's key order and number format", ["info", ID], {
  mock: mock(rule("manage.query_file_info", raw('{"jsonrpc":"2.0","id":1,"result":{"structuredContent":{"b":1,"10":2,"2":3,"big":12345678901234567890,"tiny":1e-7,"huge":1e21,"frac":1.50,"neg":-0,"nested":{"z":1,"1":[1.0,2e0]},"s":"tab\\there"}}}'))),
});
add("info: an answer as JSON text", ["info", ID], { mock: mock(rule("manage.query_file_info", text('{"title":"from text","n":1.0}'))) });
add("info: --json prints an answer that is a list", ["info", ID, "--json"], { mock: mock(info([1, "two"])) });
add("info: --json prints an answer that is null", ["info", ID, "--json"], { mock: mock(rule("manage.query_file_info", ok(null))) });
add("info: is counted", ["info", ID], { mock: mock(info(fullInfo)), home: { ".qqdocs/usage.json": usageAt(79) } });
late("info: an answer that is a list", ["info", ID], "the TypeScript prints its entries; not reproduced", { mock: mock(info([1, "two"])) });
late("info: an answer that is null", ["info", ID], REPORTED, { mock: mock(rule("manage.query_file_info", ok(null))) });
late("info: no document of that title", ["info", "nothing here"], REPORTED, { mock: mock(found([])) });
back("info: without a document", ["info"], YARGS, { mock: mock(info(fullInfo)) });
back("info: --json=1", ["info", ID, "--json=1"], YARGS, { mock: mock(info(fullInfo)) });

// ── perm get ─────────────────────────────────────────────────────────────────

const privilege = (answer) => rule("manage.get_privilege", ok(answer));
add("perm get: the policy in words, other fields as they are", ["perm", "get", ID], { mock: mock(privilege({ file_id: ID, policy: 2, trace_id: "trace-1", empty: "" })) });
for (const [what, policy] of [["private", 0], ["partially shared", 1], ["link-edit", 3], ["a number that is no policy", 7], ["a fraction", 2.5], ["text that is a policy number", "2"], ["other text", "public"], ["null", null], ["true", true]]) {
  add(`perm get: policy ${what}`, ["perm", "get", ID], { mock: mock(privilege({ policy, file_id: ID })) });
}
add("perm get: no policy in the answer", ["perm", "get", ID], { mock: mock(privilege({ file_id: ID })) });
add("perm get: by address", ["perm", "get", "https://docs.qq.com/doc/DZEZ6TEFiQmpGdUJy"], { mock: mock(privilege({ policy: 0 })) });
add("perm get: by title", ["perm", "get", "Plan A"], { mock: mock([found([{ file_id: ID, file_name: "Plan A" }]), privilege({ file_id: ID, policy: 3 })]) });
add("perm get: is counted", ["perm", "get", ID], { mock: mock(privilege({ policy: 2 })), home: { ".qqdocs/usage.json": usageAt(79) } });
late("perm get: an answer that is null", ["perm", "get", ID], REPORTED, { mock: mock(rule("manage.get_privilege", ok(null))) });
late("perm get: an answer that is a list", ["perm", "get", ID], "the TypeScript spreads whatever it got", { mock: mock(privilege([1])) });
late("perm get: a policy that is a list", ["perm", "get", ID], "JavaScript's own text for a list", { mock: mock(privilege({ policy: [2] })) });
late("perm get: a policy named like a member of every JavaScript object", ["perm", "get", ID], "the label lookup finds Object.prototype's", { mock: mock(privilege({ policy: "constructor" })) });
back("perm get: without a document", ["perm", "get"], YARGS, {});
back("perm get: two documents", ["perm", "get", ID, "x"], YARGS, {});
back("perm: without a subcommand", ["perm"], YARGS, {});
back("perm: an option before the subcommand", ["perm", "--help", "get", ID], YARGS, {});

// ── space list, space ls ─────────────────────────────────────────────────────

const spaces = [
  { space_id: "space000001", title: "Team wiki", policy: 2, file_cnt: 12, member_cnt: 3, is_owner: true },
  { space_id: "space000002", title: "私人空间", policy: 0, is_owner: false },
  { space_id: "space000003", title: "Shared", policy: 1, file_cnt: null, member_cnt: 0 },
  { space_id: "space000004", policy: 3, file_cnt: "many", is_owner: 1 },
  { title: "No policy", policy: "2" },
  { space_id: 5, title: 6, policy: 9 },
];
const spaceList = (answer) => rule("query_space_list", ok(answer));
add("space list: one line per space", ["space", "list"], { mock: mock(spaceList({ spaces })) });
add("space list: more pages", ["space", "list"], { mock: mock(spaceList({ spaces: [spaces[0]], has_next: true })) });
add("space list: none", ["space", "list"], { mock: mock(spaceList({ spaces: [] })) });
add("space list: an answer without spaces", ["space", "list"], { mock: mock(spaceList({ has_next: true })) });
add("space list: --page", ["space", "list", "--page", "2"], { mock: mock(spaceList({ spaces })) });
add("space list: -p", ["space", "list", "-p", "3"], { mock: mock(spaceList({ spaces })) });
for (const scope of ["all", "mine", "joined"]) add(`space list: --scope ${scope}`, ["space", "list", "--scope", scope], { mock: mock(spaceList({ spaces: [] })) });
for (const order of ["preview", "edited", "created"]) add(`space list: --order ${order}`, ["space", "list", `--order=${order}`], { mock: mock(spaceList({ spaces: [] })) });
add("space list: --asc", ["space", "list", "--asc"], { mock: mock(spaceList({ spaces: [] })) });
add("space list: every option", ["space", "list", "--asc", "--order", "created", "--scope=joined", "-p", "1"], { mock: mock(spaceList({ spaces })) });
add("space list: is counted", ["space", "list"], { mock: mock(spaceList({ spaces })), home: { ".qqdocs/usage.json": usageAt(94) } });
late("space list: an answer that is null", ["space", "list"], REPORTED, { mock: mock(rule("query_space_list", ok(null))) });
late("space list: a space that is null", ["space", "list"], REPORTED, { mock: mock(spaceList({ spaces: [null] })) });
late("space list: spaces that are not a list", ["space", "list"], "the TypeScript iterates whatever it got", { mock: mock(spaceList({ spaces: { a: 1 } })) });
back("space list: a scope that does not exist", ["space", "list", "--scope", "everyone"], YARGS, {});
back("space list: a word after it", ["space", "list", "mine"], YARGS, {});
back("space list: an option between the two words", ["space", "--page", "1", "list"], YARGS, {});
back("space list: --no-asc", ["space", "list", "--no-asc"], YARGS, {});
back("space: without a subcommand", ["space"], YARGS, {});

const nodes = [
  { node_id: "node0001", title: "Folder", node_type: "wiki_folder", has_child: true },
  { node_id: "node0002", title: "A doc", node_type: "wiki_file", doc_type: "smartcanvas", url: "https://docs.qq.com/aio/Dnode0002" },
  { node_id: "node0003", title: "A file", node_type: "wiki_file" },
  { node_id: "node0004", title: "A file of no type", node_type: "wiki_file", doc_type: "" },
  { node_id: "node0005", title: "外部链接", node_type: "link", url: "https://example.com/x" },
  { node_id: "node0006", title: "Long kind", node_type: "a_node_type_longer_than_ten", has_child: 0, url: "" },
  { node_id: "node0007", title: "宽", node_type: "wiki_file", doc_type: "幻灯片" },
  { node_type: "wiki_tdoc" },
];
const spaceNodes = (answer) => rule("query_space_node", ok(answer));
add("space ls: one line per node", ["space", "ls", "space000001"], { mock: mock(spaceNodes({ children: nodes })) });
add("space ls: more pages", ["space", "ls", "space000001"], { mock: mock(spaceNodes({ children: [nodes[0]], has_next: true })) });
add("space ls: none", ["space", "ls", "space000001"], { mock: mock(spaceNodes({ children: [] })) });
add("space ls: an answer without children", ["space", "ls", "space000001"], { mock: mock(spaceNodes({})) });
add("space ls: --parent and -p", ["space", "ls", "space000001", "--parent", "node0001", "-p", "2"], { mock: mock(spaceNodes({ children: nodes })) });
add("space ls: --parent= with a value that looks like a number, --page=", ["space", "ls", "--parent=0012", "--page=1", "space000001"], { mock: mock(spaceNodes({ children: [] })) });
add("space ls: a space id that looks like a number", ["space", "ls", "12345"], { mock: mock(spaceNodes({ children: [] })) });
late("space ls: a node without a type", ["space", "ls", "space000001"], REPORTED, { mock: mock(spaceNodes({ children: [{ node_id: "n", title: "t" }] })) });
late("space ls: a document type that is not text", ["space", "ls", "space000001"], REPORTED, { mock: mock(spaceNodes({ children: [{ node_id: "n", title: "t", node_type: "wiki_file", doc_type: 5 }] })) });
late("space ls: an answer that is null", ["space", "ls", "space000001"], REPORTED, { mock: mock(rule("query_space_node", ok(null))) });
back("space ls: without a space", ["space", "ls"], YARGS, {});
back("space ls: --parent without a value", ["space", "ls", "space000001", "--parent"], YARGS, {});
back("space ls: an empty --parent", ["space", "ls", "space000001", "--parent="], "an empty value is left to yargs", { mock: mock(spaceNodes({ children: [] })) });

// ── canvas read, canvas find ─────────────────────────────────────────────────

const canvas = (replies) => rule("smartcanvas.read", [].concat(replies).map(ok));
add("canvas read: the content, and the token of the next page", ["canvas", "read", ID], { mock: mock(canvas({ content: "<h1>Title</h1>\n<p>段落</p>\n", next_token: "tok-2" })) });
add("canvas read: the last page has no token", ["canvas", "read", ID], { mock: mock(canvas({ content: "<p>end</p>" })) });
add("canvas read: no content", ["canvas", "read", ID], { mock: mock(canvas({})) });
add("canvas read: null content and an empty token", ["canvas", "read", ID], { mock: mock(canvas({ content: null, next_token: "" })) });
add("canvas read: a token that is a number", ["canvas", "read", ID], { mock: mock(canvas({ content: "x", next_token: 7 })) });
add("canvas read: --page, --size and --next", ["canvas", "read", ID, "--page", "page-1", "--size", "50", "--next", "tok-2"], { mock: mock(canvas({ content: "page two" })) });
add("canvas read: --size 0 and values with =", ["canvas", "read", "--size=0", "--page=p", "--next=n", ID], { mock: mock(canvas({ content: "x" })) });
add("canvas read: by title", ["canvas", "read", "Plan A"], { mock: mock([found([{ file_id: ID, file_name: "Plan A" }]), canvas({ content: "found" })]) });
add("canvas read: --all follows the tokens and joins the pages", ["canvas", "read", ID, "--all"], {
  mock: mock(canvas([{ content: "<p>one</p>\n", next_token: "t1" }, { content: "", next_token: "t2" }, { next_token: "t3" }, { content: "<p>four</p>" }])),
});
add("canvas read: --all with --page and --size; --next is not used", ["canvas", "read", ID, "--all", "--page", "p1", "--size", "2", "--next", "ignored"], {
  mock: mock(canvas([{ content: "a", next_token: "t1" }, { content: "b" }])),
});
add("canvas read: --all of an empty document", ["canvas", "read", ID, "--all"], { mock: mock(canvas({})) });
add("canvas read: every page is counted", ["canvas", "read", ID, "--all"], {
  mock: mock(canvas([{ content: "a", next_token: "t1" }, { content: "b", next_token: "t2" }, { content: "c" }])),
  home: { ".qqdocs/usage.json": usageAt(77) },
});
late("canvas read: content that is not text", ["canvas", "read", ID], "what console.log makes of it is bun's", { mock: mock(canvas({ content: { a: 1 } })) });
// (Answers by what was asked, not by turn: the JavaScript asks from the start again.)
late("canvas read: --all when a page reports an error", ["canvas", "read", ID, "--all"], REPORTED, {
  mock: mock([rule("smartcanvas.read", ok({ error: "page gone" }), { next_token: "t1" }), canvas({ content: "a", next_token: "t1" })]),
});
late("canvas read: --all with a token that is not text", ["canvas", "read", ID, "--all"], "tokens are text", {
  mock: mock([rule("smartcanvas.read", ok({ content: "b" }), { next_token: 5 }), canvas({ content: "a", next_token: 5 })]),
});
late("canvas read: an answer that is null", ["canvas", "read", ID], REPORTED, { mock: mock(rule("smartcanvas.read", ok(null))) });
back("canvas read: without a document", ["canvas", "read"], YARGS, {});
back("canvas read: --size with text", ["canvas", "read", ID, "--size", "big"], YARGS, {});
back("canvas read: --all=true", ["canvas", "read", ID, "--all=true"], YARGS, {});
back("canvas: without a subcommand", ["canvas"], YARGS, {});

const blocks = (answer) => rule("smartcanvas.find", ok(answer));
add("canvas find: each block with its id, a blank line between", ["canvas", "find", ID, "needle"], {
  mock: mock(blocks({ blocks: [{ id: "block-1", content: "<p>needle one</p>" }, { id: "block-2", content: "多行\ncontent\n" }, { id: 3, content: "" }] })),
});
add("canvas find: one block", ["canvas", "find", ID, "two words"], { mock: mock(blocks({ blocks: [{ id: "only", content: "x" }] })) });
add("canvas find: a block without content or id", ["canvas", "find", ID, "x"], { mock: mock(blocks({ blocks: [{}] })) });
add("canvas find: nothing matches", ["canvas", "find", ID, "x"], { mock: mock(blocks({ blocks: [] })) });
add("canvas find: an answer without blocks", ["canvas", "find", ID, "x"], { mock: mock(blocks({})) });
add("canvas find: by address", ["canvas", "find", "https://docs.qq.com/aio/DZEZ6TEFiQmpGdUJy", "x"], { mock: mock(blocks({ blocks: [] })) });
late("canvas find: content that is not text", ["canvas", "find", ID, "x"], "what console.log makes of it is bun's", { mock: mock(blocks({ blocks: [{ id: "b", content: 5 }] })) });
late("canvas find: blocks that are not a list", ["canvas", "find", ID, "x"], REPORTED, { mock: mock(blocks({ blocks: "abc" })) });
back("canvas find: without a query", ["canvas", "find", ID], YARGS, {});

// ── raw, for tools that read ─────────────────────────────────────────────────

add("raw: a reading tool, the answer as JSON", ["raw", "manage.recent_online_file", "--json", '{"num":1,"count":3}'], { mock: mock(recent([planA, budget])) });
add("raw: without --json the arguments are empty", ["raw", "manage.folder_list"], { mock: mock(folderList({ list: folderItems, finish: true })) });
add("raw: --json=", ["raw", '--json={"file_id":"abc"}', "get_content"], { mock: mock(content("the text")) });
add("raw: the arguments go out the way JavaScript writes them", ["raw", "manage.search_file", "--json", ' { "b" : 1.0, "10": [ 1e3, -0 ], "a": "é\\u00e9", "2": null, "b": 2 } '], { mock: mock(found([])) });
add("raw: an answer that is null", ["raw", "get_content", "--json", "{}"], { mock: mock(rule("get_content", ok(null))) });
add("raw: an answer that is text in the content", ["raw", "smartcanvas.find", "--json", '{"file_id":"x","query":"y"}'], { mock: mock(rule("smartcanvas.find", text('{"blocks":[]}'))) });
add("raw: is counted", ["raw", "query_space_list"], { mock: mock(spaceList({ spaces: [] })), home: { ".qqdocs/usage.json": usageAt(79) } });
for (const tool of ["manage.get_privilege", "manage.import_progress", "manage.query_file_info", "manage.query_folder_meta", "query_space_node", "smartcanvas.read"]) {
  add(`raw: ${tool} is a reading tool`, ["raw", tool, "--json", '{"x":1}'], { mock: mock(rule(tool, ok({ tool }))) });
}
late("raw: the service reports an error", ["raw", "get_content", "--json", '{"file_id":"x"}'], REPORTED, { mock: mock(rule("get_content", rpcError("no such file"))) });
back("raw: arguments that are not a JSON object", ["raw", "get_content", "--json", "[1]"], REPORTED, { mock: mock(content("x")) });
back("raw: arguments that are not JSON", ["raw", "get_content", "--json", "{file_id:1}"], REPORTED, { mock: mock(content("x")) });
back("raw: arguments in quotes", ["raw", "get_content", "--json", '"{}"'], YARGS, { mock: mock(content("x")) });
back("raw: a tool that creates", ["raw", "manage.create_file", "--json", '{"title":"x","file_type":"doc"}'], "raw is ported for the tools that read only; a call that changes something is not repeated by a hand-back", {});
back("raw: a tool that deletes", ["raw", "manage.delete_file", "--json", '{"file_id":"x"}'], "raw is ported for the tools that read only; a call that changes something is not repeated by a hand-back", {});
back("raw: a tool nobody knows", ["raw", "some.future_tool"], "raw is ported for the tools that read only; a call that changes something is not repeated by a hand-back", {});
back("raw: without a tool", ["raw"], YARGS, {});
back("raw: --json twice", ["raw", "get_content", "--json", "{}", "--json", "{}"], YARGS, { mock: mock(content("x")) });

// ── sync ─────────────────────────────────────────────────────────────────────

const syncMock = (files, list) => mock([rule("manage.recent_online_file", ok({ files })), rule("manage.folder_list", ok({ list }))], [2]);
add("sync: recent documents and the root folder's, once each, folders left out", ["sync"], {
  mock: syncMock([planA, budget, planA], [...folderItems, { id: planA.file_id, is_folder: false, title: "Plan A again", url: "u" }]),
});
add("sync: nothing to cache", ["sync"], { mock: syncMock([], []) });
add("sync: answers without lists", ["sync"], { mock: mock([rule("manage.recent_online_file", ok({})), rule("manage.folder_list", ok({}))], [2]) });
add("sync: documents without a title or address", ["sync"], {
  mock: syncMock([{ file_id: "bare00000001" }, { file_id: "nulls0000001", file_name: null, file_url: null }], [{ id: "item00000001", url: "//docs.qq.com/doc/x" }]),
});
add("sync: replaces the cache that is there, both calls are counted", ["sync"], {
  mock: syncMock([planA], []),
  home: { ".qqdocs/cache.json": '[{"file_id":"old","title":"Old","url":"u"}]', ".qqdocs/usage.json": usageAt(78) },
});
back("sync: first run, no ~/.qqdocs yet", ["sync"], "the TypeScript's two counts cannot take a lock yet and overwrite each other; left to it", { mock: syncMock([planA], []), firstRun: true, racyCount: true });
// The TypeScript ends on the failed call while the other call's count is
// still being written: no usage.json, or one, or a lock file left behind.
late("sync: one of the two calls fails", ["sync"], REPORTED, { mock: mock([rule("manage.recent_online_file", ok({ files: [planA] })), rule("manage.folder_list", rpcError("busy"))], [2]), racyCount: true });
late("sync: a document without an id", ["sync"], "ids are text", { mock: syncMock([{ file_name: "no id" }], []) });
late("sync: a root item without an address", ["sync"], REPORTED, { mock: syncMock([], [{ id: "item00000001", title: "no address" }]) });
back("sync: a word after it", ["sync", "now"], YARGS, {});
back("sync: the cache file is a directory", ["sync"], "the TypeScript reports that it cannot write", { mock: syncMock([planA], []), setup: ["mkdir -p <HOME>/.qqdocs/cache.json"], late: true });

// ── what the service can answer instead ──────────────────────────────────────

const failing = (reply) => mock(rule("manage.recent_online_file", reply));
late("service: HTTP 401 with a JSON-RPC error", ["ls"], REPORTED, { mock: failing({ status: 401, body: '{"error":{"message":"invalid token"}}' }) });
late("service: HTTP 403 with a page", ["ls"], REPORTED, { mock: failing({ status: 403, body: "<html>Forbidden</html>" }) });
late("service: HTTP 404 with nothing", ["ls", "--json"], REPORTED, { mock: failing({ status: 404, body: "" }) });
late("service: HTTP 500 on every attempt (the TypeScript tries four times)", ["ls"], REPORTED, { mock: failing({ status: 500, headers: { "retry-after": "0" }, body: "boom" }) });
late("service: HTTP 429 once, then an answer (the TypeScript tries again)", ["ls"], "a status the TypeScript retries; Rust leaves the retrying to it", {
  mock: mock(rule("manage.recent_online_file", [{ status: 429, headers: { "retry-after": "0" }, body: "slow down" }, ok({ files: [planA] })])),
});
late("service: HTTP 503 once, then an answer, with the usual back-off", ["search", "x"], "a status the TypeScript retries; Rust leaves the retrying to it", {
  mock: mock(rule("manage.search_file", [{ status: 503, body: "" }, ok({ list: hits })])),
});
late("service: a redirect", ["ls"], "fetch's own redirect rules", { mock: failing({ status: 302, headers: { location: "/openapi/elsewhere" }, body: "" }) });
late("service: the connection is closed once, then an answer (the TypeScript tries again)", ["ls"], "no connection is reported, or retried, by the TypeScript", {
  mock: mock(rule("manage.recent_online_file", [{ drop: true }, ok({ files: [planA] })])),
});
late("service: a JSON-RPC error", ["ls"], REPORTED, { mock: failing(rpcError("quota exceeded")) });
late("service: a JSON-RPC error with data.message", ["search", "x"], REPORTED, { mock: mock(rule("manage.search_file", rpcError("outer", { data: { message: "inner detail" } }))) });
late("service: a body that is not JSON", ["ls"], REPORTED, { mock: failing(raw("<html>maintenance</html>")) });
late("service: a body that is a JSON list", ["ls"], REPORTED, { mock: failing(raw("[1,2]")) });
late("service: an empty body", ["ls"], REPORTED, { mock: failing(raw("")) });
late("service: an answer without a result", ["ls"], REPORTED, { mock: failing({}) });
late("service: content text that is not JSON", ["ls"], REPORTED, { mock: failing(text("plain words")) });
late("service: content text that is a number", ["ls"], "JSON.parse turns it into text first", { mock: failing({ result: { content: [{ type: "text", text: 5 }] } }) });
late("service: a string with half a surrogate pair", ["ls", "--json"], "only JavaScript strings hold half a pair", {
  mock: failing(raw('{"jsonrpc":"2.0","id":1,"result":{"structuredContent":{"files":[{"file_name":"\\ud83d"}]}}}')),
});
late("service: no rule in the stand-in (an unknown tool)", ["ls"], REPORTED, { mock: mock([]) });
add("service: an `error` that is null is no error", ["ls"], { mock: failing(raw('{"jsonrpc":"2.0","id":1,"error":null,"result":{"structuredContent":{"files":[]}}}')) });
add("service: a result that is a number has no content", ["ls"], { mock: failing({ result: 5 }) });
add("service: content whose first part has no text", ["ls"], { mock: failing({ result: { content: [{ type: "image" }, { type: "text", text: '{"files":[1]}' }] } }) });
add("service: structured content wins over content text", ["ls", "--json"], {
  mock: failing({ result: { content: [{ type: "text", text: '{"files":["from text"]}' }], structuredContent: { files: ["structured"] } } }),
});
add("service: an answer with white space around it", ["ls", "--json"], {
  mock: failing(raw(' \n{"jsonrpc":"2.0","id":1,"result":{"structuredContent":{"files":[]}}}\n ')),
});

// ── usage ────────────────────────────────────────────────────────────────────

add("usage: nothing counted yet", ["usage"], {});
add("usage: first run, no ~/.qqdocs yet, creates nothing", ["usage"], { firstRun: true });
add("usage: needs no token", ["usage"], { env: { TENCENT_DOCS_TOKEN: null }, home: { ".qqdocs/usage.json": usageAt(12) } });
add("usage: today and this month against the free quota", ["usage"], { home: { ".qqdocs/usage.json": '{"daily":{"@TODAY@":37,"2001-01-01":99},"monthly":{"@MONTH@":4321,"2001-01":5}}' } });
add("usage: over the quota", ["usage"], { home: { ".qqdocs/usage.json": '{"daily":{"@TODAY@":150},"monthly":{"@MONTH@":25000}}' } });
add("usage: an inferred tier", ["usage"], { home: { ".qqdocs/usage.json": usageAt(150, ',"inferredTier":"member"') } });
add("usage: an inferred tier of plus", ["usage"], { home: { ".qqdocs/usage.json": usageAt(1500, ',"inferredTier":"plus"') } });
add("usage: an inferred tier of free is not mentioned", ["usage"], { home: { ".qqdocs/usage.json": usageAt(5, ',"inferredTier":"free"') } });
add("usage: --tier", ["usage", "--tier", "plus"], { home: { ".qqdocs/usage.json": usageAt(150, ',"inferredTier":"member"') } });
add("usage: --tier=", ["usage", "--tier=member"], { home: { ".qqdocs/usage.json": usageAt(995) } });
add("usage: --tier free over an inferred one", ["usage", "--tier", "free"], { home: { ".qqdocs/usage.json": usageAt(50, ',"inferredTier":"plus"') } });
add("usage: the tier of ~/.qqdocs/config.yaml", ["usage"], { home: { ".qqdocs/usage.json": usageAt(150), ".qqdocs/config.yaml": "# 我的配置\n\ndefaultPerm: link-read\ntier: member\n" } });
add("usage: --tier over the tier of config.yaml", ["usage", "--tier", "plus"], { home: { ".qqdocs/usage.json": usageAt(150), ".qqdocs/config.yaml": "tier: member" } });
add("usage: a config.yaml without a tier", ["usage"], { home: { ".qqdocs/usage.json": usageAt(150), ".qqdocs/config.yaml": "defaultDocType: smartcanvas\ndefaultFormat: markdown\n" } });
add("usage: an empty config.yaml", ["usage"], { home: { ".qqdocs/config.yaml": "" } });
add("usage: ~/.qqdocs.config.yaml", ["usage"], { home: { ".qqdocs.config.yaml": "tier: plus\n", ".qqdocs/usage.json": usageAt(1900) } });
add("usage: ~/.qqdocs/config.yaml is read before ~/.qqdocs.config.yaml", ["usage"], { home: { ".qqdocs.config.yaml": "tier: plus\n", ".qqdocs/config.yaml": "tier: member\n" } });
add("usage: .qqdocs/config.yaml in the current directory comes first", ["usage"], {
  files: { ".qqdocs/config.yaml": "tier: plus\n", ".qqdocs.config.yaml": "tier: free\n" },
  home: { ".qqdocs/config.yaml": "tier: member\n" },
});
add("usage: .qqdocs.config.yaml in the current directory comes before the home directory's", ["usage"], {
  files: { ".qqdocs.config.yaml": "defaultSpace: abc\n" },
  home: { ".qqdocs/config.yaml": "tier: member\n" },
});
add("usage: a counter file that is not JSON counts as empty", ["usage"], { home: { ".qqdocs/usage.json": "{{{" } });
add("usage: counts that are fractions", ["usage"], { home: { ".qqdocs/usage.json": '{"daily":{"@TODAY@":12.5},"monthly":{"@MONTH@":0.4}}' } });
back("usage: the day starts in the local zone, far east", ["usage"], ZONE, { env: { TZ: "Pacific/Kiritimati" }, home: { ".qqdocs/usage.json": usageAt(41) } });
back("usage: the day starts in the local zone, far west", ["usage"], ZONE, { env: { TZ: "Pacific/Pago_Pago" }, home: { ".qqdocs/usage.json": usageAt(42) } });
back("usage: the day starts in the local zone, Tokyo", ["usage"], ZONE, { env: { TZ: "Asia/Tokyo" }, home: { ".qqdocs/usage.json": usageAt(43) } });
// Answered by the binary on Linux where the machine's own zone is UTC (see the top).
add("usage: the system's zone when TZ is not set", ["usage"], { env: { TZ: null }, handback: { darwin: MAC_ZONE }, home: { ".qqdocs/usage.json": usageAt(44) } });
back("usage: a negative count", ["usage"], "the progress bar throws in the TypeScript", { home: { ".qqdocs/usage.json": usageAt(-5) } });
back("usage: a counter file of another shape", ["usage"], "the TypeScript's arithmetic on a file of another shape is not reproduced", { home: { ".qqdocs/usage.json": '{"daily":[]}' } });
back("usage: TZ in POSIX notation", ["usage"], ZONE, { env: { TZ: "JST-9" }, home: { ".qqdocs/usage.json": usageAt(5) } });
back("usage: TZ that names no zone", ["usage"], ZONE, { env: { TZ: "Mars/Olympus" } });
back("usage: TZ with a colon in front", ["usage"], ZONE, { env: { TZ: ":Asia/Tokyo" }, home: { ".qqdocs/usage.json": usageAt(5) } });
back("usage: a tier that does not exist", ["usage", "--tier", "gold"], YARGS, {});
back("usage: a word after it", ["usage", "today"], YARGS, {});
back("usage: --help", ["usage", "--help"], YARGS, {});
for (const [what, yaml] of [
  ["a quoted tier", 'tier: "member"\n'],
  ["a tier that is not one of the three", "tier: gold\n"],
  ["a tier that is a number", "tier: 1\n"],
  ["a comment after a value", "tier: member # paid\n"],
  ["nested keys", "defaults:\n  perm: private\ntier: member\n"],
  ["a list", "tags: [a, b]\ntier: member\n"],
  ["a document marker", "---\ntier: member\n"],
  ["Windows line ends", "tier: member\r\n"],
  ["the same key twice", "tier: free\ntier: plus\n"],
  ["YAML that does not parse", "tier: [member\n"],
  ["a single word", "member\n"],
]) {
  back(`usage: config.yaml with ${what}`, ["usage"], "YAML beyond plain `key: value` lines is left to the YAML parser", { home: { ".qqdocs/config.yaml": yaml, ".qqdocs/usage.json": usageAt(150) } });
}
back("usage: a config.yaml that is a directory", ["usage"], "the TypeScript fails reading it, in bun's words", { setup: ["mkdir -p <HOME>/.qqdocs/config.yaml"] });

// usage calibrate
add("calibrate: --today sets the day and moves the month by the difference", ["usage", "calibrate", "--today", "42"], { home: { ".qqdocs/usage.json": '{"daily":{"@TODAY@":10},"monthly":{"@MONTH@":300}}' } });
add("calibrate: --today below the current count lowers the month", ["usage", "calibrate", "--today", "2"], { home: { ".qqdocs/usage.json": '{"daily":{"@TODAY@":10},"monthly":{"@MONTH@":300}}' } });
add("calibrate: the month does not go below zero", ["usage", "calibrate", "--today", "0"], { home: { ".qqdocs/usage.json": '{"daily":{"@TODAY@":10},"monthly":{"@MONTH@":3}}' } });
add("calibrate: --month alone", ["usage", "calibrate", "--month", "1234"], { home: { ".qqdocs/usage.json": usageAt(10) } });
add("calibrate: --today and --month", ["usage", "calibrate", "--today=7", "--month=70"], { home: { ".qqdocs/usage.json": usageAt(10) } });
add("calibrate: --tier alone", ["usage", "calibrate", "--tier", "plus"], { home: { ".qqdocs/usage.json": usageAt(10) } });
add("calibrate: --tier can lower the tier", ["usage", "calibrate", "--tier=free"], { home: { ".qqdocs/usage.json": usageAt(10, ',"inferredTier":"plus"') } });
add("calibrate: --today over 100 infers member", ["usage", "calibrate", "--today", "101"], {});
add("calibrate: --today over 1000 infers plus", ["usage", "calibrate", "--today", "1001"], { home: { ".qqdocs/usage.json": usageAt(10, ',"inferredTier":"member"') } });
add("calibrate: --today with --tier infers nothing", ["usage", "calibrate", "--today", "5000", "--tier", "free"], {});
add("calibrate: a lower --today leaves the tier", ["usage", "calibrate", "--today", "1"], { home: { ".qqdocs/usage.json": usageAt(500, ',"inferredTier":"member"') } });
add("calibrate: nothing given rewrites the file as it is", ["usage", "calibrate"], { home: { ".qqdocs/usage.json": '{"monthly":{"2001-01":1},"daily":{"2001-01-01":1},"other":1.0}' } });
add("calibrate: first run creates ~/.qqdocs", ["usage", "calibrate", "--today", "9"], { firstRun: true });
add("calibrate: old days are kept", ["usage", "calibrate", "--today", "3"], { home: { ".qqdocs/usage.json": '{"daily":{"2001-01-01":1,"2001-01-02":2,"2001-01-03":3,"2001-01-04":4,"2001-01-05":5,"2001-01-06":6,"2001-01-07":7,"2001-01-08":8},"monthly":{}}' } });
add("calibrate: is silent about the quota", ["usage", "calibrate", "--today", "99"], {});
back("calibrate: a negative --today", ["usage", "calibrate", "--today", "-5"], YARGS, {});
back("calibrate: a fraction", ["usage", "calibrate", "--today", "1.5"], YARGS, {});
back("calibrate: text for a number", ["usage", "calibrate", "--month", "lots"], YARGS, {});
back("calibrate: a tier that does not exist", ["usage", "calibrate", "--tier", "gold"], YARGS, {});
back("calibrate: an option it does not have", ["usage", "calibrate", "--yesterday", "5"], YARGS, {});
back("calibrate: a counter file of another shape", ["usage", "calibrate", "--today", "5"], "the TypeScript's arithmetic on a file of another shape is not reproduced", { home: { ".qqdocs/usage.json": '"text"' } });

// ── where the token comes from ───────────────────────────────────────────────

const lsMock = mock(recent([planA]));
const NO_TOKEN = { TENCENT_DOCS_TOKEN: null };
add("token: from ~/.qqdocs/.env.local", ["ls"], { mock: lsMock, env: NO_TOKEN, home: { ".qqdocs/.env.local": "TENCENT_DOCS_TOKEN=fake-from-home\n" } });
add("token: ~/.qqdocs/.env.local with comments, other lines and blanks around", ["ls"], {
  mock: lsMock,
  env: NO_TOKEN,
  home: { ".qqdocs/.env.local": "# Tencent Docs\r\nOTHER=1\r\n\r\n  TENCENT_DOCS_TOKEN =  fake-padded  \r\nTENCENT_DOCS_TOKEN=fake-second\r\n" },
});
add("token: ~/.qqdocs/.env.local keeps quotes as part of the token", ["ls"], { mock: lsMock, env: NO_TOKEN, home: { ".qqdocs/.env.local": 'TENCENT_DOCS_TOKEN="fake-quoted"\n' } });
add("token: ~/.qqdocs/.env.local keeps a trailing comment as part of the token", ["ls"], { mock: lsMock, env: NO_TOKEN, home: { ".qqdocs/.env.local": "TENCENT_DOCS_TOKEN=fake-token # mine\n" } });
add("token: the environment wins over ~/.qqdocs/.env.local", ["ls"], { mock: lsMock, home: { ".qqdocs/.env.local": "TENCENT_DOCS_TOKEN=fake-from-home\n" } });
add("token: from .env in the current directory", ["ls"], { mock: lsMock, env: NO_TOKEN, files: { ".env": "TENCENT_DOCS_TOKEN=fake-from-dotenv\n" } });
add("token: from .env.local in the current directory", ["ls"], { mock: lsMock, env: NO_TOKEN, files: { ".env.local": "# local\nTENCENT_DOCS_TOKEN=fake-from-dotenv-local\nOTHER=x y z\n" } });
add("token: .env.local wins over .env", ["ls"], { mock: lsMock, env: NO_TOKEN, files: { ".env": "TENCENT_DOCS_TOKEN=fake-from-dotenv\n", ".env.local": "TENCENT_DOCS_TOKEN=fake-from-dotenv-local\n" } });
add("token: .env.development.local wins over .env.local", ["ls"], {
  mock: lsMock,
  env: NO_TOKEN,
  files: { ".env.development.local": "TENCENT_DOCS_TOKEN=fake-dev-local\n", ".env.local": "TENCENT_DOCS_TOKEN=fake-local\n", ".env.development": "TENCENT_DOCS_TOKEN=fake-dev\n" },
});
add("token: .env.development wins over .env", ["ls"], { mock: lsMock, env: NO_TOKEN, files: { ".env.development": "TENCENT_DOCS_TOKEN=fake-dev\n", ".env": "TENCENT_DOCS_TOKEN=fake-plain\n" } });
add("token: .env.production is not read", ["ls"], { mock: lsMock, env: NO_TOKEN, files: { ".env.production": "TENCENT_DOCS_TOKEN=fake-production\n", ".env": "TENCENT_DOCS_TOKEN=fake-plain\n" } });
add("token: the current directory wins over ~/.qqdocs/.env.local", ["ls"], {
  mock: lsMock,
  env: NO_TOKEN,
  files: { ".env.local": "TENCENT_DOCS_TOKEN=fake-from-cwd\n" },
  home: { ".qqdocs/.env.local": "TENCENT_DOCS_TOKEN=fake-from-home\n" },
});
add("token: the environment wins over .env", ["ls"], { mock: lsMock, files: { ".env": "TENCENT_DOCS_TOKEN=fake-from-dotenv\n" } });
add("token: a quoted token in .env loses its quotes", ["ls"], { mock: lsMock, env: NO_TOKEN, files: { ".env": 'TENCENT_DOCS_TOKEN="fake-quoted-dotenv"\n' } });
add("token: a comment after the token in .env is dropped", ["ls"], { mock: lsMock, env: NO_TOKEN, files: { ".env": "TENCENT_DOCS_TOKEN=fake-commented # mine\n" } });
add("token: a .env about other things changes nothing", ["ls"], { mock: lsMock, files: { ".env": "# a project's settings\nDATABASE_URL=postgres://user:pw@localhost:5432/db\nDEBUG=true\nNAME='two words'\n" } });
add("token: a token with a blank inside", ["ls"], { mock: lsMock, env: { TENCENT_DOCS_TOKEN: "Bearer fake-token" } });
back("token: none anywhere", ["ls"], REPORTED, { mock: lsMock, env: NO_TOKEN });
back("token: empty in the environment", ["ls"], REPORTED, { mock: lsMock, env: { TENCENT_DOCS_TOKEN: "" }, home: { ".qqdocs/.env.local": "TENCENT_DOCS_TOKEN=fake-from-home\n" } });
back("token: empty in ~/.qqdocs/.env.local", ["ls"], REPORTED, { mock: lsMock, env: NO_TOKEN, home: { ".qqdocs/.env.local": "TENCENT_DOCS_TOKEN=\n" } });
back("token: with blanks around it in the environment", ["ls"], "fetch's own rules for header values", { mock: lsMock, env: { TENCENT_DOCS_TOKEN: " fake-token " } });
back("token: not ASCII", ["ls"], "fetch's own rules for header values", { mock: lsMock, env: { TENCENT_DOCS_TOKEN: "fake-令牌" } });
back("token: ~/.qqdocs/.env.local is a directory", ["ls"], "the TypeScript fails reading it, in bun's words", { mock: lsMock, setup: ["mkdir -p <HOME>/.qqdocs/.env.local"] });
for (const [what, dotenv] of [
  ["a variable reference", "BASE=fake\nTENCENT_DOCS_TOKEN=$BASE-token\n"],
  ["an escape in quotes", 'TENCENT_DOCS_TOKEN="fake-\\ntoken"\n'],
  ["export", "export TENCENT_DOCS_TOKEN=fake-exported\n"],
  ["a value over two lines", 'NOTE="two\nlines"\nTENCENT_DOCS_TOKEN=fake-token\n'],
  ["a blank before the equals sign", "TENCENT_DOCS_TOKEN =fake-token\n"],
  ["a line without an equals sign", "TENCENT_DOCS_TOKEN\n"],
  ["the same key twice", "TENCENT_DOCS_TOKEN=fake-one\nTENCENT_DOCS_TOKEN=fake-two\n"],
  ["NODE_ENV", "NODE_ENV=production\n"],
  ["TZ", "TZ=Asia/Tokyo\n"],
  ["a proxy", "HTTPS_PROXY=http://127.0.0.1:9\n"],
  ["QQDOCS_NO_NATIVE", "QQDOCS_NO_NATIVE=1\n"],
]) {
  back(`token: a .env with ${what}`, ["ls"], "a .env in syntax bun interprets, or one that steers bun, is left to bun", { mock: lsMock, files: { ".env": dotenv } });
}
back("token: a .env.local with a variable reference, even with the token in the environment", ["ls"], "a .env in syntax bun interprets, or one that steers bun, is left to bun", {
  mock: lsMock,
  files: { ".env.local": "GREETING=hello $USER\n" },
});

// ── states of the machine that go back ───────────────────────────────────────

back("machine: QQDOCS_NO_NATIVE=1 hands everything back", ["ls"], "the way out for users", { mock: lsMock, env: { QQDOCS_NO_NATIVE: "1" } });
back("machine: QQDOCS_NO_NATIVE=1, usage", ["usage"], "the way out for users", { env: { QQDOCS_NO_NATIVE: "1" } });
back("machine: bunfig.toml in the current directory", ["ls"], "bun's own configuration", { mock: lsMock, files: { "bunfig.toml": "[run]\nsilent = true\n" } });
back("machine: .bunfig.toml in the home directory", ["ls"], "bun's own configuration", { mock: lsMock, home: { ".bunfig.toml": "telemetry = false\n" } });
back("machine: NODE_ENV is set", ["ls"], "it changes which .env files bun loads", { mock: lsMock, env: { NODE_ENV: "production" } });
back("machine: BUN_OPTIONS is set", ["ls"], "extra options for bun", { mock: lsMock, env: { BUN_OPTIONS: "--smol" } });
back("machine: an HTTPS proxy is set", ["ls"], "fetch's own proxy rules", { mock: lsMock, env: { HTTPS_PROXY: "http://127.0.0.1:9" } });
back("machine: a lower-case https_proxy is set", ["ls"], "fetch's own proxy rules", { mock: lsMock, env: { https_proxy: "http://127.0.0.1:9" } });
back("machine: NODE_TLS_REJECT_UNAUTHORIZED is set", ["ls"], "the runtime's own certificate rules", { mock: lsMock, env: { NODE_TLS_REJECT_UNAUTHORIZED: "1" } });
back("machine: SSL_CERT_FILE is set", ["ls"], "the runtime's own certificate rules", { mock: lsMock, env: { SSL_CERT_FILE: "/nonexistent.pem" } });
add("machine: BUN_INSTALL is set, as bun's installer does", ["ls"], { mock: lsMock, env: { BUN_INSTALL: "<HOME>/../bun" } });
add("machine: NO_PROXY alone is set", ["ls"], { mock: lsMock, env: { NO_PROXY: "localhost" } });
add("machine: LANG is Chinese", ["ls"], { mock: lsMock, env: { LANG: "zh_CN.UTF-8", LC_ALL: "zh_CN.UTF-8" }, home: { ".qqdocs/usage.json": usageAt(96) } });

// ── what yargs answers ───────────────────────────────────────────────────────

back("cli: no command", [], YARGS, {});
back("cli: --help", ["--help"], YARGS, {});
back("cli: -h", ["-h"], YARGS, {});
back("cli: --version", ["--version"], YARGS, {});
back("cli: an unknown command", ["frobnicate"], YARGS, {});
back("cli: completion", ["completion"], YARGS, {});
back("cli: a command in capitals", ["LS"], YARGS, { mock: lsMock });
back("cli: tools --help", ["tools", "--help"], YARGS, {});
back("cli: --version after a command", ["usage", "--version"], YARGS, {});

// ── commands that stay in the JavaScript ─────────────────────────────────────
// The stand-in has no rule for their tools, so each ends with the same
// reported error on both sides; the point is that the binary hands them back.

for (const args of [
  ["rename", ID, "New title"],
  ["mv", ID, "New title"],
  ["cp", ID],
  ["copy", ID, "--title", "Copy"],
  ["delete", ID],
  ["rm", ID, "--confirm", "1234"],
  ["import", "missing.md"],
  ["upload", "missing.docx"],
  ["perm", "set", ID, "link-read"],
  ["space", "create", "A space"],
  ["space", "mkdir", "space000001", "Folder"],
  ["space", "mkdoc", "space000001", "Doc"],
  ["space", "link", "space000001", "Link", "https://example.com"],
  ["space", "rm", "space000001", "node0001"],
  ["space", "move", ID, "space000001"],
  ["canvas", "edit", ID, "delete", "--id", "block1"],
  ["flowchart", "A chart", "--mermaid", "graph TD; A-->B"],
  ["flowchart", "A chart"],
  ["create", "A document"],
]) {
  back(`not ported: ${args.join(" ")}`, args, NOT_PORTED, {});
}

// ── the word help ────────────────────────────────────────────────────────────
// yargs prints a command's help when the last word that is not an option or
// an option's value is `help`. (The verification's cases further down have
// one per command.) The binary leaves the word to yargs wherever it stands.

back("help: ls -d help", ["ls", "-d", "help"], HELP, { mock: mock([recent([planA]), rule("manage.folder_list", ok({ list: [] }))]) });
back("help: canvas read as the value of --page", ["canvas", "read", ID, "--page", "help"], HELP, { mock: mock(rule("smartcanvas.read", ok({ content: "x" }))) });
back("help: usage help", ["usage", "help"], HELP, {});
back("help: sync help", ["sync", "help"], HELP, {});
back("help: raw get_content help", ["raw", "get_content", "help"], HELP, {});
back("help: space list help", ["space", "list", "help"], HELP, {});
add("help: inside a value given with =, it is that value", ["space", "ls", "S", "--parent=help"], { mock: mock(rule("query_space_node", ok({ children: [] }))) });
add("help: as part of a longer word", ["search", "helpdesk"], { mock: mock(found([])) });
add("help: with blanks around it, it is a query", ["search", " help "], { mock: mock(found([])) });

// ── project files ────────────────────────────────────────────────────────────
// bun reads package.json, tsconfig.json and jsconfig.json of the current
// directory and of every directory above it before the program starts, and
// writes to standard error what it finds wrong with them. A directory inside
// a project is handed back, whatever the files hold.

const lsOnce = mock(recent([planA]));
back("project: an ordinary package.json in the current directory", ["ls"], PROJECT, {
  mock: lsOnce,
  files: { "package.json": '{\n  "name": "some-project",\n  "version": "1.0.0",\n  "type": "module",\n  "scripts": { "test": "bun test" },\n  "dependencies": { "yargs": "^18.0.0" }\n}\n' },
});
back("project: an ordinary package.json in the directory above", ["usage"], PROJECT, { setup: ['printf \'{"name":"above"}\' > ../package.json'] });
back("project: a tsconfig.json as `tsc --init` writes it, with comments", ["ls"], PROJECT, {
  mock: lsOnce,
  files: { "tsconfig.json": '{\n  // Visit https://aka.ms/tsconfig to read more about this file\n  "compilerOptions": {\n    "target": "es2022", /* comment */\n    "strict": true,\n  }\n}\n' },
});
back("project: a tsconfig.json in the directory above", ["usage"], PROJECT, { setup: ["printf '{}' > ../tsconfig.json"] });
back("project: a jsconfig.json in the directory above that does not parse", ["usage"], PROJECT, { setup: ["printf 'nope' > ../jsconfig.json"] });
back("project: a tsconfig.json of no bytes", ["usage"], PROJECT, { files: { "tsconfig.json": "" } });
back("project: a package.json with a type bun does not know", ["usage"], PROJECT, { files: { "package.json": '{"type":"weird"}' } });
back("project: a package.json with a key twice", ["usage"], PROJECT, { files: { "package.json": '{"name":"a","name":"b"}' } });
back("project: a package.json with exports bun warns about", ["ls"], PROJECT, { mock: lsOnce, files: { "package.json": '{"exports":{"x":"y","./z":"w"}}' } });
back("project: a tsconfig.json that extends a file that does not parse", ["usage"], PROJECT, { files: { "tsconfig.json": '{"extends":"./base.json"}', "base.json": "{ bad" } });
back("project: package.json is a link to nowhere", ["usage"], PROJECT, { setup: ["ln -s /nonexistent/package.json package.json"] });
back("project: package.json is a directory", ["usage"], PROJECT, { setup: ["mkdir package.json"] });
add("project: files of other names are not read", ["ls"], {
  mock: lsOnce,
  files: { "package.json5": "{ bad", "package-lock.json": "{ bad", "bun.lock": "{ bad", "tsconfig.base.json": "{ bad", ".npmrc": "{ bad", "deno.json": "{ bad", "sub/package.json": "{ bad", "node_modules/x/package.json": "{ bad" },
});

// ── the zone ─────────────────────────────────────────────────────────────────
// The call counter is kept per local day. bun takes the local day from the
// zone data built into it, which is not the data in /usr/share/zoneinfo (for
// America/Vancouver, bun 1.4.0 and tzdata 2026b are an hour apart). The
// binary works the day out only for zones that are a fixed number of hours
// from UTC by their name; a machine in any other zone is handed back.

add("zone: Etc/GMT-14, where the day starts first", ["usage"], { env: { TZ: "Etc/GMT-14" }, home: { ".qqdocs/usage.json": usageAt(41) } });
add("zone: Etc/GMT+12, where the day starts last", ["usage"], { env: { TZ: "Etc/GMT+12" }, home: { ".qqdocs/usage.json": usageAt(42) } });
add("zone: Etc/UTC", ["usage"], { env: { TZ: "Etc/UTC" }, home: { ".qqdocs/usage.json": usageAt(43) } });
add("zone: Etc/GMT-8, a call is counted on the local day and warned about", ["ls"], { mock: lsOnce, env: { TZ: "Etc/GMT-8" }, home: { ".qqdocs/usage.json": usageAt(79) } });
add("zone: Etc/GMT+5, both calls of read are counted on the local day", ["read", ID], { mock: readMock(), env: { TZ: "Etc/GMT+5" }, home: { ".qqdocs/usage.json": usageAt(10) } });
for (let hours = 1; hours <= 14; hours++) {
  add(`zone: Etc/GMT-${hours}, the day of a calibration`, ["usage", "calibrate", "--today", String(hours)], { env: { TZ: `Etc/GMT-${hours}` } });
  if (hours <= 12) add(`zone: Etc/GMT+${hours}, the day of a calibration`, ["usage", "calibrate", "--today", String(hours)], { env: { TZ: `Etc/GMT+${hours}` } });
}
for (const zone of ["Asia/Shanghai", "America/Vancouver", "America/New_York", "Europe/Berlin", "Asia/Kathmandu"]) {
  back(`zone: ${zone}, usage`, ["usage"], ZONE, { env: { TZ: zone }, home: { ".qqdocs/usage.json": usageAt(7) } });
}
back("zone: America/Vancouver, a call", ["ls"], ZONE, { mock: lsOnce, env: { TZ: "America/Vancouver" }, home: { ".qqdocs/usage.json": usageAt(7) } });
back("zone: Asia/Shanghai, tools", ["tools"], ZONE, { mock: tools(toolList), env: { TZ: "Asia/Shanghai" } });
for (const zone of ["Etc/GMT", "Etc/GMT+0", "Etc/GMT-0", "Etc/GMT0", "Etc/GMT+13", "Etc/GMT-15", "Etc/GMT+01", "GMT", "UCT", "Etc/Universal", "Zulu", "utc", "UTC0", "UTC+8", "+08:00", " UTC", ""]) {
  back(`zone: TZ=${JSON.stringify(zone)} is not one of the names taken`, ["usage", "calibrate", "--today", "2"], ZONE, { env: { TZ: zone } });
}

// ── the cases of the verification ────────────────────────────────────────────
{
  const add = (name, args, o = {}) => cases.push(make(`x ${name}`, args, o));
  const back = (name, args, why, o = {}) => cases.push(make(`x ${name}`, args, { ...o, handback: why }));
  const late = (name, args, why, o = {}) => cases.push(make(`x ${name}`, args, { ...o, handback: why, late: true }));

  const planA = { file_id: "dFzLAbBjFuBr", file_name: "Plan A", file_url: "https://docs.qq.com/doc/DZEZ6TEFiQmpGdUJy" };
  const budget = { file_id: "sheetBudget01", file_name: "预算 2026", file_url: "https://docs.qq.com/sheet/DSheetBudget01" };
  const recent = (files) => rule("manage.recent_online_file", ok({ files }));
  const usageAt = (today, more = "") => `{"daily":{"@TODAY@":${today}},"monthly":{"@MONTH@":${today}}${more}}`;
  const tools = (list) => mock(listRule({ result: { tools: list } }));
  const searchHits = (list, where) => rule("manage.search_file", ok({ list }), where);
  const infoOf = (id, info) => rule("manage.query_file_info", ok(info), { file_id: id });
  const folderList = (answer, where) => rule("manage.folder_list", ok(answer), where);

  // ── arguments yargs might read differently ───────────────────────────────────
  const someTools = [{ name: "completion", description: "completion usage true 0 null" }, { name: "other", description: "Other I thing" }];
  for (const word of ["completion", "0", "true", "false", "null", "undefined", "__proto__", "constructor", "1e3", "007", "0x10", "-", "a=b", "--", "—json", "@file", "%s", "$HOME", "~", "*", "\\", "a b  c", "\ta\t", "I"]) {
    if (word === "-" || word === "--") continue;
    add(`tools: the pattern ${JSON.stringify(word)}`, ["tools", word], { mock: tools(someTools) });
  }
  add('tools: a pattern in double quotes', ["tools", '"other"'], { mock: tools([...someTools, { name: 'q', description: 'say "other" twice' }]) });
  add("tools: a pattern in single quotes", ["tools", "'other'"], { mock: tools([...someTools, { name: "q", description: "say 'other' twice" }]) });
  add("tools: a pattern that is blanks only matches everything", ["tools", " \t "], { mock: tools(someTools) });
  add("tools: a pattern with a line break in it", ["tools", "a\nb"], { mock: tools(someTools) });
  add("tools: white space JavaScript knows and white space it does not, in a description", ["tools"], {
    mock: tools([
      { name: "nbsp", description: "a  b　c d e﻿f g h i j" },
      { name: "not-space", description: "a\u0085b᠎c​d\u001ce\u001ff" },
      { name: "edges", description: " ﻿　 padded   " },
      { name: "empty", description: "" },
      { name: "blank", description: " \n\t " },
    ]),
  });
  add("tools: descriptions of exactly 100, 101 and 103 units with pairs before the cut", ["tools"], {
    mock: tools([
      { name: "a", description: `${"😀".repeat(48)}xyzw` },
      { name: "b", description: `${"😀".repeat(48)}xyzwv` },
      { name: "c", description: `${"😀".repeat(48)}x${"y".repeat(6)}` },
      { name: "d", description: `${"x".repeat(95)}😀${"y".repeat(10)}` },
    ]),
  });
  add("tools: names and descriptions spelled with escapes, numbers spelled oddly", ["tools"], {
    mock: mock(listRule(rawResult('{"tools":[{"name":"a\\u0041\\ud83d\\ude00\\/","description":"x\\/y\\u00e9\\t\\u0020z"},{"name":1.50,"description":"n"},{"name":1e21},{"name":-0},{"name":1E2},{"name":0.000001},{"name":1e-7},{"name":false,"name":"last wins"}]}'))),
  });
  add("tools: a pattern with a capital I under a Turkish locale", ["tools", "I"], { mock: tools(someTools), env: { LC_ALL: "tr_TR.UTF-8", LANG: "tr_TR.UTF-8" } });
  add("tools: FORCE_COLOR and NO_COLOR are set", ["tools"], { mock: tools(someTools), env: { FORCE_COLOR: "1", TERM: "xterm-256color", COLORTERM: "truecolor" } });
  add("tools: answered with HTTP 201", ["tools"], { mock: mock(listRule(rawResult('{"tools":[{"name":"t"}]}', 201))) });
  add("tools: answered with HTTP 299", ["tools"], { mock: mock(listRule(rawResult('{"tools":[{"name":"t"}]}', 299))) });
  add("tools: an `error` of 0, false or an empty string is no error", ["tools"], { mock: mock(listRule(raw('{"error":0,"result":{"tools":[{"name":"zero"}]}}'))) });
  add("tools: an `error` that is an empty string", ["tools"], { mock: mock(listRule(raw('{"result":{"tools":[{"name":"empty"}]},"error":""}'))) });
  late("tools: an `error` that is an empty object", ["tools"], REPORTED, { mock: mock(listRule(raw('{"error":{},"result":{"tools":[{"name":"x"}]}}'))) });
  add("tools: the answer has `result` twice", ["tools"], { mock: mock(listRule(raw('{"result":{"tools":[{"name":"first"}]},"result":{"tools":[{"name":"second"}]}}'))) });
  add("tools: a body with a JSON answer and no content type", ["tools"], { mock: mock(listRule({ status: 200, body: ' \n{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"plain"}]}}\r\n\t ' })) });
  late("tools: a body that starts with a byte order mark", ["tools"], "res.text() has its own rule for it", { mock: mock(listRule({ status: 200, body: '﻿{"result":{"tools":[{"name":"bom"}]}}' })) });
  late("tools: an answer nested 300 deep", ["tools"], "left to the JavaScript", { mock: mock(listRule(raw(`{"result":{"tools":[{"name":"deep","x":${"[".repeat(300)}${"]".repeat(300)}}]}}`))) });
  late("tools: an answer with a __proto__ key", ["tools"], "left to the JavaScript", { mock: mock(listRule(raw('{"result":{"tools":[{"name":"p","__proto__":{"description":"inherited"}}]}}'))) });

  // search
  for (const word of ["completion", "true", "null", "0", "__proto__", "1e3", "007", "-", "—json", " ", "a=b"]) {
    if (word === "-") continue;
    add(`search: the query ${JSON.stringify(word)}`, ["search", word], { mock: mock(searchHits([])) });
  }
  add("search: a query in double quotes", ["search", '"Plan A"'], { mock: mock(searchHits([planA])) });
  add("search: a query in single quotes", ["search", "'Plan A'"], { mock: mock(searchHits([planA])) });
  add("search: a query with quotes, a backslash, control characters and separators", ["search", 'a"b\\c\u0001\u007f  \t\n\r/😀é'], { mock: mock(searchHits([])) });
  add("search: --json before the query", ["search", "--json", "Plan"], { mock: mock(searchHits([planA])) });
  add("search: titles and addresses that are empty, null or missing", ["search", "x"], {
    mock: mock(searchHits([{ title: "", file_name: "ignored", url: "", file_url: "ignored" }, { title: null, file_name: null, url: null, file_url: null }, { title: 0, url: false }, "text", 5, [], {}])),
  });
  add("search: --json of a list spelled with escapes and odd numbers", ["search", "x", "--json"], {
    mock: mock(rule("manage.search_file", rawStructured('{"list":[{"3":1,"1":2,"z":1.0,"a":[],"o":{},"n":[[]],"e":"\\u00e9\\ud83d\\ude00\\u2028\\u007f\\u0000","big":123456789012345678901234567890,"small":0.00000012,"neg":-1.5e-10,"inf":1e999}]}'))),
  });
  add("search: an answer as content text with escapes inside escapes", ["search", "x", "--json"], {
    mock: mock(rule("manage.search_file", rawResult('{"content":[{"type":"text","text":"{\\"list\\":[{\\"title\\":\\"a\\\\nb\\\\u00e9\\",\\"n\\":1.0}]}"}]}'))),
  });
  add("search: the query usage, with the day nearly used up", ["search", "usage"], { mock: mock(searchHits([planA])), home: { ".qqdocs/usage.json": usageAt(98) } });
  add("search: --json with the day nearly used up", ["search", "x", "--json"], { mock: mock(searchHits([planA])), home: { ".qqdocs/usage.json": usageAt(98) } });

  // ls
  add("ls: a folder whose name is a number", ["ls", "123"], {
    mock: mock([rule("manage.folder_list", ok({ list: [] }), { folder_id: "f123" }), folderList({ list: [{ id: "f123", is_folder: true, title: "123", url: "u" }, { id: "n", is_folder: true, title: 123, url: "u" }] })]),
  });
  for (const word of ["true", "0", "1e3", "007", "completion", "ROOT", "Root", " root ", " ", "1234567890", "12345678901234567890", "abcdefghi", "abcdefghij/"]) {
    add(`ls: the folder ${JSON.stringify(word)}`, ["ls", word], {
      mock: mock([rule("manage.folder_list", ok({ list: [{ id: "inner", is_folder: false, title: "Inner", url: "https://docs.qq.com/doc/inner" }] }), { folder_id: "target0001" }), folderList({ list: [{ id: "target0001", is_folder: true, title: word.trim().replace(/\/$/, ""), url: "u" }] })]),
    });
  }
  add("ls: the largest count and page it takes", ["ls", "-n", "999999999", "-p", "999999999"], { mock: mock(recent([planA])) });
  add("ls: a count of zero", ["ls", "--count=0", "--json"], { mock: mock(recent([planA])) });
  add("ls: -d before -n, then --json last", ["ls", "-d", "-n", "3", "--json"], { mock: mock(recent([planA])) });
  add("ls: names with brackets, line breaks and a carriage return", ["ls"], {
    mock: mock(recent([{ file_id: "a", file_name: "a](b)[c", file_url: "https://docs.qq.com/doc/a)b" }, { file_id: "b", file_name: "two\nlines\r", file_url: "//docs.qq.com/sheet/x" }, { file_id: "c", file_name: "%s %d %%", file_url: "https://docs.qq.com/smartsheet/sheet/slide/" }])),
  });
  add("ls: --json when `files` is 0, false or text", ["ls", "--json"], { mock: mock(rule("manage.recent_online_file", ok({ files: 0, file: [planA] }))) });
  add("ls: --json when `files` is false", ["ls", "--json"], { mock: mock(rule("manage.recent_online_file", ok({ files: false }))) });
  add("ls: --json of a folder whose list is text", ["ls", "root", "--json"], { mock: mock(folderList({ list: "abc" })) });
  add("ls: a folder whose `finish` is 0", ["ls", "root"], { mock: mock(folderList({ list: [{ id: "a", title: "A", url: "//docs.qq.com/doc/a" }], finish: 0 })) });
  add("ls: a folder whose `finish` is the text false", ["ls", "root"], { mock: mock(folderList({ list: [{ id: "a", title: "A", url: "//docs.qq.com/doc/a" }], finish: "false" })) });
  add("ls: a folder whose `finish` is an empty text", ["ls", "root"], { mock: mock(folderList({ list: [{ id: "a", title: "A", url: "//docs.qq.com/doc/a" }], finish: "" })) });
  add("ls: a folder of folders with --dates asks nothing more", ["ls", "root", "-d"], { mock: mock(folderList({ list: [{ id: "a", is_folder: true, title: "A", url: "//x" }, { id: "b", is_folder: "yes", title: "B", url: "" }] })) });
  add("ls: a folder and a document share an id, with --dates", ["ls", "root", "--dates"], {
    mock: mock([folderList({ list: [{ id: "same000001", is_folder: true, title: "Folder", url: "//x" }, { id: "same000001", is_folder: false, title: "Doc", url: "//docs.qq.com/pdf/y" }] }), infoOf("same000001", { last_modify_time: 1500000000000 })]),
  });
  add("ls: --dates with times that are fractions, text of digits and very old", ["ls", "--dates"], {
    mock: mock(
      [
        recent([planA, budget, { file_id: "third0000001", file_name: "Third", file_url: "https://docs.qq.com/slide/D3" }, { file_id: "fourth000001", file_name: "Fourth", file_url: "https://docs.qq.com/doc/D4" }]),
        rule("manage.query_file_info", rawStructured('{"last_modify_time":1700000000000.9}'), { file_id: planA.file_id }),
        infoOf(budget.file_id, { last_modify_time: "0" }),
        rule("manage.query_file_info", rawStructured('{"last_modify_time":-62167219200000}'), { file_id: "third0000001" }),
        rule("manage.query_file_info", rawStructured('{"last_modify_time":1.7e12}'), { file_id: "fourth000001" }),
      ],
      [1, 4],
    ),
  });
  add("ls: --dates with the last moment of the year 9999 and text with leading zeros", ["ls", "--dates"], {
    mock: mock([recent([planA, budget]), infoOf(planA.file_id, { last_modify_time: -1 }), infoOf(budget.file_id, { last_modify_time: "000001600000000" })], [1, 2]),
  });
  late("ls: --dates with a time before the year 0", ["ls", "--dates"], "JavaScript's own date text", { mock: mock([recent([planA]), infoOf(planA.file_id, { last_modify_time: -62167219200001 })]) });
  late("ls: --dates with a time that is true", ["ls", "--dates"], "JavaScript's own arithmetic", { mock: mock([recent([planA]), infoOf(planA.file_id, { last_modify_time: true })]) });
  add("ls: --dates when the answer about a document is null or a number", ["ls", "--dates"], {
    mock: mock([recent([planA, budget]), infoOf(planA.file_id, null), infoOf(budget.file_id, 5)], [1, 2]),
  });
  add("ls: FORCE_COLOR is set", ["ls"], { mock: mock(recent([planA])), env: { FORCE_COLOR: "3" } });
  back("ls: a package.json and a tsconfig.json that do not parse, in the current directory", ["ls"], PROJECT, {
    mock: mock(recent([planA])),
    files: { "package.json": "{ this is not json", "tsconfig.json": "{ nor this", "jsconfig.json": "nope" },
  });
  add("ls: a node_modules with another yargs in the current directory", ["ls"], {
    mock: mock(recent([planA])),
    files: { "node_modules/yargs/package.json": '{"name":"yargs","version":"0.0.1","main":"index.js"}', "node_modules/yargs/index.js": "throw new Error('wrong yargs')" },
  });

  // read
  const content = (id, c) => rule("get_content", ok({ content: c }), { file_id: id });
  const docInfo = { file_id: "dFzLAbBjFuBr", title: "Plan A", url: "https://docs.qq.com/doc/DZEZ6TEFiQmpGdUJy" };
  add("read: content with format marks, CRLF, a NUL and line separators", ["read", "dFzLAbBjFuBr"], {
    mock: mock([infoOf("dFzLAbBjFuBr", docInfo), content("dFzLAbBjFuBr", "100%% %s %d %o %c %j\r\nsecond\u0000third fourth \n\n\n")], [2]),
  });
  add("read: empty content", ["read", "dFzLAbBjFuBr"], { mock: mock([infoOf("dFzLAbBjFuBr", docInfo), content("dFzLAbBjFuBr", "")], [2]) });
  add("read: 50 000 characters of content", ["read", "dFzLAbBjFuBr"], {
    mock: mock([infoOf("dFzLAbBjFuBr", docInfo), content("dFzLAbBjFuBr", "行 line 😀\n".repeat(5000))], [2]),
  });
  add("read: an address whose first part is empty is a title to search for", ["read", "https://docs.qq.com//doc/abc"], {
    mock: mock([searchHits([{ file_id: "found00001", title: "whatever" }]), infoOf("found00001", docInfo), content("found00001", "found")], [1, 2]),
  });
  add("read: a title that is a number and an address that is true", ["read", "dFzLAbBjFuBr"], {
    mock: mock([infoOf("dFzLAbBjFuBr", { title: 12.5, url: true }), content("dFzLAbBjFuBr", "x")], [2]),
  });
  add("read: an empty title hides the file name", ["read", "dFzLAbBjFuBr"], {
    mock: mock([infoOf("dFzLAbBjFuBr", { title: "", file_name: "Hidden", url: "", file_url: "https://docs.qq.com/doc/x" }), content("dFzLAbBjFuBr", "x")], [2]),
  });
  add("read: information that is a list", ["read", "dFzLAbBjFuBr"], { mock: mock([infoOf("dFzLAbBjFuBr", ["a"]), content("dFzLAbBjFuBr", "x")], [2]) });
  add("read: information that is text", ["read", "dFzLAbBjFuBr"], { mock: mock([infoOf("dFzLAbBjFuBr", "plain"), content("dFzLAbBjFuBr", "x")], [2]) });
  add("read: information that is null", ["read", "dFzLAbBjFuBr"], { mock: mock([infoOf("dFzLAbBjFuBr", null), content("dFzLAbBjFuBr", "x")], [2]) });
  for (const [what, ref, id] of [
    ["an address with a query and a fragment", "https://docs.qq.com/doc/DABCdef123?tab=x#h", "DABCdef123"],
    ["an address of a kind it does not list", "https://docs.qq.com/desktop/Xy9", "Xy9"],
    ["two addresses, the listed kind wins", "docs.qq.com/x/first docs.qq.com/aio/second", "second"],
    ["an address without a scheme, in capitals after the host", "DOCS.QQ.COM docs.qq.com/SHEET/abc/def", "abc"],
    ["an address inside other text", "see <https://docs.qq.com/smartsheet/Sm4rt-rest> please", "Sm4rt"],
    ["an address with the host twice", "docs.qq.com/docs.qq.com/doc/Zz1", "Zz1"],
    ["an address with a line break in the first part", "docs.qq.com/a\nb/Id7", "Id7"],
    ["an id of exactly ten characters with blanks around", "  abcdefghi0 \t", "abcdefghi0"],
  ]) {
    add(`read: ${what}`, ["read", ref], { mock: mock([infoOf(id, { title: `T ${id}`, url: `https://docs.qq.com/doc/${id}` }), content(id, `content of ${id}`)], [2]) });
  }
  add("read: nine characters are a title to search for", ["read", "abcdefghi"], {
    mock: mock([searchHits([{ file_id: "found00001", file_name: "abcdefghi" }, { file_id: "other00002", title: "abcdefghi2" }]), infoOf("found00001", docInfo), content("found00001", "found")], [1, 2]),
  });
  add("read: an address with nothing usable is a title to search for", ["read", "https://docs.qq.com/doc/"], {
    mock: mock([searchHits([{ file_id: "found00001", title: "whatever" }]), infoOf("found00001", docInfo), content("found00001", "found")], [1, 2]),
  });
  add("read: a title that only `title` matches exactly, among several", ["read", " Plan B "], {
    mock: mock([searchHits([{ file_id: "a000000001", file_name: "Plan B draft" }, { file_id: "b000000002", file_name: null, title: "Plan B" }, { file_id: "c000000003", file_name: "plan b" }]), infoOf("b000000002", docInfo), content("b000000002", "b")], [1, 2]),
  });
  late("read: a title that two results have", ["read", "Twin"], REPORTED, { mock: mock(searchHits([{ file_id: "a000000001", file_name: "Twin" }, { file_id: "b000000002", title: "Twin" }])) });
  back("read: an address whose id is valueOf", ["read", "https://docs.qq.com/doc/valueOf"], "a name every JavaScript object has", {
    mock: mock([infoOf("valueOf", docInfo), content("valueOf", "x")], [2]),
  });
  late("read: a search result whose id is constructor", ["read", "Odd"], "a name every JavaScript object has", {
    mock: mock([searchHits([{ file_id: "constructor", file_name: "Odd" }]), infoOf("constructor", docInfo), content("constructor", "x")], [1, 2]),
  });
  const cacheOf = (entries) => JSON.stringify(entries);
  add("read: from the cache, remembered a minute in the future", ["read", "dFzLAbBjFuBr"], {
    home: { ".qqdocs/doc-cache.json": '{"dFzLAbBjFuBr":{"content":"cached text","info":{"title":"Cached","url":"u"},"cachedAt":@MS--60000@}}'.replace("@MS--60000@", "@MS-0@") },
  });
  add("read: from the cache, information that is null, text or without a title", ["read", "dFzLAbBjFuBr"], {
    home: { ".qqdocs/doc-cache.json": '{"zzzz":{"content":"other","info":"text","cachedAt":@MS-1000@},"dFzLAbBjFuBr":{"cachedAt":@MS-200000@,"info":null,"content":""}}' },
  });
  add("read: from the cache, a title that is a number", ["read", "dFzLAbBjFuBr"], {
    home: { ".qqdocs/doc-cache.json": '{"dFzLAbBjFuBr":{"content":"c","info":{"title":7,"file_name":"n","url":null,"file_url":"https://docs.qq.com/doc/x"},"cachedAt":@MS-1000@.5}}' },
  });
  add("read: a cache with ids that are numbers, stale and fresh entries, and other values", ["read", "dFzLAbBjFuBr"], {
    mock: mock([infoOf("dFzLAbBjFuBr", docInfo), content("dFzLAbBjFuBr", "fresh")], [2]),
    home: {
      ".qqdocs/doc-cache.json":
        '{"zeta":{"content":"z","info":null,"cachedAt":@MS-1000@},"4294967295":{"content":"n","info":null,"cachedAt":@MS-2000@},"10":{"content":"ten","info":{},"cachedAt":@MS-3000@},"2":{"content":"two","info":{},"cachedAt":@MS-400000@},"dFzLAbBjFuBr":{"content":"old","info":{},"cachedAt":@MS-400000@},"alpha":{"content":"a","info":[1],"cachedAt":@MS-5000@},"n":5,"s":"text","f":false,"l":[1],"nocachedat":{"content":"x"}}',
    },
  });
  add("read: the id is a number, so it is first in the cache file", ["read", "1234567890"], {
    mock: mock([infoOf("1234567890", docInfo), content("1234567890", "numbered")], [2]),
    home: { ".qqdocs/doc-cache.json": '{"zeta":{"content":"z","info":null,"cachedAt":@MS-1000@},"4294967294":{"content":"n","info":null,"cachedAt":@MS-2000@}}' },
  });
  add("read: a cache file that starts with a byte order mark is not JSON", ["read", "dFzLAbBjFuBr"], {
    mock: mock([infoOf("dFzLAbBjFuBr", docInfo), content("dFzLAbBjFuBr", "fresh")], [2]),
    home: { ".qqdocs/doc-cache.json": '﻿{"dFzLAbBjFuBr":{"content":"bom","info":null,"cachedAt":@MS-1000@}}' },
  });
  add("read: an empty cache file", ["read", "dFzLAbBjFuBr"], { mock: mock([infoOf("dFzLAbBjFuBr", docInfo), content("dFzLAbBjFuBr", "fresh")], [2]), home: { ".qqdocs/doc-cache.json": "" } });
  add("read: a cache entry that is false is replaced where it stands", ["read", "dFzLAbBjFuBr"], {
    mock: mock([infoOf("dFzLAbBjFuBr", docInfo), content("dFzLAbBjFuBr", "fresh")], [2]),
    home: { ".qqdocs/doc-cache.json": '{"a":{"content":"a","info":null,"cachedAt":@MS-1000@},"dFzLAbBjFuBr":false,"b":{"content":"b","info":null,"cachedAt":@MS-1000@}}' },
  });
  add("read: a cache with a null entry is left as it is", ["read", "dFzLAbBjFuBr"], {
    mock: mock([infoOf("dFzLAbBjFuBr", docInfo), content("dFzLAbBjFuBr", "fresh")], [2]),
    home: { ".qqdocs/doc-cache.json": '{"a":{"content":"a","info":null,"cachedAt":@MS-400000@},"gone":null}' },
  });
  late("read: a cache that is a list", ["read", "dFzLAbBjFuBr"], "not what the program writes", {
    mock: mock([infoOf("dFzLAbBjFuBr", docInfo), content("dFzLAbBjFuBr", "fresh")], [2]),
    home: { ".qqdocs/doc-cache.json": "[]" },
  });
  add("read: the two calls take the day to 80%", ["read", "dFzLAbBjFuBr"], {
    mock: mock([infoOf("dFzLAbBjFuBr", docInfo), content("dFzLAbBjFuBr", "x")], [2]),
    home: { ".qqdocs/usage.json": usageAt(78) },
  });
  add("read: by title, three calls take the day to 95%", ["read", "Plan"], {
    mock: mock([searchHits([planA]), infoOf("dFzLAbBjFuBr", docInfo), content("dFzLAbBjFuBr", "x")], [1, 2]),
    home: { ".qqdocs/usage.json": usageAt(92) },
  });
  add("read: a counter lock left behind long ago is removed", ["read", "dFzLAbBjFuBr"], {
    mock: mock([infoOf("dFzLAbBjFuBr", docInfo), content("dFzLAbBjFuBr", "x")], [2]),
    setup: [aged("<HOME>/.qqdocs/usage.json.lock", 60)],
  });

  // info, perm get
  add("info: every kind of value, keys that are numbers", ["info", "dFzLAbBjFuBr"], {
    mock: mock(rule("manage.query_file_info", rawStructured('{"z":"last?","10":"ten","2":"two","empty":"","nul":null,"no":false,"zero":0,"negzero":-0,"f":1.50,"big":1e21,"tiny":1e-7,"list":[1,"a",null,{"k":[]}],"obj":{"b":1,"1":2},"text":" padded ","uni":"\\u00e9😀\\u2028","01":"not a number key","z":"z again"}'))),
  });
  add("info: --json before the reference, by title", ["info", "--json", "Plan"], { mock: mock([searchHits([planA]), infoOf("dFzLAbBjFuBr", docInfo)]) });
  add("info: an answer that is text, with --json", ["info", "dFzLAbBjFuBr", "--json"], { mock: mock(rule("manage.query_file_info", ok("just text"))) });
  add("info: an answer that is null, with --json", ["info", "dFzLAbBjFuBr", "--json"], { mock: mock(rule("manage.query_file_info", ok(null))) });
  late("info: an answer that is a list", ["info", "dFzLAbBjFuBr"], "JavaScript's own listing of a list", { mock: mock(rule("manage.query_file_info", ok(["a", "b"]))) });
  add("info: the reference usage", ["info", "usage"], { mock: mock([searchHits([planA]), infoOf("dFzLAbBjFuBr", docInfo)]), home: { ".qqdocs/usage.json": usageAt(97) } });
  for (const [what, policy] of [["the text 3", '"3"'], ["2.0", "2.0"], ["1e0", "1e0"], ["-0", "-0"], ["4", "4"], ["null", "null"], ["true", "true"], ["the text link-read", '"link-read"'], ["0.5", "0.5"]]) {
    add(`perm get: a policy of ${what}`, ["perm", "get", "dFzLAbBjFuBr"], { mock: mock(rule("manage.get_privilege", rawStructured(`{"file_id":"dFzLAbBjFuBr","policy":${policy},"trace_id":"t1"}`))) });
  }
  add("perm get: no policy in the answer", ["perm", "get", "dFzLAbBjFuBr"], { mock: mock(rule("manage.get_privilege", ok({ "5": "five", file_id: "dFzLAbBjFuBr", trace_id: "" }))) });
  add("perm get: the reference get", ["perm", "get", "get"], { mock: mock([searchHits([planA]), rule("manage.get_privilege", ok({ policy: 3 }))]) });
  late("perm get: a policy that is a list", ["perm", "get", "dFzLAbBjFuBr"], "JavaScript's own text for a list", { mock: mock(rule("manage.get_privilege", ok({ policy: [2] }))) });

  // space
  add("space list: every option at once, = forms", ["space", "list", "--page=3", "--scope=joined", "--order=edited", "--asc"], { mock: mock(rule("query_space_list", ok({ spaces: [] }))) });
  add("space list: -p and the options in another order", ["space", "list", "--asc", "--order", "preview", "-p", "0", "--scope", "all"], { mock: mock(rule("query_space_list", ok({ spaces: [] }))) });
  add("space list: odd values in every field", ["space", "list"], {
    mock: mock(
      rule(
        "query_space_list",
        rawStructured(
          '{"spaces":[{"title":"A","space_id":"s1","policy":2.0,"file_cnt":0,"member_cnt":null,"is_owner":"no"},{"title":null,"space_id":7,"policy":"2","file_cnt":"many","member_cnt":1.5,"is_owner":0},{"policy":-0,"file_cnt":false,"member_cnt":"","is_owner":[]},{"title":"空间 😀","space_id":"s4","policy":1e0,"file_cnt":1e21,"member_cnt":-1,"is_owner":{}},{"policy":7},"text",5],"has_next":"yes"}',
        ),
      ),
    ),
  });
  add("space list: has_next of 1 with nothing listed is not mentioned", ["space", "list"], { mock: mock(rule("query_space_list", ok({ spaces: [], has_next: 1 }))) });
  add("space ls: --parent, -p and the space last", ["space", "ls", "--parent", "0123", "-p", "2", "S1"], { mock: mock(rule("query_space_node", ok({ children: [] }))) });
  add("space ls: a space that is a number, a parent named usage", ["space", "ls", "12345", "--parent=usage"], { mock: mock(rule("query_space_node", ok({ children: [] }))), home: { ".qqdocs/usage.json": usageAt(98) } });
  add("space ls: a parent that is the word usage silences the quota warning", ["space", "ls", "S1", "--parent", "usage"], { mock: mock(rule("query_space_node", ok({ children: [] }))), home: { ".qqdocs/usage.json": usageAt(98) } });
  add("space ls: kinds of every length, Chinese and pairs", ["space", "ls", "ls"], {
    mock: mock(
      rule(
        "query_space_node",
        ok({
          children: [
            { node_id: "n1", title: "F", node_type: "wiki_folder", has_child: 1, url: "" },
            { node_id: "n2", title: "D", node_type: "wiki_file", doc_type: "", url: "https://docs.qq.com/doc/n2" },
            { node_id: "n3", title: "D", node_type: "wiki_file", doc_type: "smartcanvas-long-kind", has_child: "yes" },
            { node_id: "n4", title: null, node_type: "链接类型", url: 0 },
            { node_id: 5, node_type: "😀😀😀😀", url: 12.5 },
            { node_type: "exactly-10", has_child: {} },
            { node_type: "", title: "" },
            { node_id: "n8", title: "D", node_type: "wiki_file", doc_type: null },
          ],
          has_next: {},
        }),
      ),
    ),
  });
  late("space ls: a kind that is a number", ["space", "ls", "S1"], REPORTED, { mock: mock(rule("query_space_node", ok({ children: [{ node_id: "n", node_type: 5 }] }))) });

  // canvas
  add("canvas read: every option, = forms", ["canvas", "read", "dFzLAbBjFuBr", "--page=0", "--size=0", "--next=007"], { mock: mock(rule("smartcanvas.read", ok({ content: "<p>x</p>", next_token: 0 }))) });
  add("canvas read: --all leaves --next out and keeps --page and --size", ["canvas", "read", "--all", "--next", "ignored", "--size", "2", "--page", "P1", "dFzLAbBjFuBr"], {
    mock: mock(rule("smartcanvas.read", [ok({ content: "one", next_token: "t1" }), ok({ content: "two", next_token: "" })])),
  });
  add("canvas read: --all stops after a hundred pages", ["canvas", "read", "dFzLAbBjFuBr", "--all"], { mock: mock(rule("smartcanvas.read", ok({ content: "p\n", next_token: "again" }))), timeout: 300 });
  add("canvas read: a next token that is a number, content with format marks", ["canvas", "read", "dFzLAbBjFuBr"], { mock: mock(rule("smartcanvas.read", ok({ content: "%s %% %d\r\n", next_token: 12.5 }))) });
  add("canvas read: --all, an `error` that is 0 and content that is missing", ["canvas", "read", "dFzLAbBjFuBr", "--all"], { mock: mock(rule("smartcanvas.read", [ok({ error: 0, next_token: "t" }), ok({ error: "", content: "end" })])) });
  late("canvas read: --all, content that is false", ["canvas", "read", "dFzLAbBjFuBr", "--all"], "only text is joined here", { mock: mock(rule("smartcanvas.read", ok({ content: false }))) });
  add("canvas read: --page usage silences the quota warning", ["canvas", "read", "dFzLAbBjFuBr", "--page", "usage"], { mock: mock(rule("smartcanvas.read", ok({ content: "x" }))), home: { ".qqdocs/usage.json": usageAt(98) } });
  add("canvas find: ids that are not text, content with format marks, a query named find", ["canvas", "find", "read", "find"], {
    mock: mock([searchHits([planA]), rule("smartcanvas.find", ok({ blocks: [{ id: 1.5, content: "%s %%" }, { content: "" }, { id: null, content: "last\n" }, { id: "nocontent" }] }))]),
  });
  late("canvas find: content that is null", ["canvas", "find", "dFzLAbBjFuBr", "q"], "console.log's own text for it", { mock: mock(rule("smartcanvas.find", ok({ blocks: [{ id: "a", content: null }] }))) });

  // raw
  add("raw: arguments spelled oddly are sent the JavaScript way", ["raw", "get_content", "--json", ' {"b":1.0,"10":"x","2":[1.50,-0,1e21,1E-7,0.1e1],"a":{"z":null,"y":true},"u":"\\u00e9\\ud83d\\ude00\\/\\u0001\\u007f\\u2028","b":2,"inf":1e999,"neg":-1e999} '], {
    mock: mock(rule("get_content", ok({ content: "c" }))),
  });
  add("raw: --json= with equals signs inside", ["raw", "manage.search_file", '--json={"search_key":"a=b==c"}'], { mock: mock(rule("manage.search_file", ok({ list: [] }))) });
  add("raw: an answer that is text, a number, null, a list", ["raw", "smartcanvas.find"], { mock: mock(rule("smartcanvas.find", ok("just text\n"))) });
  add("raw: an answer that is null", ["raw", "query_space_list"], { mock: mock(rule("query_space_list", ok(null))) });
  add("raw: an answer that is a number spelled 1.0e2", ["raw", "query_space_node"], { mock: mock(rule("query_space_node", rawStructured("1.0e2"))) });
  add("raw: an answer in content text, nested and empty things", ["raw", "manage.import_progress", "--json", '{"task_id":"t"}'], {
    mock: mock(rule("manage.import_progress", text('{"progress":100,"a":[],"o":{},"n":[[],{}],"s":"","deep":{"x":{"y":[1,[2,[3]]]}}}'))),
  });
  add("raw: the day nearly used up", ["raw", "manage.query_folder_meta", "--json", '{"folder_id":"usage"}'], { mock: mock(rule("manage.query_folder_meta", ok({ folder: {} }))), home: { ".qqdocs/usage.json": usageAt(94) } });
  back("raw: JSON that is a list", ["raw", "get_content", "--json", "[]"], REPORTED, {});
  back("raw: JSON with a __proto__ key", ["raw", "get_content", "--json", '{"__proto__":{"a":1},"file_id":"x"}'], "left to the JavaScript", { mock: mock(rule("get_content", ok({ content: "c" }))) });
  back("raw: a tool in capitals", ["raw", "GET_CONTENT"], "not on the list of tools that read", { mock: mock(rule("GET_CONTENT", ok({}))) });
  back("raw: a tool with a blank after it", ["raw", "get_content "], "not on the list of tools that read", { mock: mock(rule("get_content ", ok({}))) });

  // sync
  add("sync: the home directory has a blank and Chinese in its name", ["sync"], {
    mock: mock([recent([planA]), folderList({ list: [] })], [2]),
    env: { HOME: "<HOME>/my home/家" },
    setup: ["mkdir -p '<HOME>/my home/家/.qqdocs'"],
  });
  add("sync: ids, titles and addresses of every kind", ["sync"], {
    mock: mock(
      [
        recent([{ file_id: "a", file_name: null }, { file_id: "", file_name: 5, file_url: ["u"] }, { file_id: "a", file_name: "again" }, { file_id: "10", file_url: { k: 1 } }]),
        folderList({ list: [{ id: "", is_folder: 0, title: "empty id again", url: "//x" }, { id: "b", is_folder: "", url: "//" }, { id: "c", is_folder: [], url: 5 }, { id: "d", title: { t: 1 }, url: "///x" }] }),
      ],
      [2],
    ),
  });
  add("sync: both calls take the day to 80%", ["sync"], { mock: mock([recent([planA]), folderList({ list: [] })], [2]), home: { ".qqdocs/usage.json": usageAt(78) } });
  back("sync: ~/.qqdocs is a file", ["sync"], "left to the JavaScript", { mock: mock([recent([planA]), folderList({ list: [] })], [2]), firstRun: true, setup: ["printf x > <HOME>/.qqdocs"] });

  // usage and calibrate: the counter file
  add("usage: a counter file that starts with a byte order mark counts as empty", ["usage"], { home: { ".qqdocs/usage.json": `﻿${usageAt(44)}` } });
  add("usage: a counter file with white space around and keys in another order", ["usage"], { home: { ".qqdocs/usage.json": ` \n{"inferredTier":null,"monthly":{"@MONTH@":2.5e1},"x":[1],"daily":{"@TODAY@":1e1}}\n\n` } });
  add("usage: today is in the file twice", ["usage"], { home: { ".qqdocs/usage.json": '{"daily":{"@TODAY@":5,"@TODAY@":7},"monthly":{"@MONTH@":1},"daily":{"@TODAY@":9}}' } });
  add("usage: counts of a half and of one below the next percent", ["usage"], { home: { ".qqdocs/usage.json": '{"daily":{"@TODAY@":0.5},"monthly":{"@MONTH@":99.99}}' } });
  add("usage: counts that round at the half", ["usage", "--tier", "plus"], { home: { ".qqdocs/usage.json": '{"daily":{"@TODAY@":50},"monthly":{"@MONTH@":500}}' } });
  add("usage: a huge count", ["usage"], { home: { ".qqdocs/usage.json": '{"daily":{"@TODAY@":1e21},"monthly":{"@MONTH@":123456789012345678901234567890}}' } });
  add("usage: ~/.qqdocs is a file", ["usage"], { firstRun: true, setup: ["printf x > <HOME>/.qqdocs"] });
  add("usage: the counter file is a directory", ["usage"], { setup: ["mkdir <HOME>/.qqdocs/usage.json"] });
  add("usage: --tier=plus with the tier of config.yaml in the current directory and an inferred one", ["usage", "--tier=plus"], {
    files: { ".qqdocs.config.yaml": "# 层级\n\ndefaultPerm: link-read\ntier: member\ndefaultSpace: 2026-01/x.y_z\n" },
    home: { ".qqdocs/usage.json": usageAt(1500, ',"inferredTier":"member"'), ".qqdocs/config.yaml": "tier: free\n" },
  });
  add("usage: a config.yaml with keys YAML reads as other things", ["usage"], {
    home: { ".qqdocs/config.yaml": "yes: no\nnull: null\ntrue: false\na1_b: 0x1F\nn: 1e3\nd: 2026-01-01\ntier: plus\nv: 1.2.3\np: a/b/c\nt: 12:30\n".replace("t: 12:30\n", ""), ".qqdocs/usage.json": usageAt(10) },
  });
  add("usage: a config.yaml that is only comments", ["usage"], { home: { ".qqdocs/config.yaml": "# nothing\n#\n# tier: plus\n" } });
  back("usage: a config.yaml with a line of blanks", ["usage"], "left to the YAML parser", { home: { ".qqdocs/config.yaml": "tier: member\n  \n" } });
  back("usage: a config.yaml with a tab after the colon", ["usage"], "left to the YAML parser", { home: { ".qqdocs/config.yaml": "tier:\tmember\n" } });
  back("usage: a config.yaml in the current directory that is a dangling link is skipped by both, then an odd one in the home directory", ["usage"], "left to the YAML parser", {
    setup: ["mkdir -p .qqdocs && ln -s /nonexistent/config.yaml .qqdocs/config.yaml"],
    home: { ".qqdocs/config.yaml": "tier: 'plus'\n" },
  });
  add("usage: a dangling link for config.yaml in the current directory is skipped", ["usage"], {
    setup: ["mkdir -p .qqdocs && ln -s /nonexistent/config.yaml .qqdocs/config.yaml"],
    home: { ".qqdocs/config.yaml": "tier: plus\n" },
  });
  add("calibrate: = forms, all three", ["usage", "calibrate", "--today=5", "--tier=plus", "--month=7"], { home: { ".qqdocs/usage.json": usageAt(3) } });
  add("calibrate: zero for both", ["usage", "calibrate", "--month", "0", "--today", "0"], { home: { ".qqdocs/usage.json": usageAt(30, ',"inferredTier":"plus"') } });
  add("calibrate: the largest number it takes", ["usage", "calibrate", "--today", "999999999"], { home: { ".qqdocs/usage.json": usageAt(1) } });
  add("calibrate: a file with other keys, days that are numbers and an order of its own", ["usage", "calibrate", "--today", "8"], {
    home: { ".qqdocs/usage.json": '{"note":"kept","monthly":{"zz":1,"@MONTH@":40,"7":7},"inferredTier":null,"daily":{"2001-01-01":1,"20260101":2,"@TODAY@":10,"5":5,"":0},"last":true}' },
  });
  add("calibrate: fractions in the file", ["usage", "calibrate", "--today", "3"], { home: { ".qqdocs/usage.json": '{"daily":{"@TODAY@":2.5},"monthly":{"@MONTH@":0.25}}' } });
  add("calibrate: a counter lock left behind long ago", ["usage", "calibrate", "--today", "3"], { setup: [aged("<HOME>/.qqdocs/usage.json.lock", 60)] });
  add("calibrate: a counter lock taken just now is waited for, then ignored and removed", ["usage", "calibrate", "--today", "3"], { setup: ["touch <HOME>/.qqdocs/usage.json.lock"] });
  add("calibrate: a counter lock that is a directory", ["usage", "calibrate", "--today", "3"], { setup: ["mkdir <HOME>/.qqdocs/usage.json.lock"] });
  back("calibrate: the counter file is a directory", ["usage", "calibrate", "--today", "3"], REPORTED, { setup: ["mkdir <HOME>/.qqdocs/usage.json"] });
  back("calibrate: ~/.qqdocs is a file", ["usage", "calibrate", "--today", "3"], REPORTED, { firstRun: true, setup: ["printf x > <HOME>/.qqdocs"] });
  add("search: a counter lock taken just now is waited for", ["search", "x"], { mock: mock(searchHits([])), setup: ["touch <HOME>/.qqdocs/usage.json.lock"], home: { ".qqdocs/usage.json": usageAt(4) } });
  add("search: nine days and five months in the file, numbers among the keys", ["search", "x"], {
    mock: mock(searchHits([])),
    home: {
      ".qqdocs/usage.json":
        '{"daily":{"2001-01-09":1,"zz":"text","2001-01-01":2,"7":7,"2001-01-03":3,"":0,"2001-01-04":4,"10":10,"2001-01-05":5,"9999-99-99":{"a":1}},"monthly":{"2001-03":1,"1":1,"2001-01":2,"2001-02":3,"zz":null,"9999-99":[]},"other":{"kept":1}}',
    },
  });
  add("search: the counter file is a directory", ["search", "x"], { mock: mock(searchHits([])), setup: ["mkdir <HOME>/.qqdocs/usage.json"] });
  add("search: ~/.qqdocs is a file", ["search", "x"], { mock: mock(searchHits([])), firstRun: true, setup: ["printf x > <HOME>/.qqdocs"] });
  add("search: the 1001st call of the day with a config tier of free", ["search", "x"], {
    mock: mock(searchHits([])),
    home: { ".qqdocs/usage.json": usageAt(1000), ".qqdocs.config.yaml": "tier: free\n" },
  });
  late("search: an inferred tier that does not exist", ["search", "x"], "a counter file of another shape", { mock: mock(searchHits([])), home: { ".qqdocs/usage.json": usageAt(90, ',"inferredTier":"gold"') } });

  // the token: files bun loads, files the program loads
  const lsOne = mock(recent([planA]));
  const envCase = (name, files, o = {}) => add(`token: ${name}`, ["ls"], { mock: lsOne, env: { TENCENT_DOCS_TOKEN: null }, files, ...o });
  const envBack = (name, files, why, o = {}) => back(`token: ${name}`, ["ls"], why, { mock: lsOne, env: { TENCENT_DOCS_TOKEN: null }, files, ...o });
  envCase("a # right after the token in .env starts a comment", { ".env": "TENCENT_DOCS_TOKEN=fake-hash#rest\n" });
  envCase("a backslash in an unquoted token in .env is kept", { ".env": "TENCENT_DOCS_TOKEN=fake-a\\nb\\\\c\\t\n" });
  envCase(".env with Windows line ends", { ".env": "# c\r\nOTHER=1\r\nTENCENT_DOCS_TOKEN=fake-crlf\r\n\r\n" });
  envCase(".env with equals signs in the token and no final line end", { ".env": "TENCENT_DOCS_TOKEN=fake-a=b==" });
  envCase(".env with a token in single quotes that holds a # and blanks", { ".env": "TENCENT_DOCS_TOKEN='fake a # b'   # c\n" });
  envCase(".env with a token in double quotes that holds a # and an equals sign", { ".env": 'TENCENT_DOCS_TOKEN="fake=a#b" #c\n' });
  envCase(".env with tabs and blanks around the token", { ".env": "TENCENT_DOCS_TOKEN= \t fake-padded \t \n" });
  envCase(".env with punctuation in the token", { ".env": "TENCENT_DOCS_TOKEN=fake-;{}[]!%&*|~^,.<>?/:@+()\n" });
  envCase(".env with other variables that are not ASCII, and keys with digits and underscores", { ".env": "NAME=värde 值\n_X9=1\nA__=\nTENCENT_DOCS_TOKEN=fake-after-others\n" });
  envCase(".env with a lower-case key is another variable", { ".env": "tencent_docs_token=fake-lower\n" }, { home: { ".qqdocs/.env.local": "TENCENT_DOCS_TOKEN=fake-from-home\n" } });
  envCase("all four files, the strongest wins", {
    ".env": "TENCENT_DOCS_TOKEN=fake-env\n",
    ".env.development": "TENCENT_DOCS_TOKEN=fake-development\n",
    ".env.local": "TENCENT_DOCS_TOKEN=fake-local\n",
    ".env.development.local": "TENCENT_DOCS_TOKEN=fake-development-local\n",
    ".env.production.local": "TENCENT_DOCS_TOKEN=fake-production-local\n",
    ".env.test": "TENCENT_DOCS_TOKEN=fake-test\n",
  });
  envCase("the token only in .env.development, other things in the stronger files", {
    ".env.development": "TENCENT_DOCS_TOKEN=fake-development\n",
    ".env.local": "OTHER=1\n",
    ".env.development.local": "# nothing\n",
  });
  envBack("empty in .env.local, set in .env", { ".env.local": "TENCENT_DOCS_TOKEN=\n", ".env": "TENCENT_DOCS_TOKEN=fake-weaker\n" }, "an empty token is the TypeScript's to report");
  envBack("empty in .env, set in ~/.qqdocs/.env.local", { ".env": "TENCENT_DOCS_TOKEN=\n" }, "an empty token is the TypeScript's to report", { home: { ".qqdocs/.env.local": "TENCENT_DOCS_TOKEN=fake-from-home\n" } });
  envBack(".env with a form feed in a value", { ".env": "OTHER=a\fb\nTENCENT_DOCS_TOKEN=fake-ff\n" }, "bun's own reading");
  envBack(".env with a no-break space in a value", { ".env": "OTHER=a b\nTENCENT_DOCS_TOKEN=fake-nbsp\n" }, "bun's own reading");
  envBack(".env with a line that is a blank and a comment", { ".env": "  # indented comment\nTENCENT_DOCS_TOKEN=fake-indent\n" }, "bun's own reading");
  envBack(".env with text after a closing quote", { ".env": 'TENCENT_DOCS_TOKEN="fake-q"tail\n' }, "bun's own reading");
  envBack(".env with a backtick", { ".env": "TENCENT_DOCS_TOKEN=`fake-tick`\n" }, "bun's own reading");
  envBack(".env that is a directory", {}, "bun's own reading", { setup: ["mkdir .env"], env: { TENCENT_DOCS_TOKEN: TOKEN } });
  envCase(".env.local that is a dangling link", {}, { setup: ["ln -s /nonexistent/env .env.local"], home: { ".qqdocs/.env.local": "TENCENT_DOCS_TOKEN=fake-from-home\n" } });
  const homeEnv = (name, text, o = {}) => add(`token: ~/.qqdocs/.env.local ${name}`, ["ls"], { mock: lsOne, env: { TENCENT_DOCS_TOKEN: null }, home: { ".qqdocs/.env.local": text }, ...o });
  homeEnv("with a byte order mark and Windows line ends", "﻿TENCENT_DOCS_TOKEN=fake-bom\r\nOTHER=1\r\n");
  homeEnv("with blanks around the key and the value", " \t TENCENT_DOCS_TOKEN \t = \t fake-spaced \t \n");
  homeEnv("with the token twice, the first wins", "X=1\nTENCENT_DOCS_TOKEN=fake-first\nTENCENT_DOCS_TOKEN=fake-second\n");
  homeEnv("with export, a comment and a line starting with =, before the token", "export TENCENT_DOCS_TOKEN=fake-export\n#TENCENT_DOCS_TOKEN=fake-comment\n=fake-nokey\nTENCENT_DOCS_TOKEN#=fake-hash\nTENCENT_DOCS_TOKEN=fake-real=x # kept\n");
  homeEnv("with a carriage return inside the token", "TENCENT_DOCS_TOKEN=fake-\rcr\r\n");
  homeEnv("with no-break spaces around the token", " TENCENT_DOCS_TOKEN　= fake-nbsp﻿\n");
  homeEnv("where a line separator ends the value's line", "TENCENT_DOCS_TOKEN=fake-ls rest\nTENCENT_DOCS_TOKEN=fake-second\n");
  homeEnv("with a line separator before the key", " TENCENT_DOCS_TOKEN=fake-ls-key\n");
  back("token: ~/.qqdocs/.env.local with a tab inside the token", ["ls"], "the runtime's header rules", { mock: lsOne, env: { TENCENT_DOCS_TOKEN: null }, home: { ".qqdocs/.env.local": "TENCENT_DOCS_TOKEN=fake\ttab\n" } });
  add("token: an empty ~/.qqdocs/.env.local, the token in the environment", ["ls"], { mock: lsOne, home: { ".qqdocs/.env.local": "" } });

  // the machine
  add("machine: the home directory has a blank and Chinese in its name, calibrate", ["usage", "calibrate", "--today", "2"], { env: { HOME: "<HOME>/my home/家" }, setup: ["mkdir -p '<HOME>/my home/家'"] });
  back("machine: HOME ends with a slash", ["usage"], "left to the JavaScript", { env: { HOME: "<HOME>/" }, home: { ".qqdocs/usage.json": usageAt(5) } });
  back("machine: HOME has a .. in it", ["usage"], "left to the JavaScript", { env: { HOME: "<HOME>/x/.." }, setup: ["mkdir -p <HOME>/x"], home: { ".qqdocs/usage.json": usageAt(5) } });
  back("machine: HOME is empty", ["usage"], "left to the JavaScript", { env: { HOME: "" }, noHome: true });
  back("machine: .bunfig.toml in XDG_CONFIG_HOME", ["usage"], "bun reads it", { setup: ["mkdir -p <HOME>/.config && printf '' > <HOME>/.config/.bunfig.toml"] });
  add("machine: bunfig.toml in the home directory without the dot is not read", ["usage"], { setup: ["printf 'preload = [\"./nope.ts\"]\\n' > <HOME>/bunfig.toml"] });
  for (const zone of ["Etc/GMT+12", "Etc/GMT-14", "Etc/UTC"]) {
    add(`machine: TZ=${zone}`, ["usage", "calibrate", "--today", "1"], { env: { TZ: zone } });
  }
  for (const zone of ["America/Argentina/Buenos_Aires", "Europe/London", "Asia/Kolkata", "Pacific/Chatham", "Antarctica/Troll", "America/St_Johns", "Australia/Lord_Howe"]) {
    back(`machine: TZ=${zone}`, ["usage", "calibrate", "--today", "1"], ZONE, { env: { TZ: zone } });
  }
  // Names that are no zone file under /usr/share/zoneinfo on Linux.
  for (const zone of ["Etc/Unknown", "America/Argentina", "asia/tokyo", "Asia/Tokyo/", "/usr/share/zoneinfo/Asia/Tokyo", "../zoneinfo/Asia/Tokyo"]) {
    back(`machine: TZ=${zone}`, ["usage", "calibrate", "--today", "1"], ZONE, { env: { TZ: zone } });
  }

  // ── found by the verification: where the binary did not do what the TypeScript does ──

  // yargs prints the command's help when the last word of the command line is `help`.
  back("help: tools help", ["tools", "help"], HELP, { mock: tools([{ name: "help", description: "the help tool" }, { name: "other", description: "no" }]) });
  back("help: search help", ["search", "help"], HELP, { mock: mock(searchHits([{ file_id: "h000000001", file_name: "help", file_url: "https://docs.qq.com/doc/h" }])) });
  back("help: search help --json", ["search", "help", "--json"], HELP, { mock: mock(searchHits([planA])) });
  back("help: search --json help", ["search", "--json", "help"], HELP, { mock: mock(searchHits([planA])) });
  back("help: ls help", ["ls", "help"], HELP, {
    mock: mock([rule("manage.folder_list", ok({ list: [] }), { folder_id: "folderHelp1" }), folderList({ list: [{ id: "folderHelp1", is_folder: true, title: "help", url: "u" }] })]),
  });
  back("help: list help -n 5", ["list", "help", "-n", "5"], HELP, {
    mock: mock([rule("manage.folder_list", ok({ list: [] }), { folder_id: "folderHelp1" }), folderList({ list: [{ id: "folderHelp1", is_folder: true, title: "help", url: "u" }] })]),
  });
  back("help: read help", ["read", "help"], HELP, { mock: mock([searchHits([{ file_id: "h000000001", file_name: "help" }]), infoOf("h000000001", docInfo), content("h000000001", "the help document")], [1, 2]) });
  back("help: info help", ["info", "help"], HELP, { mock: mock([searchHits([{ file_id: "h000000001", file_name: "help" }]), infoOf("h000000001", docInfo)]) });
  back("help: perm get help", ["perm", "get", "help"], HELP, { mock: mock([searchHits([{ file_id: "h000000001", file_name: "help" }]), rule("manage.get_privilege", ok({ policy: 2 }))]) });
  back("help: space ls help", ["space", "ls", "help"], HELP, { mock: mock(rule("query_space_node", ok({ children: [] }))) });
  back("help: canvas read help --all", ["canvas", "read", "help", "--all"], HELP, { mock: mock([searchHits([{ file_id: "h000000001", file_name: "help" }]), rule("smartcanvas.read", ok({ content: "x" }))]) });
  back("help: canvas find dFzLAbBjFuBr help", ["canvas", "find", "dFzLAbBjFuBr", "help"], HELP, { mock: mock(rule("smartcanvas.find", ok({ blocks: [] }))) });
  // Not the last word: an ordinary argument to yargs. The binary leaves the
  // word to yargs wherever it stands.
  back("help: canvas find help q", ["canvas", "find", "help", "q"], HELP, { mock: mock([searchHits([{ file_id: "h000000001", file_name: "help" }]), rule("smartcanvas.find", ok({ blocks: [] }))]) });
  add("help: the word Help in capitals is an ordinary query", ["search", "Help"], { mock: mock(searchHits([])) });
  back("help: space ls S --parent help", ["space", "ls", "S", "--parent", "help"], HELP, { mock: mock(rule("query_space_node", ok({ children: [] }))) });

  // A number whose shortest spelling is a tie between two digits: JavaScript takes the even one.
  add("number: raw sends 1459077941253781.25 as JavaScript writes it", ["raw", "get_content", "--json", '{"n":1459077941253781.25,"m":172237639781087.625,"k":-951257392298430.25}'], { mock: mock(rule("get_content", ok({ content: "c" }))) });
  add("number: info --json prints 1459077941253781.25 as JavaScript writes it", ["info", "dFzLAbBjFuBr", "--json"], { mock: mock(rule("manage.query_file_info", rawStructured('{"size":1459077941253781.25,"ratio":247750044800341.125}'))) });
  add("number: info prints 1262661521323025.25 as JavaScript writes it", ["info", "dFzLAbBjFuBr"], { mock: mock(rule("manage.query_file_info", rawStructured('{"size":1262661521323025.25}'))) });
  add("number: usage with a count of 1037828712724149.25", ["usage"], { home: { ".qqdocs/usage.json": '{"daily":{"@TODAY@":1037828712724149.25},"monthly":{"@MONTH@":1}}' } });
  add("number: read remembers information that holds 1459077941253781.25", ["read", "dFzLAbBjFuBr"], {
    mock: mock([rule("manage.query_file_info", rawStructured('{"title":"T","url":"https://docs.qq.com/doc/x","size":1459077941253781.25}'), { file_id: "dFzLAbBjFuBr" }), content("dFzLAbBjFuBr", "x")], [2]),
  });
  add("number: a call counted on top of 1132576346863060.25", ["search", "x"], { mock: mock(searchHits([])), home: { ".qqdocs/usage.json": '{"daily":{"@TODAY@":1132576346863060.25},"monthly":{"@MONTH@":1132576346863060.25},"inferredTier":"plus"}' } });

  // bun reads package.json, tsconfig.json and jsconfig.json of the current directory and of
  // every directory above it, and reports one it cannot parse on standard error.
  back("project: a package.json that does not parse, in the current directory", ["usage"], PROJECT, { files: { "package.json": "{ this is not json" } });
  back("project: a package.json of no bytes in the current directory is passed over", ["ls"], PROJECT, { mock: mock(recent([planA])), files: { "package.json": "" } });
  back("project: a package.json that is one line end, in the current directory", ["ls"], PROJECT, { mock: mock(recent([planA])), files: { "package.json": "\n" } });
  back("project: a tsconfig.json that does not parse, in the current directory", ["usage"], PROJECT, { files: { "tsconfig.json": "{ nor this" } });
  back("project: a jsconfig.json that does not parse, in the current directory", ["usage"], PROJECT, { files: { "jsconfig.json": "nope" } });
  back("project: a package.json that does not parse, in the directory above", ["usage"], PROJECT, { setup: ["printf '{ bad' > ../package.json"] });
  back("project: a package.json and a tsconfig.json that parse, with comments, paths and a trailing comma", ["ls"], PROJECT, {
    mock: mock(recent([planA])),
    files: { "package.json": '{"name":"elsewhere","version":"9.9.9","type":"commonjs","imports":{"#x":"./x.js"},}', "tsconfig.json": '{\n // c\n "compilerOptions": {"baseUrl": ".", "paths": {"yargs": ["./nope.ts"], "yaml": ["./nope.ts"]}, "jsx": "react"},\n}\n' },
  });

  // more of the same kind as above, which the binary got right
  add("ls: --dates on thirty documents, thirty-one calls counted", ["ls", "-n", "30", "--dates"], {
    mock: mock([recent(Array.from({ length: 30 }, (_, i) => ({ file_id: `doc${String(i).padStart(7, "0")}`, file_name: `Doc ${i}`, file_url: `https://docs.qq.com/doc/D${i}` }))), rule("manage.query_file_info", ok({ last_modify_time: 1700000000000 }))], [1, 30]),
    home: { ".qqdocs/usage.json": usageAt(40) },
    timeout: 300,
  });
  add("search: a query of 20 000 characters", ["search", "长 query ".repeat(2500)], { mock: mock(searchHits([])) });
  add("usage: a count too large for a number", ["usage"], { home: { ".qqdocs/usage.json": '{"daily":{"@TODAY@":1e999},"monthly":{"@MONTH@":-1e-999}}' } });
  add("search: a call counted on top of a count too large for a number", ["search", "x"], { mock: mock(searchHits([])), home: { ".qqdocs/usage.json": '{"daily":{"@TODAY@":1e999},"monthly":{"@MONTH@":9007199254740992}}' } });


  // the first run on a machine, for commands that make several calls
  add("first run: read by title, three calls", ["read", "Plan"], { firstRun: true, mock: mock([searchHits([planA]), infoOf("dFzLAbBjFuBr", docInfo), content("dFzLAbBjFuBr", "x")], [1, 2]) });
  add("first run: info by title, two calls", ["info", "Plan"], { firstRun: true, mock: mock([searchHits([planA]), infoOf("dFzLAbBjFuBr", docInfo)]) });
  add("first run: ls --dates, one call then two at once", ["ls", "--dates"], { firstRun: true, mock: mock([recent([planA, budget]), rule("manage.query_file_info", ok({ last_modify_time: 1700000000000 }))], [1, 2]) });
  add("first run: a folder by path with --dates", ["ls", "Projects", "--dates"], { firstRun: true, mock: mock([rule("manage.folder_list", ok({ list: [{ id: "d1", title: "D1", url: "//docs.qq.com/doc/d1" }, { id: "d2", title: "D2", url: "//docs.qq.com/doc/d2" }] }), { folder_id: "folderAAAA01" }), folderList({ list: [{ id: "folderAAAA01", is_folder: true, title: "Projects", url: "u" }] }), rule("manage.query_file_info", ok({ last_modify_time: 1700000000000 }))], [1, 1, 2]) });
  add("first run: canvas read --all, two pages", ["canvas", "read", "dFzLAbBjFuBr", "--all"], { firstRun: true, mock: mock(rule("smartcanvas.read", [ok({ content: "a", next_token: "t" }), ok({ content: "b" })])) });
  add("first run: usage calibrate with a tier", ["usage", "calibrate", "--tier", "member"], { firstRun: true });
  add("first run: ~/.qqdocs is a dangling link", ["search", "x"], { firstRun: true, setup: ["ln -s /nonexistent/dir <HOME>/.qqdocs"], mock: mock(searchHits([])) });

}

// ── output ───────────────────────────────────────────────────────────────────

const spec = {
  // What differs between two runs of the same case: the time a document was
  // put into the cache, and the time of a sync, in milliseconds.
  normalize: [
    ['"cachedAt": ?\\d{13}(\\.5)?\\b', '"cachedAt": <MS>'],
    ['"syncedAt": \\d{13}\\b', '"syncedAt": <MS>'],
  ],
  cases,
};
const json = `${JSON.stringify(spec, null, 2)}\n`;

/** Who answers the case: `back` everywhere, or `rust` and the systems where it goes back or is skipped. */
function who(c) {
  if (typeof c.handback === "string") return "back";
  const marks = [`back on ${Object.keys(c.handback).join(", ")}`, ...(c.skip ? [`skipped on ${Object.keys(c.skip).join(", ")}`] : [])];
  return `rust (${marks.join("; ")})`;
}

if (process.argv.includes("--list")) {
  for (const c of cases) console.log(`${who(c)}  ${c.name}`);
} else if (process.argv.includes("--check")) {
  // A checkout on Windows may have turned the line ends into CR LF.
  if (fs.readFileSync(OUT, "utf8").replace(/\r\n/g, "\n") !== json) {
    console.error("rs/parity.json is not what rs/parity.gen.mjs writes; run `node rs/parity.gen.mjs`");
    process.exit(1);
  }
  console.log(`rs/parity.json is current (${cases.length} cases)`);
} else {
  fs.writeFileSync(OUT, json);
  const everywhere = cases.filter((c) => typeof c.handback === "string").length;
  const count = (os) => cases.filter((c) => typeof c.handback === "object" && !(c.skip && os in c.skip) && !(os in c.handback)).length;
  const skipped = (os) => cases.filter((c) => c.skip && os in c.skip).length;
  console.log(
    `wrote ${cases.length} cases to rs/parity.json: ${everywhere} handed back everywhere; for Rust ${count("linux")} on Linux, ` +
      `${count("darwin")} on macOS, ${count("win32")} on Windows (${skipped("win32")} skipped there)`,
  );
}
