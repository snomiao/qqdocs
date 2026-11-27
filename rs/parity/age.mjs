#!/usr/bin/env node
// Parity only: leaves a file (empty if it was not there) last changed this
// many seconds ago, for the cases about a lock left behind.
//
//   node rs/parity/age.mjs <seconds> <file>
//
// Written for node because macOS has no GNU `touch -d`. A script and not a
// `node -e` one-liner: started under the name `node`, bun leaves the first
// argument after -e out of process.argv, and a one-liner that took its file
// from there opened bun's own executable instead, after which macOS killed
// every start of it for a while. So the file has to be one in the case's
// home directory, and nothing else is touched.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [seconds, file] = process.argv.slice(2);
// HOME, or USERPROFILE on Windows; there in any letters.
const fold = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
const home = fold(path.resolve(os.homedir()));
const target = file ? path.resolve(file) : "";
const inHome = fold(target).startsWith(home + path.sep);
if (process.argv.length !== 4 || !/^\d+$/.test(seconds ?? "") || !inHome || fold(target) === fold(path.resolve(process.execPath))) {
  console.error(`age.mjs: wants <seconds> <a file in HOME>, got ${JSON.stringify(process.argv.slice(2))}`);
  process.exit(2);
}
const when = Date.now() / 1000 - Number(seconds);
fs.closeSync(fs.openSync(target, "a"));
fs.utimesSync(target, when, when);
