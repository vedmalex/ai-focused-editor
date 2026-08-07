#!/usr/bin/env bun
/**
 * Assert that every `fa-*` / `codicon-*` icon class name claimed in our own
 * source actually resolves to a glyph the shipped icon fonts define (ISS-366).
 *
 * ## Why this exists
 *
 * `title.iconClass = 'fa fa-project-diagram'` and `title.iconClass = 'fa
 * fa-coins'` both shipped and both rendered as an EMPTY button: Theia bundles
 * Font Awesome 4.7, and `project-diagram` / `coins` only exist from FA 5
 * onward. Nothing in the build warns about this — a CSS class that does not
 * exist is not a TypeScript error, not a lint error, not a broken import. The
 * class is applied, the `<i>` element is drawn, there is no glyph inside it,
 * and the button silently reads as blank. `fa-coins` shipped a second time
 * this way, unnoticed, until a full sweep of every `iconClass` in the project
 * (not just the reported widget) turned it up too. This check is that sweep,
 * made permanent.
 *
 * ## What is audited
 *
 * Every packages/*\/src file, not just widget `title.iconClass` assignments.
 * The same defect shape shows up in `React.createElement('span', {
 * className: 'codicon codicon-xxx' })`, in lookup tables like
 * `SECTION_ICONS`, in `iconClasses: ['fa', 'fa-xxx']` arrays, and in Theia's
 * `codicon('xxx')` helper (which expands to `codicon codicon-xxx` at
 * runtime, so the literal string never appears verbatim in source and needs
 * its own extraction rule). Restricting the sweep to the `iconClass`
 * property name would have missed most of these — the actual invariant is
 * "every `fa-*` / `codicon-*` token that appears in our source resolves to a
 * real glyph", regardless of which property or helper puts it on the page.
 *
 * Composite class strings are handled token-by-token: in
 * `'codicon codicon-symbol-namespace afe-ico-entities'` only
 * `codicon-symbol-namespace` is a claim against the icon font; `codicon` is
 * the font's own base/marker class (defined by the font, not glyph-bearing,
 * skipped by construction — the token regex requires a trailing `-name`) and
 * `afe-ico-entities` is this project's own accent class, styled in
 * `packages/manuscript-workspace/src/browser/style/index.css`, not part of
 * either icon set. Tokens without an `fa-`/`codicon-` prefix are never
 * inspected, so project classes never get misreported as missing glyphs.
 *
 * Dynamically assembled names (`` `codicon codicon-${mode.icon}` ``) cannot
 * be resolved statically — the interpolated half is only known at runtime
 * (it comes from author-editable mode config). Those are silently skipped
 * rather than guessed at; this check proves what it can prove and does not
 * pretend to cover what it cannot.
 *
 * ## Source of truth: node_modules, not the built bundle
 *
 * `apps/browser/lib/frontend/bundle.css` is the actual shipped artifact, but
 * gating on it would mean this check only works AFTER `bun run build`,
 * which is exactly the kind of trap `check:test-reports` warns about
 * (REQ-014) — a check that only fires post-build silently reports nothing
 * useful on a fresh clone or a pre-build `bun run verify` invocation, and
 * `verify` here needs this check to run BEFORE `build:packages`, alongside
 * `check:control-bytes`, so a bad icon class fails fast instead of riding
 * along through a full build first.
 *
 * `node_modules` carries the exact same CSS `bun install` already resolved
 * for the build to consume, and is present the moment dependencies are
 * installed — no build step required. It is not a weaker proxy for the
 * bundle: `font-awesome/css/font-awesome.css` and
 * `@vscode/codicons/dist/codicon.css` are copied into the webpack bundle
 * unmodified (no icon subsetting), which this check's own test suite
 * confirms by comparing glyph counts against a real `bundle.css` fixture.
 *
 * ## What counts as "defined"
 *
 * Not just `:before` glyph rules. Font Awesome and codicons also ship
 * modifier classes with no glyph of their own (`fa-spin`, `fa-lg`,
 * `codicon-modifier-spin`, `codicon-modifier-disabled` — real classes that
 * restyle an existing icon rather than draw a new one). A glyph-only check
 * would flag `codicon-modifier-spin` — used in
 * `proofreading-widget.ts` — as missing, which would be a false positive on
 * a class that genuinely ships and works. "Defined" here means: this class
 * name appears as a selector anywhere in the font's CSS, glyph rule or not.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export interface IconCssSource {
  readonly prefix: 'fa' | 'codicon';
  readonly paths: readonly string[];
}

export interface IconClaim {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly token: string;
  readonly prefix: 'fa' | 'codicon';
}

export interface IconClassReport {
  readonly cssSources: readonly IconCssSource[];
  readonly definedCounts: Readonly<Record<'fa' | 'codicon', number>>;
  readonly filesScanned: number;
  readonly claimsChecked: number;
  readonly findings: readonly IconClaim[];
}

/**
 * Every file in the working tree the icon audit is responsible for: tracked
 * AND untracked-but-not-ignored `packages/*\/src/**\/*.ts(x)` files.
 *
 * `--others --exclude-standard` matters here for the same reason
 * `check-control-bytes.ts` added it (TASK-022 WP-4b): a brand-new widget
 * file with a bad icon class must fail on its FIRST `verify`, not silently
 * pass because it has not been `git add`-ed yet.
 *
 * `*.test.ts(x)` is excluded: a parser/validator test legitimately embeds a
 * deliberately-WRONG icon string as fixture data (e.g.
 * `directive-core.test.ts`'s `'codicon-Book is rejected by the pattern'`
 * case) — that string proves the validator rejects bad input, it is not a
 * claim that the UI renders it.
 *
 * Both a direct `packages/*\/src/*.ts` pattern AND a `packages/*\/src/**\/*.ts`
 * pattern are passed, deliberately redundant. Git's pathspec `**` requires at
 * least one intervening directory component to match — `src/**\/*.ts` alone
 * silently misses a file sitting directly in `src/` with no subdirectory
 * (verified: `packages/book-export/src/index.ts`, `packages/semantic-markdown
 * /src/index.ts` and others are exactly this shape, and vanished from the
 * scan with the `**`-only pattern until this was caught). The union of both
 * patterns is deduplicated below.
 */
