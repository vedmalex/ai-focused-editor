/**
 * WP-9a's OWN fixtures (TASK-022, plan `### WP-9a`).
 *
 * DELIBERATELY NOT SHARED WITH WP-9b, and the plan says so in as many words
 * ("Фикстуры собственные ... НЕ разделяемая с WP-9a", plan.md:211 read from the
 * other side). Two work packages sharing one fixture means either of them can
 * make the other's tooth green by adding a file, and this task has already paid
 * for that failure mode: eight teeth came back green on the first try and six of
 * them were holes in a fixture rather than working code.
 *
 * WHAT EACH FEATURE OF {@link hardManuscript} IS FOR. Nothing here is scenery —
 * every file is the state that violates one of the four assertions if the code
 * is wrong:
 *
 *   - `entities/characters/warrior-3.yaml` HOLDS `id: arjuna`. The filename and
 *     the id DISAGREE ON PURPOSE. Assertion 4 (identity continuity) is about
 *     `entity_id` coming from the YAML `id:` field with a fallback to the file
 *     name (`node-domain-knowledge-service.ts:387`, tech_spec ОВ-1 :609) — and
 *     against a fixture whose filename equals its id, a path-derived
 *     implementation is INDISTINGUISHABLE from a field-derived one. That is
 *     exactly the "green by fixture coincidence" the adapter sort-order suite
 *     was caught by.
 *   - `zz-krishna-again.yaml` DUPLICATES `id: krishna`. The `zz-` prefix is not
 *     decoration: the catalog gives the id to the FIRST card in input order and
 *     the workspace source sorts by code point, so the winner has to be
 *     predictable from the names alone or the duplicate assertions would be
 *     asserting whatever the sort happened to do.
 *   - `gandiva.yaml` carries THREE `ownership` entries: one with an explicit
 *     `origin: ai-candidate`, one with NO `origin` field (which must read as
 *     `explicit`), and one naming an id no card defines (a BROKEN relation end).
 *     One card, three assertions — and the first two are a matched pair, so an
 *     implementation stamping one origin on every entry fails one of them
 *     whichever value it picks.
 *   - `balarama.yaml` is the LEGACY CARD: `id` and `name` and nothing else, the
 *     shape every card written before `origin` existed has.
 *   - `content/ch-06.md` is a real chapter the manifest does NOT list, so
 *     `chapterOrder` is absent and the spoiler-safe rule has something to key
 *     on.
 *   - `sources/citations.yaml`, `sources/excerpts.jsonl` and
 *     `knowledge/plans/act-1.yaml` MUST ARRIVE in order to be REFUSED. The
 *     workspace walk filters by extension only and is documented as
 *     deliberately liberal (`narrative-workspace-scan.ts:10-18`); a fixture that
 *     omitted these files would make "the pipeline produces nothing from them"
 *     green because they never showed up.
 *
 * WHY SHA-256 HERE AND FNV IN THE WP-4b CORE. That core runs under `bun` too,
 * where `src/common` may not import `node:crypto` (prohibition (a)). This module
 * is node-only, so it hashes with the SAME function the production walk uses
 * (`hashContent`, `narrative-workspace-scan.ts:47`) and the fixture's hashes are
 * the hashes a real disk would produce rather than a stand-in that merely
 * behaves like one.
 */

import { createHash } from 'node:crypto';
import type { IndexableFile } from '../../lib/common/index.js';

