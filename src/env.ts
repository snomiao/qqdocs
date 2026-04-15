// Minimal .env.local loader. Merges values from the module dir, its parent,
// grand-parent (monorepo layouts), and the current working directory.
// Process env always wins over file values.

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

function loadEnv(): Record<string, string> {
  const result: Record<string, string> = {};
  const root = resolve(import.meta.dir, "..");
  const dirs = [root, resolve(root, ".."), resolve(root, "../.."), process.cwd()];
  for (const dir of dirs) {
    const f = resolve(dir, ".env.local");
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