export function listAuditedSourceFiles(cwd: string): string[] {
  const out = execFileSync(
    'git',
    [
      'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--',
      'packages/*/src/*.ts', 'packages/*/src/**/*.ts',
      'packages/*/src/*.tsx', 'packages/*/src/**/*.tsx',
      ':(exclude)packages/*/src/*.test.ts', ':(exclude)packages/*/src/**/*.test.ts',
      ':(exclude)packages/*/src/*.test.tsx', ':(exclude)packages/*/src/**/*.test.tsx'
    ],
    { cwd, maxBuffer: 64 * 1024 * 1024 }
  );
  const paths = out.toString('utf8').split('\0').filter(path => path.length > 0);
  return [...new Set(paths)].sort();
}

/**
 * Locate every copy of a font's CSS under `node_modules` by its stable
 * suffix. Bounded to `node_modules` (not the whole repo) and matched on the
 * relative path suffix rather than a package-manager-specific layout, so it
 * survives bun's `.bun` content store, a hoisted flat `node_modules`, or a
 * pnpm-style layout equally.
 */
export function resolveIconCssFiles(cwd: string, suffix: string): string[] {
  let out: Buffer;
  try {
    out = execFileSync('find', ['node_modules', '-type', 'f', '-path', `*${suffix}`], {
      cwd,
      maxBuffer: 16 * 1024 * 1024
    });
  } catch {
    return [];
  }
  return out
    .toString('utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .sort();
}

/**
 * Every `.<prefix>-name` selector token appearing anywhere in the CSS —
 * glyph rules (`.fa-book:before`) and non-glyph modifier/utility rules
 * (`.fa-spin`, `.codicon-modifier-spin`) alike. See the "What counts as
 * defined" note above for why glyph-only would misfire.
 */
export function extractDefinedClasses(cssText: string, prefix: 'fa' | 'codicon'): Set<string> {
  const re = new RegExp(`\\.(${prefix}-[a-zA-Z0-9][a-zA-Z0-9-]*)`, 'g');
  const found = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = re.exec(cssText)) !== null) {
    found.add(match[1]!);
  }
  return found;
}

