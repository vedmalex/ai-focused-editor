import { describe, expect, test } from 'bun:test';
import { parse } from 'yaml';
import { bookScaffoldEntries } from './book-scaffold';
import { flattenManifestRows } from './book-config-forms';
import {
  aiSettingsMigrationChecks,
  assembleBookDoctorReport,
  citationsParseFinding,
  deriveChapterTitle,
  entityCardMissingFixes,
  entityCardOrphanFindings,
  entityTypeProblemFindings,
  entityUnknownKindFindings,
  excerptsParseFinding,
  humanizeEntityId,
  manifestAppendFix,
  compareVersionTriples,
  manifestChapterFixes,
  manifestRecreateFix,
  metadataFindings,
  obsidianPluginFindings,
  preferredEntityLabel,
  scaffoldFixes,
  type EntityCardRef,
  type EntityTagOccurrence
} from './book-doctor';
import {
  BASE_ENTITY_TYPES,
  mergeEntityTypes,
  parseEntityTypesYaml,
  type EntityTypeProblem
} from './entity-type-registry';

/**
 * Effective type list (built-in + one author-declared `sloka` type) shared by the
 * dynamic entity-check tests. Declaring nothing but id/label lets `sloka` default
 * its tagKind + directory to `sloka` and take the default author field schema.
 */
const EFFECTIVE_WITH_SLOKA = mergeEntityTypes(
  BASE_ENTITY_TYPES,
  parseEntityTypesYaml('types:\n  - id: sloka\n    label: Sloka\n').types
);

/** Build an `exists` predicate from a fixed set of present paths. */
function existsIn(present: string[]): (path: string) => boolean {
  const set = new Set(present);
  return path => set.has(path);
}

const ALL_SCAFFOLD_PATHS = bookScaffoldEntries().map(entry => entry.path);

describe('scaffoldFixes', () => {
  test('offers every scaffold entry when nothing exists', () => {
    const fixes = scaffoldFixes(bookScaffoldEntries(), () => false, false);
    // 19 canonical entries, all missing.
    expect(fixes.map(fix => fix.path)).toEqual(ALL_SCAFFOLD_PATHS);
    // Folders carry no seed; files carry a (possibly empty) seed string.
    const manifest = fixes.find(fix => fix.path === 'manifest.yaml');
    expect(manifest?.kind).toBe('file');
    expect(manifest?.seed).toBe('version: 1\ncontent: []\n');
    const contentFolder = fixes.find(fix => fix.path === 'content');
    expect(contentFolder?.kind).toBe('folder');
    expect(contentFolder?.seed).toBeUndefined();
  });

  test('emits nothing when the whole scaffold is present', () => {
    expect(scaffoldFixes(bookScaffoldEntries(), existsIn(ALL_SCAFFOLD_PATHS), true)).toEqual([]);
  });

  test('skips the starter chapter-01 when content already has markdown', () => {
    // Everything present except the starter chapter and (say) the ai/ tree.
    const present = ALL_SCAFFOLD_PATHS.filter(path => path !== 'content/chapter-01.md');
    const fixes = scaffoldFixes(bookScaffoldEntries(), existsIn(present), true);
    expect(fixes.map(fix => fix.path)).not.toContain('content/chapter-01.md');
  });

  test('offers the starter chapter-01 when content has no markdown', () => {
    const present = ALL_SCAFFOLD_PATHS.filter(path => path !== 'content/chapter-01.md');
    const fixes = scaffoldFixes(bookScaffoldEntries(), existsIn(present), false);
    expect(fixes.map(fix => fix.path)).toContain('content/chapter-01.md');
  });

  test('carries create-folder/create-file codes with the description param', () => {
    const fixes = scaffoldFixes(bookScaffoldEntries(), () => false, false);
    const folder = fixes.find(fix => fix.kind === 'folder');
    expect(folder?.code).toBe('create-folder');
    expect(folder?.params).toHaveLength(1);
    const file = fixes.find(fix => fix.kind === 'file');
    expect(file?.code).toBe('create-file');
    expect(file?.params).toHaveLength(1);
  });
});

