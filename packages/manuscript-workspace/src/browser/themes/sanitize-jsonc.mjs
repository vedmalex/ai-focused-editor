// Tiny JSONC -> strict-JSON sanitizer.
// Strips // line comments, /* block */ comments, and trailing commas while
// respecting string literals, then re-parses and re-serializes to guarantee
// strict JSON (esbuild's json loader and JSON.parse both reject JSONC).
// Usage: node sanitize-jsonc.mjs <in.json> [out.json]
import { readFileSync, writeFileSync } from 'node:fs';

export function stripJsonc(input) {
  let out = '';
  let i = 0;
  const n = input.length;
  let inStr = false;
  while (i < n) {
    const c = input[i];
    if (inStr) {
      out += c;
      if (c === '\\') { out += input[i + 1] ?? ''; i += 2; continue; }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === '/' && input[i + 1] === '/') {
      i += 2;
      while (i < n && input[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && input[i + 1] === '*') {
      i += 2;
      while (i < n && !(input[i] === '*' && input[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  // Remove trailing commas: a comma followed only by whitespace before } or ]
  // (string-aware second pass).
  let res = '';
  inStr = false;
  for (let j = 0; j < out.length; j++) {
    const c = out[j];
    if (inStr) {
      res += c;
      if (c === '\\') { res += out[j + 1] ?? ''; j++; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; res += c; continue; }
    if (c === ',') {
      let k = j + 1;
      while (k < out.length && /\s/.test(out[k])) k++;
      if (out[k] === '}' || out[k] === ']') continue; // drop trailing comma
    }
    res += c;
  }
  return res;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const inFile = process.argv[2];
  const outFile = process.argv[3] || inFile;
  const raw = readFileSync(inFile, 'utf8');
  const obj = JSON.parse(stripJsonc(raw));
  writeFileSync(outFile, JSON.stringify(obj, null, 2) + '\n');
  console.log(`sanitized ${inFile} -> ${outFile}`);
}
