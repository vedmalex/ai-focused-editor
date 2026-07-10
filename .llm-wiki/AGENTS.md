<!-- Template for llm-wiki-* family. Authored under TASK-357. Substituted by skills/llm-wiki-init/scripts/init-node.ts. -->
---
node: /Users/vedmalex/work/ai-editor-3/.llm-wiki


created: 2026-07-09T21:07:41.695Z
language: en
link_mode_default: copy
---

# Wiki Node: .llm-wiki

<!-- Parent reference lives in frontmatter `parent:` (machine-readable) and Node Context section (human-readable). Do not duplicate in Node Identity. -->

## Node Identity

- **Path**: `/Users/vedmalex/work/ai-editor-3/.llm-wiki`
- **Purpose**: Reference knowledge base of official Theia Platform documentation for the AI Focused Editor project (Theia AI first)
- **Created**: 2026-07-09T21:07:41.695Z
- **Language**: en

## Available Commands

This node is managed by the llm-wiki skill family. Use the following skills
when operating in this node:

| Skill | When to use |
|---|---|
| `llm-wiki-init` | Re-initialize this node or add missing service files |
| `llm-wiki-ingest` | Add new source material as wiki pages |
| `llm-wiki-maintain` | Run lint/health check, evolve hierarchy if signals warrant |
| `llm-wiki-query` | Answer questions from this node's wiki content |
| `llm-wiki-extract` | Run a data extractor to pull from a database, API, or custom source |
| `llm-wiki-router` | Route any wiki operation via intake interview if goal is unclear |

## Raw Layer

This node maintains a `raw/` directory holding source materials in one of three modes per source:

- **symlink** (default for this node): `raw/<name>` is a soft link to the canonical location.
- **move**: source physically moved into `raw/<name>`; original removed.
- **copy**: source duplicated into `raw/<name>`.

See `sources.md` for the actual mode per source. Resolution precedence: per-source flag > this node's `link_mode_default` (`copy`) > wiki-root default > router intake.

## Node Context


This is a root node (no parent).

## Operating Rules

- Do not mutate raw source files. Copy or reference originals; never overwrite them.
- Do not create new sub-nodes or pages without evidence from content, repeated queries, or lint findings.
- Append to `log.md` after every operation that changes node structure or content.
- Update `sources.md` after every ingest.
- Keep `index.md` current; it is the primary navigation map for this node.
- If `health.md` shows open issues, resolve them before ingesting new material.
- Cross-references between pages SHOULD use wikilink syntax `[[other-page]]` (Obsidian compat) when the target lives in the same wiki-node; use standard markdown links `[text](./path.md)` only for relative paths outside `pages/`. See `references/wikilink-syntax.md`.
- Image embeds: `![[image.png]]` where the image lives in `<node>/raw/`.



## Maintenance Log

See [log.md](./log.md) for the operation history of this node.