describe('manifestChapterFixes', () => {
  const manifest = parse(
    'version: 1\ncontent:\n' +
      '  - path: content/chapter-01.md\n    title: Beginnings\n' +
      '  - path: content/chapter-02.md\n' +
      '  - path: content/part-one\n    title: Part One\n    children:\n' +
      '      - path: content/part-one/chapter-03.md\n        title: Third\n'
  );
  const rows = flattenManifestRows(manifest);

  test('creates missing leaf chapter files, seeded from title or filename', () => {
    // chapter-01 exists on disk; chapter-02 and the nested chapter-03 do not.
    const exists = existsIn(['content/chapter-01.md']);
    const fixes = manifestChapterFixes(rows, exists);
    expect(fixes.map(fix => fix.path)).toEqual([
      'content/chapter-02.md',
      'content/part-one/chapter-03.md'
    ]);
    // Title-less chapter-02 seeds an H1 derived from its filename stem.
    const ch2 = fixes.find(fix => fix.path === 'content/chapter-02.md');
    expect(ch2?.seed).toBe('# chapter-02\n\n');
    // chapter-03 seeds its manifest title.
    const ch3 = fixes.find(fix => fix.path === 'content/part-one/chapter-03.md');
    expect(ch3?.seed).toBe('# Third\n\n');
  });

  test('never treats a part folder (row with children) as a chapter file', () => {
    const fixes = manifestChapterFixes(rows, () => false);
    expect(fixes.map(fix => fix.path)).not.toContain('content/part-one');
  });

  test('skips leaf entries that already exist on disk', () => {
    const exists = existsIn(['content/chapter-01.md', 'content/chapter-02.md', 'content/part-one/chapter-03.md']);
    expect(manifestChapterFixes(rows, exists)).toEqual([]);
  });

  test('carries the create-missing-chapter code on every chapter fix', () => {
    const fixes = manifestChapterFixes(rows, existsIn(['content/chapter-01.md']));
    expect(fixes.length).toBeGreaterThan(0);
    expect(fixes.every(fix => fix.code === 'create-missing-chapter')).toBe(true);
  });
});

describe('manifestRecreateFix', () => {
  test('rebuilds the manifest from discovered content when it is missing', () => {
    const fix = manifestRecreateFix(false, [
      { path: 'content/chapter-01.md', firstHeading: 'Intro' },
      { path: 'content/part-01/chapter-02.md' }
    ]);
    expect(fix?.path).toBe('manifest.yaml');
    expect(fix?.kind).toBe('file');
    expect(fix?.manifest?.mode).toBe('recreate');
    expect(fix?.manifest?.fileCount).toBe(2);
    // The seed is a real manifest the reader accepts.
    const rows = flattenManifestRows(parse(fix?.seed ?? ''));
    expect(rows.map(row => row.path)).toEqual([
      'content/chapter-01.md',
      'content/part-01',
      'content/part-01/chapter-02.md'
    ]);
  });

  test('is undefined when the manifest already exists or there is no content', () => {
    expect(manifestRecreateFix(true, [{ path: 'content/a.md' }])).toBeUndefined();
    expect(manifestRecreateFix(false, [])).toBeUndefined();
  });
});

describe('manifestAppendFix', () => {
  const rows = flattenManifestRows(
    parse('version: 1\ncontent:\n  - path: content/chapter-01.md\n')
  );

  test('offers an append fix for discovered files the manifest does not list', () => {
    const fix = manifestAppendFix(true, [
      { path: 'content/chapter-01.md' },
      { path: 'content/orphan.md' },
      { path: 'content/notes/scratch.md' }
    ], rows);
    expect(fix?.path).toBe('manifest.yaml');
    expect(fix?.manifest?.mode).toBe('append');
    expect(fix?.manifest?.fileCount).toBe(2);
    expect(fix?.manifest?.samplePaths).toEqual(['content/orphan.md', 'content/notes/scratch.md']);
    // No seed — the browser merges the entries into the existing manifest.
    expect(fix?.seed).toBeUndefined();
  });

  test('is undefined when every discovered file is already referenced', () => {
    expect(manifestAppendFix(true, [{ path: 'content/chapter-01.md' }], rows)).toBeUndefined();
  });

  test('is undefined when the manifest is missing (reconstruction handles that)', () => {
    expect(manifestAppendFix(false, [{ path: 'content/orphan.md' }], rows)).toBeUndefined();
  });
});

