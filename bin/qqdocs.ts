#!/usr/bin/env bun
// qqdocs — standalone CLI for Tencent Docs (docs.qq.com).

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import {
  cmdDocsLs, cmdDocsSearch, cmdDocsRead, cmdDocsInfo, cmdDocsCreate,
} from "../src/index";

await yargs(hideBin(process.argv))
  .scriptName("qqdocs")
  .usage("$0 <command> [options]")
  .command("ls", "List recently viewed documents", y => y
    .option("count", { type: "number", default: 20, alias: "n" })
    .option("page", { type: "number", default: 1, alias: "p" }),
    async argv => cmdDocsLs({ count: argv.count, page: argv.page }))
  .command("search <query>", "Search documents by keyword", y => y
    .positional("query", { type: "string", demandOption: true }),
    async argv => cmdDocsSearch(argv.query))
  .command("read <file>", "Read document content (file ID or URL)", y => y
    .positional("file", { type: "string", demandOption: true }),
    async argv => cmdDocsRead(argv.file))
  .command("info <file>", "Show document metadata (file ID or URL)", y => y
    .positional("file", { type: "string", demandOption: true }),
    async argv => cmdDocsInfo(argv.file))
  .command("create <title>", "Create a new document", y => y
    .positional("title", { type: "string", demandOption: true })
    .option("type", {
      type: "string", default: "smartcanvas",
      choices: ["smartcanvas", "doc", "sheet", "slide", "mind", "flowchart", "smartsheet", "form"],
    })
    .option("content", { type: "string", describe: "Initial content (MDX for smartcanvas)" }),
    async argv => cmdDocsCreate(argv.title, { type: argv.type, content: argv.content }))
  .demandCommand(1, "Specify a subcommand: ls, search, read, info, create")
  .strict()
  .help()
  .alias("help", "h")
  .showHelpOnFail(true)
  .parse();
