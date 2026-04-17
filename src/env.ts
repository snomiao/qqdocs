// Minimal .env.local loader. Merges values from the module dir, its parent,
// grand-parent (monorepo layouts), and the current working directory.
// Process env always wins over file values.

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";

function loadEnv(): Record<string, string> {
  const result: Record<string, string> = {};
  const root = resolve(import.meta.dir, "..");
  const home = homedir();
  const files = [
    resolve(root, ".env.local"),
    resolve(root, "..", ".env.local"),
    resolve(root, "../..", ".env.local"),
    resolve(process.cwd(), ".env.local"),
    resolve(home, ".qqdocs", ".env.local"),
  ];
  for (const f of files) {
    if (!existsSync(f)) continue;
    const entries = readFileSync(f, "utf-8").replace(/\r/g, "").split("\n")
      .map(l => l.match(/^([^#=]+)=(.*)$/))
      .filter(Boolean).map(m => [m![1].trim(), m![2].trim()] as const);
    for (const [k, v] of entries) {
      if (!(k in result)) result[k] = v;
    }
  }
  return result;
}

export const env = loadEnv();