/** One token+position, without the file name (callers attach that). */
interface RawClaim {
  readonly offset: number;
  readonly token: string;
  readonly prefix: 'fa' | 'codicon';
}

/**
 * String and template literals, plus comments (so comment content is walked
 * past rather than misread as code — a `//` inside an actual string like a
 * URL must not be mistaken for a comment start, and this alternation-based
 * scan naturally avoids that: whichever pattern matches first at the current
 * position wins, and a literal's opening quote is always reached before any
 * `//`/`/*` inside it could be).
 */
const LITERAL_OR_COMMENT = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g;

/**
 * `fa-xxx` / `codicon-xxx` tokens inside a string/template literal's own
 * text. The trailing `(?!-*\$)` refuses a match immediately followed by a
 * template interpolation (`` `codicon codicon-chevron-${expanded ? ... }` ``)
 * — without it, `[a-zA-Z0-9-]*` greedily eats the trailing hyphen, backtracks
 * one char to satisfy `\b`, and reports a truncated `codicon-chevron` as if
 * it were a complete, resolvable claim, when the real (dynamic) suffix is
 * unknowable statically. Skipping the whole token is correct: this check
 * proves what it can prove about literal text and does not guess at authored
 * runtime values.
 */
const ICON_TOKEN = /\b(fa|codicon)-([a-zA-Z0-9][a-zA-Z0-9-]*)\b(?!-*\$)/g;

