---
name: narrative-memory-query
description: "Как спрашивать индекс рукописи и как читать его ответы — четыре состояния, обоснования и границы"
allowedTools:
  - narrative_find_entities
  - narrative_find_mentions
  - narrative_entity_relations
  - narrative_document_context
  - narrative_entity_appearances
---

# Querying the narrative index

This book keeps an inspectable index of its own narrative: entity cards,
every reference to them, the relations between them, and the defects found
along the way. Four read-only tools query it. They never write.

## Read the `index` block before you read anything else

Every answer opens with an `index` block, and `index.answered` decides
whether there is anything below it.

- `"state": "ready"` — the answer is authoritative. An empty list means the
  manuscript really holds no such thing.
- `"state": "rebuilding"` or `"absent"` — `answered` is `false` and the
  answer carries NO data at all. This is not "nothing found". Say the index is
  not ready, and say what would fix it; do not answer from memory.
- `"state": "failed"` — the index is broken. `failureCode` says how and
  `incidentId` ties the answer to a line in the backend log. Report both
  verbatim.
- `"state": "stale"` — the index answers, and every answer is marked. Give the
  facts AND say they may be out of date, with `staleReason`. Never quietly
  drop the mark: an unmarked stale answer is a confident lie.

The `notice` array carries these as sentences. Pass them on.

## Never state a fact you cannot point at

Every entity, mention, relation and finding carries `evidence` with a
workspace-relative `path`, a `uri`, and a `locator`:

- `"locator": "range"` — the fact is at that exact span. Cite the line.
- `"locator": "whole-file"` — the fact was read from a structural YAML field
  or from front matter, and has NO position. Name the file. Do not invent a
  line number; there is none, and the file's first line is not it.

## What these tools do not do

- `narrative_entity_relations` returns DIRECT relations only — one hop.
  Storylines, subgraphs and neighbourhoods of depth N are a separate feature and
  are not available here.
- A relation the author wrote into both participants' cards arrives as TWO
  relations, one per card, each with its own evidence. That is not duplication
  to clean up; it is two records of one belief, and either card may be edited
  independently.
- `narrative_document_context` returns pointers, never manuscript prose. Read
  the files it names if you need the text.
- By default it withholds chapters positioned after the one you asked about, so
  an answer cannot spoil the book for its own author. Ask for them explicitly if
  the author has asked you to look ahead.
- `origin` says who is responsible for a fact: `explicit` the author wrote,
  `derived` the index computed, `ai-candidate` an agent proposed and nobody
  has accepted yet. Never present an `ai-candidate` as something the book says.