describe('metadataFindings', () => {
  test('warns on blank title and author', () => {
    const findings = metadataFindings({ title: '  ', author: '' });
    expect(findings).toHaveLength(2);
    expect(findings.every(finding => finding.kind === 'metadata')).toBe(true);
  });

  test('is silent when title and author are present', () => {
    expect(metadataFindings({ title: 'A Book', author: 'An Author' })).toEqual([]);
  });

  test('carries stable codes on the findings for localized rendering', () => {
    const findings = metadataFindings({ title: '', author: '' });
    expect(findings.map(finding => finding.code)).toEqual([
      'metadata-title-blank',
      'metadata-author-blank'
    ]);
  });
});

describe('sources parse checks', () => {
  test('citations: valid YAML yields no finding', () => {
    expect(citationsParseFinding('version: 1\ncitations: []\n')).toBeUndefined();
  });

  test('citations: broken YAML yields a parse finding', () => {
    const finding = citationsParseFinding('version: 1\n: : :\n  - [unbalanced\n');
    expect(finding?.kind).toBe('parse-error');
  });

  test('excerpts: valid JSONL (blank lines allowed) yields no finding', () => {
    expect(excerptsParseFinding('{"id":1}\n\n{"id":2}\n')).toBeUndefined();
  });

  test('excerpts: reports the first invalid line with its 1-based number', () => {
    const finding = excerptsParseFinding('{"id":1}\nnot json\n{"id":3}\n');
    expect(finding?.kind).toBe('parse-error');
    expect(finding?.detail).toContain('Line 2');
  });

  test('parse findings carry codes and positional params for localized rendering', () => {
    const excerpt = excerptsParseFinding('{"id":1}\nnot json\n');
    expect(excerpt?.code).toBe('excerpts-parse-error');
    // {0} is the 1-based line number, {1} is the parser message.
    expect(excerpt?.params?.[0]).toBe(2);
    expect(excerpt?.params).toHaveLength(2);
    const citations = citationsParseFinding('version: 1\n: : :\n  - [unbalanced\n');
    expect(citations?.code).toBe('citations-parse-error');
    expect(citations?.params).toHaveLength(1);
  });
});

describe('deriveChapterTitle', () => {
  test('prefers a non-blank manifest title', () => {
    expect(deriveChapterTitle('content/chapter-01.md', '  My Chapter ')).toBe('My Chapter');
  });

  test('falls back to the filename stem', () => {
    expect(deriveChapterTitle('content/part-one/chapter-03.md', '  ')).toBe('chapter-03');
  });
});

describe('humanizeEntityId', () => {
  test('splits separators and capitalizes each word', () => {
    expect(humanizeEntityId('john-smith')).toBe('John Smith');
    expect(humanizeEntityId('the_one.ring')).toBe('The One Ring');
  });

  test('falls back to the raw id when it has no word characters', () => {
    expect(humanizeEntityId('---')).toBe('---');
  });
});

describe('preferredEntityLabel', () => {
  test('picks the most frequent label', () => {
    expect(preferredEntityLabel({ Gandalf: 3, 'Gandalf the Grey': 1 })).toBe('Gandalf');
  });

  test('is undefined when no labels were harvested', () => {
    expect(preferredEntityLabel(undefined)).toBeUndefined();
    expect(preferredEntityLabel({})).toBeUndefined();
  });
});

