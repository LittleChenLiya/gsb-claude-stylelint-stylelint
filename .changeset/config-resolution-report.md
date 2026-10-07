---
"stylelint": minor
---

Added: `resolveConfigReport()` Node API function that returns an explicit configuration resolution report (winning source of every rule value, `extends`/`overrides`/`plugins` in actual loading order, disabled rules separated from missing ones), and a `ConfigurationError` naming the full chain for circular `extends`
