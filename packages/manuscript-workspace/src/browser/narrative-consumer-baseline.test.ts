/**
 * TASK-022 WP-9b — БАЗОВАЯ ЛИНИЯ ПОВЕДЕНИЯ ЧЕТЫРЁХ ПОТРЕБИТЕЛЕЙ.
 *
 * Это ХАРАКТЕРИЗАЦИОННЫЙ пакет, а не пакет соответствия. Он не утверждает, что
 * код делает ПРАВИЛЬНО, — он фиксирует, что код делает СЕГОДНЯ, чтобы WP-7
 * (поглощение `narrative-graph`/`narrative-entity` индексом) и WP-8 (обуздание
 * пишущих AI-инструментов) не смогли изменить наблюдаемое поведение МОЛЧА.
 *
 * Четыре потребителя (плана WP-9b, «Зачем вообще»):
 *   1. Narrative Map      — снимок графа (`NodeNarrativeGraphService`);
 *   2. Entity Cards       — содержимое карточки (`NodeNarrativeEntityService`
 *                           плюс отрисовка упоминаний в `EntityCardsWidget`);
 *   3. `manuscript_find_entities` — структурный ответ инструмента;
 *   4. Book Doctor        — набор находок (`BookDoctorContribution.gather`).
 *
 * Для первых трёх это шлюз ПЕРЕИМЕНОВАНИЯ. Для Book Doctor — шлюз МИГРАЦИИ:
 * он ни один поглощаемый сервис не вызывает, WP-7 заменяет ЧЕТЫРЕ ЗНАНИЕВЫХ
 * ВХОДА из ТРЁХ ФИДЕРОВ внутри `gather()`, а ЧЕТЫРНАДЦАТЬ незнаниевых входов
 * остаются на ФС (ISS-307).
 *
 * ГРАНИЦА ФИКСТУРЫ BOOK DOCTOR — ТРИ ВЕДРА (плана WP-9b):
 *   ведро 1 — ЗНАНИЕВЫЕ: полное покрытие (карточки, включая осиротевшую и
 *             bare-форменную; вхождения тегов в ОБЕИХ формах; проблемы разбора
 *             `entities/types.yaml`);
 *   ведро 2 — ФИКСТУРО-УПРАВЛЯЕМЫЕ незнаниевые: РОВНО ДВЕНАДЦАТЬ входов, каждый
 *             утверждается ПО РЕАЛЬНОЙ НАХОДКЕ (список ниже, `BUCKET_2_INPUTS`);
 *   ведро 3 — RPC-ЗАВИСИМЫЕ (`obsidianPlugin`, `transcription`): в герметичной
 *             фикстуре они могут быть ТОЛЬКО `undefined`, поэтому утверждение
 *             СТРУКТУРНОЕ — оно наблюдает, что `gather()` по-прежнему ПЕРЕДАЁТ
 *             эти поля в `assembleBookDoctorReport`.
 *
 * ЗАПУСК: файл живёт в изолированной дорожке `bun run test:widget`, а не в
 * `test:packages`, потому что импорт браузерных модулей Theia требует загрузочный
 * DOM-шим (Lumino трогает `document` на уровне модуля). Тот же приём и та же
 * причина, что у `welcome-widget.test.ts` / `semantic-link-contribution.test.ts`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/* ------------------------------------------------------------------------- */
/* Загрузочный DOM-шим (должен стоять ДО импорта браузерных модулей Theia)     */
/* ------------------------------------------------------------------------- */

const stubElement = (): Record<string, unknown> => {
  const node: any = {
    style: {},
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    dataset: {},
    children: [],
    setAttribute() {},
    getAttribute: () => null,
    removeAttribute() {},
    appendChild(child: unknown) { node.children.push(child); return child; },
    append(...items: unknown[]) { node.children.push(...items); },
    removeChild() {},
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    matches: () => false,
    remove() {},
    focus() {},
    blur() {},
    cloneNode: () => stubElement(),
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 })
  };
  return node;
};

const stubDocument: any = {
  createElement: stubElement,
  createElementNS: stubElement,
  createTextNode: (text: string) => ({ text }),
  createDocumentFragment: stubElement,
  body: stubElement(),
  head: stubElement(),
  documentElement: stubElement(),
  addEventListener() {},
  removeEventListener() {},
  querySelector: () => null,
  querySelectorAll: () => [],
  getElementById: () => null,
  queryCommandSupported: () => false,
  execCommand: () => false,
  hasFocus: () => false,
  getSelection: () => null,
  activeElement: null
};