describe('entityCardMissingFixes', () => {
  test('creates one seeded card per registry-kind tag whose card is absent', () => {
    const occurrences: EntityTagOccurrence[] = [
      { kind: 'char', id: 'gandalf', count: 3, firstPath: 'content/ch1.md', labels: { Gandalf: 2, 'Gandalf the Grey': 1 } }
    ];
    const fixes = entityCardMissingFixes(occurrences, []);
    expect(fixes).toHaveLength(1);
    const fix = fixes[0];
    expect(fix.path).toBe('entities/characters/gandalf.yaml');
    expect(fix.kind).toBe('file');
    expect(fix.code).toBe('entity-card-missing');
    // Name prefers the most frequent label.
    expect(fix.seed).toContain('name: Gandalf\n');
    expect(fix.seed).toContain('id: gandalf');
    // params: [entity label, name, count, first file].
    expect(fix.params).toEqual(['Character', 'Gandalf', 3, 'content/ch1.md']);
    // Description carries the mention count + first file.
    expect(fix.description).toContain('3 mention(s)');
    expect(fix.description).toContain('content/ch1.md');
  });

  test('names the card from the humanized id when no label was harvested', () => {
    const fixes = entityCardMissingFixes(
      [{ kind: 'term', id: 'astral-plane', count: 1, firstPath: 'content/ch2.md' }],
      []
    );
    expect(fixes[0].seed).toContain('name: Astral Plane\n');
    expect(fixes[0].path).toBe('entities/terms/astral-plane.yaml');
  });

  test('skips a tag whose card already exists on disk', () => {
    const existing: EntityCardRef[] = [{ kind: 'character', id: 'gandalf' }];
    const fixes = entityCardMissingFixes(
      [{ kind: 'char', id: 'gandalf', count: 2, firstPath: 'content/ch1.md' }],
      existing
    );
    expect(fixes).toEqual([]);
  });

  test('never creates a card from a bare kindless [[id]] tag — a card needs a kind', () => {
    // A bare occurrence (no kind) is a reference for orphan purposes only; it
    // can never materialize a card because the target directory is unknown.
    const fixes = entityCardMissingFixes(
      [{ kind: undefined, id: 'gandalf', count: 5, firstPath: 'content/ch1.md' }],
      []
    );
    expect(fixes).toEqual([]);
  });

  test('never creates a card from a well-formed but non-registry kind', () => {
    const fixes = entityCardMissingFixes(
      [{ kind: 'spell', id: 'fireball', count: 4, firstPath: 'content/ch1.md' }],
      []
    );
    expect(fixes).toEqual([]);
  });

  test('creates a card in the author directory for a declared author-kind tag', () => {
    const fixes = entityCardMissingFixes(
      [{ kind: 'sloka', id: 'bg-2-47', count: 2, firstPath: 'content/ch1.md', labels: { 'BG 2.47': 2 } }],
      [],
      EFFECTIVE_WITH_SLOKA
    );
    expect(fixes).toHaveLength(1);
    // Directory comes from the author descriptor (defaults to the id `sloka`).
    expect(fixes[0].path).toBe('entities/sloka/bg-2-47.yaml');
    expect(fixes[0].code).toBe('entity-card-missing');
    // params[0] is the author type's label.
    expect(fixes[0].params?.[0]).toBe('Sloka');
    expect(fixes[0].seed).toContain('name: BG 2.47\n');
  });

  test('without the effective list, an author kind is still treated as unknown', () => {
    const fixes = entityCardMissingFixes(
      [{ kind: 'sloka', id: 'bg-2-47', count: 2, firstPath: 'content/ch1.md' }],
      []
    );
    expect(fixes).toEqual([]);
  });
});

describe('entityCardOrphanFindings', () => {
  const cards: EntityCardRef[] = [{ kind: 'character', id: 'boromir' }];

  test('reports a card that no tag references', () => {
    const findings = entityCardOrphanFindings([], cards);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('entity');
    expect(findings[0].code).toBe('entity-card-orphan');
    // params: [entity label, id, path].
    expect(findings[0].params).toEqual(['Character', 'boromir', 'entities/characters/boromir.yaml']);
  });

  test('is silent when a matching-kind tag references the card', () => {
    const occ: EntityTagOccurrence[] = [{ kind: 'char', id: 'boromir', count: 1, firstPath: 'content/a.md' }];
    expect(entityCardOrphanFindings(occ, cards)).toEqual([]);
  });

  test('is silent when a bare kindless [[id]] tag references the card (matches any kind)', () => {
    const occ: EntityTagOccurrence[] = [{ kind: undefined, id: 'boromir', count: 1, firstPath: 'content/a.md' }];
    expect(entityCardOrphanFindings(occ, cards)).toEqual([]);
  });

  test('still reports the card when only a WRONG-kind tag shares the id', () => {
    // [[term:boromir]] resolves to the `term` kind, not `character` — so the
    // character card boromir stays orphaned.
    const occ: EntityTagOccurrence[] = [{ kind: 'term', id: 'boromir', count: 1, firstPath: 'content/a.md' }];
    expect(entityCardOrphanFindings(occ, cards)).toHaveLength(1);
  });
});

