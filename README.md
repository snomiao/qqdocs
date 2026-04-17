# qqdocs

Tencent Docs ([docs.qq.com](https://docs.qq.com)) CLI and library. Thin
wrapper over the MCP JSON-RPC endpoints — no SDK, no handshake, one HTTP
POST per call.

## Requirements

[Bun](https://bun.sh) ≥ 1.x. The CLI is shipped as `.ts` with a Bun shebang,
so `node`/`npx` is not supported — use `bun`/`bunx`.

## Install

```bash
bunx qqdocs ls        # run without install
bun add qqdocs        # library
bun add -g qqdocs     # `qqdocs` CLI
```

Published binaries:

- `qqdocs` (canonical)
- `qqdoc` (typo-tolerant alias)

## Auth

Get a token from [docs.qq.com MCP settings](https://docs.qq.com/openapi/mcp)
and either:

- export `TENCENT_DOCS_TOKEN=...` in your shell, or
- put `TENCENT_DOCS_TOKEN=...` in a `.env.local` file. Lookup order
  (first hit wins): package dir, its parents, the current working
  directory, and `$HOME/.qqdocs/.env.local`.

Non-secret defaults (e.g. default space, default permission) can live
in a YAML config. Lookup order:

- `$PWD/.qqdocs/config.yaml`
- `$PWD/.qqdocs.config.yaml`
- `$HOME/.qqdocs/config.yaml`
- `$HOME/.qqdocs.config.yaml`

## CLI

```bash
qqdocs tools [pattern]                                # list live MCP tools
qqdocs raw <tool> --json '{"file_id":"..."}'          # raw tool call

qqdocs ls [--json]                                   # recent documents
qqdocs search <query> [--json]                       # keyword search
qqdocs read <file-id-or-url-or-name>                 # read document content
qqdocs rename <file-id-or-url-or-name> <new-title>   # rename
qqdocs open <file-id-or-url-or-name>                 # open in browser
qqdocs cp <file-id-or-url-or-name> [--title <t>]     # copy document (alias: copy)
qqdocs delete <file-id-or-url>                       # dry run; prints delete confirm code (alias: rm)
qqdocs delete <file-id-or-url> --confirm=1234        # delete using current content-hash code
qqdocs delete <file-id-or-url> -c 1234               # same as --confirm
qqdocs info <file-id-or-url> [--json]                # document metadata
qqdocs import <path> [--title <title>]                # import pdf/docx/pptx/... or ingest .md/.mdx
qqdocs perm get <file-id-or-url>                     # read permission
qqdocs perm set <file-id-or-url> <private|link-read|link-edit>

qqdocs space list [--scope all|mine|joined]
qqdocs space create <title> [--description <text>]
qqdocs space ls <space-id> [--parent <node-id>] [--page <n>]
qqdocs space mkdir <space-id> <title> [--parent <node-id>]
qqdocs space mkdoc <space-id> <title> [--type smartcanvas|doc|sheet|slide|mind|flowchart|smartsheet|form]
qqdocs space link <space-id> <title> <url> [--description <text>]
qqdocs space rm <space-id> <node-id> [--all]
qqdocs space move <file-id-or-url> <space-id> [--parent <node-id>]

qqdocs canvas read <file-id-or-url> [--page <page-id>] [--size <n>] [--next <token>] [--all]
qqdocs canvas find <file-id-or-url> <query>
qqdocs canvas edit <file-id-or-url> <insert-before|insert-after|append|update|delete>
                 [--id <block-id>] [--content '<mdx>']

qqdocs create <title> [--type smartcanvas|doc|sheet|slide|mind|flowchart|smartsheet|form]
                      [--format mdx|markdown]
                      [--content '<mdx-or-markdown>']
                      [--perm private|link-read|link-edit]

qqdocs completion                                    # prints a shell completion script
```

## Shell completion

`qqdocs completion` prints a completion script. Source it from your shell rc:

```bash
qqdocs completion >> ~/.zshrc     # zsh
qqdocs completion >> ~/.bashrc    # bash
```

The live Tencent Docs MCP surface changes over time. `qqdocs tools` is the
source of truth for what the current server actually exposes.

File arguments accept a raw `file_id`, a full `docs.qq.com` URL, or a
filename. When a filename is given, qqdocs searches Tencent Docs and
resolves to a unique match; if multiple documents share the name the
command throws a list of candidates so you can disambiguate by ID, URL,
or rename.

`qqdocs delete` is intentionally two-step. Running it without `--confirm`
does a dry run and prints the current 4-digit confirmation code derived from
the document's current content. The delete only happens when that exact code
is passed back via `--confirm=<4-digit-code>`, so if the content changes, the
code changes.

`qqdocs import` supports:

- Markdown sources: `.md`, `.markdown`, `.mdx`
- Tencent async import formats: `xls`, `xlsx`, `csv`, `doc`, `docx`, `txt`, `text`, `ppt`, `pptx`, `pdf`, `xmind`

For `.md` and `.markdown`, the CLI creates a smartcanvas document with
`content_format=markdown`.
For `.mdx`, it creates a smartcanvas document with MDX content.
For the importable binary/text formats, the CLI uploads the local file,
starts Tencent Docs async import, waits for completion, and can optionally
rename the result with `--title`.

Permission policies:

- `private`
- `link-read`
- `link-edit`

New documents are private by default.
`qqdocs perm get` can report all three states.
`qqdocs perm set` accepts `private|link-read|link-edit`, but Tencent Docs MCP currently only supports setting the public modes, so `private` prints a clear unsupported message.
The `create` command also prints the new document's initial policy plus ready-to-run `qqdocs perm get` and `qqdocs perm set` commands.

## Library

```ts
import {
  callTool,
  copyDoc,
  createDoc,
  createSpace,
  createSpaceDocNode,
  editCanvas,
  findCanvasBlocks,
  getDocInfo,
  getDocDeleteConfirmCode,
  importLocalFile,
  getDocPermission,
  listRecent,
  listSpaceNodes,
  listSpaces,
  listTools,
  renameDoc,
  readCanvas,
  readDoc,
  searchDocs,
  setDocPermission,
} from "qqdocs";

const tools = await listTools("space");
const files = await listRecent(10);
const hits = await searchDocs("Q4 planning");
const content = await readDoc("YOUR_FILE_ID");
const info = await getDocInfo("YOUR_FILE_ID");
const deleteConfirmCode = await getDocDeleteConfirmCode("YOUR_FILE_ID");
const permission = await getDocPermission("YOUR_FILE_ID");
await setDocPermission("YOUR_FILE_ID", "link-read");

const spaces = await listSpaces({ scope: "all" });
const space = await createSpace("Docs Playground");
const nodes = await listSpaceNodes("space_id_here");
const node = await createSpaceDocNode("space_id_here", "New Space Doc", "smartcanvas");

const canvas = await readCanvas("YOUR_FILE_ID");
const blocks = await findCanvasBlocks("YOUR_FILE_ID", "Hello");
await editCanvas("YOUR_FILE_ID", "append", { content: "<Text>Hello</Text>" });

const raw = await callTool("manage.query_file_info", { file_id: "YOUR_FILE_ID" });
const { url } = await createDoc("New Doc", "smartcanvas", {
  content: "# Hello",
  contentFormat: "markdown",
});
const imported = await importLocalFile("./report.pdf");
await renameDoc(imported.file_id, "Quarterly Report");
const copy = await copyDoc("YOUR_FILE_ID");
```

All functions throw on MCP errors (`Error: MCP error: <message>`).

## License

MIT
