---
stylelint: patch
---

Fixed: rule runtime errors now report the rule name and the source file being linted, while preserving the original error as `cause`. Rule failures keep aborting the run instead of being reported as ordinary lint violations, are attributed to the file being linted when multiple files run in parallel, and a failed file is no longer saved to the cache as a success.
