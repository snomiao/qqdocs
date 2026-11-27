#!/usr/bin/env node
// Runs one command against a stand-in for the Tencent Docs MCP endpoint.
//
//   node rs/parity/with-mock.mjs <command> [args...]
//
// qqdocs talks to one address, https://docs.qq.com/openapi/mcp. This starts a
// server on 127.0.0.1 that answers in its place, runs the command with
// QQDOCS_PARITY_MCP_URL naming that server, and afterwards writes down every
// request the server received ($TMPDIR/mcp.log), so that a parity case can
// compare what each implementation asked for and not only what it printed.
//
// The Rust binary reads QQDOCS_PARITY_MCP_URL itself (loopback addresses
// only). The TypeScript knows no such variable, so rs/parity/bin is put first
// on PATH: its `bun` starts the real bun with rs/parity/seam.ts preloaded,
// which redirects the one address and refuses every other. That covers the
// TypeScript side of a case and the JavaScript a binary hands back to alike.
// Nothing here can reach the real service.
//
// What the server answers comes from QQDOCS_PARITY_MOCK, a JSON object:
//
//   { "rules": [ { "tool": "get_content",            // tools/call of this tool
//                  "where": { "file_id": "abc" },    // optional: arguments to match
//                  "replies": [ <reply>, ... ] },    // used in turn; the last one repeats
//                { "method": "tools/list", "replies": [ ... ] } ],
//     "batches": [1, 2] }                            // optional, see below
//
// A reply is one of
//   { "structured": <value> }   result.structuredContent
//   { "text": "<string>" }      result.content[0].text
//   { "result": <value> }       the JSON-RPC result as given
//   { "error": <value> }        a JSON-RPC error
//   { "status": 503, "body": "...", "headers": {...} }   any HTTP response
//   { "drop": true }            the connection is closed without an answer
// A request no rule matches gets a JSON-RPC error saying so. In a reply, the
// string "@now-90000" stands for the number of milliseconds since 1970 as of
// 90 seconds before the reply is sent ("@now-90000@text" for the same as a
// string of digits), for answers that are shown relative to the present.
//
// "batches" is for calls the TypeScript makes at the same time
// (Promise.all): [1, 2] says the first request comes alone and the next two
// together. The server holds a batch until all of it has arrived and logs it
// in a fixed order, marked "N at once"; an implementation that sends those
// one after the other waits out the hold and is logged differently.

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const [program, ...programArgs] = process.argv.slice(2);
if (!program) {
  console.error("usage: with-mock.mjs <command> [args...]");
  process.exit(2);
}

const scenario = JSON.parse(process.env.QQDOCS_PARITY_MOCK || "{}");
const rules = (scenario.rules || []).map((rule) => ({ ...rule, used: 0 }));
const batches = [...(scenario.batches || [])];
const logFile = process.env.QQDOCS_PARITY_LOG || path.join(process.env.TMPDIR || os.tmpdir(), "mcp.log");
/** How long a batch waits for its missing requests. */
const HOLD_MS = 1500;

const lines = [];
let pending = [];
let want = batches.shift() ?? 1;
let timer = null;
let sequence = 0;

function matches(rule, call) {
  if ((rule.method || "tools/call") !== call?.method) return false;
  if (rule.tool !== undefined && rule.tool !== call?.params?.name) return false;
  const args = call?.params?.arguments || {};
  return Object.entries(rule.where || {}).every(([key, value]) => JSON.stringify(args[key]) === JSON.stringify(value));
}

/** Replaces the "@now±N" strings of a reply by times relative to now. */
function timed(value) {
  if (typeof value === "string") {
    const stamp = /^@now([+-]\d+)(@text)?$/.exec(value);
    if (!stamp) return value;
    const ms = Date.now() + Number(stamp[1]);
    return stamp[2] ? String(ms) : ms;
  }
  if (Array.isArray(value)) return value.map(timed);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, timed(v)]));
  return value;
}

function answer(entry) {
  let call = null;
  try {
    call = JSON.parse(entry.body);
  } catch {
    // not JSON: no rule matches
  }
  const rule = rules.find((r) => matches(r, call));
  const replies = rule?.replies || [];
  const reply = replies.length
    ? replies[Math.min(rule.used++, replies.length - 1)]
    : { error: { code: -32601, message: `parity mock: no rule for ${call?.method} ${call?.params?.name ?? ""}`.trim() } };
  const { res } = entry;
  if (reply.drop) return res.destroy();
  if (reply.status !== undefined) {
    res.writeHead(reply.status, reply.headers || {});
    return res.end(reply.body ?? "");
  }
  const payload = { jsonrpc: "2.0", id: 1 };
  if (reply.error !== undefined) payload.error = reply.error;
  else if (reply.result !== undefined) payload.result = timed(reply.result);
  else if (reply.text !== undefined) payload.result = { content: [{ type: "text", text: reply.text }] };
  else if (reply.structured !== undefined) payload.result = { structuredContent: timed(reply.structured) };
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function release(timedOut) {
  clearTimeout(timer);
  timer = null;
  const group = pending;
  pending = [];
  sequence++;
  // Requests sent at the same time arrive in no particular order.
  group.sort((a, b) => (a.line < b.line ? -1 : a.line > b.line ? 1 : 0));
  const together = want > 1 ? `${group.length} at once${timedOut ? `, waited for ${want}` : ""}` : "alone";
  for (const entry of group) lines.push(`${sequence}\t${together}\t${entry.line}`);
  want = batches.shift() ?? 1;
  for (const entry of group) answer(entry);
}

/** The token as sent, if it is one of the cases' made-up ones. A real one is never written down. */
function shownToken(value) {
  if (value === undefined) return "(none)";
  return /fake-/.test(value) && value.length <= 64 ? value : `(not a parity token, ${value.length} characters)`;
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    const line = [
      `${req.method} ${req.url}`,
      `content-type: ${req.headers["content-type"] ?? "(none)"}`,
      `authorization: ${shownToken(req.headers.authorization)}`,
      body,
    ].join("\t");
    pending.push({ res, body, line });
    if (pending.length >= want) release(false);
    else if (!timer) timer = setTimeout(() => release(true), HOLD_MS);
  });
});

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  const child = spawn(program, programArgs, {
    stdio: "inherit",
    env: {
      ...process.env,
      PATH: `${path.join(here, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
      QQDOCS_PARITY_MCP_URL: `http://127.0.0.1:${port}/openapi/mcp`,
    },
  });
  const finish = (code) => {
    fs.writeFileSync(logFile, lines.length ? `${lines.join("\n")}\n` : "(no requests)\n");
    process.exit(code);
  };
  child.on("error", (error) => {
    console.error(`with-mock: could not run ${program}: ${error.message}`);
    finish(127);
  });
  child.on("exit", (code, signal) => finish(code ?? 128 + (os.constants.signals[signal] ?? 0)));
});
