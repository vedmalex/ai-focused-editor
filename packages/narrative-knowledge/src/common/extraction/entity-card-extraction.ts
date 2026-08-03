/**
 * Entity cards: the entity itself, plus relation sources 2 and 3 (TASK-022
 * WP-2).
 *
 * ONE FILE, THREE OUTPUTS, ONE PARSE. An entity card is the only document in
 * the manuscript that produces all three kinds of narrative fact — the entity
 * row, the `ownership` relations of an artifact card (source 2), and the
 * entity→entity relations implied by `[[...]]` references inside the card's own
 * free text (source 3). They are extracted together because they come from one
 * YAML document, and parsing it three times would be three chances to disagree.
 *
 * TWO PASSES, NOT ONE, AND THE SEAM IS DELIBERATE. Resolvedness needs a catalog
 * of every id the manuscript defines, which cannot exist until every card has
 * been read. So {@link parseEntityCard} reads one file and knows nothing about
 * its neighbours, and {@link extractCardRelations} takes the catalog and
 * decides what resolves. Both are pure; the intermediate
 * {@link ParsedEntityCard} is what carries the first pass's work to the second
 * instead of re-parsing.
 *
 * WHY BOTH RELATION SOURCES ARE `whole-file` EVIDENCE. Neither has a computable
 * offset: `ownership` is a structural YAML field read through `parse()`, and a
 * card mention is found by `extractEntityMentions` in a value the YAML parser
 * has already unescaped and folded. The plan routes both to `whole-file` and
 * the DDL pairs the coordinate columns with `evidence_kind` by CHECK, so the
 * "fill it with zeros" shortcut is not merely discouraged, it is
 * unconstructible through {@link EvidenceRef}.
 *
 * THIS PATH IS THE ASCII-ONLY ONE (R-15, gh#66). Source 3 goes through
 * `extractEntityMentions`, whose `ENTITY_MENTION_PATTERN`
 * (`entity-mentions.ts:23`) still carries the pre-TASK-013 ASCII kind grammar
 * `[a-z][\w-]*`, while chapter prose goes through the Unicode-aware wiki-link
 * and semantic-tag parsers. `[[персонаж:krishna]]` is therefore a mention in a
 * chapter and invisible in a backstory. #46 INHERITS that and does not repair
 * it; the repair is gh#66. The asymmetry is pinned by a characterizing test so
 * it cannot change unnoticed in either direction.
 */

import { parse as parseYaml } from 'yaml';
import { extractEntityMentions, type EntityMention } from '../entity-mentions';
import type { EntityTypeDescriptor } from '../entity-type-registry';
import {
  DEFAULT_NARRATIVE_ORIGIN,
  NARRATIVE_ORIGINS,
  wholeFileEvidence,
  type NarrativeEntity,
  type NarrativeOrigin
} from '../graph';
import { isRelationEndResolved, type EntityCatalog } from './entity-catalog';
import { CARD_MENTION_REL_TYPE, OWNERSHIP_REL_TYPE, type ExtractedRelation } from './extracted-relation';
import { asOptionalString, asString, asStringArray, cardIdFromPath, isRecord } from './yaml-values';

/** An entity card as read off disk — text plus the two identities the index keeps. */
export interface EntityCardDocument {
  /** Workspace-relative path. The index's document key (`document.rel_path`). */
  path: string;
  /**
   * URI of the same file.
   *
   * PASSED IN, NEVER DERIVED. `NarrativeEntity.sourceUri` is required, and
   * turning a workspace-relative path into a URI needs the workspace root —
   * which `src/common` neither knows nor may learn (it would mean a Theia
   * import, prohibition (c), and would make the extraction untestable without
   * a workspace). The caller that read the file already holds both.
   */
  uri: string;
  /** Raw file text. */
  text: string;
}