const globals = globalThis as any;
globals.document = globals.document ?? stubDocument;
globals.window = globals.window ?? globalThis;
globals.location = globals.location ?? { href: 'http://localhost/' };
globals.navigator = globals.navigator ?? { userAgent: 'bun', platform: 'bun', language: 'en' };
globals.localStorage = globals.localStorage ?? { getItem: () => null, setItem() {}, removeItem() {}, clear() {} };
globals.getComputedStyle = globals.getComputedStyle ?? (() => ({ getPropertyValue: () => '' }));
globals.matchMedia = globals.matchMedia ?? (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
globals.MutationObserver = globals.MutationObserver ?? class { observe() {} disconnect() {} takeRecords() { return []; } };
globals.ResizeObserver = globals.ResizeObserver ?? class { observe() {} disconnect() {} unobserve() {} };
globals.requestAnimationFrame = globals.requestAnimationFrame ?? ((fn: () => void) => setTimeout(fn, 0) as unknown as number);
globals.cancelAnimationFrame = globals.cancelAnimationFrame ?? ((handle: number) => clearTimeout(handle));
for (const name of [
  'DragEvent', 'MouseEvent', 'KeyboardEvent', 'UIEvent', 'FocusEvent', 'WheelEvent', 'TouchEvent',
  'PointerEvent', 'CustomEvent', 'Event', 'InputEvent', 'ClipboardEvent', 'DataTransfer', 'DOMRect',
  'Range', 'Selection', 'Text', 'Document', 'DocumentFragment', 'HTMLElement', 'Element', 'Node',
  'HTMLDivElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLAnchorElement', 'HTMLIFrameElement',
  'HTMLImageElement', 'SVGElement', 'CSSStyleDeclaration', 'StorageEvent', 'MessageEvent'
]) {
  if (globals[name] === undefined) {
    globals[name] = class {};
  }
}

// `FrontendApplicationConfigProvider` — процессный синглтон, чей `.set()` бросает
// на втором вызове. Пробуем `.get()` прежде чем ставить, и убираем за собой
// ТОЛЬКО если ставили мы (тот же протокол, что в `semantic-link-contribution.test.ts`).
const { FrontendApplicationConfigProvider } =
  await import('@theia/core/lib/browser/frontend-application-config-provider');
let weSetTheFrontendConfig = false;
try {
  FrontendApplicationConfigProvider.get();
} catch {
  FrontendApplicationConfigProvider.set({ applicationName: 'test' } as never);
  weSetTheFrontendConfig = true;
}
afterAll(() => {
  if (!weSetTheFrontendConfig) {
    return;
  }
  const win = globals.window as Record<string | symbol, unknown>;
  for (const symbol of Object.getOwnPropertySymbols(win)) {
    if (symbol.description === 'FrontendApplicationConfigProvider') {
      delete win[symbol];
    }
  }
});

/* ------------------------------------------------------------------------- */
/* Импорты после шима                                                         */
/* ------------------------------------------------------------------------- */

const URI = (await import('@theia/core/lib/common/uri')).default;
type TheiaURI = InstanceType<typeof URI>;
const { FileUri } = await import('@theia/core/lib/common/file-uri');

const { NodeNarrativeGraphService } = await import('../node/node-narrative-graph-service');
const { NodeNarrativeEntityService } = await import('../node/node-domain-knowledge-service');
const { EntityCardsWidget } = await import('./entity-cards-widget');
const { ManuscriptFindEntitiesTool } = await import('./manuscript-tools-contribution');
const { BookDoctorContribution } = await import('./book-doctor-contribution');

import type { BookDoctorFinding, BookDoctorFix, BookDoctorReport } from '../common/book-doctor';
import type { NarrativeEntitySnapshot } from '../common/narrative-entity-protocol';

/* ------------------------------------------------------------------------- */
/* НОРМАЛИЗУЮЩИЙ АДАПТЕР                                                      */
/*                                                                            */
/* Плана WP-9b, «Как пишутся утверждения»: сравнивает СЕМАНТИЧЕСКОЕ СОДЕРЖАНИЕ; */
/* терпим к ДОБАВЛЕННЫМ полям, но НЕ к исчезновению или изменению ЗНАЧЕНИЙ;    */
/* терпимость к ПЕРЕИМЕНОВАНИЮ в G1 НЕ закладывается — она добавляется в WP-7  */
/* diff-ом с записанной причиной. Адаптер — ЕДИНСТВЕННОЕ место такой правки.   */
/* ------------------------------------------------------------------------- */

/** Маркер ожидания «ключа нет, либо он `undefined`». */
export const ABSENT = Symbol('wp9b.absent');

/**
 * Собрать список семантических расхождений между `actual` и `expected`.
 *
 * Правила (ровно те, что в плане):
 *  - примитивы сравниваются строго (`Object.is`);
 *  - МАССИВЫ сравниваются по длине И поэлементно: исчезнувший элемент — это
 *    исчезнувшее ЗНАЧЕНИЕ, а не добавленное поле, поэтому он ОБЯЗАН уронить
 *    сравнение; появившийся лишний элемент — тоже (иначе WP-7 смог бы тихо
 *    досыпать находок);
 *  - ОБЪЕКТЫ сравниваются как НАДМНОЖЕСТВО: каждый ключ из `expected` обязан
 *    быть в `actual` с тем же значением, а лишние ключи `actual` терпимы —
 *    это и есть «терпим к добавленным полям»;
 *  - `expected === undefined` или {@link ABSENT} требует, чтобы в `actual`
 *    ключа не было или он был `undefined`.
 */
export function semanticDiff(actual: unknown, expected: unknown, path = '$'): string[] {
  if (expected === ABSENT || expected === undefined) {
    return actual === undefined
      ? []
      : [`${path}: ожидалось отсутствие значения, получено ${render(actual)}`];
  }
  if (expected === null || typeof expected !== 'object') {
    return Object.is(actual, expected)
      ? []
      : [`${path}: ожидалось ${render(expected)}, получено ${render(actual)}`];
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      return [`${path}: ожидался массив, получено ${render(actual)}`];
    }
    if (actual.length !== expected.length) {
      return [
        `${path}: ожидалось ${expected.length} элемент(ов), получено ${actual.length}`
          + `\n  ожидалось: ${render(expected)}`
          + `\n  получено : ${render(actual)}`
      ];
    }
    const problems: string[] = [];
    for (let index = 0; index < expected.length; index++) {
      problems.push(...semanticDiff(actual[index], expected[index], `${path}[${index}]`));
    }
    return problems;
  }
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
    return [`${path}: ожидался объект, получено ${render(actual)}`];
  }
  const problems: string[] = [];
  for (const [key, value] of Object.entries(expected as Record<string, unknown>)) {
    problems.push(...semanticDiff(
      (actual as Record<string, unknown>)[key],
      value,
      `${path}.${key}`
    ));
  }
  return problems;
}

/** Утверждение через {@link semanticDiff}: падает с читаемым перечнем расхождений. */
export function expectSemantic(actual: unknown, expected: unknown, note?: string): void {
  const problems = semanticDiff(actual, expected);
  if (problems.length > 0) {
    throw new Error(
      `Семантическое расхождение${note ? ` (${note})` : ''}:\n  - ${problems.join('\n  - ')}`
    );
  }
}

