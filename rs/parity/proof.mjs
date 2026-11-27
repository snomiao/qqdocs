#!/usr/bin/env node
// The proof that the binary behaves like the TypeScript, as the pipeline's
// parity job runs it on linux-x64, darwin-arm64 and win32-x64, and as it runs
// by hand from a checkout (after `bun install` and a release build):
//
//   node rs/parity/proof.mjs <the binary> <rustify's templates/parity/parity.mjs>
//
// 1. rs/parity.json is what rs/parity.gen.mjs writes.
// 2. Every bun the cases start loads the stand-in's seam
//    (rs/parity/with-mock.mjs --check), so that no case can reach the service.
// 3. The cases, TypeScript against the binary. What the binary hands back
//    reaches bin/qqdocs.ts of this checkout.
// 4. Which cases the binary answered itself (--handback): exactly those the
//    cases do not mark "handback" for this system.
// 5. The crate's own tests (cargo test).
//
// 3 and 4 run in parts, every part at once and beside 5: QQDOCS_PARITY_PARTS
// parts each (3 on Windows, where a case takes longest, 2 elsewhere), case 1,
// 1 + n, 1 + 2n, … in part 1 and so on. Each run has a temp directory of its
// own, and its output is printed whole when everything has ended. A node
// script and not a shell script: a checkout on Windows may give a shell
// script CR LF line ends, which bash does not read.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const [binaryArg, runnerArg] = process.argv.slice(2);
if (!binaryArg || !runnerArg) {
  console.error("usage: node rs/parity/proof.mjs <the binary> <rustify's templates/parity/parity.mjs>");
  process.exit(2);
}
const binary = path.resolve(binaryArg);
const runner = path.resolve(runnerArg);
const isWindows = process.platform === "win32";
const parts = Number(process.env.QQDOCS_PARITY_PARTS || (isWindows ? 3 : 2));
if (!Number.isInteger(parts) || parts < 1) {
  console.error(`QQDOCS_PARITY_PARTS must be a whole number above 0, not ${JSON.stringify(process.env.QQDOCS_PARITY_PARTS)}`);
  process.exit(2);
}
process.chdir(repo);

for (const step of [["rs/parity.gen.mjs", "--check"], ["rs/parity/with-mock.mjs", "--check"]]) {
  const { status } = spawnSync(process.execPath, step, { stdio: "inherit" });
  if (status !== 0) process.exit(1);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "qqdocs-proof-"));
const spec = JSON.parse(fs.readFileSync("rs/parity.json", "utf8"));
// A word for the runner's --ts and --rs, which it splits at spaces.
const word = (text) => (/\s/.test(text) ? `"${text}"` : text);
const withMock = `node rs/parity/with-mock.mjs ${word(binary)}`;

/**
 * Starts one run; resolves to its name, exit code and output file when it has
 * ended. `id` names its files: no blanks, as the cases' lines do not quote
 * the directories they are given.
 */
function start(id, name, command, args) {
  const tmp = path.join(work, `${id}.tmp`);
  fs.mkdirSync(tmp);
  const log = path.join(work, `${id}.log`);
  const out = fs.openSync(log, "w");
  const env = { ...process.env, TMPDIR: tmp, ...(isWindows ? { TEMP: tmp, TMP: tmp } : {}) };
  const child = spawn(command, args, { stdio: ["ignore", out, out], env, windowsHide: true });
  fs.closeSync(out);
  return new Promise((resolve) => {
    child.on("error", (error) => {
      fs.appendFileSync(log, `could not start ${command}: ${error.message}\n`);
      resolve({ name, code: 127, log });
    });
    child.on("exit", (code, signal) => resolve({ name, code: code ?? `signal ${signal}`, log }));
  });
}

const runs = [];
for (let part = 0; part < parts; part++) {
  const file = path.join(work, `part-${part + 1}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...spec, cases: spec.cases.filter((_, index) => index % parts === part) }));
  const of = `${part + 1} of ${parts}`;
  runs.push(
    start(`compare-${part + 1}`, `the cases, TypeScript against the binary, part ${of}`, process.execPath, [
      runner, "--cases", file,
      "--ts", "node rs/parity/with-mock.mjs bun bin/qqdocs.ts",
      "--rs", `env ${word(`QQDOCS_PACKAGE_ROOT=${repo}`)} ${withMock}`,
    ]),
    start(`handback-${part + 1}`, `who answers each case, part ${of}`, process.execPath, [runner, "--cases", file, "--rs", withMock, "--handback", "QQDOCS_PACKAGE_ROOT=bin/qqdocs.ts"]),
  );
}
runs.push(start("cargo-test", "cargo test", "cargo", ["test", "--manifest-path", path.join("rs", "Cargo.toml")]));

const ended = await Promise.all(runs);
const grouped = process.env.GITHUB_ACTIONS === "true";
for (const { name, code, log } of ended) {
  console.log(grouped ? `::group::${name}: exit ${code}` : `── ${name}: exit ${code}`);
  process.stdout.write(fs.readFileSync(log));
  if (grouped) console.log("::endgroup::");
}
fs.rmSync(work, { recursive: true, force: true, maxRetries: 3 });
const failed = ended.filter((run) => run.code !== 0);
for (const { name, code } of ended) console.log(`${code === 0 ? "passed" : "FAILED"}  ${name}${code === 0 ? "" : ` (exit ${code})`}`);
console.log(failed.length ? `proof: ${failed.length} of ${ended.length} runs failed` : `proof: all ${ended.length} runs passed on ${process.platform}`);
// Not process.exit(): on macOS and Windows a pipe is written asynchronously,
// and the logs above must arrive whole.
process.exitCode = failed.length ? 1 : 0;
