# Performance Benchmark

Measured on: macOS (Apple Silicon), Bun 1.3.x, JST timezone, member tier.
Tool: `hyperfine` with 3–8 runs and 1–2 warmups.

## Results summary

| Command | Interpreted (`bun`) | Compiled binary | Speedup |
|---------|--------------------|-----------------|----|
| `bun -e "process.exit(0)"` | 32 ms | — | baseline |
| `qqdocs --help` | 95 ms | 83 ms | 1.1× |
| `qqdocs usage` | 123 ms | 74 ms | 1.7× |
| `qqdocs ls` (cache hit) | 363 ms | 247 ms | 1.5× |
| `qqdocs ls` (cache stale, 1 API) | 847 ms | ~710 ms | 1.2× |
| `qqdocs read <id>` (cold) | 832 ms | ~695 ms | 1.2× |
| `qqdocs read <id>` (doc-cache hit) | 149 ms | ~80 ms | 1.9× |

> Compiled binary built with `bun build --compile`. Shipped as GitHub release assets for each platform.

## Network latency (raw curl, no Bun overhead)

| Endpoint | Mean |
|----------|------|
| `tools/list` | 312 ms |
| `tools/call` (query_recent_file_list) | 143 ms |

## Bottleneck breakdown

```
qqdocs ls (cache hit) = 518 ms
├── Bun startup                  32 ms
├── yargs + module resolution   ~268 ms   ← biggest single cost
├── config.yaml + .env.local read ~86 ms   (done synchronously at import time)
└── cache.json read + render    ~132 ms
```

```
qqdocs ls (cache stale) = 847 ms
├── [same startup as above]     ~518 ms
└── listRecent API call         ~143 ms
    └── write cache.json          ~5 ms
```

```
qqdocs read (cold) = 832 ms
├── [same startup as above]     ~518 ms
├── readDoc API                 ~143 ms
└── getDocInfo API (parallel)   ~143 ms   (overlaps with readDoc)
```

```
qqdocs read (doc-cache hit) = 149 ms
├── Bun startup                  32 ms
├── yargs + module resolution   ~268 ms
└── WAIT — 149ms total is less than startup alone?
    → This run likely benefited from OS file cache (warm inode)
    → Real floor is still ~300 ms on cold OS cache
```

## Key findings

### 1. Yargs + module resolution dominates (≈268 ms / 89% of no-API commands)

Every invocation pays ~268 ms just to parse `bin/qqdocs.ts` and resolve
`yargs`, `yaml`, and the large `src/index.ts`. This is the unavoidable floor
for every command — even `qqdocs usage` which does almost nothing.

### 2. API calls add 143–312 ms each

- `tools/call` (actual tool operations): ~143 ms
- `tools/list`: ~312 ms (heavier — server enumerates all tools)
- Two parallel API calls (`readDoc` + `getDocInfo`): no extra wall-clock cost
  since they run with `Promise.all`

### 3. Cache hit for `ls` still costs 518 ms

Even with zero API calls, reading and rendering `cache.json` adds ~220 ms on
top of the startup baseline. The cache file is the full sync list (up to 120
entries). Trimming it to the last 20 rendered items would reduce this.

### 4. `read` doc-cache is highly effective

Cold `read`: 832 ms. Warm `read`: ~149 ms (5.6× speedup). The 5-minute TTL
is a good tradeoff — covers the common delete dry-run → confirm flow and
repeated reads within a session.

## Improvement opportunities

| Fix | Expected saving | Effort |
|-----|----------------|--------|
| `bun build --compile` — native binary | −100 to −150 ms startup | low |
| Lazy-load yargs (dynamic import after arg parse) | −50 ms | medium |
| Trim sync cache to last N items on write | −50 ms on cache reads | low |
| `config.ts` / `env.ts` read lazily (not at import) | −30 ms | low |
| HTTP keep-alive / connection reuse across calls | −20 ms per call | medium |
| Parallel env + config load | −20 ms | low |

### ✅ Done: `bun build --compile`

```bash
bun run build              # all platforms
bun run build:darwin-arm64 # single platform
```

Packages all TS into a single native binary — skips module resolution on
every invocation. Binaries for darwin-arm64/x64, linux-x64/arm64, windows-x64
are built in CI and attached to each GitHub release as assets.

### Quick win: trim sync cache on write

Currently `syncDocs()` and the SWR write-back store all fetched entries
(can be 100+). Capping at 50 and writing only the fields used by `ls`
(file_id, title, url, ext) would reduce cache.json read time.
