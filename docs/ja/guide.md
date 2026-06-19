# ガイド

Tencent Docs（[docs.qq.com](https://docs.qq.com)）の CLI およびライブラリ。
MCP の JSON-RPC エンドポイントを薄くラップしたもので、SDK もハンドシェイクも
不要、1 回の呼び出しにつき HTTP POST 1 回だけです。

## 必要環境

[Bun](https://bun.sh) ≥ 1.x。この CLI は Bun の shebang 付き `.ts` として
配布されるため、`node`/`npx` には対応していません。`bun`/`bunx` を使って
ください。

## インストール

```bash
bunx qqdocs ls        # インストールせずに実行
bun add qqdocs        # ライブラリとして
bun add -g qqdocs     # `qqdocs` CLI として
```

公開されている実行ファイル：

- `qqdocs`（正式名称）
- `qqdoc`（タイプミスに強いエイリアス）

## 認証

[docs.qq.com の MCP 設定ページ](https://docs.qq.com/openapi/mcp)で
トークンを取得し、いずれかの方法で設定します：

- シェルで `TENCENT_DOCS_TOKEN=...` を export する、または
- `.env.local` ファイルに `TENCENT_DOCS_TOKEN=...` を記述する。検索順
  （最初に見つかったものを採用）：パッケージディレクトリ、その親
  ディレクトリ群、カレントディレクトリ、そして `$HOME/.qqdocs/.env.local`。

機密でないデフォルト値（既定のスペースや既定の権限など）は YAML 設定に
置けます。検索順：

- `$PWD/.qqdocs/config.yaml`
- `$PWD/.qqdocs.config.yaml`
- `$HOME/.qqdocs/config.yaml`
- `$HOME/.qqdocs.config.yaml`

## CLI

公開された読み取り専用のサンプル文書があります：
`https://docs.qq.com/aio/DZEZ6TEFiQmpGdUJy`（名前：`qqdocs-example`、ID：`dFzLAbBjFuBr`）

```bash
qqdocs tools [pattern]                                # 稼働中の MCP ツールを一覧表示
qqdocs raw <tool> --json '{"file_id":"..."}'          # 生のツール呼び出し

qqdocs ls [--json]                                   # 最近の文書
qqdocs ls [root|<folder-id>|<name/subname>] [--json] # ルート、フォルダ ID、またはパスで移動
qqdocs ls --dates                                    # 最終更新日時を含める
qqdocs search <query> [--json]                       # キーワード検索
qqdocs read <ref>                 # 文書の内容を読む
qqdocs rename <ref> <new-title>   # 名前を変更（エイリアス：mv）
qqdocs open <ref>                 # ブラウザで開く
qqdocs cp <ref> [--title <t>]     # 文書を複製（エイリアス：copy）
qqdocs delete <ref>                       # ドライラン。削除確認コードを表示（エイリアス：rm）
qqdocs delete <ref> --confirm=1234        # 現在のコンテンツハッシュコードで削除
qqdocs delete <ref> -c 1234               # --confirm と同じ
qqdocs info <ref> [--json]                # 文書のメタデータ
qqdocs import <path> [--title <title>]                # pdf/docx/pptx/... をインポート、または .md/.mdx を取り込み
qqdocs perm get <ref>                     # 権限を読み取る
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

qqdocs flowchart <title> --mermaid 'graph LR; A-->B'  # Mermaid 構文でフローチャート/UML/インフラ図を作成
qqdocs flowchart <title> --file diagram.mmd          # ファイルから Mermaid を読み込む
qqdocs sync                                          # 最近 + ルートの文書を ~/.qqdocs/cache.json にキャッシュ
qqdocs usage [--tier free|member|plus]               # API 呼び出しのクォータ進捗バーを表示
qqdocs completion                                    # シェル補完スクリプトを出力
```

## シェル補完

`qqdocs completion` は補完スクリプトを出力します。シェルの rc ファイルから
読み込んでください：

```bash
qqdocs completion >> ~/.zshrc     # zsh
qqdocs completion >> ~/.bashrc    # bash
```

稼働中の Tencent Docs MCP のインターフェースは時間とともに変化します。
現在のサーバーが実際に公開している機能については、`qqdocs tools` が
信頼できる情報源です。

ファイル引数には、生の `file_id`、完全な `docs.qq.com` の URL、または
ファイル名を指定できます。ファイル名を指定すると、qqdocs は Tencent Docs
を検索して一意の一致に解決します。複数の文書が同名の場合は候補の一覧を
例外として投げるので、ID・URL・名前の変更で曖昧さを解消できます。

`qqdocs delete` は意図的に 2 段階になっています。`--confirm` なしで実行すると
ドライランとなり、文書の現在の内容から導出された 4 桁の確認コードを表示
します。削除は、そのコードを `--confirm=<4-digit-code>` で渡したときにのみ
実行されるため、内容が変われば確認コードも変わります。

`qqdocs import` がサポートするもの：

- Markdown ソース：`.md`、`.markdown`、`.mdx`
- Tencent の非同期インポート形式：`xls`、`xlsx`、`csv`、`doc`、`docx`、`txt`、`text`、`ppt`、`pptx`、`pdf`、`xmind`

`.md` と `.markdown` の場合、CLI は `content_format=markdown` の smartcanvas
文書を作成します。
`.mdx` の場合は、MDX コンテンツを持つ smartcanvas 文書を作成します。
インポート可能なバイナリ/テキスト形式の場合、CLI はローカルファイルを
アップロードし、Tencent Docs の非同期インポートを開始して完了を待ち、
必要に応じて `--title` で結果の名前を変更できます。

権限ポリシー：

- `private`
- `link-read`
- `link-edit`

新しい文書はデフォルトで非公開（private）です。
`qqdocs perm get` は 3 つの状態すべてを報告できます。
`qqdocs perm set` は `private|link-read|link-edit` を受け付けますが、
Tencent Docs MCP は現在、公開モードの設定のみをサポートしているため、
`private` を指定すると明確な「未対応」のメッセージが表示されます。
`create` コマンドは、新しい文書の初期ポリシーに加えて、そのまま実行できる
`qqdocs perm get` と `qqdocs perm set` のコマンドも表示します。

## ライブラリ

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

すべての関数は MCP エラー時に例外を投げます（`Error: MCP error: <message>`）。

## ライセンス

MIT
