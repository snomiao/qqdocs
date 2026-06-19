# qqdocs

[English](./README.md) · **简体中文** · [日本語](./README.ja.md) · [한국어](./README.ko.md)

腾讯文档（[docs.qq.com](https://docs.qq.com)）命令行工具与代码库。它是 MCP
JSON-RPC 接口的轻量封装——不依赖 SDK，无需握手，每次调用只发起一个 HTTP
POST 请求。

## 环境要求

[Bun](https://bun.sh) ≥ 1.x。该 CLI 以带 Bun shebang 的 `.ts` 形式发布，
因此不支持 `node`/`npx`——请使用 `bun`/`bunx`。

## 安装

```bash
bunx qqdocs ls        # 无需安装直接运行
bun add qqdocs        # 作为代码库使用
bun add -g qqdocs     # 安装 `qqdocs` 命令行
```

已发布的可执行文件：

- `qqdocs`（标准名称）
- `qqdoc`（容错别名）

## 鉴权

在[docs.qq.com MCP 设置页](https://docs.qq.com/openapi/mcp)获取 token，
然后任选其一：

- 在 shell 中导出 `TENCENT_DOCS_TOKEN=...`，或
- 将 `TENCENT_DOCS_TOKEN=...` 写入 `.env.local` 文件。查找顺序
  （命中即止）：包目录、其各级父目录、当前工作目录，以及
  `$HOME/.qqdocs/.env.local`。

非敏感的默认值（例如默认空间、默认权限）可以放在 YAML 配置中。
查找顺序：

- `$PWD/.qqdocs/config.yaml`
- `$PWD/.qqdocs.config.yaml`
- `$HOME/.qqdocs/config.yaml`
- `$HOME/.qqdocs.config.yaml`

## 命令行

提供了一个公开的只读示例文档：
`https://docs.qq.com/aio/DZEZ6TEFiQmpGdUJy`（名称：`qqdocs-example`，ID：`dFzLAbBjFuBr`）

```bash
qqdocs tools [pattern]                                # 列出在线的 MCP 工具
qqdocs raw <tool> --json '{"file_id":"..."}'          # 原始工具调用

qqdocs ls [--json]                                   # 最近的文档
qqdocs ls [root|<folder-id>|<name/subname>] [--json] # 根目录、文件夹 ID 或按路径导航
qqdocs ls --dates                                    # 包含最后修改时间
qqdocs search <query> [--json]                       # 关键词搜索
qqdocs read <ref>                 # 读取文档内容
qqdocs rename <ref> <new-title>   # 重命名（别名：mv）
qqdocs open <ref>                 # 在浏览器中打开
qqdocs cp <ref> [--title <t>]     # 复制文档（别名：copy）
qqdocs delete <ref>                       # 试运行；打印删除确认码（别名：rm）
qqdocs delete <ref> --confirm=1234        # 用当前内容哈希码执行删除
qqdocs delete <ref> -c 1234               # 等同于 --confirm
qqdocs info <ref> [--json]                # 文档元数据
qqdocs import <path> [--title <title>]                # 导入 pdf/docx/pptx/... 或解析 .md/.mdx
qqdocs perm get <ref>                     # 读取权限
qqdocs perm set <ref> <private|link-read|link-edit>

qqdocs space list [--scope all|mine|joined]
qqdocs space create <title> [--description <text>]
qqdocs space ls <space-id> [--parent <node-id>] [--page <n>]
qqdocs space mkdir <space-id> <title> [--parent <node-id>]
qqdocs space mkdoc <space-id> <title> [--type smartcanvas|doc|sheet|slide|mind|flowchart|smartsheet|form]
qqdocs space link <space-id> <title> <url> [--description <text>]
qqdocs space rm <space-id> <node-id> [--all]
qqdocs space move <ref> <space-id> [--parent <node-id>]

qqdocs canvas read <ref> [--page <page-id>] [--size <n>] [--next <token>] [--all]
qqdocs canvas find <ref> <query>
qqdocs canvas edit <ref> <insert-before|insert-after|append|update|delete>
                 [--id <block-id>] [--content '<mdx>']

qqdocs create <title> [--type smartcanvas|doc|sheet|slide|mind|flowchart|smartsheet|form]
                      [--format mdx|markdown]
                      [--content '<mdx-or-markdown>']
                      [--perm private|link-read|link-edit]

qqdocs flowchart <title> --mermaid 'graph LR; A-->B'  # 用 Mermaid 语法创建流程图/UML/架构图
qqdocs flowchart <title> --file diagram.mmd          # 从文件读取 Mermaid
qqdocs sync                                          # 将最近 + 根目录文档缓存到 ~/.qqdocs/cache.json
qqdocs usage [--tier free|member|plus]               # 显示 API 调用配额进度条
qqdocs completion                                    # 打印 shell 补全脚本
```

## Shell 补全

`qqdocs completion` 会打印补全脚本。在你的 shell rc 文件中加载它：

```bash
qqdocs completion >> ~/.zshrc     # zsh
qqdocs completion >> ~/.bashrc    # bash
```

在线的腾讯文档 MCP 接口会随时间变化。`qqdocs tools` 是当前服务器实际
暴露能力的权威来源。

文件参数接受原始 `file_id`、完整的 `docs.qq.com` URL 或文件名。给定文件名
时，qqdocs 会在腾讯文档中搜索并解析为唯一匹配项；若多个文档同名，命令会
抛出候选列表，便于你通过 ID、URL 或重命名来消除歧义。

`qqdocs delete` 刻意设计为两步操作。不带 `--confirm` 运行时只做试运行，
并打印根据文档当前内容派生的 4 位确认码。只有当该确认码通过
`--confirm=<4-digit-code>` 回传时才会真正删除，因此一旦内容发生变化，
确认码也随之改变。

`qqdocs import` 支持：

- Markdown 来源：`.md`、`.markdown`、`.mdx`
- 腾讯文档异步导入格式：`xls`、`xlsx`、`csv`、`doc`、`docx`、`txt`、`text`、`ppt`、`pptx`、`pdf`、`xmind`

对于 `.md` 和 `.markdown`，CLI 会创建一个 `content_format=markdown` 的
smartcanvas 文档。
对于 `.mdx`，会创建一个带 MDX 内容的 smartcanvas 文档。
对于可导入的二进制/文本格式，CLI 会上传本地文件，启动腾讯文档异步导入，
等待其完成，并可通过 `--title` 选择性地重命名结果。

权限策略：

- `private`
- `link-read`
- `link-edit`

新文档默认为私有。
`qqdocs perm get` 可报告全部三种状态。
`qqdocs perm set` 接受 `private|link-read|link-edit`，但腾讯文档 MCP 目前
仅支持设置公开模式，因此传入 `private` 会打印一条明确的不支持提示。
`create` 命令还会打印新文档的初始权限策略，以及可直接运行的
`qqdocs perm get` 与 `qqdocs perm set` 命令。

## 代码库

```ts
import {
  callTool,
  copyDoc,
  createDoc,
  getFolderMeta,
  listFolderContents,
  loadSyncCache,
  resolveFolderId,
  syncDocs,
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

所有函数在遇到 MCP 错误时都会抛出异常（`Error: MCP error: <message>`）。

## 许可证

MIT