function render(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/* ------------------------------------------------------------------------- */
/* Фикстура                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * СОБСТВЕННАЯ фикстура WP-9b, НЕ разделяемая с WP-9a (плана WP-9b). В ней
 * обязательно есть:
 *  - заведомо ОСИРОТЕВШАЯ карточка (`orphan-hero`);
 *  - карточка, единственная ссылка на которую — BARE-ФОРМА без двоеточия
 *    (`gandiva` ← `[[gandiva]]`): она ОБЯЗАНА НЕ попасть в осиротевшие
 *    (регрессия TASK-013 U-B, `book-doctor-contribution.ts:575-592`);
 *  - BARE-ФОРМЕННАЯ ссылка на id, У КОТОРОГО КАРТОЧКИ НЕТ (`[[sharan-108]]`):
 *    она ОБЯЗАНА НЕ породить предложение «создать недостающую карточку».
 */
async function seedBaselineRoot(root: string): Promise<void> {
  await write(root, 'manifest.yaml', [
    'version: 1',
    'content:',
    '  - path: content/ch1.md',
    '    title: Chapter One',
    '  - path: content/part-1',
    '    title: Part One',
    '    children:',
    '      - path: content/part-1/ch2.md',
    '        title: Chapter Two',
    '  - path: content/ch-missing.md',
    '    title: Lost Chapter',
    '  - path: content/notes.md',
    '    title: Draft Notes',
    '    include: false',
    ''
  ].join('\n'));

  // metadata.yaml СУЩЕСТВУЕТ с пустыми полями -> вход `metadata` ведра 2.
  await write(root, 'metadata.yaml', 'title: ""\nauthor: ""\n');

  await write(root, 'content/ch1.md', [
    '# Chapter One',
    '',
    '[[char:krishna|Krishna]] and [[char:arjuna|Arjuna]] stand together.',
    '[[char:krishna|Krishna]] lifts [[gandiva]] once more.',
    // gh#66: кириллический ВИД ТЕГА. Из ПРОЗЫ он извлекается (Unicode-осведомлённый
    // `parseSemanticMarkdown`), из ТЕЛА КАРТОЧКИ — нет (ASCII-only `entity-mentions`).
    '[[персонаж:krishna|Кришна]] speaks in the mother tongue.',
    ''
  ].join('\n'));

  await write(root, 'content/part-1/ch2.md', [
    '# Chapter Two',
    '',
    '[[char:krishna|Krishna]] teaches [[char:arjuna|Arjuna]] about [[term:dharma|dharma]].',
    '[[spell:fireball|Fireball]] is forbidden lore.',
    '[[sloka:bg-2-47|BG 2.47]] is quoted here.',
    'A colon-less bare reference with no card: [[sharan-108]].',
    ''
  ].join('\n'));

  await write(root, 'content/notes.md', [
    '# Notes',
    '',
    'Check [[char:krishna|Krishna]] epithets.',
    ''
  ].join('\n'));

  // Глава ВНЕ манифеста -> вход `manuscriptCandidates` ведра 2 (manifest-append).
  await write(root, 'content/stray.md', [
    '# Stray Chapter',
    '',
    '[[char:arjuna|Arjuna]] wanders off the manifest.',
    ''
  ].join('\n'));

  // `entities/types.yaml`: один ВАЛИДНЫЙ авторский тип + один отвергаемый
  // (коллизия со встроенным) -> `entityTypeProblems` ведра 1.
  await write(root, 'entities/types.yaml', [
    'types:',
    '  - id: sloka',
    '    label: Sloka',
    '    directory: slokas',
    '  - id: character',
    '    label: Shadowing Built-in',
    ''
  ].join('\n'));

  await write(root, 'entities/characters/krishna.yaml', [
    'id: krishna',
    'name: Krishna',
    'aliases:',
    '  - Govinda',
    '  - Keshava',
    'epithets:',
    '  - Хранитель',
    'summary: Charioteer of [[char:arjuna|Arjuna]].',
    // Три упоминания в теле карточки: ASCII-разрешимое, ASCII-НЕразрешимое
    // (нет такой карточки) и КИРИЛЛИЧЕСКОГО вида (gh#66 — невидимо для
    // ASCII-only `entity-mentions`, поэтому остаётся простым текстом).
    'backstory: >-',
    '  Speaks to [[char:arjuna|Arjuna]], recalls [[no-such-entity]],',
    '  and is named [[персонаж:krishna|Кришна]] at home.',
    'arc: From charioteer to teacher.',
    'speechPatterns:',
    '  - Calm imperative',
    'notes: Draft notes.',
    ''
  ].join('\n'));

  await write(root, 'entities/characters/arjuna.yaml', 'id: arjuna\nname: Arjuna\n');
  // ОСИРОТЕВШАЯ карточка: ни одна ссылка на неё не ведёт.
  await write(root, 'entities/characters/orphan-hero.yaml', 'id: orphan-hero\nname: Orphan Hero\n');
  await write(root, 'entities/terms/dharma.yaml', 'term: Dharma\n');
  // Карточка, единственная ссылка на которую — BARE-форма `[[gandiva]]`.
  await write(root, 'entities/artifacts/gandiva.yaml', [
    'id: gandiva',
    'name: Gandiva',
    'ownership:',
    '  - owner: varuna',
    '    to: the age of gods',
    '    note: guards the bow',
    '  - owner: arjuna',
    '    from: the great war',
    '    note: wields it in battle',
    ''
  ].join('\n'));
  await fs.mkdir(join(root, 'entities/locations'), { recursive: true });

  // Сломанные источники -> входы `citationsContent` / `excerptsContent` ведра 2.
  await write(root, 'sources/citations.yaml', 'citations:\n  - id: one\n   title: bad indent\n');
  await write(root, 'sources/excerpts.jsonl', '{"id":"ok"}\nnot json at all\n');

  // Legacy AI-настройки -> вход `workspaceSettings` ведра 2.
  await write(root, '.theia/settings.json', JSON.stringify({
    'aiFocusedEditor.ai.apiKeys': { groq: 'x' },
    'aiFocusedEditor.ai.activeAlias': 'fast'
  }, undefined, 2));

  // `.gitignore` НЕ покрывает `.theia/` -> вход `transcriptionSecret` ведра 2
  // срабатывает (при застабленном `preferences.inspect`).
  await write(root, '.gitignore', 'build/\n');
}

async function write(root: string, relative: string, content: string): Promise<void> {
  const path = join(root, relative);
  await fs.mkdir(join(path, '..'), { recursive: true });
  await fs.writeFile(path, content);
}

const scratchBase = process.env.CLAUDE_SCRATCHPAD_DIR ?? tmpdir();

async function makeRoot(prefix: string): Promise<string> {
  await fs.mkdir(scratchBase, { recursive: true });
  return fs.mkdtemp(join(scratchBase, prefix));
}

/** Каталоги, созданные тестами; удаляются в `afterAll`. */
const createdRoots: string[] = [];

async function newBaselineRoot(): Promise<string> {
  const root = await makeRoot('wp9b-baseline-');
  createdRoots.push(root);
  await seedBaselineRoot(root);
  return root;
}

afterAll(async () => {
  await Promise.all(createdRoots.map(root => fs.rm(root, { recursive: true, force: true })));
});

/* ------------------------------------------------------------------------- */
/* Тесты адаптера                                                             */
/* ------------------------------------------------------------------------- */

describe('WP-9b — нормализующий адаптер', () => {
  test('терпим к ДОБАВЛЕННЫМ полям объекта', () => {
    expect(semanticDiff({ a: 1, b: 2 }, { a: 1 })).toEqual([]);
  });

  test('НЕ терпим к исчезнувшему полю', () => {
    expect(semanticDiff({ a: 1 }, { a: 1, b: 2 })).toHaveLength(1);
  });

  test('НЕ терпим к изменившемуся ЗНАЧЕНИЮ', () => {
    expect(semanticDiff({ a: 1 }, { a: 2 })).toHaveLength(1);
  });

  test('НЕ терпим к ПЕРЕИМЕНОВАНИЮ поля (терпимость добавляется только в WP-7)', () => {
    // `label` -> `title` в G1 обязано уронить сравнение.
    expect(semanticDiff({ title: 'Krishna' }, { label: 'Krishna' })).toHaveLength(1);
  });

  test('массив: исчезнувший элемент роняет сравнение', () => {
    expect(semanticDiff([1, 2], [1, 2, 3])).toHaveLength(1);
  });

  test('массив: ДОБАВЛЕННЫЙ элемент тоже роняет сравнение', () => {
    expect(semanticDiff([1, 2, 3], [1, 2])).toHaveLength(1);
  });

  test('вложенность: расхождение сообщается с путём', () => {
    const [problem] = semanticDiff({ a: [{ b: 1 }] }, { a: [{ b: 2 }] });
    expect(problem).toContain('$.a[0].b');
  });

  test('ABSENT требует отсутствия значения', () => {
    expect(semanticDiff({}, { gone: ABSENT })).toEqual([]);
    expect(semanticDiff({ gone: 1 }, { gone: ABSENT })).toHaveLength(1);
  });

  test('expectSemantic бросает с читаемым текстом', () => {
    expect(() => expectSemantic({ a: 1 }, { a: 2 }, 'проба')).toThrow(/проба/);
    expect(() => expectSemantic({ a: 1 }, { a: 1 })).not.toThrow();
  });
});

/* ------------------------------------------------------------------------- */
/* Потребитель 1 — Narrative Map                                              */
/* ------------------------------------------------------------------------- */

describe('WP-9b базовая линия — Narrative Map (снимок графа)', () => {
  let root: string;
  let snapshot: Awaited<ReturnType<InstanceType<typeof NodeNarrativeGraphService>['getSnapshot']>>;

  beforeAll(async () => {
    root = await newBaselineRoot();
    snapshot = await new NodeNarrativeGraphService().getSnapshot(root);
  });

  test('таймлайн: порядок манифеста, заголовки, buildIncluded, пропуск отсутствующей главы', () => {
    expectSemantic(
      snapshot.timeline.map(chapter => ({
        path: chapter.path,
        title: chapter.title,
        order: chapter.order,
        buildIncluded: chapter.buildIncluded
      })),
      [
        { path: 'content/ch1.md', title: 'Chapter One', order: 0, buildIncluded: true },
        { path: 'content/part-1/ch2.md', title: 'Chapter Two', order: 1, buildIncluded: true },
        // `content/ch-missing.md` (order 2) в манифесте есть, на диске нет —
        // глава ПРОПУСКАЕТСЯ, а не вставляется пустой; вместо неё диагностика.
        { path: 'content/notes.md', title: 'Draft Notes', order: 3, buildIncluded: false }
      ],
      'таймлайн Narrative Map'
    );
    // `content/stray.md` на диске есть, но манифест его не называет — карта его НЕ видит.
    expect(snapshot.timeline.some(chapter => chapter.path === 'content/stray.md')).toBe(false);
  });

  test('отсутствующая глава манифеста даёт warning-диагностику, а не падение', () => {
    const warning = snapshot.diagnostics.find(diagnostic =>
      diagnostic.message.includes('Skipping missing chapter file: content/ch-missing.md'));
    expectSemantic(
      warning && { severity: warning.severity, source: warning.source },
      { severity: 'warning', source: 'narrative-graph' },
      'диагностика пропущенной главы'
    );
  });

  test('вхождения главы: kind сворачивается на канонический, label берётся из карточки', () => {
    expectSemantic(
      snapshot.timeline[0].entities,
      [
        // Сортировка: count desc, затем label.localeCompare.
        { kind: 'character', id: 'krishna', label: 'Krishna', count: 2 },
        { kind: 'character', id: 'arjuna', label: 'Arjuna', count: 1 },
        // gh#66: кириллический ВИД ТЕГА из ПРОЗЫ извлекается. `персонаж` не
        // сворачивается на `character` (в TAG_KIND_TO_ENTITY_KIND его нет),
        // поэтому это ОТДЕЛЬНЫЙ узел, а label берётся из самого тега.
        { kind: 'персонаж', id: 'krishna', label: 'Кришна', count: 1 }
      ],
      'вхождения content/ch1.md'
    );
    // `[[gandiva]]` — bare-форма БЕЗ `|label`; `parseSemanticMarkdown` её не
    // видит, поэтому в карте её нет. Это шов, который WP-7 обязан сохранить.
    expect(snapshot.timeline[0].entities.some(entity => entity.id === 'gandiva')).toBe(false);
  });

  test('узлы ранжируются по суммарным появлениям', () => {
    expectSemantic(
      snapshot.nodes.map(node => ({ id: node.id, kind: node.kind, entityId: node.entityId, label: node.label, appearances: node.appearances })),
      [
        { id: 'character:krishna', kind: 'character', entityId: 'krishna', label: 'Krishna', appearances: 4 },
        { id: 'character:arjuna', kind: 'character', entityId: 'arjuna', label: 'Arjuna', appearances: 2 },
        // Равные appearances разводит label.localeCompare:
        // 'BG 2.47' < 'Dharma' < 'Fireball' < 'Кришна'.
        { id: 'sloka:bg-2-47', kind: 'sloka', entityId: 'bg-2-47', label: 'BG 2.47', appearances: 1 },
        { id: 'term:dharma', kind: 'term', entityId: 'dharma', label: 'Dharma', appearances: 1 },
        { id: 'spell:fireball', kind: 'spell', entityId: 'fireball', label: 'Fireball', appearances: 1 },
        { id: 'персонаж:krishna', kind: 'персонаж', entityId: 'krishna', label: 'Кришна', appearances: 1 }
      ],
      'узлы графа'
    );
    expectSemantic(
      { totalEntities: snapshot.totalEntities, truncated: snapshot.truncated },
      { totalEntities: 6, truncated: false }
    );
  });

  test('рёбра co-occurrence взвешены общими главами', () => {
    expectSemantic(
      snapshot.relations.map(edge => ({
        source: edge.source,
        target: edge.target,
        weight: edge.weight,
        sharedChapters: edge.sharedChapters
      })),
      [
        // Сортировка: weight desc, затем sourceLabel.localeCompare, затем
        // targetLabel.localeCompare. Метки: Arjuna, BG 2.47, Dharma, Fireball,
        // Krishna, Кириллическая «Кришна» — отсюда именно этот порядок.
        { source: 'character:arjuna', target: 'character:krishna', weight: 2, sharedChapters: ['0', '1'] },
        { source: 'character:arjuna', target: 'sloka:bg-2-47', weight: 1, sharedChapters: ['1'] },
        { source: 'character:arjuna', target: 'term:dharma', weight: 1, sharedChapters: ['1'] },
        { source: 'character:arjuna', target: 'spell:fireball', weight: 1, sharedChapters: ['1'] },
        { source: 'character:arjuna', target: 'персонаж:krishna', weight: 1, sharedChapters: ['0'] },
        { source: 'sloka:bg-2-47', target: 'term:dharma', weight: 1, sharedChapters: ['1'] },
        { source: 'sloka:bg-2-47', target: 'spell:fireball', weight: 1, sharedChapters: ['1'] },
        { source: 'spell:fireball', target: 'term:dharma', weight: 1, sharedChapters: ['1'] },
        { source: 'character:krishna', target: 'sloka:bg-2-47', weight: 1, sharedChapters: ['1'] },
        { source: 'character:krishna', target: 'term:dharma', weight: 1, sharedChapters: ['1'] },
        { source: 'character:krishna', target: 'spell:fireball', weight: 1, sharedChapters: ['1'] },
        { source: 'character:krishna', target: 'персонаж:krishna', weight: 1, sharedChapters: ['0'] }
      ],
      'рёбра графа'
    );
  });

  test('цепочки владения читаются с разрешением метки владельца', () => {
    expectSemantic(
      snapshot.ownership,
      [{
        artifactId: 'gandiva',
        artifactLabel: 'Gandiva',
        path: 'entities/artifacts/gandiva.yaml',
        entries: [
          // `varuna` карточки не имеет -> метка падает на сырой id.
          { owner: 'varuna', ownerLabel: 'varuna', to: 'the age of gods', note: 'guards the bow' },
          { owner: 'arjuna', ownerLabel: 'Arjuna', from: 'the great war', note: 'wields it in battle' }
        ]
      }],
      'цепочки владения'
    );
  });
});

/* ------------------------------------------------------------------------- */
/* Потребитель 2 — Entity Cards                                               */
/* ------------------------------------------------------------------------- */

/** Собрать из React-дерева карточки плоский список текстов и mention-span'ов. */
interface RenderedNode {
  className?: string;
  title?: string;
  text: string;
}

function collectRendered(node: unknown, out: RenderedNode[]): void {
  if (node === null || node === undefined || node === false) {
    return;
  }
  if (typeof node === 'string' || typeof node === 'number') {
    out.push({ text: String(node) });
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      collectRendered(child, out);
    }
    return;
  }
  const element = node as { props?: Record<string, unknown> };
  const props = element.props ?? {};
  const className = typeof props.className === 'string' ? props.className : undefined;
  if (className && className.startsWith('afe-entity-mention')) {
    const parts: RenderedNode[] = [];
    collectRendered(props.children, parts);
    out.push({
      className,
      title: typeof props.title === 'string' ? props.title : undefined,
      text: parts.map(part => part.text).join('')
    });
    return;
  }
  collectRendered(props.children, out);
}

