/**
 * Tests for the icon-class-resolves-to-a-real-glyph guard (see
 * `check-icon-classes.ts`, ISS-366).
 *
 * The end-to-end teeth — put back `fa-project-diagram`, watch the check turn
 * red with a message naming the file/line/icon, put it back — were run by hand
 * against the real tree and are recorded in the task evidence. What is
 * asserted here is the part that can regress silently: which CSS selectors
 * count as "defined", which source shapes are extracted as claims (and which
 * are deliberately NOT — dynamic interpolation, comments, test fixtures), and
 * that `auditRepository` wires it all together correctly end to end against a
 * throwaway repository (never the real tree — real node_modules/package
 * layouts drift, and the point is to test behaviour, not today's inventory).
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import {
  auditRepository,
  extractDefinedClasses,
  extractIconClaims,
  extractRawClaims,
  formatReport,
  listAuditedSourceFiles,
  resolveIconCssFiles
} from './check-icon-classes';

describe('extractDefinedClasses — what counts as "defined"', () => {
  test('picks up a :before glyph rule', () => {
    const css = '.fa-book:before { content: "\\f02d"; }';
    expect(extractDefinedClasses(css, 'fa')).toEqual(new Set(['fa-book']));
  });

  test('picks up a non-glyph modifier rule too — codicon-modifier-spin has no glyph of its own', () => {
    const css = '.codicon-sync.codicon-modifier-spin { animation: spin 1.5s steps(30) infinite; }';
    const defined = extractDefinedClasses(css, 'codicon');
    expect(defined.has('codicon-modifier-spin')).toBe(true);
    expect(defined.has('codicon-sync')).toBe(true);
  });

  test('picks up a comma-joined selector list', () => {
    const css = '.fa-glass:before,\n.fa-music:before {\n  content: "x";\n}';
    expect(extractDefinedClasses(css, 'fa')).toEqual(new Set(['fa-glass', 'fa-music']));
  });

  test('does not cross prefixes: a codicon rule is invisible to the fa extraction', () => {
    const css = '.codicon-book:before { content: "x"; }';
    expect(extractDefinedClasses(css, 'fa').size).toBe(0);
  });
});

describe('extractRawClaims — what a source file is claiming', () => {
  const tokensOf = (text: string): string[] => extractRawClaims(text).map(c => c.token);

  test('a plain iconClass assignment', () => {
    expect(tokensOf(`this.title.iconClass = 'fa fa-book';`)).toEqual(['fa-book']);
  });

  test('an iconClasses array — the bare "fa"/"codicon" mode token is not a claim', () => {
    expect(tokensOf(`iconClasses: ['fa', 'fa-book'],`)).toEqual(['fa-book']);
  });

  test('a composite string keeps the icon token and ignores the project-owned accent class', () => {
    const tokens = tokensOf(`iconClass: 'codicon codicon-symbol-namespace afe-ico-entities',`);
    expect(tokens).toEqual(['codicon-symbol-namespace']);
    expect(tokens).not.toContain('afe-ico-entities');
  });

  test('the Theia codicon(name) helper is reconstructed as codicon-name', () => {
    expect(tokensOf(`iconClass: codicon('git-compare')`)).toEqual(['codicon-git-compare']);
  });

  test('a dynamically interpolated suffix is skipped entirely, not truncated into a false claim', () => {
    // Regression: naive matching reported the truncated `codicon-chevron` here
    // as if it were a complete, resolvable claim.
    expect(tokensOf('`codicon codicon-chevron-${expanded ? \'down\' : \'right\'}`')).toEqual([]);
  });

  test('a fully dynamic name (`codicon-${mode.icon}`) is skipped', () => {
    expect(tokensOf('`codicon codicon-${mode.icon}`')).toEqual([]);
  });

  test('comment content is walked past, not scanned for tokens', () => {
    expect(tokensOf('// fa-does-not-exist should never be flagged\nconst x = 1;')).toEqual([]);
    expect(tokensOf('/* codicon-also-fake */\nconst y = 2;')).toEqual([]);
  });

  test('a // inside a real string literal is not mistaken for a comment start', () => {
    // If it were, everything after the "//" (including the closing quote)
    // would be swallowed as "comment", silently losing the claim.
    expect(tokensOf(`const url = 'https://example.com/fa-book';`)).toEqual(['fa-book']);
  });

  test('a lookup table of literal values is covered, not just iconClass= sites', () => {
    const src = `
      const SECTION_ICONS: Record<string, string> = {
        manuscript: 'codicon codicon-book afe-ico-manuscript',
        citations: 'codicon codicon-quote afe-ico-citations'
      };`;
    expect(tokensOf(src)).toEqual(['codicon-book', 'codicon-quote']);
  });

  test('no false match on a bare word that merely starts with the prefix letters', () => {
    expect(tokensOf(`const label = 'facade-pattern';`)).toEqual([]);
  });
});