/** SHA-256 of the UTF-8 bytes, lowercase hex — the production `content_hash`. */
export function hashContent(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Fixed epoch ms, so nothing in a fixture depends on when it was built. */
export const FIXTURE_MTIME = 1_700_000_000_000;

/**
 * One workspace file, measured the way the real walk measures one.
 *
 * `sizeBytes` is the UTF-8 BYTE LENGTH and not `text.length`. The manuscript is
 * Russian, so the two differ by roughly a factor of two on every chapter, and a
 * fixture that used the code-unit count would be asserting the prefilter against
 * a number no `stat` ever returns.
 */
export function file(path: string, text: string, overrides: Partial<IndexableFile> = {}): IndexableFile {
  return {
    path,
    uri: `file:///workspace/${path}`,
    text,
    sizeBytes: Buffer.byteLength(text, 'utf8'),
    mtimeMs: FIXTURE_MTIME,
    contentHash: hashContent(text),
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Named paths — so an assertion cites the fixture instead of re-spelling it
// ---------------------------------------------------------------------------

/** The card whose FILENAME AND `id` DISAGREE. Assertion 4 turns on this. */
export const ARJUNA_CARD = 'entities/characters/warrior-3.yaml';
/** The card that WINS the `krishna` collision (sorts before `zz-`). */
export const KRISHNA_CARD = 'entities/characters/krishna.yaml';
/** The card that LOSES it. */
export const KRISHNA_DUPLICATE_CARD = 'entities/characters/zz-krishna-again.yaml';
/** A card in the pre-`origin` shape: `id` and `name`, nothing more. */
export const LEGACY_CARD = 'entities/characters/balarama.yaml';
/** The artifact card carrying the hand-built `ai-candidate` ownership entry. */
export const GANDIVA_CARD = 'entities/artifacts/gandiva.yaml';
/** A chapter the manifest lists. */
export const CH = (n: number): string => `content/ch-${String(n).padStart(2, '0')}.md`;
/** The chapter the manifest does NOT list. */
export const UNLISTED_CHAPTER = CH(6);

/** Chapters the manifest lists, in manifest order. */
export const LISTED_CHAPTERS = [CH(1), CH(2), CH(3), CH(4), CH(5)];

/**
 * The invariant fixture: aliases, a duplicate id, broken links, an unlisted
 * chapter, a legacy card, a hand-built `ai-candidate` relation, and three files
 * the index must refuse.
 */
export function hardManuscript(): IndexableFile[] {
  return [
    file(
      'manifest.yaml',
      [
        'content:',
        ...LISTED_CHAPTERS.map((path, index) => `  - path: ${path}\n    title: Глава ${index + 1}`)
      ].join('\n')
    ),

    // -- cards ------------------------------------------------------------
    // ALIASES live here, and they are what `namePrefix` searches across.
    file(
      KRISHNA_CARD,
      [
        'id: krishna',
        'name: Кришна',
        'aliases:',
        '  - Говинда',
        '  - Мадхава',
        'summary: Возница [[char:arjuna]] в решающей битве.'
      ].join('\n')
    ),
    // The LOSER of the collision. Same id, different file, later in code-point
    // order — so the winner is decided by the fixture and not by luck.
    file(KRISHNA_DUPLICATE_CARD, ['id: krishna', 'name: Кришна (дубль)'].join('\n')),
    // FILENAME != id. A path-derived implementation calls this entity
    // `warrior-3`; a field-derived one calls it `arjuna`.
    file(ARJUNA_CARD, ['id: arjuna', 'name: Арджуна', 'aliases:', '  - Партха'].join('\n')),
    // The LEGACY shape: no `origin`, no `aliases`, nothing but the two fields
    // every card has always had.
    file(LEGACY_CARD, ['id: balarama', 'name: Баларама'].join('\n')),
    // THREE ownership entries, THREE different things being asserted.
    file(
      GANDIVA_CARD,
      [
        'id: gandiva',
        'name: Гандива',
        'ownership:',
        // (1) the author decision assertion 3 must carry through a rebuild
        '  - owner: arjuna',
        "    origin: 'ai-candidate'",
        // (2) NO origin field -> must read as `explicit`, which is what stops
        //     "stamp ai-candidate on everything" from passing (1)
        '  - owner: krishna',
        // (3) an owner no card defines -> a BROKEN relation end, stored with
        //     the flag rather than dropped or silently self-labelled (ISS-319)
        '  - owner: nobody-at-all'
      ].join('\n')
    ),

    // -- chapters ----------------------------------------------------------
    file(CH(1), 'Вместе: [[char:krishna|Кришна]] и [[char:arjuna|Арджуна]].'),
    file(CH(2), 'Один: [[char:krishna|Кришна]].'),
    file(CH(3), 'Тоже один: [[char:krishna|Кришна]].'),
    // A BROKEN mention: no card defines `nobody`.
    file(CH(4), 'Оба снова: [[char:krishna|Кришна]] и [[char:arjuna|Арджуна]]. И [[char:nobody|Никто]].'),
    file(CH(5), 'Брат: [[char:balarama|Баларама]].'),
    // A real chapter the manifest does not list: indexed, but with no position.
    file(UNLISTED_CHAPTER, 'Черновик: [[char:krishna|Кришна]] снова.'),

    // -- files that MUST ARRIVE IN ORDER TO BE REFUSED ---------------------
    file('sources/citations.yaml', ['citations:', '  - id: gita-1-1', '    target: content/ch-01.md'].join('\n')),
    file('sources/excerpts.jsonl', '{"id":"ex-1","target":"content/ch-02.md","text":"…"}'),
    file('knowledge/plans/act-1.yaml', ['scenes:', '  - id: s1', '    beats:', '      - Начало'].join('\n'))
  ];
}

/**
 * The same manuscript with `manifest.yaml` REMOVED.
 *
 * "workspace без манифеста" from the plan's fixture list. Every chapter is then
 * unlisted, so `chapterOrder` is absent everywhere and `manifestPresent` is
 * false — which is the input the service turns into `absent/no-manuscript`.
 */
export function manuscriptWithoutManifest(): IndexableFile[] {
  return hardManuscript().filter(item => item.path !== 'manifest.yaml');
}

/**
 * A generated manuscript of `chapterCount` chapters, for the budgets.
 *
 * WHY THE CHAPTERS ARE NOT ALL THE SAME. Two reasons, and both are about the
 * budget measuring the right thing:
 *
 *   - identical chapters would give identical `contentHash`es, and the
 *     delete/create pairing keys on the hash — a batch over twins would then be
 *     measuring the pairing's tie-break rather than the write path;
 *   - the co-occurrence fold is over PAIRS of entities sharing a chapter, so a
 *     manuscript where every chapter names the same two characters produces ONE
 *     derived edge no matter how long it is. The entity referenced is rotated
 *     so the derived layer grows with the manuscript, which is the part of a
 *     rebuild that could plausibly be quadratic.
 *
 * The prose is padded to roughly a realistic chapter length, because a budget
 * measured over 200 one-line files measures process startup and directory
 * traversal, not extraction.
 */
export function largeManuscript(chapterCount: number, cast = 8): IndexableFile[] {
  const castIds = Array.from({ length: cast }, (_, index) => `hero-${index}`);
  const files: IndexableFile[] = [
    file(
      'manifest.yaml',
      [
        'content:',
        ...Array.from(
          { length: chapterCount },
          (_, index) => `  - path: ${CH(index + 1)}\n    title: Глава ${index + 1}`
        )
      ].join('\n')
    ),
    ...castIds.map((id, index) =>
      file(
        `entities/characters/${id}.yaml`,
        [`id: ${id}`, `name: Герой ${index}`, 'aliases:', `  - Псевдоним ${index}`].join('\n')
      )
    )
  ];

  // ~2 KB of Russian prose per chapter — long enough that scanning it is real
  // work, short enough that 200 of them stay a test and not a benchmark.
  const filler = 'Слова наполняют главу и продолжают повествование дальше. '.repeat(30);

  for (let index = 0; index < chapterCount; index++) {
    // Two DIFFERENT cast members per chapter, rotating, so the derived
    // co-occurrence layer grows with the manuscript instead of collapsing to a
    // single edge.
    const first = castIds[index % cast]!;
    const second = castIds[(index + 1 + (index % (cast - 1))) % cast]!;
    files.push(
      file(
        CH(index + 1),
        [
          `# Глава ${index + 1}`,
          '',
          `Здесь встречаются [[char:${first}|Первый]] и [[char:${second}|Второй]].`,
          '',
          filler,
          '',
          `Глава ${index + 1} завершается.`
        ].join('\n')
      )
    );
  }
  return files;
}