describe('WP-9b базовая линия — Entity Cards (содержимое карточки)', () => {
  let root: string;
  let snapshot: NarrativeEntitySnapshot;

  beforeAll(async () => {
    root = await newBaselineRoot();
    snapshot = await new NodeNarrativeEntityService().getSnapshot(root);
  });

  test('карточки читаются по ЭФФЕКТИВНЫМ типам, в порядке тип → имя файла', () => {
    expectSemantic(
      snapshot.entities.map(entity => ({ kind: entity.kind, id: entity.id, label: entity.label, path: entity.path })),
      [
        { kind: 'character', id: 'arjuna', label: 'Arjuna', path: 'entities/characters/arjuna.yaml' },
        { kind: 'character', id: 'krishna', label: 'Krishna', path: 'entities/characters/krishna.yaml' },
        { kind: 'character', id: 'orphan-hero', label: 'Orphan Hero', path: 'entities/characters/orphan-hero.yaml' },
        // `dharma.yaml` не несёт `id` -> id берётся из ИМЕНИ ФАЙЛА, метка — из `term`.
        { kind: 'term', id: 'dharma', label: 'Dharma', path: 'entities/terms/dharma.yaml' },
        { kind: 'artifact', id: 'gandiva', label: 'Gandiva', path: 'entities/artifacts/gandiva.yaml' }
      ],
      'состав и порядок карточек'
    );
  });

  test('полное содержимое одной карточки, включая пустые строки вместо undefined', () => {
    const krishna = snapshot.entities.find(entity => entity.id === 'krishna' && entity.kind === 'character');
    expectSemantic(
      krishna,
      {
        kind: 'character',
        id: 'krishna',
        label: 'Krishna',
        path: 'entities/characters/krishna.yaml',
        uri: FileUri.create(join(root, 'entities/characters/krishna.yaml')).toString(),
        summary: 'Charioteer of [[char:arjuna|Arjuna]].',
        aliases: ['Govinda', 'Keshava'],
        epithets: ['Хранитель'],
        backstory: 'Speaks to [[char:arjuna|Arjuna]], recalls [[no-such-entity]], and is named [[персонаж:krishna|Кришна]] at home.',
        arc: 'From charioteer to teacher.',
        speechPatterns: ['Calm imperative'],
        notes: 'Draft notes.'
      },
      'карточка krishna'
    );
    // Отсутствующее поле становится ПУСТОЙ СТРОКОЙ, а не `undefined`, —
    // наблюдаемая деталь, на которую опирается отрисовка (`entity.summary ? …`).
    const arjuna = snapshot.entities.find(entity => entity.id === 'arjuna');
    expectSemantic(
      arjuna,
      { summary: '', backstory: '', arc: '', notes: '', aliases: [], epithets: [], speechPatterns: [] },
      'пустые поля карточки arjuna'
    );
  });

  test('эффективные типы и проблемы разбора types.yaml доезжают до снимка', () => {
    expectSemantic(
      snapshot.effectiveEntityTypes?.map(type => ({ id: type.id, tagKind: type.tagKind, directory: type.directory, origin: type.origin })),
      [
        { id: 'character', tagKind: 'char', directory: 'characters', origin: 'built-in' },
        { id: 'term', tagKind: 'term', directory: 'terms', origin: 'built-in' },
        { id: 'artifact', tagKind: 'artifact', directory: 'artifacts', origin: 'built-in' },
        { id: 'location', tagKind: 'location', directory: 'locations', origin: 'built-in' },
        { id: 'sloka', tagKind: 'sloka', directory: 'slokas', origin: 'book' }
      ],
      'эффективные типы'
    );
    expectSemantic(
      snapshot.typeProblems?.map(problem => ({ code: problem.code, id: problem.id })),
      [{ code: 'reserved-id', id: 'character' }],
      'проблемы types.yaml'
    );
    // Отсутствующий каталог авторского типа даёт info-диагностику, а не ошибку.
    expect(snapshot.diagnostics.some(diagnostic =>
      diagnostic.message === 'No sloka entity directory found at entities/slokas/.')).toBe(true);
  });

  test('ОТРИСОВКА упоминаний в карточке: что кликабельно, а что нет (gh#66)', () => {
    // Виджет строится через прототип: конструктор `ReactWidget` создаёт
    // react-dom root на настоящем DOM-узле, которого в bun нет. Отрисовка
    // (`render`/`renderMentionText`/`buildMentionIndex`/`resolveMention`) —
    // настоящая, это и есть предмет характеризации.
    const widget: any = Object.create(EntityCardsWidget.prototype);
    widget.snapshot = snapshot;
    widget.mentionIndex = new Map();
    const rendered: RenderedNode[] = [];
    collectRendered(widget.render(), rendered);

    const mentions = rendered
      .filter(node => node.className?.startsWith('afe-entity-mention'))
      .map(node => ({ className: node.className, text: node.text }));

    expectSemantic(
      mentions,
      [
        // summary карточки krishna
        { className: 'afe-entity-mention', text: 'Arjuna' },
        // arc — упоминаний нет; backstory:
        { className: 'afe-entity-mention', text: 'Arjuna' },
        // `[[no-such-entity]]` — bare-форма, карточки нет -> НЕразрешённое упоминание.
        { className: 'afe-entity-mention unknown', text: 'no-such-entity' },
        // `[[персонаж:krishna|Кришна]]` СЮДА НЕ ПОПАДАЕТ: `entity-mentions`
        // ASCII-only (`[a-z][\w-]*`), поэтому в теле карточки кириллический вид
        // тега — просто текст. Это gh#66, зафиксировано КАК ЕСТЬ, а не одобрено.
      ],
      'кликабельные упоминания в карточках'
    );

    // Вторая половина того же факта: кириллический тег остался ПРОСТЫМ ТЕКСТОМ.
    const plainText = rendered.filter(node => !node.className).map(node => node.text).join('');
    expect(plainText).toContain('[[персонаж:krishna|Кришна]]');
  });
});