/** Machine-readable code for each way an entity card can be malformed. */
export type EntityCardProblemCode =
  /** The YAML failed to parse. */
  | 'invalid-yaml'
  /** The document parsed but its top level is not a mapping. */
  | 'not-a-mapping'
  /** `ownership:` is present but is not a list. */
  | 'ownership-not-a-list'
  /** An `ownership:` entry is not an object. */
  | 'ownership-entry-not-an-object'
  /** An `ownership:` entry has no `owner`. */
  | 'ownership-entry-missing-owner'
  /** An `origin:` value that is not one of the three known provenances. */
  | 'unknown-origin';

/** One problem found while reading an entity card. */
export interface EntityCardProblem {
  code: EntityCardProblemCode;
  /** Human-readable, English. Localisation happens at the presentation layer. */
  message: string;
  /** Workspace-relative path of the offending card. */
  sourcePath: string;
  /** Zero-based index of the offending `ownership:` entry, when applicable. */
  index?: number;
}

/**
 * One `ownership:` entry, read but not yet resolved.
 *
 * The story-time labels travel as the opaque strings they are — see
 * {@link ExtractedRelation} for why the names are not `from`/`to`.
 */
export interface OwnershipEntry {
  /** The owner's entity id, verbatim. May name no card at all. */
  owner: string;
  /** Zero-based position in the `ownership:` list. THE chronology (R-14). */
  position: number;
  /** Provenance of this entry. `explicit` when the entry states none. */
  origin: NarrativeOrigin;
  storyTimeFrom?: string;
  storyTimeTo?: string;
  note?: string;
}

/** Everything one entity card yields, before the catalog exists. */
export interface ParsedEntityCard {
  /** The card's own document identity. */
  document: EntityCardDocument;
  /** The entity row. */
  entity: NarrativeEntity;
  /** `ownership:` entries IN LIST ORDER (source 2). Empty for most cards. */
  ownership: OwnershipEntry[];
  /**
   * Entity references found in the card's own free text (source 3), deduplicated
   * by kind+id — a card that names another twice states one relationship.
   */
  mentions: EntityMention[];
}

/** The result of reading one card: the card, or the reasons there is none. */
export interface EntityCardParseResult {
  card?: ParsedEntityCard;
  problems: EntityCardProblem[];
}

/**
 * Keys whose string values are NOT scanned for entity references.
 *
 * `id` and `origin` are structural: an id is a token, not prose, and a
 * provenance is a closed vocabulary. Everything else the author can type into —
 * `summary`, `backstory`, `arc`, `notes`, and the list fields — IS scanned,
 * because `EntityCardsWidget.renderMentionText` already turns references in
 * those fields into working links, which is exactly the relation source 3
 * names. NESTED objects (`ownership:`) are not scanned at all: their strings
 * are read as structure by the ownership pass, and scanning them too would
 * report one entry as both a relation end and a mention.
 */
const STRUCTURAL_CARD_KEYS: ReadonlySet<string> = new Set(['id', 'origin']);

/**
 * Read the `origin:` field of a card or an `ownership` entry.
 *
 * ABSENT MEANS `explicit`, and that is not a convenience: every card and every
 * ownership entry written before this feature existed has no such field, and
 * reading them as anything else would relabel the whole existing corpus as
 * machine-proposed. An UNKNOWN value is reported rather than silently defaulted
 * — a typo'd `origin: ai_candidate` that quietly reads as `explicit` is a
 * candidate promoted to author-written by a misspelling.
 */
function readOrigin(
  value: unknown,
  sourcePath: string,
  problems: EntityCardProblem[],
  index?: number
): NarrativeOrigin {
  const text = asString(value);
  if (text.length === 0) {
    return DEFAULT_NARRATIVE_ORIGIN;
  }
  const known = NARRATIVE_ORIGINS.find(origin => origin === text);
  if (known !== undefined) {
    return known;
  }
  problems.push({
    code: 'unknown-origin',
    message: `Unknown origin "${text}"; expected one of ${NARRATIVE_ORIGINS.join(', ')}. Reading it as "${DEFAULT_NARRATIVE_ORIGIN}".`,
    sourcePath,
    ...(index !== undefined ? { index } : {})
  });
  return DEFAULT_NARRATIVE_ORIGIN;
}

