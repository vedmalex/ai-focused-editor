/**
 * Guard against raw C0 control bytes in tracked text files.
 *
 * ## Why this exists
 *
 * A literal control byte written into source where an escape was meant — a real
 * NUL byte instead of `\u0000` — is invisible three times over:
 *
 *   - `grep` **skips the whole file and exits 0 as if it had searched it**. Not a
 *     warning; zero hits where there are matches. Enumerations built with `grep`
 *     silently come out short.
 *   - `git` classifies the file as binary and shows no diff, so the change never
 *     appears in review.
 *   - Editors and `cat` render nothing, so it is invisible to the eye too.
 *
 * The intent behind such bytes is usually sound — NUL is a fine separator for a
 * composite key precisely because it cannot occur in the parts. Only the
 * *encoding in the source file* is wrong. `\u0000` produces a byte-identical
 * runtime string with none of the three blindnesses.
 *
 * ## Why it is not built on grep
 *
 * A scanner built on `grep` (or `git grep`) would be blinded by the very byte it
 * hunts. This reads raw bytes with `readFileSync` and compares numbers.
 *
 * ## Why it does not ask git what is text
 *
 * The obvious design — "let git decide text vs binary" — is self-defeating here.
 * Git's binary heuristic *is* "contains a NUL byte", so at the time of writing
 * `git ls-files --eol` reported `w/-text` for all four offending source files in
 * this repo. Delegating the text/binary question to git would have skipped
 * exactly the files the guard exists to catch.
 *
 * So the classification is:
 *
 *   1. An explicit `binary` / `-text` gitattribute is honoured as a skip. This is
 *      the escape hatch, and it is deliberately a costly one: marking a file
 *      binary also kills its diff, so it is only ever the right answer for a file
 *      that genuinely is binary.
 *   2. Otherwise the file is decoded as strict UTF-8. Real binaries (images,
 *      fonts, compiled artefacts) fail to decode almost immediately — a PNG is
 *      invalid UTF-8 by its second byte. Those are skipped.
 *   3. Anything that decodes as UTF-8 is text, and is scanned.
 *
 * There is no hand-kept extension allowlist. This task exists because hand-kept
 * lists drift.
 *
 * ## Allowed bytes
 *
 * TAB (0x09), LF (0x0A) and CR (0x0D) are legitimate whitespace and pass.
 * Every other byte below 0x20 is rejected, including form feed (0x0C) and ESC
 * (0x1B): both render as nothing, which is the exact failure mode being closed,
 * and neither is used anywhere in this repository.
 */

import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';

/** Control bytes that are legitimate in text and must never be reported. */
export const ALLOWED_CONTROL_BYTES: ReadonlySet<number> = new Set([
  0x09, // TAB
  0x0a, // LF
  0x0d // CR
]);

/** Short names for the C0 block, so the failure message can say `NUL`, not just `0x00`. */
const C0_NAMES = [
  'NUL', 'SOH', 'STX', 'ETX', 'EOT', 'ENQ', 'ACK', 'BEL',
  'BS', 'TAB', 'LF', 'VT', 'FF', 'CR', 'SO', 'SI',
  'DLE', 'DC1', 'DC2', 'DC3', 'DC4', 'NAK', 'SYN', 'ETB',
  'CAN', 'EM', 'SUB', 'ESC', 'FS', 'GS', 'RS', 'US'
] as const;

export interface ControlByteFinding {
  /** Absolute byte offset from the start of the file. */
  readonly offset: number;
  /** 1-based line number, counting LF. */
  readonly line: number;
  /** 1-based column, in bytes from the last LF. */
  readonly column: number;
  /** The offending byte value. */
  readonly byte: number;
  /** Its C0 mnemonic, e.g. `NUL`. */
  readonly name: string;
  /** The suggested source escape, e.g. `\u0000`. */
  readonly escape: string;
}

export function controlByteName(byte: number): string {
  return C0_NAMES[byte] ?? `0x${byte.toString(16).padStart(2, '0')}`;
}

export function suggestedEscape(byte: number): string {
  return `\\u${byte.toString(16).padStart(4, '0')}`;
}

/**
 * Scan raw bytes for disallowed C0 control bytes.
 *
 * Deliberately operates on the byte array and not on a decoded string: a decoded
 * string is one more layer that could quietly normalise the thing being looked for.
 */
export function scanBytes(bytes: Uint8Array): ControlByteFinding[] {
  const findings: ControlByteFinding[] = [];
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i]!;
    if (byte === 0x0a) {
      line++;
      lineStart = i + 1;
      continue;
    }
    if (byte >= 0x20 || ALLOWED_CONTROL_BYTES.has(byte)) {
      continue;
    }
    findings.push({
      offset: i,
      line,
      column: i - lineStart + 1,
      byte,
      name: controlByteName(byte),
      escape: suggestedEscape(byte)
    });
  }
  return findings;
}