/** Theia's `codicon(name)` helper — expands to `codicon codicon-${name}` at runtime (widget.js). */
const CODICON_HELPER_CALL = /\bcodicon\(\s*(['"])([a-zA-Z0-9][a-zA-Z0-9-]*)\1/g;

/**
 * Every `fa-*` / `codicon-*` token claimed in `text`, with its absolute
 * character offset. Two independent passes, both over the whole file:
 *
 *  1. String/template literal content — covers `iconClass = 'fa fa-book'`,
 *     `iconClasses: ['fa', 'fa-book']`, `SECTION_ICONS` map values, and
 *     `className: 'codicon codicon-xxx'`. Comments are matched by the same
 *     pass so their content is skipped rather than scanned for tokens.
 *  2. `codicon(name)` call sites — the helper builds the class name at
 *     runtime, so pass 1 only ever sees the bare `name` argument (no
 *     `codicon-` prefix to match); this pass reconstructs the claim.
 */
export function extractRawClaims(text: string): RawClaim[] {
  const claims: RawClaim[] = [];

  let m: RegExpExecArray | null;
  LITERAL_OR_COMMENT.lastIndex = 0;
  while ((m = LITERAL_OR_COMMENT.exec(text)) !== null) {
    const chunk = m[0];
    if (chunk.startsWith('/')) {
      continue; // comment, not a literal — walked past, not scanned
    }
    const chunkStart = m.index;
    ICON_TOKEN.lastIndex = 0;
    let tm: RegExpExecArray | null;
    while ((tm = ICON_TOKEN.exec(chunk)) !== null) {
      claims.push({
        offset: chunkStart + tm.index,
        token: tm[0],
        prefix: tm[1] as 'fa' | 'codicon'
      });
    }
  }

  CODICON_HELPER_CALL.lastIndex = 0;
  while ((m = CODICON_HELPER_CALL.exec(text)) !== null) {
    const name = m[2]!;
    // Offset the synthetic token onto the captured name, so a finding still
    // points at the string the author actually wrote.
    const nameOffset = m.index + m[0].indexOf(name, m[0].indexOf(m[1]!));
    claims.push({ offset: nameOffset, token: `codicon-${name}`, prefix: 'codicon' });
  }

  return claims;
}

/** Absolute char offset -> 1-based {line, column}, single forward pass (mirrors check-control-bytes.ts). */
function toPositions(text: string, offsets: readonly number[]): Map<number, { line: number; column: number }> {
  const sorted = [...new Set(offsets)].sort((a, b) => a - b);
  const result = new Map<number, { line: number; column: number }>();
  let line = 1;
  let lineStart = 0;
  let cursor = 0;
  for (const offset of sorted) {
    while (cursor < offset) {
      if (text.charCodeAt(cursor) === 0x0a) {
        line++;
        lineStart = cursor + 1;
      }
      cursor++;
    }
    result.set(offset, { line, column: offset - lineStart + 1 });
  }
  return result;
}

export function extractIconClaims(file: string, text: string): IconClaim[] {
  const raw = extractRawClaims(text);
  const positions = toPositions(text, raw.map(r => r.offset));
  return raw
    .map(r => {
      const pos = positions.get(r.offset)!;
      return { file, line: pos.line, column: pos.column, token: r.token, prefix: r.prefix };
    })
    .sort((a, b) => a.line - b.line || a.column - b.column);
}

const FA_CSS_SUFFIX = '/font-awesome/css/font-awesome.css';
const CODICON_CSS_SUFFIX = '/@vscode/codicons/dist/codicon.css';

export function auditRepository(cwd: string): IconClassReport {
  const faPaths = resolveIconCssFiles(cwd, FA_CSS_SUFFIX);
  const codiconPaths = resolveIconCssFiles(cwd, CODICON_CSS_SUFFIX);
  if (faPaths.length === 0) {
    throw new Error(
      `check-icon-classes: no ${FA_CSS_SUFFIX} found under node_modules — run "bun install" first.`
    );
  }
  if (codiconPaths.length === 0) {
    throw new Error(
      `check-icon-classes: no ${CODICON_CSS_SUFFIX} found under node_modules — run "bun install" first.`
    );
  }

  const definedFa = new Set<string>();
  for (const p of faPaths) {
    for (const cls of extractDefinedClasses(readFileSync(`${cwd}/${p}`, 'utf8'), 'fa')) {
      definedFa.add(cls);
    }
  }
  const definedCodicon = new Set<string>();
  for (const p of codiconPaths) {
    for (const cls of extractDefinedClasses(readFileSync(`${cwd}/${p}`, 'utf8'), 'codicon')) {
      definedCodicon.add(cls);
    }
  }

  const files = listAuditedSourceFiles(cwd);
  const findings: IconClaim[] = [];
  let claimsChecked = 0;
  for (const file of files) {
    const text = readFileSync(`${cwd}/${file}`, 'utf8');
    const claims = extractIconClaims(file, text);
    for (const claim of claims) {
      claimsChecked++;
      const defined = claim.prefix === 'fa' ? definedFa : definedCodicon;
      if (!defined.has(claim.token)) {
        findings.push(claim);
      }
    }
  }

  return {
    cssSources: [
      { prefix: 'fa', paths: faPaths },
      { prefix: 'codicon', paths: codiconPaths }
    ],
    definedCounts: { fa: definedFa.size, codicon: definedCodicon.size },
    filesScanned: files.length,
    claimsChecked,
    findings
  };
}

export function formatReport(report: IconClassReport): string {
  const lines: string[] = [];
  lines.push('Icon classes claimed in source that the shipped icon fonts do not define.');
  lines.push('');
  lines.push(
    'The class is applied, the element is drawn, there is no glyph inside it — an empty' +
      ' button with no build error and no warning. See scripts/check-icon-classes.ts for how this is decided.'
  );
  lines.push('');
  for (const f of report.findings) {
    lines.push(`  ${f.file}:${f.line}:${f.column}  ${f.token}  (no such class in the shipped ${f.prefix === 'fa' ? 'Font Awesome' : 'codicon'} font)`);
  }
  lines.push('');
  lines.push(
    `${report.findings.length} unresolved icon class(es) across ` +
      `${new Set(report.findings.map(f => f.file)).size} file(s).`
  );
  return lines.join('\n');
}

if (import.meta.main) {
  const cwd = process.argv[2] ?? process.cwd();
  let report: IconClassReport;
  try {
    report = auditRepository(cwd);
  } catch (err) {
    console.error(`check-icon-classes: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (report.findings.length > 0) {
    console.error(formatReport(report));
    process.exit(1);
  }
  console.log(
    `check-icon-classes: ${report.filesScanned} source file(s), ${report.claimsChecked} icon class claim(s) ` +
      `checked against ${report.definedCounts.fa} fa-* and ${report.definedCounts.codicon} codicon-* classes — all resolve.`
  );
}
