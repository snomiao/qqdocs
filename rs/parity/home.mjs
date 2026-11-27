#!/usr/bin/env node
// Parity only: prints everything under a directory, for a case to compare.
//
//   node rs/parity/home.mjs <dir>
//
// Every entry below <dir>, sorted by its path as bytes (what `find . | sort`
// gives in the C locale): a directory as `== ./path/ <mode>`, a symbolic link
// as `== ./path -> <target>` (not followed), and anything else as
// `== ./path <mode>`, then, for a regular file, its bytes and a line end. The
// mode is the permission bits in octal, as `stat -c %a` writes them on Linux.
// Written for node because macOS has no `stat -c`, and so that Windows runs
// the same probe; under bun it prints the same.

import fs from "node:fs";
import path from "node:path";

const root = process.argv[process.argv.length - 1];
const entries = [];
const problem = (error) => `(cannot be read: ${error.code ?? error.message})`;

function walk(dir, shown) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    entries.push({ shown: `${shown}/`, text: `${problem(error)}\n` });
    return;
  }
  for (const name of names) {
    const full = path.join(dir, name);
    const here = `${shown}/${name}`;
    const stat = fs.lstatSync(full);
    const mode = (stat.mode & 0o7777).toString(8);
    if (stat.isDirectory()) {
      entries.push({ shown: `${here}/`, sortBy: here, text: `== ${here}/ ${mode}\n` });
      walk(full, here);
    } else if (stat.isSymbolicLink()) {
      entries.push({ shown: here, text: `== ${here} -> ${fs.readlinkSync(full)}\n` });
    } else if (stat.isFile()) {
      let bytes;
      try {
        bytes = fs.readFileSync(full);
      } catch (error) {
        bytes = Buffer.from(problem(error));
      }
      entries.push({ shown: here, text: Buffer.concat([Buffer.from(`== ${here} ${mode}\n`), bytes, Buffer.from("\n")]) });
    } else {
      entries.push({ shown: here, text: `== ${here} ${mode} (not a regular file)\n` });
    }
  }
}

walk(root, ".");
entries.sort((a, b) => Buffer.compare(Buffer.from(a.sortBy ?? a.shown), Buffer.from(b.sortBy ?? b.shown)));
process.stdout.write(Buffer.concat(entries.map((entry) => (Buffer.isBuffer(entry.text) ? entry.text : Buffer.from(entry.text)))));
