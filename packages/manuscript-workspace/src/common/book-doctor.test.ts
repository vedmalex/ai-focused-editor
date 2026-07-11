import { describe, expect, test } from 'bun:test';
import { parse } from 'yaml';
import { bookScaffoldEntries } from './book-scaffold';
import { flattenManifestRows } from './book-config-forms';
import {
  assembleBookDoctorReport,
  citationsParseFinding,
  deriveChapterTitle,
  excerptsParseFinding,
  manifestAppendFix,
  manifestChapterFixes,
  manifestRecreateFix,
  metadataFindings,
  scaffoldFixes
} from './book-doctor';

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
});

describe('deriveChapterTitle', () => {
  test('prefers a non-blank manifest title', () => {
    expect(deriveChapterTitle('content/chapter-01.md', '  My Chapter ')).toBe('My Chapter');
  });

  test('falls back to the filename stem', () => {
    expect(deriveChapterTitle('content/part-one/chapter-03.md', '  ')).toBe('chapter-03');
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
});