/** Collect entity references from every free-text value of a card. */
function collectCardMentions(record: Record<string, unknown>): EntityMention[] {
  const mentions: EntityMention[] = [];
  const seen = new Set<string>();
  const take = (text: unknown): void => {
    if (typeof text !== 'string') {
      return;
    }
    for (const mention of extractEntityMentions(text)) {
      // JSON, not a separator character: a raw control byte in a key is how a
      // file becomes invisible to grep and binary to git, and this key exists
      // only to be compared.
      const key = JSON.stringify([mention.kind ?? null, mention.id]);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      mentions.push(mention);
    }
  };

  for (const [key, value] of Object.entries(record)) {
    if (STRUCTURAL_CARD_KEYS.has(key)) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        take(item);
      }
      continue;
    }
    take(value);
  }
  return mentions;
}

/** Read the `ownership:` list of an artifact card, in list order. */
function collectOwnership(
  value: unknown,
  sourcePath: string,
  problems: EntityCardProblem[]
): OwnershipEntry[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    problems.push({
      code: 'ownership-not-a-list',
      message: 'Ignoring ownership: expected a list.',
      sourcePath
    });
    return [];
  }

  const entries: OwnershipEntry[] = [];
  for (const [index, raw] of value.entries()) {
    if (!isRecord(raw)) {
      problems.push({
        code: 'ownership-entry-not-an-object',
        message: `Ignoring ownership entry ${index + 1}: expected an object.`,
        sourcePath,
        index
      });
      continue;
    }
    const owner = asString(raw.owner);
    if (!owner) {
      problems.push({
        code: 'ownership-entry-missing-owner',
        message: `Ignoring ownership entry ${index + 1}: missing owner.`,
        sourcePath,
        index
      });
      continue;
    }
    const storyTimeFrom = asOptionalString(raw.from);
    const storyTimeTo = asOptionalString(raw.to);
    const note = asOptionalString(raw.note);
    entries.push({
      owner,
      // The entry's own index in the SOURCE list, not its index among the
      // entries that survived validation: the surviving-entries count shifts
      // when a malformed neighbour is dropped, and the chronology must not.
      position: index,
      origin: readOrigin(raw.origin, sourcePath, problems, index),
      ...(storyTimeFrom !== undefined ? { storyTimeFrom } : {}),
      ...(storyTimeTo !== undefined ? { storyTimeTo } : {}),
      ...(note !== undefined ? { note } : {})
    });
  }
  return entries;
}

/**
 * Read one entity card. Pure: text in, domain values out, never throws.
 *
 * `type` is passed in rather than guessed from the path because the effective
 * type list is a separate resolution (`entities/types.yaml` merged over the
 * built-ins) and the caller that walked `entities/<directory>/` already knows
 * which one it was reading.
 */
