# API Call Budget

Tencent Docs MCP rate limits: **100/day** (free) · **1000/day** (member) · **2000/day** (plus) · **20,000/month** (all tiers).

Every `tools/call` counts. `tools/list` does not.

## Per-command cost

| Command | Without cache | With cache | Notes |
|---------|--------------|------------|-------|
| `qqdocs ls` | 1 | 0 (if <5 min old) | `listRecent` · SWR TTL 300s |
| `qqdocs ls --dates` | 1 + N | 0 (if <5 min old) | +`query_file_info` per doc |
| `qqdocs ls <folder>` | 1 + 1 | 0 (if <5 min old) | `folder_list` + `resolveFolderId` |
| `qqdocs sync` | 2 | — | `listRecent` + `folder_list`; manual only |
| `qqdocs read <ref>` | 1 | — | `read_doc` |
| `qqdocs delete <ref>` (dry-run) | 2 | — | `getDocInfo` + `readDoc`; writes doc-cache |
| `qqdocs delete <ref> --confirm` | 0 | 0 | reads doc-cache (5 min TTL); skips both calls |
| `qqdocs info <ref>` | 1 | — | `query_file_info` |
| `qqdocs rename <ref>` | 1 | — | `rename_doc` |
| `qqdocs cp <ref>` | 1 | — | `copy_doc` |
| `qqdocs open <ref>` | 0 | — | browser open, no API |
| `qqdocs create` | 1–2 | — | `create_doc` + optional `set_permission` |
| `qqdocs import` | 3–5 | — | upload + start + poll until done |
| `qqdocs perm get` | 1 | — | `query_permission` |
| `qqdocs perm set` | 1 | — | `set_permission` |
| `qqdocs space list` | 1 | — | `list_spaces` |
| `qqdocs space ls` | 1 | — | `list_space_nodes` |
| `qqdocs space mkdir/mkdoc/link` | 1 | — | one node creation call |
| `qqdocs space rm` | 1 | — | `delete_space_node` |
| `qqdocs space move` | 1 | — | `move_doc_to_space` |
| `qqdocs canvas read` | 1 per page | — | `read_smart_canvas`; `--all` multiplies |
| `qqdocs canvas find` | 1+ | — | read + search |
| `qqdocs canvas edit` | 1 | — | `edit_smart_canvas` |
| `qqdocs usage` | 0 | — | local file only |
| `qqdocs usage calibrate` | 0 | — | local file only |
| `qqdocs tools` | 0 | — | `tools/list` (not rate-limited) |
| `qqdocs raw` | 1 | — | one arbitrary tool call |

## Caching layers

### 1. SWR list cache — `~/.qqdocs/cache.json`

- Written by `qqdocs sync` and refreshed by `qqdocs ls` (background fetch)
- TTL: **300 seconds** — repeated `ls` within 5 min costs 0 calls
- Contains: file_id, title, url, mtime, owner per entry
- Used by: `qqdocs ls`, tab-completion candidate resolution

### 2. Doc content cache — `~/.qqdocs/doc-cache.json`

- Written by `qqdocs delete <ref>` dry-run (after fetching content + info)
- TTL: **5 minutes** — safe window for the two-step delete confirm flow
- Eliminates: 2 API calls (`getDocInfo` + `readDoc`) on `delete --confirm`
- Stale entries are pruned on next write

### 3. Usage tracker — `~/.qqdocs/usage.json`

- Incremented locally after every `tools/call`
- No API calls; used for quota progress display and tier inference

## High-cost patterns to avoid

- `qqdocs ls --dates` in a loop — N extra `query_file_info` calls per run
- Scripting `qqdocs delete` without reusing the same session (TTL is 5 min)
- `qqdocs sync` in a cron job at high frequency — costs 2 calls each time
- `qqdocs canvas read --all` on large documents — one call per page

## Checking usage

```bash
qqdocs usage                          # show progress bars
qqdocs usage calibrate --today 45     # correct today's count
qqdocs usage calibrate --tier member  # set tier after upgrade
```