/** True when the buffer decodes as strict UTF-8, which is this guard's definition of text. */
export function isUtf8Text(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every path git would show you: tracked, PLUS untracked-and-not-ignored.
 *
 * The untracked half is not a nicety — it is the hole this guard fell through
 * once. `git ls-files` alone lists only TRACKED paths, so a brand-new file is
 * invisible to the check until the commit that adds it. TASK-022 WP-4b wrote a
 * raw NUL into a new `narrative-memory-configure.ts`; `bun run verify` passed at
 * EXIT 0 because the file was still untracked, and the byte only surfaced on the
 * NEXT verify, after the commit had already landed. That is exactly backwards:
 * new code is where a fresh raw byte is most likely, and it was the one place
 * the guard did not look.
 *
 * `--exclude-standard` keeps `.gitignore` honoured, so `lib/`, `node_modules/`
 * and every other ignored tree stay out. Deduplicated because a path staged with
 * `git add -N` appears in both halves.
 */
export function listTrackedFiles(cwd: string): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd, maxBuffer: 64 * 1024 * 1024 }
  );
  const paths = out.toString('utf8').split('\0').filter(path => path.length > 0);
  return [...new Set(paths)];
}

/**
 * Paths whose gitattributes declare them binary (`binary`, or an explicit `-text`).
 * With no `.gitattributes` every attribute is `unspecified` and this is empty.
 */
export function declaredBinaryPaths(cwd: string, paths: readonly string[]): Set<string> {
  const declared = new Set<string>();
  if (paths.length === 0) {
    return declared;
  }
  const out = execFileSync('git', ['check-attr', '-z', '--stdin', 'binary', 'text'], {
    cwd,
    input: `${paths.join('\0')}\0`,
    maxBuffer: 64 * 1024 * 1024
  });
  const fields = out.toString('utf8').split('\0');
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const [path, attr, value] = [fields[i]!, fields[i + 1]!, fields[i + 2]!];
    if ((attr === 'binary' && value === 'set') || (attr === 'text' && value === 'unset')) {
      declared.add(path);
    }
  }
  return declared;
}

export interface ScanReport {
  readonly scanned: number;
  readonly skippedBinary: number;
  readonly findings: ReadonlyArray<{ readonly file: string } & ControlByteFinding>;
}

export function scanRepository(cwd: string): ScanReport {
  const paths = listTrackedFiles(cwd);
  const declaredBinary = declaredBinaryPaths(cwd, paths);
  const findings: Array<{ file: string } & ControlByteFinding> = [];
  let scanned = 0;
  let skippedBinary = 0;

  for (const path of paths) {
    if (declaredBinary.has(path)) {
      skippedBinary++;
      continue;
    }
    let stat;
    try {
      stat = lstatSync(`${cwd}/${path}`);
    } catch {
      continue; // Tracked but absent from the worktree (mid-rebase, sparse checkout).
    }
    if (!stat.isFile()) {
      continue; // Symlinks and gitlinks have no content of their own here.
    }
    const bytes = readFileSync(`${cwd}/${path}`);
    if (!isUtf8Text(bytes)) {
      skippedBinary++;
      continue;
    }
    scanned++;
    for (const finding of scanBytes(bytes)) {
      findings.push({ file: path, ...finding });
    }
  }

  return { scanned, skippedBinary, findings };
}

export function formatReport(report: ScanReport): string {
  const lines: string[] = [];
  lines.push('Raw C0 control bytes found in tracked text files.');
  lines.push('');
  lines.push('These bytes make the file invisible to grep (which skips it and still exits 0)');
  lines.push('and to git diff (which treats it as binary). Replace each with its escape;');
  lines.push('the runtime string is byte-identical.');
  lines.push('');
  for (const f of report.findings) {
    lines.push(
      `  ${f.file}:${f.line}:${f.column}  byte 0x${f.byte.toString(16).padStart(2, '0')} (${f.name})` +
        `  at offset ${f.offset}  ->  write ${f.escape}`
    );
  }
  lines.push('');
  lines.push(`${report.findings.length} byte(s) in ` +
    `${new Set(report.findings.map(f => f.file)).size} file(s).`);
  lines.push('');
  lines.push('If a file is genuinely binary, declare it in .gitattributes (`path binary`)');
  lines.push('rather than weakening this guard.');
  return lines.join('\n');
}

if (import.meta.main) {
  const cwd = process.argv[2] ?? process.cwd();
  const report = scanRepository(cwd);
  if (report.findings.length > 0) {
    console.error(formatReport(report));
    process.exit(1);
  }
  console.log(
    `check-control-bytes: ${report.scanned} tracked text file(s) clean ` +
      `(${report.skippedBinary} binary file(s) skipped).`
  );
}