describe('entityUnknownKindFindings', () => {
  test('groups well-formed non-registry kinds with tag + id counts', () => {
    const occ: EntityTagOccurrence[] = [
      { kind: 'spell', id: 'fireball', count: 3, firstPath: 'content/a.md' },
      { kind: 'spell', id: 'icebolt', count: 2, firstPath: 'content/a.md' },
      { kind: 'char', id: 'gandalf', count: 9, firstPath: 'content/a.md' }
    ];
    const findings = entityUnknownKindFindings(occ);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe('entity-tag-unknown-kind');
    // params: [kind, total tag count, distinct id count].
    expect(findings[0].params).toEqual(['spell', 5, 2]);
  });

  test('ignores registry kinds, malformed kinds, and bare kindless tags', () => {
    const occ: EntityTagOccurrence[] = [
      { kind: 'char', id: 'gandalf', count: 1, firstPath: 'a.md' },
      { kind: '1bad', id: 'x', count: 1, firstPath: 'a.md' },
      { kind: undefined, id: 'y', count: 1, firstPath: 'a.md' }
    ];
    expect(entityUnknownKindFindings(occ)).toEqual([]);
  });

  test('treats a DECLARED author kind as known (no finding) but an undeclared one as unknown', () => {
    const occ: EntityTagOccurrence[] = [
      { kind: 'sloka', id: 'bg-2-47', count: 3, firstPath: 'a.md' },
      { kind: 'spell', id: 'fireball', count: 1, firstPath: 'a.md' }
    ];
    // With `sloka` in the effective list, only the still-undeclared `spell` is reported.
    const findings = entityUnknownKindFindings(occ, EFFECTIVE_WITH_SLOKA);
    expect(findings.map(finding => finding.params?.[0])).toEqual(['spell']);
    // Without it (built-ins only), `sloka` is unknown too.
    expect(entityUnknownKindFindings(occ).map(finding => finding.params?.[0]).sort()).toEqual(['sloka', 'spell']);
  });
});