describe('extractIconClaims — line/column reporting', () => {
  test('reports the token position, not the literal start', () => {
    const text = "const x = 1;\nthis.title.iconClass = 'fa fa-book';\n";
    const claims = extractIconClaims('widget.ts', text);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ file: 'widget.ts', line: 2, token: 'fa-book' });
    // Column points at "fa-book" itself, inside the "fa fa-book" literal.
    expect(text.split('\n')[1]!.slice(claims[0]!.column - 1, claims[0]!.column - 1 + 7)).toBe('fa-book');
  });

  test('multiple claims on multiple lines are ordered by position', () => {
    const text = "iconClass: 'codicon codicon-add',\niconClass: 'fa fa-book',\n";
    const claims = extractIconClaims('f.ts', text);
    expect(claims.map(c => c.token)).toEqual(['codicon-add', 'fa-book']);
    expect(claims.map(c => c.line)).toEqual([1, 2]);
  });
});

describe('auditRepository — wired end to end against a throwaway repository', () => {
  const withScratchProject = (body: (dir: string) => void): void => {
    const dir = mkdtempSync(join(tmpdir(), 'icon-classes-audit-'));
    try {
      const git = (...args: string[]): void => {
        execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
      };
      git('init', '-q');
      git('config', 'user.email', 'test@example.invalid');
      git('config', 'user.name', 'test');

      // Minimal stand-ins for the two shipped icon fonts — enough to prove
      // the wiring, not a copy of the real font.
      mkdirSync(join(dir, 'node_modules/font-awesome/css'), { recursive: true });
      writeFileSync(
        join(dir, 'node_modules/font-awesome/css/font-awesome.css'),
        '.fa-book:before { content: "a"; }\n.fa-spin { animation: spin 2s infinite; }\n'
      );
      mkdirSync(join(dir, 'node_modules/@vscode/codicons/dist'), { recursive: true });
      writeFileSync(
        join(dir, 'node_modules/@vscode/codicons/dist/codicon.css'),
        '.codicon-book:before { content: "b"; }\n'
      );

      body(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test('resolveIconCssFiles finds a font CSS by its stable path suffix', () => {
    withScratchProject(dir => {
      expect(resolveIconCssFiles(dir, '/font-awesome/css/font-awesome.css')).toEqual([
        'node_modules/font-awesome/css/font-awesome.css'
      ]);
      expect(resolveIconCssFiles(dir, '/@vscode/codicons/dist/codicon.css')).toEqual([
        'node_modules/@vscode/codicons/dist/codicon.css'
      ]);
      expect(resolveIconCssFiles(dir, '/does-not-exist.css')).toEqual([]);
    });
  });

  test('a resolvable icon class passes clean', () => {
    withScratchProject(dir => {
      mkdirSync(join(dir, 'packages/demo/src'), { recursive: true });
      writeFileSync(
        join(dir, 'packages/demo/src/widget.ts'),
        `this.title.iconClass = 'fa fa-book';\n`
      );
      const report = auditRepository(dir);
      expect(report.findings).toEqual([]);
      expect(report.filesScanned).toBe(1);
      expect(report.claimsChecked).toBe(1);
    });
  });

  test('an unresolvable icon class is reported with file, line and the exact token', () => {
    withScratchProject(dir => {
      mkdirSync(join(dir, 'packages/demo/src'), { recursive: true });
      writeFileSync(
        join(dir, 'packages/demo/src/widget.ts'),
        `import x from 'y';\nthis.title.iconClass = 'fa fa-project-diagram';\n`
      );
      const report = auditRepository(dir);
      expect(report.findings).toHaveLength(1);
      expect(report.findings[0]).toMatchObject({
        file: 'packages/demo/src/widget.ts',
        line: 2,
        token: 'fa-project-diagram',
        prefix: 'fa'
      });
      expect(formatReport(report)).toContain('packages/demo/src/widget.ts:2:');
      expect(formatReport(report)).toContain('fa-project-diagram');
    });
  });

  test('a *.test.ts fixture with a deliberately-invalid icon string is not audited', () => {
    withScratchProject(dir => {
      mkdirSync(join(dir, 'packages/demo/src'), { recursive: true });
      writeFileSync(
        join(dir, 'packages/demo/src/parser.test.ts'),
        `test('rejects a malformed icon', () => { expect(parse('codicon-Nope')).toThrow(); });\n`
      );
      const report = auditRepository(dir);
      expect(report.filesScanned).toBe(0);
      expect(report.findings).toEqual([]);
    });
  });

  test('a non-glyph modifier class (fa-spin) is not a false positive', () => {
    withScratchProject(dir => {
      mkdirSync(join(dir, 'packages/demo/src'), { recursive: true });
      writeFileSync(
        join(dir, 'packages/demo/src/widget.ts'),
        `React.createElement('i', { className: 'fa fa-book fa-spin' });\n`
      );
      const report = auditRepository(dir);
      expect(report.findings).toEqual([]);
    });
  });

  test('an untracked (not yet git-added) file is still audited', () => {
    withScratchProject(dir => {
      mkdirSync(join(dir, 'packages/demo/src'), { recursive: true });
      writeFileSync(
        join(dir, 'packages/demo/src/fresh.ts'),
        `this.title.iconClass = 'fa fa-project-diagram';\n`
      );
      // Deliberately not `git add`-ed.
      expect(listAuditedSourceFiles(dir)).toContain('packages/demo/src/fresh.ts');
      const report = auditRepository(dir);
      expect(report.findings.map(f => f.file)).toContain('packages/demo/src/fresh.ts');
    });
  });
});