export function parseEntityCard(
  document: EntityCardDocument,
  type: EntityTypeDescriptor
): EntityCardParseResult {
  const problems: EntityCardProblem[] = [];

  let parsed: unknown;
  try {
    parsed = parseYaml(document.text);
  } catch (error) {
    problems.push({
      code: 'invalid-yaml',
      message: `Invalid ${type.id} YAML: ${error instanceof Error ? error.message : String(error)}`,
      sourcePath: document.path
    });
    return { problems };
  }

  if (!isRecord(parsed)) {
    problems.push({
      code: 'not-a-mapping',
      message: `A ${type.id} entity card must be a YAML mapping.`,
      sourcePath: document.path
    });
    return { problems };
  }

  const labelField = type.fields.find(field => field.role === 'label')?.name ?? 'name';
  const id = asString(parsed.id) || cardIdFromPath(document.path);
  const name = asString(parsed[labelField]) || id;
  const summary = asOptionalString(parsed.summary);
  const backstory = asOptionalString(parsed.backstory);
  const arc = asOptionalString(parsed.arc);
  const notes = asOptionalString(parsed.notes);

  const entity: NarrativeEntity = {
    id,
    type: type.id,
    name,
    sourcePath: document.path,
    sourceUri: document.uri,
    origin: readOrigin(parsed.origin, document.path, problems),
    // The card file IS where the entity was read from, so recording it is a
    // fact, not an invention. (The legacy bridge deliberately does NOT
    // synthesise one — there it would be a pointer nobody ever recorded.)
    evidence: wholeFileEvidence(document.path),
    aliases: asStringArray(parsed.aliases),
    ...(summary !== undefined ? { summary } : {}),
    ...(Array.isArray(parsed.epithets) ? { epithets: asStringArray(parsed.epithets) } : {}),
    ...(backstory !== undefined ? { backstory } : {}),
    ...(arc !== undefined ? { arc } : {}),
    ...(Array.isArray(parsed.speechPatterns) ? { speechPatterns: asStringArray(parsed.speechPatterns) } : {}),
    ...(notes !== undefined ? { notes } : {})
  };

  return {
    card: {
      document,
      entity,
      ownership: collectOwnership(parsed.ownership, document.path, problems),
      mentions: collectCardMentions(parsed)
    },
    problems
  };
}

/**
 * Turn one parsed card into its relations (sources 2 and 3), resolved against
 * `catalog`.
 *
 * BOTH ENDS CARRY THEIR RESOLVEDNESS AND NOTHING IS DROPPED (ISS-319). An
 * `ownership.owner` naming a card that does not exist yields a relation with
 * `targetResolved: false` — not a relation silently pointing at its own label,
 * and not no relation at all. That is the whole difference between a broken
 * link the author can see and a broken link nobody will ever find.
 */
export function extractCardRelations(
  card: ParsedEntityCard,
  catalog: EntityCatalog
): ExtractedRelation[] {
  const sourceId = card.entity.id;
  const sourceResolved = isRelationEndResolved(catalog, sourceId);
  // A FRESH array per relation, not one shared instance: `evidence` is a
  // mutable list a later pass may append to (a relation restated in a second
  // document gains a second entry), and a shared array would grow on every
  // relation of the card at once.
  const evidence = () => [wholeFileEvidence(card.document.path)];
  const relations: ExtractedRelation[] = [];

  for (const entry of card.ownership) {
    relations.push({
      sourceId,
      targetId: entry.owner,
      relType: OWNERSHIP_REL_TYPE,
      origin: entry.origin,
      ownerPath: card.document.path,
      sourceResolved,
      targetResolved: isRelationEndResolved(catalog, entry.owner),
      evidence: evidence(),
      listPosition: entry.position,
      ...(entry.storyTimeFrom !== undefined ? { storyTimeFrom: entry.storyTimeFrom } : {}),
      ...(entry.storyTimeTo !== undefined ? { storyTimeTo: entry.storyTimeTo } : {}),
      ...(entry.note !== undefined ? { note: entry.note } : {})
    });
  }

  for (const [index, mention] of card.mentions.entries()) {
    relations.push({
      sourceId,
      targetId: mention.id,
      relType: CARD_MENTION_REL_TYPE,
      // A card the agent proposed states its references with the same
      // confidence it states everything else, so the relation inherits the
      // CARD's provenance. There is nowhere in the syntax to write a
      // per-reference one, and inventing one would be gh#57's job, not this
      // extraction's.
      origin: card.entity.origin,
      ownerPath: card.document.path,
      sourceResolved,
      targetResolved: isRelationEndResolved(catalog, mention.id),
      evidence: evidence(),
      listPosition: index
    });
  }

  return relations;
}