/* ------------------------------------------------------------------------- */
/* Потребитель 3 — manuscript_find_entities                                   */
/* ------------------------------------------------------------------------- */

describe('WP-9b базовая линия — manuscript_find_entities', () => {
  let root: string;
  let handler: (argString: string) => Promise<unknown>;
  let tool: InstanceType<typeof ManuscriptFindEntitiesTool>;

  beforeAll(async () => {
    root = await newBaselineRoot();
    const backend = new NodeNarrativeEntityService();
    tool = new ManuscriptFindEntitiesTool();
    (tool as any).entities = {
      getSnapshot: () => backend.getSnapshot(root),
      refresh: () => backend.getSnapshot(root)
    };
    const request = tool.getTool();
    handler = (argString: string) => Promise.resolve(request.handler!(argString, {} as never));
  });

  const parse = async (argString: string): Promise<unknown[]> =>
    JSON.parse(String(await handler(argString)));

  test('дескриптор инструмента: id и форма параметров', () => {
    const request = tool.getTool();
    expectSemantic(
      { id: request.id, parameters: request.parameters },
      {
        id: 'manuscript_find_entities',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            kind: { type: 'string' }
          },
          required: []
        }
      },
      'дескриптор manuscript_find_entities'
    );
  });

  test('пустой запрос возвращает ВСЕ карточки в порядке снимка и с УЗКИМ набором полей', async () => {
    const all = await parse('{}');
    expectSemantic(
      all,
      [
        { kind: 'character', id: 'arjuna', label: 'Arjuna', aliases: [], epithets: [], summary: '', arc: '' },
        {
          kind: 'character',
          id: 'krishna',
          label: 'Krishna',
          aliases: ['Govinda', 'Keshava'],
          epithets: ['Хранитель'],
          summary: 'Charioteer of [[char:arjuna|Arjuna]].',
          arc: 'From charioteer to teacher.'
        },
        { kind: 'character', id: 'orphan-hero', label: 'Orphan Hero', aliases: [], epithets: [], summary: '', arc: '' },
        { kind: 'term', id: 'dharma', label: 'Dharma', aliases: [], epithets: [], summary: '', arc: '' },
        { kind: 'artifact', id: 'gandiva', label: 'Gandiva', aliases: [], epithets: [], summary: '', arc: '' }
      ],
      'ответ на пустой запрос'
    );
    // Выдача НАМЕРЕННО уже карточки: ни backstory, ни notes, ни speechPatterns,
    // ни path/uri наружу не идут. Исчезновение этой границы — изменение контракта.
    expectSemantic(
      all[1],
      { backstory: ABSENT, notes: ABSENT, speechPatterns: ABSENT, path: ABSENT, uri: ABSENT },
      'поля, которых в ответе быть не должно'
    );
  });

  test('query ищет по id, метке, псевдонимам и эпитетам, без учёта регистра', async () => {
    expectSemantic((await parse('{"query":"govinda"}')).map((entity: any) => entity.id), ['krishna']);
    expectSemantic((await parse('{"query":"Хранитель"}')).map((entity: any) => entity.id), ['krishna']);
    expectSemantic((await parse('{"query":"ORPHAN"}')).map((entity: any) => entity.id), ['orphan-hero']);
    // Поиск НЕ смотрит в summary/arc — только id/label/aliases/epithets.
    expectSemantic(await parse('{"query":"charioteer"}'), []);
  });

  test('kind фильтрует по ТОЧНОМУ id типа, а не по виду тега', async () => {
    expectSemantic(
      (await parse('{"kind":"character"}')).map((entity: any) => entity.id),
      ['arjuna', 'krishna', 'orphan-hero']
    );
    // `char` — ВИД ТЕГА, а не id типа; фильтр по нему не находит ничего.
    expectSemantic(await parse('{"kind":"char"}'), []);
  });

  test('нераспарсенный argString трактуется как СТРОКА ЗАПРОСА', async () => {
    expectSemantic((await parse('gandiva')).map((entity: any) => entity.id), ['gandiva']);
  });
});

