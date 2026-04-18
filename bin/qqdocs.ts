#!/usr/bin/env bun
// qqdocs — standalone CLI for Tencent Docs (docs.qq.com).

import { basename } from "path";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

function resolveScriptName(): string {
  const raw = basename(process.argv[1] ?? "qqdocs");
  // Strip .ts/.js so help output reads "qqdocs" not "qqdocs.ts" under bun link.
  return raw.replace(/\.(ts|js|mjs|cjs)$/i, "") || "qqdocs";
}
import {
  type CanvasEditActionInput,
  type SpaceDocTypeInput,
  type SmartCanvasContentFormat,
  cmdCanvasEdit,
  cmdCanvasFind,
  cmdCanvasRead,
  cmdDocsCreate,
  cmdDocsDelete,
  cmdDocsInfo,
  cmdDocsImport,
  cmdDocsLs,
  cmdDocsOpen,
  cmdDocsCopy,
  cmdDocsPermission,
  cmdDocsRead,
  cmdDocsRename,
  cmdDocsSearch,
  cmdDocsSetPermission,
  cmdRaw,
  cmdSpaceCreate,
  cmdSpaceLink,
  cmdSpaceList,
  cmdSpaceLs,
  cmdSpaceMkdir,
  cmdSpaceMkdoc,
  cmdSpaceMove,
  cmdSpaceRm,
  cmdTools,
} from "../src/index";

