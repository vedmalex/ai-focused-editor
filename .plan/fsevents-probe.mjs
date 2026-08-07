// Проба: доставляет ли macOS FSEvents события этому процессу.
// Запускать: node .plan/fsevents-probe.mjs
import { watch, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

async function probe(label, dir, cleanup) {
  let n = 0;
  const w = watch(dir, () => n++);
  await new Promise(r => setTimeout(r, 300));
  writeFileSync(join(dir, 'fsevents-probe.tmp'), String(Date.now()));
  await new Promise(r => setTimeout(r, 2000));
  w.close();
  try { rmSync(join(dir, 'fsevents-probe.tmp'), { force: true }); } catch {}
  if (cleanup) { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
  console.log(`${label.padEnd(28)} ${n > 0 ? 'РАБОТАЕТ (' + n + ' событий)' : 'МОЛЧИТ'}`);
  return n;
}

console.log(`node ${process.version}, pid ${process.pid}, ppid ${process.ppid}`);
let total = 0;
total += await probe('временный каталог', mkdtempSync(join(tmpdir(), 'fsp-')), true);
total += await probe('домашний каталог', homedir(), false);
console.log(total > 0 ? '\nИТОГ: FSEvents В ЭТОМ ПРОЦЕССЕ РАБОТАЕТ' : '\nИТОГ: FSEvents В ЭТОМ ПРОЦЕССЕ МОЛЧИТ');
