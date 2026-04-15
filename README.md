# qqdocs

Tencent Docs ([docs.qq.com](https://docs.qq.com)) CLI and library. Thin
wrapper over the MCP JSON-RPC endpoints — no SDK, no handshake, one HTTP
POST per call.

## Install

```bash
bun add qqdocs        # library
bun add -g qqdocs     # `qqdocs` CLI
```

## Auth

Get a token from [docs.qq.com MCP settings](https://docs.qq.com/openapi/mcp)
and either:

- export `TENCENT_DOCS_TOKEN=...` in your shell, or
- put `TENCENT_DOCS_TOKEN=...` in a `.env.local` file next to the package
  (or in any parent directory, or in the current working directory —
  first one wins).

## CLI

```
qqdocs ls                          # recent documents
qqdocs search <query>              # search by keyword
qqdocs read <file-id-or-url>       # print document content
qqdocs info <file-id-or-url>       # print document metadata
qqdocs create <title> [--type smartcanvas|doc|sheet|slide|mind|flowchart]
                      [--content '<mdx>']
```

File arguments accept either a raw `file_id` or a full `docs.qq.com` URL —
the ID is extracted automatically.

## Library

```ts
import { listRecent, searchDocs, readDoc, getDocInfo, createDoc } from "qqdocs";

const files = await listRecent(10);
const hits = await searchDocs("Q4 planning");
const content = await readDoc("DZHRkcGZ5TXpyaVZB");
const info = await getDocInfo("DZHRkcGZ5TXpyaVZB");
const { url } = await createDoc("New Doc", "smartcanvas", { content: "# Hello" });
```

All functions throw on MCP errors (`Error: MCP error: <message>`).

## License

MIT
