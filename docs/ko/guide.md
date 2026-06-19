# 가이드

Tencent Docs([docs.qq.com](https://docs.qq.com)) CLI 및 라이브러리입니다. MCP
JSON-RPC 엔드포인트를 얇게 감싼 래퍼로, SDK도 핸드셰이크도 없이 호출 한 번에
HTTP POST 한 번만 보냅니다.

## 요구 사항

[Bun](https://bun.sh) ≥ 1.x. 이 CLI는 Bun shebang이 포함된 `.ts` 형태로
배포되므로 `node`/`npx`는 지원하지 않습니다. `bun`/`bunx`를 사용하세요.

## 설치

```bash
bunx qqdocs ls        # 설치 없이 실행
bun add qqdocs        # 라이브러리로 사용
bun add -g qqdocs     # `qqdocs` CLI로 설치
```

배포된 실행 파일:

- `qqdocs`(표준 이름)
- `qqdoc`(오타 허용 별칭)

## 인증

[docs.qq.com MCP 설정 페이지](https://docs.qq.com/openapi/mcp)에서 토큰을
발급받은 뒤 다음 중 하나로 설정하세요:

- 셸에서 `TENCENT_DOCS_TOKEN=...`을 export 하거나,
- `.env.local` 파일에 `TENCENT_DOCS_TOKEN=...`을 작성합니다. 검색 순서
  (먼저 찾은 것 우선): 패키지 디렉터리, 그 상위 디렉터리들, 현재 작업
  디렉터리, 그리고 `$HOME/.qqdocs/.env.local`.

민감하지 않은 기본값(예: 기본 스페이스, 기본 권한)은 YAML 설정에 둘 수
있습니다. 검색 순서:

- `$PWD/.qqdocs/config.yaml`
- `$PWD/.qqdocs.config.yaml`
- `$HOME/.qqdocs/config.yaml`
- `$HOME/.qqdocs.config.yaml`

## CLI

공개된 읽기 전용 예제 문서가 제공됩니다:
`https://docs.qq.com/aio/DZEZ6TEFiQmpGdUJy`(이름: `qqdocs-example`, ID: `dFzLAbBjFuBr`)

```bash
qqdocs tools [pattern]                                # 실행 중인 MCP 도구 목록
qqdocs raw <tool> --json '{"file_id":"..."}'          # 원시 도구 호출

qqdocs ls [--json]                                   # 최근 문서
qqdocs ls [root|<folder-id>|<name/subname>] [--json] # 루트, 폴더 ID 또는 경로로 탐색
qqdocs ls --dates                                    # 마지막 수정 시각 포함
qqdocs search <query> [--json]                       # 키워드 검색
qqdocs read <ref>                 # 문서 내용 읽기
qqdocs rename <ref> <new-title>   # 이름 변경(별칭: mv)
qqdocs open <ref>                 # 브라우저에서 열기
qqdocs cp <ref> [--title <t>]     # 문서 복사(별칭: copy)
qqdocs delete <ref>                       # 드라이런; 삭제 확인 코드 출력(별칭: rm)
qqdocs delete <ref> --confirm=1234        # 현재 콘텐츠 해시 코드로 삭제
qqdocs delete <ref> -c 1234               # --confirm 과 동일
qqdocs info <ref> [--json]                # 문서 메타데이터
qqdocs import <path> [--title <title>]                # pdf/docx/pptx/... 가져오기 또는 .md/.mdx 처리
qqdocs perm get <ref>                     # 권한 읽기
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

qqdocs flowchart <title> --mermaid 'graph LR; A-->B'  # Mermaid 구문으로 플로차트/UML/인프라 다이어그램 생성
qqdocs flowchart <title> --file diagram.mmd          # 파일에서 Mermaid 읽기
qqdocs sync                                          # 최근 + 루트 문서를 ~/.qqdocs/cache.json 에 캐시
qqdocs usage [--tier free|member|plus]               # API 호출 할당량 진행 막대 표시
qqdocs completion                                    # 셸 자동완성 스크립트 출력
```

## 셸 자동완성

`qqdocs completion`은 자동완성 스크립트를 출력합니다. 셸 rc 파일에서
불러오세요:

```bash
qqdocs completion >> ~/.zshrc     # zsh
qqdocs completion >> ~/.bashrc    # bash
```

실행 중인 Tencent Docs MCP 인터페이스는 시간이 지나면서 변합니다. 현재
서버가 실제로 제공하는 기능에 대해서는 `qqdocs tools`가 신뢰할 수 있는
기준입니다.

파일 인자로는 원시 `file_id`, 전체 `docs.qq.com` URL 또는 파일 이름을 받을
수 있습니다. 파일 이름을 주면 qqdocs가 Tencent Docs를 검색해 유일한 일치
항목으로 해석합니다. 여러 문서가 같은 이름을 가지면 후보 목록을 예외로
던지므로 ID, URL 또는 이름 변경으로 모호성을 해소할 수 있습니다.

`qqdocs delete`는 의도적으로 두 단계로 동작합니다. `--confirm` 없이 실행하면
드라이런으로, 문서의 현재 내용에서 파생된 4자리 확인 코드를 출력합니다.
삭제는 그 코드를 `--confirm=<4-digit-code>`로 다시 전달했을 때만
수행되므로, 내용이 바뀌면 확인 코드도 바뀝니다.

`qqdocs import`가 지원하는 형식:

- Markdown 소스: `.md`, `.markdown`, `.mdx`
- Tencent 비동기 가져오기 형식: `xls`, `xlsx`, `csv`, `doc`, `docx`, `txt`, `text`, `ppt`, `pptx`, `pdf`, `xmind`

`.md`와 `.markdown`의 경우, CLI는 `content_format=markdown`인 smartcanvas
문서를 생성합니다.
`.mdx`의 경우 MDX 콘텐츠를 가진 smartcanvas 문서를 생성합니다.
가져오기 가능한 바이너리/텍스트 형식의 경우, CLI는 로컬 파일을 업로드하고
Tencent Docs 비동기 가져오기를 시작해 완료를 기다리며, `--title`로 결과의
이름을 선택적으로 바꿀 수 있습니다.

권한 정책:

- `private`
- `link-read`
- `link-edit`

새 문서는 기본적으로 비공개(private)입니다.
`qqdocs perm get`은 세 가지 상태를 모두 보고할 수 있습니다.
`qqdocs perm set`은 `private|link-read|link-edit`를 받지만, Tencent Docs MCP는
현재 공개 모드 설정만 지원하므로 `private`를 지정하면 명확한 "지원되지 않음"
메시지를 출력합니다.
`create` 명령은 새 문서의 초기 정책과 함께 바로 실행할 수 있는
`qqdocs perm get` 및 `qqdocs perm set` 명령도 출력합니다.

## 라이브러리

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

모든 함수는 MCP 오류 시 예외를 던집니다(`Error: MCP error: <message>`).

## 라이선스

MIT