/* ------------------------------------------------------------------------- */
/* Потребитель 4 — Book Doctor                                                */
/* ------------------------------------------------------------------------- */

/**
 * ВЕДРО 2 плана WP-9b — РОВНО ДВЕНАДЦАТЬ фикстуро-управляемых незнаниевых
 * входов `gather()`, каждый утверждается ПО РЕАЛЬНОЙ НАХОДКЕ. Список обязан
 * ПОИМЁННО совпасть со списком проверки № 3 WP-7 (F-P8-2).
 */
const BUCKET_2_INPUTS = [
  'scaffoldEntries',
  'exists',
  'contentHasMarkdown',
  'manifestExists',
  'manifestRows',
  'manuscriptCandidates',
  'folderName',
  'metadata',
  'citationsContent',
  'excerptsContent',
  'workspaceSettings',
  'transcriptionSecret'
] as const;

/** ВЕДРО 3 — RPC-зависимые входы; в герметичной фикстуре только `undefined`. */
const BUCKET_3_INPUTS = ['obsidianPlugin', 'transcription'] as const;

/** Node-fs-backed заглушка `FileService`: ровно те методы, что трогает `gather()`. */
class FixtureFileService {
  async exists(uri: TheiaURI): Promise<boolean> {
    try {
      await fs.stat(FileUri.fsPath(uri.toString()));
      return true;
    } catch {
      return false;
    }
  }

  async read(uri: TheiaURI): Promise<{ value: string }> {
    return { value: await fs.readFile(FileUri.fsPath(uri.toString()), 'utf8') };
  }

  async resolve(uri: TheiaURI): Promise<{ children: { isDirectory: boolean; isFile: boolean; resource: TheiaURI }[] }> {
    const entries = await fs.readdir(FileUri.fsPath(uri.toString()), { withFileTypes: true });
    return {
      children: entries
        .map(entry => ({
          isDirectory: entry.isDirectory(),
          isFile: entry.isFile(),
          resource: uri.resolve(entry.name)
        }))
        .sort((left, right) => left.resource.path.base.localeCompare(right.resource.path.base))
    };
  }
}

interface DoctorOverrides {
  /** Застабленный `preferences.inspect` для секретной гигиены. */
  groqApiKeyWorkspaceValue?: string;
  /** Ведро 3: подставной вход Obsidian-плагина (трассер для наблюдения аргумента). */
  obsidianPlugin?: unknown;
  /** Ведро 3: подставной вход транскрипции (трассер для наблюдения аргумента). */
  transcription?: unknown;
}

/** Счётчик вызовов фидеров ведра 3 — доказывает, что они всё ещё ВЫЗЫВАЮТСЯ. */
interface FeederCalls {
  obsidianPlugin: number;
  transcription: number;
}

function makeDoctor(overrides: DoctorOverrides = {}): {
  gather: (rootUri: string) => Promise<BookDoctorReport>;
  calls: FeederCalls;
} {
  const calls: FeederCalls = { obsidianPlugin: 0, transcription: 0 };
  const doctor: any = new BookDoctorContribution();
  doctor.fileService = new FixtureFileService();
  doctor.preferences = {
    get: (_key: string, fallback?: unknown) => fallback,
    inspect: () => ({
      preferenceName: 'mediaTranscription.groqApiKey',
      defaultValue: undefined,
      globalValue: undefined,
      workspaceValue: overrides.groqApiKeyWorkspaceValue,
      workspaceFolderValue: undefined
    })
  };
  // Герметичная фикстура: бэкенд-сервисы недоступны. Возвращаем ровно то, что
  // недоступный бэкенд даёт сегодня, и считаем вызовы.
  doctor.obsidianPlugin = { getStatus: async () => { throw new Error('backend unavailable'); } };
  doctor.transcriptSets = { list: async () => [] };
  doctor.audioConversion = { doctor: async () => undefined };

  const originalObsidian = doctor.gatherObsidianPluginInput.bind(doctor);
  doctor.gatherObsidianPluginInput = async (rootUri: string) => {
    calls.obsidianPlugin += 1;
    return 'obsidianPlugin' in overrides ? overrides.obsidianPlugin : originalObsidian(rootUri);
  };
  const originalTranscription = doctor.gatherTranscriptionInput.bind(doctor);
  doctor.gatherTranscriptionInput = async (rootUri: TheiaURI, raw: string) => {
    calls.transcription += 1;
    return 'transcription' in overrides ? overrides.transcription : originalTranscription(rootUri, raw);
  };

  return { gather: (rootUri: string) => doctor.gather(rootUri), calls };
}

const codes = (items: readonly (BookDoctorFix | BookDoctorFinding)[]): (string | undefined)[] =>
  items.map(item => item.code);

const byCode = <T extends BookDoctorFix | BookDoctorFinding>(items: readonly T[], code: string): T[] =>
  items.filter(item => item.code === code);

