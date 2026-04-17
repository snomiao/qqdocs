import { readFileSync } from "fs";
import { execFileSync } from "child_process";
import { resolve } from "path";
import { describe, expect, test } from "bun:test";

const repoRoot = resolve(import.meta.dir, "..");
const IGNORED_TRACKED_FILES = new Set([
  ".gitleaks.toml",
  "src/privacy.test.ts",
]);
const PRIVACY_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  {
    label: "concrete Tencent Docs token assignment",
    regex: /TENCENT_DOCS_TOKEN\s*=\s*["']?[A-Za-z0-9]{16,}/,
  },
  {
    label: "absolute local filesystem path",
    regex: /(?:^|[\s"'`(])(?:\/Users\/[^/\s"'`]+|\/home\/[^/\s"'`]+|[A-Za-z]:\\Users\\[^\\\s"'`]+)/,
  },
  {
    label: "personal cloud storage URL",
    regex: /https?:\/\/[^\s"'`]+(?:sharepoint\.com\/personal\/|onedrive\.live\.com)/i,
  },
  {
    label: "common personal email address",
    regex: /\b[A-Za-z0-9._%+-]+@(?:gmail|qq|hotmail|outlook)\.com\b/i,
  },
];

describe("repo privacy guard", () => {
  test("tracked files do not contain obvious secrets or personal data", () => {
    const trackedFiles = execFileSync("git", ["ls-files", "-z"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).split("\0").filter(Boolean);

    const offenders: string[] = [];

    for (const relativePath of trackedFiles) {
      if (IGNORED_TRACKED_FILES.has(relativePath)) continue;
      const content = readFileSync(resolve(repoRoot, relativePath), "utf8");
      for (const { label, regex } of PRIVACY_PATTERNS) {
        const match = content.match(regex);
        if (!match) continue;
        offenders.push(`${relativePath}: ${label}: ${match[0]}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
