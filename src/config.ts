// Non-secret YAML config loader. Search order (first match wins):
//   $PWD/.qqdocs/config.yaml
//   $PWD/.qqdocs.config.yaml
//   $HOME/.qqdocs/config.yaml
//   $HOME/.qqdocs.config.yaml
// Secrets belong in .env.local, not here.

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";
import { parse as parseYaml } from "yaml";

export type QqdocsConfig = {
  defaultSpace?: string;
  defaultParent?: string;
  defaultPerm?: "private" | "link-read" | "link-edit";
  defaultDocType?: string;
  defaultFormat?: "mdx" | "markdown";
  /** Membership tier: free (100/day), member (1000/day), plus (2000/day). Default: free. */
  tier?: "free" | "member" | "plus";
  [key: string]: unknown;
};

export function configSearchPaths(cwd: string = process.cwd(), home: string = homedir()): string[] {
  return [
    resolve(cwd, ".qqdocs", "config.yaml"),
    resolve(cwd, ".qqdocs.config.yaml"),
    resolve(home, ".qqdocs", "config.yaml"),
    resolve(home, ".qqdocs.config.yaml"),
  ];
}

export function loadConfig(cwd?: string, home?: string): QqdocsConfig {
  for (const f of configSearchPaths(cwd, home)) {
    if (!existsSync(f)) continue;
    const raw = readFileSync(f, "utf-8");
    const parsed = parseYaml(raw);
    if (parsed && typeof parsed === "object") return parsed as QqdocsConfig;
    return {};
  }
  return {};
}

export const config: QqdocsConfig = loadConfig();
