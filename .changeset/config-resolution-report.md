---
"stylelint": minor
---

Added: `--report-config` CLI flag and `reportConfig()` Node.js API for reporting how a configuration is resolved (load order, `extends` chain, applied `overrides`, and the winning source of every rule value)
Added: rejection of circular `extends` chains with a `ConfigurationError` that reports the chain
