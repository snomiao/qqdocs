## [1.22.3](https://github.com/snomiao/qqdocs/compare/v1.22.2...v1.22.3) (2026-04-19)


### Bug Fixes

* use local date for usage day/month keys instead of UTC ([cf8986c](https://github.com/snomiao/qqdocs/commit/cf8986cd764f384faaa80cb89b9a429cc939365c))

## [1.22.2](https://github.com/snomiao/qqdocs/compare/v1.22.1...v1.22.2) (2026-04-18)


### Bug Fixes

* skip usage warning after qqdocs usage command itself ([87f61f2](https://github.com/snomiao/qqdocs/commit/87f61f29777aae102e3a132eb88e85ee0805a3d2))

## [1.22.1](https://github.com/snomiao/qqdocs/compare/v1.22.0...v1.22.1) (2026-04-18)


### Bug Fixes

* await incrementUsage to prevent write being dropped on process exit ([ce48e5c](https://github.com/snomiao/qqdocs/commit/ce48e5c9c5ff2568de1ffe5e8224d169e7ccf2c6))

# [1.22.0](https://github.com/snomiao/qqdocs/compare/v1.21.1...v1.22.0) (2026-04-18)


### Features

* cache doc content at ~/.qqdocs/doc-cache.json ([21a6f83](https://github.com/snomiao/qqdocs/commit/21a6f8378fb2abbf2491225bc418b284006e136d))

## [1.21.1](https://github.com/snomiao/qqdocs/compare/v1.21.0...v1.21.1) (2026-04-18)


### Bug Fixes

* correct membership URL to docs.qq.com/vip ([0d8eaee](https://github.com/snomiao/qqdocs/commit/0d8eaee4e9c9dbe21d92885d0ba1e043211df7ba))

# [1.21.0](https://github.com/snomiao/qqdocs/compare/v1.20.0...v1.21.0) (2026-04-18)


### Features

* add --month option to usage calibrate ([164814d](https://github.com/snomiao/qqdocs/commit/164814d72d1d1504a774450c07243b99037bf44c))

# [1.20.0](https://github.com/snomiao/qqdocs/compare/v1.19.0...v1.20.0) (2026-04-18)


### Features

* add usage calibrate subcommand ([6fcbb1f](https://github.com/snomiao/qqdocs/commit/6fcbb1f4dc5bfbc50fb4ad7d3e03561be017c15f))

# [1.19.0](https://github.com/snomiao/qqdocs/compare/v1.18.0...v1.19.0) (2026-04-18)


### Features

* auto-infer membership tier from observed daily call counts ([8a40146](https://github.com/snomiao/qqdocs/commit/8a4014624221a931276b3934f49a265051d58ff9))

# [1.18.0](https://github.com/snomiao/qqdocs/compare/v1.17.2...v1.18.0) (2026-04-18)


### Features

* add API usage tracking and quota progress bars ([f4442f1](https://github.com/snomiao/qqdocs/commit/f4442f1085dac654511130366729b3e8c716e8f0))

## [1.17.2](https://github.com/snomiao/qqdocs/compare/v1.17.1...v1.17.2) (2026-04-18)


### Bug Fixes

* skip fetch when cache fresh (<1min), handle rate-limit gracefully ([26324a4](https://github.com/snomiao/qqdocs/commit/26324a4604bd975a146e05d1d226498a5ca5eb0c))

## [1.17.1](https://github.com/snomiao/qqdocs/compare/v1.17.0...v1.17.1) (2026-04-18)


### Bug Fixes

* use \x1b[J to erase leftover stale lines after SWR rewrite ([2f993f8](https://github.com/snomiao/qqdocs/commit/2f993f85e7d6c09f695f7d308131f8394782f172))

# [1.17.0](https://github.com/snomiao/qqdocs/compare/v1.16.0...v1.17.0) (2026-04-18)


### Features

* SWR ls without screen clear; add owner+date in TTY fresh render ([3b6ea2b](https://github.com/snomiao/qqdocs/commit/3b6ea2b688cbc4680436cae08617d4886fc26121))

# [1.16.0](https://github.com/snomiao/qqdocs/compare/v1.15.0...v1.16.0) (2026-04-18)


### Features

* SWR live update for qqdocs ls in TTY using React Ink ([fba1324](https://github.com/snomiao/qqdocs/commit/fba1324d969a74a7866f54d450f1979c5cc8495f))

# [1.15.0](https://github.com/snomiao/qqdocs/compare/v1.14.0...v1.15.0) (2026-04-18)


### Features

* clarify delete moves to recycle bin, show trash URL after delete ([60deafd](https://github.com/snomiao/qqdocs/commit/60deafde206a399c3d522622ecbf91da5603fd4b))

# [1.14.0](https://github.com/snomiao/qqdocs/compare/v1.13.0...v1.14.0) (2026-04-18)


### Features

* show size and content preview on delete dry-run ([d01c5fe](https://github.com/snomiao/qqdocs/commit/d01c5fed474fc4a58e87d72d253accb8353aaa00))

# [1.13.0](https://github.com/snomiao/qqdocs/compare/v1.12.0...v1.13.0) (2026-04-18)


### Features

* show title/url and irreversibility warning on delete dry-run ([c06a5ad](https://github.com/snomiao/qqdocs/commit/c06a5addd49c56822559085376cb4cc1f648fddb))

# [1.12.0](https://github.com/snomiao/qqdocs/compare/v1.11.0...v1.12.0) (2026-04-18)


### Features

* path-style ls, richer epilog, --sha alias, sync command ([4486bea](https://github.com/snomiao/qqdocs/commit/4486bea3518e00d2eaa0baa94e56d7656ee9a134))

# [1.11.0](https://github.com/snomiao/qqdocs/compare/v1.10.0...v1.11.0) (2026-04-18)


### Features

* add --dates flag to ls for parallel last-modified fetch ([8bcc8f7](https://github.com/snomiao/qqdocs/commit/8bcc8f7e0ee09ff568b12c50e00c3277a942c01e))

# [1.10.0](https://github.com/snomiao/qqdocs/compare/v1.9.0...v1.10.0) (2026-04-18)


### Features

* replace type column with dim .ext suffix in ls output ([62404c5](https://github.com/snomiao/qqdocs/commit/62404c56e6c4b4cf91457fe8f0cef89baccfff25))

# [1.9.0](https://github.com/snomiao/qqdocs/compare/v1.8.0...v1.9.0) (2026-04-18)


### Features

* OSC 8 hyperlinks in TTY, markdown links in non-TTY ([e4f5774](https://github.com/snomiao/qqdocs/commit/e4f57742656393838565427fd272a0b416e25b1e))

# [1.8.0](https://github.com/snomiao/qqdocs/compare/v1.7.0...v1.8.0) (2026-04-18)


### Features

* add folder listing to `qqdocs ls --folder [id]` ([d70de63](https://github.com/snomiao/qqdocs/commit/d70de63636be8ce86570db89351f59fbce1eb460))

# [1.7.0](https://github.com/snomiao/qqdocs/compare/v1.6.0...v1.7.0) (2026-04-17)


### Features

* prepend title+url header to `read` output ([7eaed52](https://github.com/snomiao/qqdocs/commit/7eaed5289b4afad3b6a2555d44a208f63b1f9be9))

# [1.6.0](https://github.com/snomiao/qqdocs/compare/v1.5.0...v1.6.0) (2026-04-17)


### Features

* alias `mv` for `rename` ([26a4fb5](https://github.com/snomiao/qqdocs/commit/26a4fb58b6855e6de537b621e081ae998d0c4c89))

# [1.5.0](https://github.com/snomiao/qqdocs/compare/v1.4.0...v1.5.0) (2026-04-17)


### Features

* shorten delete confirm code to 4 digits, alias `rm` for `delete` ([3067d63](https://github.com/snomiao/qqdocs/commit/3067d6354be36a408157dea0f7a1ebfc748c6c77))

# [1.4.0](https://github.com/snomiao/qqdocs/compare/v1.3.0...v1.4.0) (2026-04-17)


### Features

* add copy command, home env, and YAML config ([85d8bfb](https://github.com/snomiao/qqdocs/commit/85d8bfb0df24b068411c239613ef8b792fb3492d))

# [1.3.0](https://github.com/snomiao/qqdocs/compare/v1.2.0...v1.3.0) (2026-04-17)


### Features

* add rename/open commands, JSON output, pagination, and completion ([4ad8791](https://github.com/snomiao/qqdocs/commit/4ad879188f7cc82950a596460d163f816db08507))

# [1.2.0](https://github.com/snomiao/qqdocs/compare/v1.1.1...v1.2.0) (2026-04-17)


### Features

* resolve file reference by filename in addition to ID/URL ([5d8978d](https://github.com/snomiao/qqdocs/commit/5d8978d9f282ca3dc2fdd1425651c2255d3f8064))

## [1.1.1](https://github.com/snomiao/qqdocs/compare/v1.1.0...v1.1.1) (2026-04-17)


### Bug Fixes

* guard non-idempotent MCP writes and surface missing content ([133b37a](https://github.com/snomiao/qqdocs/commit/133b37a33ec9db2a8cd1824bdf6080f6e9a2d80a))

# [1.1.0](https://github.com/snomiao/qqdocs/compare/v1.0.0...v1.1.0) (2026-04-17)


### Features

* expand CLI and add privacy guardrails ([6ed87a6](https://github.com/snomiao/qqdocs/commit/6ed87a6f9b063017c7913f3627e09057bebd94d3))

# 1.0.0 (2026-04-15)


### Bug Fixes

* remove unused doc-engine and sheet-engine placeholders ([8b94b0f](https://github.com/snomiao/qqdocs/commit/8b94b0f850297a125075319b00afe642ee6d0af6))


### Features

* add semantic-release workflow and bunx usage ([856b8bd](https://github.com/snomiao/qqdocs/commit/856b8bddea9801bca90f5f772a5fbf0864d5fdba))