describe('entityCardOrphanFindings (author kinds)', () => {
  test('resolves an author card label + path from the effective descriptor', () => {
    const findings = entityCardOrphanFindings(
      [],
      [{ kind: 'sloka', id: 'bg-2-47' }],
      EFFECTIVE_WITH_SLOKA
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe('entity-card-orphan');
    expect(findings[0].params).toEqual(['Sloka', 'bg-2-47', 'entities/sloka/bg-2-47.yaml']);
  });

  test('is silent when a matching author-kind tag references the card', () => {
    const occ: EntityTagOccurrence[] = [{ kind: 'sloka', id: 'bg-2-47', count: 1, firstPath: 'a.md' }];
    expect(entityCardOrphanFindings(occ, [{ kind: 'sloka', id: 'bg-2-47' }], EFFECTIVE_WITH_SLOKA)).toEqual([]);
  });
});

describe('entityTypeProblemFindings', () => {
  test('surfaces each validation problem as an informational entity-type-problem row', () => {
    const problems: EntityTypeProblem[] = [
      { code: 'reserved-id', id: 'character', message: 'id collides with a built-in type.' },
      { code: 'invalid-shape', message: 'must be a list of entity types.' }
    ];
    const findings = entityTypeProblemFindings(problems);
    expect(findings).toHaveLength(2);
    expect(findings.every(finding => finding.kind === 'entity' && finding.code === 'entity-type-problem')).toBe(true);
    // With an id, {0} is the id; without one, {0} falls back to the problem code.
    expect(findings[0].params).toEqual(['character', 'id collides with a built-in type.']);
    expect(findings[1].params).toEqual(['invalid-shape', 'must be a list of entity types.']);
    expect(findings[0].detail).toBe('id collides with a built-in type.');
  });

  test('is empty when there are no problems', () => {
    expect(entityTypeProblemFindings([])).toEqual([]);
  });

  test('reflects a real reserved-id collision parsed from types.yaml', () => {
    const { problems } = parseEntityTypesYaml('types:\n  - id: character\n    label: Nope\n');
    const findings = entityTypeProblemFindings(problems);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe('entity-type-problem');
    expect(findings[0].params?.[0]).toBe('character');
  });
});

describe('compareVersionTriples', () => {
  test('orders by the numeric major.minor.patch triple', () => {
    expect(compareVersionTriples('0.1.0', '0.2.0')).toBeLessThan(0);
    expect(compareVersionTriples('0.2.0', '0.1.0')).toBeGreaterThan(0);
    expect(compareVersionTriples('1.0.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersionTriples('0.1.0', '0.1.0')).toBe(0);
  });

  test('treats missing components as 0 and ignores extra/non-numeric junk', () => {
    expect(compareVersionTriples('1', '1.0.0')).toBe(0);
    expect(compareVersionTriples('1.2', '1.2.0')).toBe(0);
    // A 4th component beyond the triple is ignored.
    expect(compareVersionTriples('1.2.3.4', '1.2.3')).toBe(0);
    // A numeric lead is kept (trailing junk after the digits is dropped).
    expect(compareVersionTriples('0.1.0-beta', '0.1.0')).toBe(0);
    // A component with no leading digit degrades to 0 (so 'v2' < '2').
    expect(compareVersionTriples('v2.0.0', '2.0.0')).toBeLessThan(0);
  });
});

describe('obsidianPluginFindings', () => {
  test('offers an install (hint) fix when the plugin is not installed', () => {
    const fixes = obsidianPluginFindings({ installedVersion: null, bundledVersion: '0.1.0', hasObsidianDir: false });
    expect(fixes).toHaveLength(1);
    expect(fixes[0].code).toBe('install-obsidian-plugin');
    expect(fixes[0].path).toBe('.obsidian/plugins/afe-companion');
    expect(fixes[0].params).toEqual(['0.1.0']);
    expect(fixes[0].obsidianPlugin).toEqual({
      mode: 'install',
      severity: 'hint',
      installedVersion: null,
      bundledVersion: '0.1.0',
      hasObsidianDir: false
    });
  });

  test('offers install regardless of whether .obsidian already exists (threads hasObsidianDir)', () => {
    const fixes = obsidianPluginFindings({ bundledVersion: '0.1.0', hasObsidianDir: true });
    expect(fixes).toHaveLength(1);
    expect(fixes[0].obsidianPlugin?.hasObsidianDir).toBe(true);
  });

  test('offers an update (warning) fix when an older version is installed', () => {
    const fixes = obsidianPluginFindings({ installedVersion: '0.1.0', bundledVersion: '0.2.0', hasObsidianDir: true });
    expect(fixes).toHaveLength(1);
    expect(fixes[0].code).toBe('update-obsidian-plugin');
    expect(fixes[0].params).toEqual(['0.1.0', '0.2.0']);
    expect(fixes[0].obsidianPlugin?.mode).toBe('update');
    expect(fixes[0].obsidianPlugin?.severity).toBe('warning');
  });

  test('offers nothing when the installed version is equal or newer', () => {
    expect(obsidianPluginFindings({ installedVersion: '0.2.0', bundledVersion: '0.2.0', hasObsidianDir: true })).toEqual([]);
    expect(obsidianPluginFindings({ installedVersion: '0.3.0', bundledVersion: '0.2.0', hasObsidianDir: true })).toEqual([]);
  });

  test('offers nothing when the bundled version is unavailable (null)', () => {
    expect(obsidianPluginFindings({ installedVersion: null, bundledVersion: null, hasObsidianDir: false })).toEqual([]);
    expect(obsidianPluginFindings({ installedVersion: '0.1.0', bundledVersion: null, hasObsidianDir: true })).toEqual([]);
  });
});

describe('assembleBookDoctorReport', () => {
  test('composes fixes + findings and de-dups by path', () => {
    // content/ empty (no markdown); manifest references chapter-01.md which is
    // ALSO the scaffold starter — the fix must appear exactly once.
    const entries = bookScaffoldEntries();
    const manifestRows = flattenManifestRows(
      parse('version: 1\ncontent:\n  - path: content/chapter-01.md\n    title: Intro\n')
    );
    const report = assembleBookDoctorReport({
      scaffoldEntries: entries,
      exists: existsIn(['manifest.yaml', 'metadata.yaml', 'content']),
      contentHasMarkdown: false,
      manifestExists: true,
      manifestRows,
      manuscriptCandidates: [],
      metadata: { title: '', author: 'Someone' },
      citationsContent: 'version: 1\ncitations: []\n',
      excerptsContent: 'not json\n'
    });

    const chapterFixes = report.fixes.filter(fix => fix.path === 'content/chapter-01.md');
    expect(chapterFixes).toHaveLength(1);

    // Blank title -> metadata finding; broken excerpts -> parse finding.
    expect(report.findings.some(finding => finding.kind === 'metadata')).toBe(true);
    expect(report.findings.some(finding => finding.kind === 'parse-error')).toBe(true);
  });

  test('recreates a missing manifest from discovered content (and drops the empty seed)', () => {
    const report = assembleBookDoctorReport({
      scaffoldEntries: bookScaffoldEntries(),
      exists: existsIn(['metadata.yaml', 'content']),
      contentHasMarkdown: true,
      manifestExists: false,
      manifestRows: [],
      manuscriptCandidates: [{ path: 'content/chapter-07.md', firstHeading: 'Seven' }],
      folderName: 'My Restored Book'
    });
    const manifestFix = report.fixes.find(fix => fix.path === 'manifest.yaml');
    expect(manifestFix?.manifest?.mode).toBe('recreate');
    // The empty-seed scaffold manifest is superseded, not offered twice.
    expect(report.fixes.filter(fix => fix.path === 'manifest.yaml')).toHaveLength(1);
    expect(manifestFix?.seed).toContain('content/chapter-07.md');
  });

  test('re-seeds a missing metadata.yaml with the workspace folder name when restoring', () => {
    const report = assembleBookDoctorReport({
      scaffoldEntries: bookScaffoldEntries(),
      exists: existsIn(['content']),
      contentHasMarkdown: true,
      manifestExists: false,
      manifestRows: [],
      manuscriptCandidates: [{ path: 'content/chapter-01.md' }],
      folderName: 'War and Peace'
    });
    const metadataFix = report.fixes.find(fix => fix.path === 'metadata.yaml');
    expect(metadataFix?.seed).toContain('title: War and Peace');
  });

  test('offers an append fix for unreferenced content when the manifest exists', () => {
    const report = assembleBookDoctorReport({
      scaffoldEntries: bookScaffoldEntries(),
      exists: existsIn(ALL_SCAFFOLD_PATHS),
      contentHasMarkdown: true,
      manifestExists: true,
      manifestRows: flattenManifestRows(
        parse('version: 1\ncontent:\n  - path: content/chapter-01.md\n')
      ),
      manuscriptCandidates: [{ path: 'content/chapter-01.md' }, { path: 'content/orphan.md' }],
      metadata: { title: 'Book', author: 'Author' }
    });
    const appendFix = report.fixes.find(fix => fix.path === 'manifest.yaml');
    expect(appendFix?.manifest?.mode).toBe('append');
    expect(appendFix?.manifest?.samplePaths).toEqual(['content/orphan.md']);
    // The orphan is a FIX now, not a report-only finding.
    expect(report.findings).toEqual([]);
  });

  test('skips manifest-coverage checks when the manifest is absent and there is no content', () => {
    const report = assembleBookDoctorReport({
      scaffoldEntries: bookScaffoldEntries(),
      exists: existsIn(ALL_SCAFFOLD_PATHS),
      contentHasMarkdown: true,
      manifestExists: false,
      manifestRows: [],
      manuscriptCandidates: [],
      metadata: { title: 'Book', author: 'Author' }
    });
    // No content => nothing to reconstruct, no chapter fixes, no findings.
    expect(report.findings).toEqual([]);
    expect(report.fixes).toEqual([]);
  });

  test('wires entity occurrences into card fixes + orphan/unknown-kind findings', () => {
    const report = assembleBookDoctorReport({
      scaffoldEntries: bookScaffoldEntries(),
      exists: existsIn(ALL_SCAFFOLD_PATHS),
      contentHasMarkdown: true,
      manifestExists: true,
      manifestRows: flattenManifestRows(parse('version: 1\ncontent:\n  - path: content/chapter-01.md\n')),
      manuscriptCandidates: [{ path: 'content/chapter-01.md' }],
      metadata: { title: 'Book', author: 'Author' },
      entityTagOccurrences: [
        // Missing character card → a create fix.
        { kind: 'char', id: 'frodo', count: 2, firstPath: 'content/chapter-01.md', labels: { Frodo: 2 } },
        // Unknown kind → an informational finding, never a fix.
        { kind: 'spell', id: 'fireball', count: 1, firstPath: 'content/chapter-01.md' }
      ],
      // An on-disk card nothing references → orphan finding.
      existingEntityCards: [{ kind: 'location', id: 'shire' }]
    });

    const cardFix = report.fixes.find(fix => fix.path === 'entities/characters/frodo.yaml');
    expect(cardFix?.code).toBe('entity-card-missing');
    expect(report.findings.some(finding => finding.code === 'entity-card-orphan')).toBe(true);
    expect(report.findings.some(finding => finding.code === 'entity-tag-unknown-kind')).toBe(true);
    // The unknown kind never becomes a fix.
    expect(report.fixes.some(fix => fix.path.includes('fireball'))).toBe(false);
  });

  test('wires author-declared types: known kind → card fix, and type-problems → findings', () => {
    const report = assembleBookDoctorReport({
      scaffoldEntries: bookScaffoldEntries(),
      exists: existsIn(ALL_SCAFFOLD_PATHS),
      contentHasMarkdown: true,
      manifestExists: true,
      manifestRows: flattenManifestRows(parse('version: 1\ncontent:\n  - path: content/chapter-01.md\n')),
      manuscriptCandidates: [{ path: 'content/chapter-01.md' }],
      metadata: { title: 'Book', author: 'Author' },
      entityTagOccurrences: [
        // An author-declared `sloka` tag with no card → a create fix in entities/sloka/.
        { kind: 'sloka', id: 'bg-2-47', count: 2, firstPath: 'content/chapter-01.md', labels: { 'BG 2.47': 2 } }
      ],
      effectiveEntityTypes: EFFECTIVE_WITH_SLOKA,
      entityTypeProblems: [
        { code: 'reserved-id', id: 'term', message: 'id collides with a built-in type.' }
      ]
    });

    // The author kind becomes a fixable card, NOT an unknown-kind finding.
    expect(report.fixes.some(fix => fix.path === 'entities/sloka/bg-2-47.yaml')).toBe(true);
    expect(report.findings.some(finding => finding.code === 'entity-tag-unknown-kind')).toBe(false);
    // The parse problem is surfaced informationally.
    expect(report.findings.some(finding => finding.code === 'entity-type-problem')).toBe(true);
  });

  test('surfaces a legacy-AI-settings migration fix + finding from the workspace settings', () => {
    const report = assembleBookDoctorReport({
      scaffoldEntries: bookScaffoldEntries(),
      exists: existsIn(ALL_SCAFFOLD_PATHS),
      contentHasMarkdown: true,
      manifestExists: true,
      manifestRows: flattenManifestRows(parse('version: 1\ncontent:\n  - path: content/chapter-01.md\n')),
      manuscriptCandidates: [{ path: 'content/chapter-01.md' }],
      metadata: { title: 'Book', author: 'Author' },
      workspaceSettings: JSON.stringify({ 'aiFocusedEditor.ai.activeAlias': 'deep' })
    });
    const fix = report.fixes.find(f => f.code === 'migrate-ai-settings');
    expect(fix?.path).toBe('.theia/settings.json');
    expect(fix?.aiSettings?.legacyKeys).toEqual(['aiFocusedEditor.ai.activeAlias']);
    expect(report.findings.some(f => f.code === 'legacy-ai-settings' && f.severity === 'warning')).toBe(true);
  });
});

describe('aiSettingsMigrationChecks', () => {
  test('returns nothing for an absent settings file', () => {
    expect(aiSettingsMigrationChecks(undefined)).toEqual({});
  });

  test('returns nothing when no legacy keys are present', () => {
    expect(aiSettingsMigrationChecks(JSON.stringify({ 'aiConnect.activeAlias': 'deep' }))).toEqual({});
  });

  test('produces a fix + warning finding when legacy keys are present', () => {
    const { fix, finding } = aiSettingsMigrationChecks(
      JSON.stringify({
        'aiFocusedEditor.ai.endpoints': [],
        'aiFocusedEditor.ai.activeAlias': 'deep'
      })
    );
    expect(fix?.code).toBe('migrate-ai-settings');
    expect(fix?.aiSettings?.legacyKeys).toEqual([
      'aiFocusedEditor.ai.endpoints',
      'aiFocusedEditor.ai.activeAlias'
    ]);
    expect(fix?.params).toEqual([2, 'aiFocusedEditor.ai.endpoints, aiFocusedEditor.ai.activeAlias']);
    expect(finding?.code).toBe('legacy-ai-settings');
    expect(finding?.severity).toBe('warning');
    expect(finding?.kind).toBe('settings');
  });

  test('reports malformed settings without offering a fix', () => {
    const { fix, finding } = aiSettingsMigrationChecks('{ "aiFocusedEditor.ai.activeAlias": }');
    expect(fix).toBeUndefined();
    expect(finding?.code).toBe('legacy-ai-settings-malformed');
    expect(finding?.severity).toBe('warning');
  });
});