await yargs(hideBin(process.argv))
  .scriptName(resolveScriptName())
  .usage("$0 <command> [options]")
  .epilog("<ref> accepts a doc ID, a docs.qq.com URL, or a document name (unique match required)")
  .command("tools [pattern]", "List live Tencent Docs MCP tools", y => y
    .positional("pattern", { type: "string" }),
    async argv => cmdTools(argv.pattern))
  .command("raw <tool>", "Call a raw Tencent Docs MCP tool", y => y
    .positional("tool", { type: "string", demandOption: true })
    .option("json", { type: "string", default: "{}", describe: "JSON object arguments" }),
    async argv => cmdRaw(argv.tool, argv.json))
  .command("ls [folder]", "List recently viewed documents, or folder contents when a folder ID is given", y => y
    .positional("folder", { type: "string", describe: "Folder ID (omit for recent docs, pass 'root' for root folder)" })
    .option("count", { type: "number", default: 20, alias: "n" })
    .option("page", { type: "number", default: 1, alias: "p" })
    .option("json", { type: "boolean", default: false })
    .option("dates", { type: "boolean", default: false, alias: "d", describe: "Fetch and show last-modified dates (extra API calls)" }),
    async argv => cmdDocsLs({ count: argv.count, page: argv.page, json: argv.json, folder: argv.folder, dates: argv.dates }))
  .command("search <query>", "Search documents by keyword", y => y
    .positional("query", { type: "string", demandOption: true })
    .option("json", { type: "boolean", default: false }),
    async argv => cmdDocsSearch(argv.query, { json: argv.json }))
  .command("read <ref>", "Read document content", y => y
    .positional("ref", { type: "string", demandOption: true }),
    async argv => cmdDocsRead(argv.ref))
  .command(["rename <ref> <title>", "mv <ref> <title>"], "Rename a document", y => y
    .positional("ref", { type: "string", demandOption: true })
    .positional("title", { type: "string", demandOption: true }),
    async argv => cmdDocsRename(argv.ref, argv.title))
  .command("open <ref>", "Open a document in the default browser", y => y
    .positional("ref", { type: "string", demandOption: true }),
    async argv => cmdDocsOpen(argv.ref))
  .command(["cp <ref>", "copy <ref>"], "Copy a document", y => y
    .positional("ref", { type: "string", demandOption: true })
    .option("title", { type: "string", describe: "New title for the copy" }),
    async argv => cmdDocsCopy(argv.ref, { title: argv.title }))
  .command(["delete <ref>", "rm <ref>"], "Dry-run document delete; prints required --confirm=<4-digit-code>, then deletes when provided", y => y
    .positional("ref", { type: "string", demandOption: true })
    .option("confirm", { type: "string", alias: "c", describe: "4-digit code derived from current document content" }),
    async argv => cmdDocsDelete(argv.ref, { confirm: argv.confirm }))
  .command("info <ref>", "Show document metadata", y => y
    .positional("ref", { type: "string", demandOption: true })
    .option("json", { type: "boolean", default: false }),
    async argv => cmdDocsInfo(argv.ref, { json: argv.json }))
  .command(["import <path>", "upload <path>"], "Import a local file or create a doc from Markdown", y => y
    .positional("path", { type: "string", demandOption: true, describe: "Local file path" })
    .option("title", { type: "string", describe: "Document title override" })
    .option("perm", { type: "string", describe: "private|link-read|link-edit" })
    .option("space", { type: "string", describe: "Target space ID" })
    .option("parent", { type: "string", describe: "Target parent node ID inside the space" })
    .option("poll", { type: "number", default: 5000, describe: "Import polling interval in ms" })
    .option("timeout", { type: "number", default: 300000, describe: "Import timeout in ms" }),
    async argv => cmdDocsImport(argv.path, {
      title: argv.title,
      perm: argv.perm,
      spaceId: argv.space,
      parentId: argv.parent,
      pollIntervalMs: argv.poll,
      timeoutMs: argv.timeout,
    }))
  .command("perm", "Permission subcommands: get <ref>; set <ref> <private|link-read|link-edit>", y => y
    .command("get <ref>", "Get document permission", yy => yy
      .positional("ref", { type: "string", demandOption: true }),
      async argv => cmdDocsPermission(argv.ref))
    .command("set <ref> <policy>", "Set document permission", yy => yy
      .positional("ref", { type: "string", demandOption: true })
      .positional("policy", { type: "string", demandOption: true, describe: "private|link-read|link-edit" }),
      async argv => cmdDocsSetPermission(argv.ref, argv.policy))
    .demandCommand(1))
  .command("space", "Space management commands", y => y
    .command("list", "List spaces", yy => yy
      .option("page", { type: "number", default: 0, alias: "p" })
      .option("scope", { type: "string", choices: ["all", "mine", "joined"] as const })
      .option("order", { type: "string", choices: ["preview", "edited", "created"] as const })
      .option("asc", { type: "boolean", default: false }),
      async argv => cmdSpaceList({
        page: argv.page,
        scope: argv.scope,
        order: argv.order,
        descending: argv.asc ? false : undefined,
      }))
    .command("create <title>", "Create a new space", yy => yy
      .positional("title", { type: "string", demandOption: true })
      .option("description", { type: "string" }),
      async argv => cmdSpaceCreate(argv.title, { description: argv.description }))
    .command("ls <space>", "List nodes inside a space", yy => yy
      .positional("space", { type: "string", demandOption: true })
      .option("parent", { type: "string", describe: "Parent node ID" })
      .option("page", { type: "number", default: 0, alias: "p" }),
      async argv => cmdSpaceLs(argv.space, { parentId: argv.parent, page: argv.page }))
    .command("mkdir <space> <title>", "Create a folder inside a space", yy => yy
      .positional("space", { type: "string", demandOption: true })
      .positional("title", { type: "string", demandOption: true })
      .option("parent", { type: "string", describe: "Parent node ID" })
      .option("before", { type: "boolean", default: false }),
      async argv => cmdSpaceMkdir(argv.space, argv.title, { parentId: argv.parent, isBefore: argv.before }))
    .command("mkdoc <space> <title>", "Create a document node inside a space", yy => yy
      .positional("space", { type: "string", demandOption: true })
      .positional("title", { type: "string", demandOption: true })
      .option("type", {
        type: "string",
        default: "smartcanvas",
        choices: ["smartcanvas", "doc", "sheet", "slide", "mind", "flowchart", "smartsheet", "form"] as const,
      })
      .option("parent", { type: "string", describe: "Parent node ID" })
      .option("before", { type: "boolean", default: false }),
      async argv => cmdSpaceMkdoc(argv.space, argv.title, { type: argv.type as SpaceDocTypeInput, parentId: argv.parent, isBefore: argv.before }))
    .command("link <space> <title> <url>", "Create a link node inside a space", yy => yy
      .positional("space", { type: "string", demandOption: true })
      .positional("title", { type: "string", demandOption: true })
      .positional("url", { type: "string", demandOption: true })
      .option("description", { type: "string" })
      .option("parent", { type: "string", describe: "Parent node ID" })
      .option("before", { type: "boolean", default: false }),
      async argv => cmdSpaceLink(argv.space, argv.title, argv.url, {
        description: argv.description,
        parentId: argv.parent,
        isBefore: argv.before,
      }))
    .command("rm <space> <node>", "Delete a node from a space", yy => yy
      .positional("space", { type: "string", demandOption: true })
      .positional("node", { type: "string", demandOption: true })
      .option("all", { type: "boolean", default: false, describe: "Delete the whole subtree" }),
      async argv => cmdSpaceRm(argv.space, argv.node, { all: argv.all }))
    .command("move <ref> <space>", "Move a document into a space", yy => yy
      .positional("ref", { type: "string", demandOption: true })
      .positional("space", { type: "string", demandOption: true })
      .option("parent", { type: "string", describe: "Target parent node ID" }),
      async argv => cmdSpaceMove(argv.ref, argv.space, { parentId: argv.parent }))
    .demandCommand(1))
  .command("canvas", "Smartcanvas commands", y => y
    .command("read <ref>", "Read smartcanvas content as MDX", yy => yy
      .positional("ref", { type: "string", demandOption: true })
      .option("page", { type: "string", describe: "Page ID" })
      .option("size", { type: "number" })
      .option("next", { type: "string", describe: "Pagination token" })
      .option("all", { type: "boolean", default: false, describe: "Follow next_token until the whole document is read" }),
      async argv => cmdCanvasRead(argv.ref, { pageId: argv.page, size: argv.size, nextToken: argv.next, all: argv.all }))
    .command("find <ref> <query>", "Find blocks in a smartcanvas document", yy => yy
      .positional("ref", { type: "string", demandOption: true })
      .positional("query", { type: "string", demandOption: true }),
      async argv => cmdCanvasFind(argv.ref, argv.query))
    .command("edit <ref> <action>", "Edit a smartcanvas document", yy => yy
      .positional("ref", { type: "string", demandOption: true })
      .positional("action", { type: "string", demandOption: true })
      .option("id", { type: "string", describe: "Target block ID" })
      .option("content", { type: "string", describe: "MDX content" }),
      async argv => cmdCanvasEdit(argv.ref, argv.action as CanvasEditActionInput, { id: argv.id, content: argv.content }))
    .demandCommand(1))
  .command("create <title>", "Create a new document", y => y
    .positional("title", { type: "string", demandOption: true })
    .option("type", {
      type: "string", default: "smartcanvas",
      choices: ["smartcanvas", "doc", "sheet", "slide", "mind", "flowchart", "smartsheet", "form"],
    })
    .option("format", { type: "string", choices: ["mdx", "markdown"] as const, describe: "smartcanvas content format" })
    .option("perm", { type: "string", describe: "private|link-read|link-edit" })
    .option("content", { type: "string", describe: "Initial content (MDX or Markdown for smartcanvas)" }),
    async argv => cmdDocsCreate(argv.title, {
      type: argv.type,
      format: argv.format as SmartCanvasContentFormat | undefined,
      content: argv.content,
      perm: argv.perm,
    }))
  .demandCommand(1, "Specify a subcommand: tools, raw, ls, search, read, rename, open, delete, info, import, perm, space, canvas, create")
  .completion("completion", "Generate shell completion script (source it in your shell rc)")
  .strict()
  .help()
  .alias("help", "h")
  .showHelpOnFail(true)
  .parse();
