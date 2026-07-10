<!-- Template for llm-wiki-* family. Authored under TASK-357. Substituted by skills/llm-wiki-init/scripts/init-node.ts. -->
---
node: /Users/vedmalex/work/ai-editor-3/.llm-wiki
updated: 2026-07-09T21:07:41.695Z
---

# Sources — .llm-wiki

Source/provenance registry. One row per ingested source. Append-only.

link_mode values: `symlink` | `move` | `copy`
Extractor values: `none` or extractor script name relative to `.extractors/` or `extractors/`.
Source ID: stable slug derived from basename + ingest date (e.g., `task-001-2026-05-18`).
Source hash: SHA-256 first 12 hex chars of file content (or recursive hash for dirs).
Original path: absolute pre-ingest location (preserved after move for audit/recovery).

Optional git columns (UR-040, tech-spec §24.19): when the source resolves inside a
git repository at ingest time, link-source.ts appends three trailing columns
to the row — `git_head_sha`, `git_branch`, `git_last_commit_date` — used by
re-ingest drift detection and the `code.*` lint rules. Rows without these
columns remain valid (backward-compatible).

Freshness columns (TASK-358 §3): six trailing columns added by change-detector.ts:
`last_checked_at`, `freshness_status`, `last_change_detected_at`, `source_mtime`,
`http_last_modified`, `http_etag`. Rows with 7, 11, or 17 columns are all valid.
See `skills/llm-wiki-maintain/references/sources-md-schema.md` for full schema reference.

| Source ID | Type | Path in raw/ | Original path | link_mode | Source hash | Ingested | Extractor (if any) | git_head_sha (opt) | git_branch (opt) | git_last_commit_date (opt) | last_checked_at | freshness_status | last_change_detected_at | source_mtime | http_last_modified | http_etag |
|-----------|------|--------------|---------------|-----------|-------------|----------|--------------------|--------------------|------------------|----------------------------|-----------------|------------------|-------------------------|--------------|--------------------|-----------|
| (empty — populated by llm-wiki-ingest) | — | — | — | — | — | — | — | — | — | — |  |  |  |  |  |  |
| theia-composing-applications | file | raw/theia-composing-applications | https://theia-ide.org/docs/composing_applications/ | copy | 4ca022d79319 | 2026-07-09T21:12:47.933Z |  |  |  |  |   |  |  |  |  |  |
| theia-authoring-extensions | file | raw/theia-authoring-extensions | https://theia-ide.org/docs/authoring_extensions/ | copy | cdb135791cb5 | 2026-07-09T21:12:47.963Z |  |  |  |  |   |  |  |  |  |  |
| theia-ai | file | raw/theia-ai | https://theia-ide.org/docs/theia_ai/ | copy | 9251ae93b194 | 2026-07-09T21:12:47.988Z |  |  |  |  |   |  |  |  |  |  |
| theia-services-and-contributions | file | raw/theia-services-and-contributions | https://theia-ide.org/docs/services_and_contributions/ | copy | f238bcf8c1f5 | 2026-07-09T21:12:48.017Z |  |  |  |  |   |  |  |  |  |  |
| theia-architecture-overview | file | raw/theia-architecture-overview | https://theia-ide.org/docs/architecture/ | copy | 7a4dc0ba46c6 | 2026-07-09T21:12:48.041Z |  |  |  |  |   |  |  |  |  |  |
| theia-extensions-vs-plugins | file | raw/theia-extensions-vs-plugins | https://theia-ide.org/docs/extensions/ | copy | bc7bf3463934 | 2026-07-09T21:12:48.091Z |  |  |  |  |   |  |  |  |  |  |
| theia-preferences | file | raw/theia-preferences | https://theia-ide.org/docs/preferences/ | copy | b26935d1af6e | 2026-07-09T21:12:48.127Z |  |  |  |  |   |  |  |  |  |  |
| theia-platform-overview | file | raw/theia-platform-overview | https://theia-ide.org/theia-platform/ | copy | 866bf3cc86ee | 2026-07-09T21:12:48.150Z |  |  |  |  |   |  |  |  |  |  |