describe('WP-9b базовая линия — Book Doctor (набор находок)', () => {
  let root: string;
  let report: BookDoctorReport;

  beforeAll(async () => {
    root = await newBaselineRoot();
    const { gather } = makeDoctor({ groqApiKeyWorkspaceValue: 'gsk_fixture_secret' });
    report = await gather(FileUri.create(root).toString());
  });

  /* ---------------- ведро 1 — знаниевые входы, ПОЛНОЕ покрытие ------------ */

  test('ведро 1: вхождения тегов в ОБЕИХ формах порождают карточные предложения', () => {
    expectSemantic(
      byCode(report.fixes, 'entity-card-missing').map(fix => ({ path: fix.path, params: fix.params })),
      [
        // Авторский тип `sloka` из `entities/types.yaml` — ЗНАЕТСЯ проверками.
        { path: 'entities/slokas/bg-2-47.yaml', params: ['Sloka', 'BG 2.47', 1, 'content/part-1/ch2.md'] }
      ],
      'предложения создать карточку'
    );
  });

  test('ведро 1: осиротевшая карточка найдена, а bare-форменная — НЕ осиротевшая', () => {
    expectSemantic(
      byCode(report.findings, 'entity-card-orphan').map(finding => finding.params),
      [['Character', 'orphan-hero', 'entities/characters/orphan-hero.yaml']],
      'осиротевшие карточки'
    );
    // Регрессия TASK-013 U-B: `gandiva` упомянут ТОЛЬКО как `[[gandiva]]`
    // (bare, без двоеточия). Он ОБЯЗАН НЕ считаться осиротевшим.
    const orphanIds = byCode(report.findings, 'entity-card-orphan').map(finding => finding.params?.[1]);
    expect(orphanIds).not.toContain('gandiva');
  });

  test('ведро 1: bare-ссылка на НЕСУЩЕСТВУЮЩИЙ id не предлагает создать карточку', () => {
    // `[[sharan-108]]` свёрнут как occurrence с kind === undefined. Карточку из
    // него материализовать нельзя — вторая половина правила 3 контракта `kind`.
    const missingPaths = byCode(report.fixes, 'entity-card-missing').map(fix => fix.path);
    expect(missingPaths.some(path => path.includes('sharan-108'))).toBe(false);
    expect(byCode(report.findings, 'entity-tag-unknown-kind').map(finding => finding.params?.[0]))
      .not.toContain('sharan-108');
  });

  test('ведро 1: неизвестный ВИД ТЕГА даёт находку; кириллический — НЕТ (gh#66)', () => {
    expectSemantic(
      byCode(report.findings, 'entity-tag-unknown-kind').map(finding => finding.params),
      [['spell', 1, 1]],
      'неизвестные виды тега'
    );
    // `персонаж` СВЁРНУТ во вхождения (Unicode-осведомлённый разбор прозы), но
    // `entityUnknownKindFindings` пропускает его через ASCII-фильтр
    // `/^[a-z][\w-]*$/` (`book-doctor.ts`), поэтому он НЕ ВИДЕН НИГДЕ в отчёте:
    // ни как неизвестный вид, ни как предложение создать карточку. Это третья
    // ASCII-only точка того же расхождения — зафиксирована, а не исправлена.
    const unknownKinds = byCode(report.findings, 'entity-tag-unknown-kind').map(finding => finding.params?.[0]);
    expect(unknownKinds).not.toContain('персонаж');
    expect(byCode(report.fixes, 'entity-card-missing').map(fix => fix.path).join('|'))
      .not.toContain('персонаж');
  });

  test('ведро 1: проблемы разбора entities/types.yaml выходят находками', () => {
    expectSemantic(
      byCode(report.findings, 'entity-type-problem').map(finding => finding.params?.[0]),
      ['character'],
      'проблемы types.yaml'
    );
  });

  /* ---------------- ведро 2 — ДВЕНАДЦАТЬ входов по РЕАЛЬНОЙ НАХОДКЕ ------- */

  test('ведро 2 (1) scaffoldEntries + (2) exists: отсутствующие пути дают fix, существующие — нет', () => {
    const folders = byCode(report.fixes, 'create-folder').map(fix => fix.path);
    expectSemantic(
      folders,
      [
        'knowledge',
        'knowledge/plans',
        'knowledge/questions',
        'knowledge/summaries',
        'ai',
        'ai/prompts',
        '.prompts',
        '.prompts/skills',
        '.prompts/skills/style-guide'
        // `proofreading`, `sources/audio`, `transcription` в списке ОТСУТСТВУЮТ,
        // хотя на диске их нет: это NEW_BOOK_ONLY-записи, подавляемые входом
        // `contentHasMarkdown` (см. отдельный тест ниже).
      ],
      'создаваемые каталоги'
    );
    // ОТВЕРГАЮЩАЯ половина `exists`: каталоги, которые ЕСТЬ, в списке отсутствуют.
    for (const present of ['content', 'entities', 'entities/characters', 'sources']) {
      expect(folders).not.toContain(present);
    }
    // И то же для файлов: `sources/citations.yaml` на диске есть -> предложения нет.
    const files = byCode(report.fixes, 'create-file').map(fix => fix.path);
    expect(files).not.toContain('sources/citations.yaml');
    expectSemantic(files, ['ai/prompts/custom-modes.yaml', '.prompts/skills/style-guide/SKILL.md'], 'создаваемые файлы');
  });

  test('ведро 2 (3) contentHasMarkdown: НОВОКНИЖНЫЕ записи не навязываются заведённой книге', () => {
    // ЧЕТЫРЕ NEW_BOOK_ONLY-записи (`book-scaffold.ts` NEW_BOOK_ONLY_PATHS) есть в
    // scaffold и отсутствуют на диске, но `content/` уже содержит Markdown ->
    // предложения ПОДАВЛЕНЫ. Отвергающий случай — тест ниже с пустым `content/`.
    const paths = report.fixes.map(fix => fix.path);
    for (const suppressed of ['content/chapter-01.md', 'proofreading', 'sources/audio', 'transcription']) {
      expect(paths).not.toContain(suppressed);
    }
  });

  test('ведро 2 (3) ОТВЕРГАЮЩИЙ случай: без Markdown в content/ те же записи ПРЕДЛАГАЮТСЯ', async () => {
    const empty = await makeRoot('wp9b-empty-');
    createdRoots.push(empty);
    await fs.mkdir(join(empty, 'content'), { recursive: true });
    const { gather } = makeDoctor();
    const bare = await gather(FileUri.create(empty).toString());
    const paths = bare.fixes.map(fix => fix.path);
    for (const offered of ['content/chapter-01.md', 'proofreading', 'sources/audio', 'transcription']) {
      expect(paths).toContain(offered);
    }
  });

  test('ведро 2 (4) manifestExists + (5) manifestRows: недостающая глава манифеста', () => {
    expectSemantic(
      byCode(report.fixes, 'create-missing-chapter').map(fix => ({ path: fix.path, kind: fix.kind })),
      [{ path: 'content/ch-missing.md', kind: 'file' }],
      'недостающие главы манифеста'
    );
    // `manifestExists === true` -> реконструкции манифеста НЕТ.
    expect(codes(report.fixes)).not.toContain('manifest-recreate');
  });

  test('ведро 2 (6) manuscriptCandidates: глава вне манифеста даёт предложение дописать', () => {
    const append = byCode(report.fixes, 'manifest-append');
    expectSemantic(
      append.map(fix => ({ path: fix.path, fileCount: fix.manifest?.fileCount, samplePaths: fix.manifest?.samplePaths })),
      [{ path: 'manifest.yaml', fileCount: 1, samplePaths: ['content/stray.md'] }],
      'дописывание манифеста'
    );
  });

  test('ведро 2 (8) metadata: пустые title/author дают ДВЕ находки', () => {
    expectSemantic(
      codes(report.findings).filter(code => code?.startsWith('metadata-')),
      ['metadata-title-blank', 'metadata-author-blank'],
      'находки metadata.yaml'
    );
  });

  test('ведро 2 (9) citationsContent + (10) excerptsContent: обе ошибки разбора видны', () => {
    expect(codes(report.findings)).toContain('citations-parse-error');
    expectSemantic(
      byCode(report.findings, 'excerpts-parse-error').map(finding => finding.params?.[0]),
      [2],
      'номер битой строки excerpts.jsonl'
    );
  });

  test('ведро 2 (11) workspaceSettings: legacy AI-ключи дают находку И правку', () => {
    expectSemantic(
      byCode(report.findings, 'legacy-ai-settings').map(finding => finding.params),
      [[2, 'aiFocusedEditor.ai.apiKeys, aiFocusedEditor.ai.activeAlias']],
      'находка legacy AI-настроек'
    );
    expectSemantic(
      byCode(report.fixes, 'migrate-ai-settings').map(fix => ({ path: fix.path, legacyKeys: fix.aiSettings?.legacyKeys })),
      [{
        path: '.theia/settings.json',
        legacyKeys: ['aiFocusedEditor.ai.apiKeys', 'aiFocusedEditor.ai.activeAlias']
      }],
      'правка миграции AI-настроек'
    );
  });

  test('ведро 2 (12) transcriptionSecret: workspace-ключ вне .gitignore даёт находку И правку', () => {
    expectSemantic(
      byCode(report.findings, 'transcription-groq-key-workspace').map(finding => finding.params),
      [['.theia/settings.json']],
      'находка секретной гигиены'
    );
    expectSemantic(
      byCode(report.fixes, 'gitignore-theia-settings').map(fix => ({ path: fix.path, entry: fix.gitignore?.entry })),
      [{ path: '.gitignore', entry: '.theia/settings.json' }],
      'правка .gitignore'
    );
  });

  test('ведро 2 (12) ОТВЕРГАЮЩИЙ случай: без workspace-ключа находки нет', async () => {
    const { gather } = makeDoctor();
    const clean = await gather(FileUri.create(root).toString());
    expect(codes(clean.findings)).not.toContain('transcription-groq-key-workspace');
    expect(codes(clean.fixes)).not.toContain('gitignore-theia-settings');
  });

  test('ведро 2 (7) folderName: имя каталога попадает в СЕМЯ создаваемой metadata.yaml', async () => {
    // `folderName` наблюдается только когда `metadata.yaml` СОЗДАЁТСЯ (в основной
    // фикстуре он существует, чтобы был наблюдаем вход `metadata`). Поэтому
    // здесь — отдельный корень БЕЗ metadata.yaml. Это единственная пара входов
    // ведра 2, которую один корень наблюдать не может.
    const parent = await makeRoot('wp9b-restore-');
    createdRoots.push(parent);
    const bookRoot = join(parent, 'Восстановленная Книга');
    await write(bookRoot, 'manifest.yaml', 'version: 1\ncontent:\n  - path: content/ch1.md\n    title: One\n');
    await write(bookRoot, 'content/ch1.md', '# One\n');

    const { gather } = makeDoctor();
    const restored = await gather(FileUri.create(bookRoot).toString());
    const metadataFix = restored.fixes.find(fix => fix.path === 'metadata.yaml');
    expect(metadataFix?.seed).toContain('Восстановленная Книга');
  });

  test('ведро 2: список из ДВЕНАДЦАТИ имён (сверка с проверкой № 3 WP-7)', () => {
    expect(BUCKET_2_INPUTS).toHaveLength(12);
    expect(new Set(BUCKET_2_INPUTS).size).toBe(12);
  });

  /* ---------------- ведро 3 — СТРУКТУРНОЕ утверждение --------------------- */

  test('ведро 3: в герметичной фикстуре оба входа `undefined` — находок нет', () => {
    expect(codes(report.fixes)).not.toContain('install-obsidian-plugin');
    expect(codes(report.fixes)).not.toContain('update-obsidian-plugin');
    expect(codes(report.findings)).not.toContain('transcription-audio-not-ignored');
  });

  test('ведро 3: `gather()` по-прежнему ВЫЗЫВАЕТ оба фидера', async () => {
    const { gather, calls } = makeDoctor();
    await gather(FileUri.create(root).toString());
    expectSemantic(calls, { obsidianPlugin: 1, transcription: 1 }, 'вызовы фидеров ведра 3');
    expect(BUCKET_3_INPUTS).toHaveLength(2);
  });

  test('ведро 3: значения фидеров ДОЕЗЖАЮТ до аргумента assembleBookDoctorReport', async () => {
    // Литеральный аргумент вызова перехватить нечем: `assembleBookDoctorReport`
    // импортируется в `book-doctor-contribution.ts` статически, а вставлять шов
    // в боевой код ради теста запрещено. Поэтому в фидеры подаются ТРАССЕРЫ —
    // значения, которые могут попасть в отчёт ТОЛЬКО через поля `obsidianPlugin`
    // и `transcription` объекта-аргумента. Если WP-7 перестанет их передавать,
    // трассеры исчезнут из отчёта и тест покраснеет.
    const { gather } = makeDoctor({
      obsidianPlugin: { installedVersion: null, bundledVersion: '9.9.9-tracer', hasObsidianDir: false },
      transcription: { setCount: 77, gitignoreContent: 'build/\n', toolchain: undefined, settings: undefined }
    });
    const traced = await gather(FileUri.create(root).toString());

    expectSemantic(
      byCode(traced.fixes, 'install-obsidian-plugin').map(fix => ({
        path: fix.path,
        bundledVersion: fix.obsidianPlugin?.bundledVersion
      })),
      [{ path: '.obsidian/plugins/afe-companion', bundledVersion: '9.9.9-tracer' }],
      'трассер obsidianPlugin'
    );
    expectSemantic(
      byCode(traced.findings, 'transcription-audio-not-ignored').map(finding => finding.params),
      [[77, 'sources/audio/']],
      'трассер transcription'
    );
  });

  /* ---------------- полный набор находок ---------------------------------- */

  test('полный набор кодов правок и находок (шлюз МИГРАЦИИ)', () => {
    expectSemantic(
      codes(report.fixes),
      [
        // knowledge, knowledge/plans, knowledge/questions, knowledge/summaries, ai, ai/prompts
        'create-folder', 'create-folder', 'create-folder', 'create-folder',
        'create-folder', 'create-folder',
        // ai/prompts/custom-modes.yaml
        'create-file',
        // .prompts, .prompts/skills, .prompts/skills/style-guide
        'create-folder', 'create-folder', 'create-folder',
        // .prompts/skills/style-guide/SKILL.md
        'create-file',
        'create-missing-chapter',
        'manifest-append',
        'entity-card-missing',
        'migrate-ai-settings',
        'gitignore-theia-settings'
      ],
      'коды правок'
    );
    expectSemantic(
      codes(report.findings),
      [
        'metadata-title-blank',
        'metadata-author-blank',
        'citations-parse-error',
        'excerpts-parse-error',
        'entity-card-orphan',
        'entity-tag-unknown-kind',
        'entity-type-problem',
        'legacy-ai-settings',
        'transcription-groq-key-workspace'
      ],
      'коды находок'
    );
  });
});

afterEach(() => {
  // Ничего не делаем: корни фикстур живут до конца файла (`afterAll`), потому
  // что снимки читаются один раз в `beforeAll` каждого потребителя.
});
