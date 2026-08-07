/**
 * TASK-022 WP-8 (UR-008) — ЧТО ТРИ ПИШУЩИХ AI-ИНСТРУМЕНТА КЛАДУТ НА ДИСК.
 *
 * Утверждения читают ФАЙЛ, а не мок: фикстура — настоящий временный каталог,
 * `FixtureFileService` пишет в него через `node:fs`, и каждая проверка
 * открывает получившийся файл заново. Блок «Проверка готовности» WP-8 требует
 * именно этого — мок подтвердил бы только то, что мы вызвали то, что вызвали.
 *
 * ТРИ ТРЕБОВАНИЯ БЛОКА ГОТОВНОСТИ и где они здесь:
 *   1. запись БЕЗ evidence либо отклонена, либо приземляется с
 *      `origin: 'ai-candidate'` — `describe('без evidence')`;
 *   2. запись С evidence даёт `origin: 'explicit'` — `describe('с evidence')`;
 *   3. диалог получает ровно то, что уходит на диск — `describe('диалог')`.
 *
 * ЗАПУСК: дорожка `bun run test:widget`, как у `narrative-consumer-baseline`.
 * Причина та же — `manuscript-tools-contribution` статически тянет
 * `excalidraw-editor-widget`, а тот и `@excalidraw/excalidraw` трогают
 * `document`/`window` на уровне модуля.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parse } from 'yaml';

/* ------------------------------------------------------------------------- */
/* Загрузочный DOM-шим (должен стоять ДО импорта браузерных модулей Theia)     */
/*                                                                            */
/* Скопирован из `narrative-consumer-baseline.test.ts`, а не вынесен в общий   */
/* модуль: базовая линия WP-9b правке не подлежит, а общий `*.ts`-помощник     */
/* попал бы в `lib` и в инвентарь `docs:drift` как продуктовый файл.           */
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


// Сверх базовой линии — ровно то, что требует `@excalidraw/excalidraw` при
// загрузке модуля: `location.origin`, `devicePixelRatio`, 2D-контекст канвы и
// `document.fonts`. Без них динамический импорт в `manuscript_create_diagram`
// падает ещё до того, как дойдёт до записи файла.
globals.location = { href: 'http://localhost/', origin: 'http://localhost', protocol: 'http:', host: 'localhost', hostname: 'localhost', pathname: '/', search: '', hash: '' };
globals.devicePixelRatio = 1;
const canvasContext = {
  measureText: (text: string) => ({ width: text.length * 8, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
  font: '', fillText() {}, save() {}, restore() {}, scale() {}, translate() {}, clearRect() {}, fillRect() {},
  beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {}, drawImage() {}, setTransform() {}
};
const createStubElement = globals.document.createElement;
globals.document.createElement = (tag: string) => {
  const element = createStubElement(tag);
  element.getContext = () => canvasContext;
  return element;
};
globals.document.fonts = { add() {}, addEventListener() {}, load: () => Promise.resolve([]), check: () => true };
globals.FontFace = globals.FontFace ?? class { load() { return Promise.resolve(this); } };

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

const {
  ManuscriptCreateEntityTool,
  ManuscriptWriteNoteTool,
  ManuscriptCreateDiagramTool
} = await import('./manuscript-tools-contribution');
const { aiWriteConfirmationMessage } = await import('./ai-write-confirmation');
import type { AiWriteConfirmationRequest } from './ai-write-confirmation';
import { provenanceYamlBlock } from '../common/ai-write-provenance';

/* ------------------------------------------------------------------------- */
/* Фикстура: настоящий каталог на диске                                        */
/* ------------------------------------------------------------------------- */

/** Единственная глава, на которую можно честно сослаться. */
const CHAPTER = 'content/chapter-01.md';
const RANGE = { start: { line: 2, character: 0 }, end: { line: 2, character: 9 } };

/**
 * `FileService`-заглушка поверх `node:fs` — ровно те методы, что трогают три
 * пишущих инструмента. Заглушка тут ТОЛЬКО транспорт: всё, что утверждается
 * ниже, читается обратно с диска через `fs`, а не с этого объекта.
 */
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

  async resolve(uri: TheiaURI): Promise<{ children: { resource: TheiaURI }[] }> {
    const entries = await fs.readdir(FileUri.fsPath(uri.toString()), { withFileTypes: true });
    return { children: entries.map(entry => ({ resource: uri.resolve(entry.name) })) };
  }

  async createFolder(uri: TheiaURI): Promise<void> {
    await fs.mkdir(FileUri.fsPath(uri.toString()), { recursive: true });
  }

  async create(uri: TheiaURI, content: string, options?: { overwrite?: boolean }): Promise<void> {
    const path = FileUri.fsPath(uri.toString());
    await fs.mkdir(join(path, '..'), { recursive: true });
    await fs.writeFile(path, content, { encoding: 'utf8', flag: options?.overwrite ? 'w' : 'wx' });
  }
}

/**
 * Записывающая заглушка подтверждения. Хранит ПОСЛЕДНИЙ запрос — то, что
 * реально увидел бы автор, — чтобы его можно было сравнить с файлом.
 */
class RecordingConfirmation {
  readonly requests: AiWriteConfirmationRequest[] = [];
  constructor(readonly answer: boolean) {}
  async confirm(request: AiWriteConfirmationRequest): Promise<boolean> {
    this.requests.push(request);
    return this.answer;
  }
  get last(): AiWriteConfirmationRequest {
    const request = this.requests[this.requests.length - 1];
    if (!request) {
      throw new Error('автора не спросили — запрос подтверждения не поступал');
    }
    return request;
  }
}

let root = '';
let fileService: FixtureFileService;

/** Свежий workspace на каждый тест: файлы создаются, и повтор не должен мешать. */
async function newFixtureRoot(): Promise<string> {
  const directory = await fs.mkdtemp(join(tmpdir(), 'wp8-ai-write-'));
  await fs.mkdir(join(directory, 'content'), { recursive: true });
  await fs.writeFile(join(directory, CHAPTER), '# Глава 1\n\nКришна правит колесницей.\n', 'utf8');
  return directory;
}

beforeEach(async () => {
  root = await newFixtureRoot();
  fileService = new FixtureFileService();
});

type WriteTool = InstanceType<typeof ManuscriptCreateEntityTool>
  | InstanceType<typeof ManuscriptWriteNoteTool>
  | InstanceType<typeof ManuscriptCreateDiagramTool>;

/** Собрать инструмент поверх фикстуры и указанной заглушки подтверждения. */
function wire<T extends WriteTool>(tool: T, confirmation: RecordingConfirmation | undefined): T {
  const anyTool = tool as unknown as Record<string, unknown>;
  anyTool.manuscriptWorkspace = { getSnapshot: async () => ({ rootUri: FileUri.create(root).toString() }) };
  anyTool.fileService = fileService;
  anyTool.confirmation = confirmation;
  return tool;
}

/** Выполнить инструмент и разобрать его JSON-ответ. */
async function run(tool: WriteTool, args: unknown): Promise<Record<string, unknown>> {
  const request = tool.getTool();
  const raw = await request.handler!(JSON.stringify(args), {} as never);
  return JSON.parse(String(raw)) as Record<string, unknown>;
}

/** Прочитать файл С ДИСКА по пути относительно фикстурного workspace. */
function readFixtureFile(relPath: string): Promise<string> {
  return fs.readFile(join(root, relPath), 'utf8');
}

/** Рекурсивный список файлов фикстуры — чем доказывается «не создан». */
async function listFixtureFiles(directory = root, prefix = ''): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...await listFixtureFiles(join(directory, entry.name), relative));
    } else {
      files.push(relative);
    }
  }
  return files.sort();
}

/** Всё, кроме фикстурной главы: то, что создал инструмент, и ничего больше. */
async function createdFiles(): Promise<string[]> {
  return (await listFixtureFiles()).filter(path => path !== CHAPTER);
}

/**
 * Достать пометку ИЗ ФАЙЛА в том виде, в каком её туда положили.
 *
 * Три формата — три способа, и это не случайность: карточка и заметка несут
 * YAML, диаграмма — JSON. Именно поэтому сравнение в блоке «диалог» идёт по
 * ЗАПИСИ, а не по строке: строка у диаграммы другая по устройству файла.
 */
function provenanceOnDisk(kind: 'card' | 'note' | 'diagram', text: string): unknown {
  if (kind === 'diagram') {
    return (JSON.parse(text) as { provenance?: unknown }).provenance;
  }
  const yamlText = kind === 'card'
    ? text
    : /^---[ \t]*\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/.exec(text)?.[1] ?? '';
  const parsed = parse(yamlText) as Record<string, unknown>;
  return parsed.evidence === undefined
    ? { origin: parsed.origin }
    : { origin: parsed.origin, evidence: parsed.evidence };
}

/* ------------------------------------------------------------------------- */
/* Требование 1 блока готовности — запись БЕЗ evidence                        */
/* ------------------------------------------------------------------------- */

describe('WP-8 — запись БЕЗ evidence', () => {
  test('карточка сущности приземляется с origin: ai-candidate (читается файл)', async () => {
    const confirmation = new RecordingConfirmation(true);
    const tool = wire(new ManuscriptCreateEntityTool(), confirmation);
    const result = await run(tool, { kind: 'character', name: 'Кришна' });

    expect(result.ok).toBe(true);
    expect(result.origin).toBe('ai-candidate');

    const card = parse(await readFixtureFile(String(result.path))) as Record<string, unknown>;
    expect(card.origin).toBe('ai-candidate');
    // Кандидат без источника НЕ несёт evidence: выдуманный указатель был бы
    // ровно той ложью, ради которой весь пакет.
    expect(card.evidence).toBeUndefined();
    expect(card.id).toBe('krishna');
  });

  test('заметка приземляется с origin: ai-candidate во front matter (читается файл)', async () => {
    const confirmation = new RecordingConfirmation(true);
    const tool = wire(new ManuscriptWriteNoteTool(), confirmation);
    const result = await run(tool, { title: 'План главы', markdown: '# План главы\n\nпункт\n' });

    expect(result.ok).toBe(true);
    const text = await readFixtureFile(String(result.path));
    expect(provenanceOnDisk('note', text)).toEqual({ origin: 'ai-candidate' });
    // Тело заметки уцелело целиком.
    expect(text.endsWith('# План главы\n\nпункт\n')).toBe(true);
  });

  test('диаграмма ОТКЛОНЕНА и файла не появляется', async () => {
    const confirmation = new RecordingConfirmation(true);
    const tool = wire(new ManuscriptCreateDiagramTool(), confirmation);
    const result = await run(tool, { title: 'Курукшетра', spec: { nodes: [{ id: 'a', label: 'Арджуна' }] } });

    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('requires "evidence"');
    expect(await createdFiles()).toEqual([]);
    // Автора даже не побеспокоили: отказ по контракту инструмента, а не по
    // ответу человека.
    expect(confirmation.requests).toEqual([]);
  });
});

/* ------------------------------------------------------------------------- */
/* Требование 2 блока готовности — запись С evidence                          */
/* ------------------------------------------------------------------------- */

describe('WP-8 — запись С evidence', () => {
  test('карточка получает origin: explicit и указатель с координатами', async () => {
    const tool = wire(new ManuscriptCreateEntityTool(), new RecordingConfirmation(true));
    const result = await run(tool, {
      kind: 'character',
      name: 'Кришна',
      evidence: { path: CHAPTER, range: RANGE }
    });

    expect(result.ok).toBe(true);
    const card = parse(await readFixtureFile(String(result.path))) as Record<string, unknown>;
    expect(card.origin).toBe('explicit');
    expect(card.evidence).toEqual({ path: CHAPTER, evidenceKind: 'range', range: RANGE });
  });

  test('ссылка на файл целиком даёт evidenceKind: whole-file, а не выдуманный диапазон', async () => {
    const tool = wire(new ManuscriptCreateEntityTool(), new RecordingConfirmation(true));
    const result = await run(tool, { kind: 'term', name: 'Дхарма', evidence: CHAPTER });

    const card = parse(await readFixtureFile(String(result.path))) as Record<string, unknown>;
    expect(card.origin).toBe('explicit');
    expect(card.evidence).toEqual({ path: CHAPTER, evidenceKind: 'whole-file' });
  });

  test('заметка получает origin: explicit', async () => {
    const tool = wire(new ManuscriptWriteNoteTool(), new RecordingConfirmation(true));
    const result = await run(tool, { title: 'Вопросы', markdown: 'текст\n', evidence: CHAPTER });

    expect(provenanceOnDisk('note', await readFixtureFile(String(result.path))))
      .toEqual({ origin: 'explicit', evidence: { path: CHAPTER, evidenceKind: 'whole-file' } });
  });

  test('диаграмма создаётся и сцена несёт пометку', async () => {
    const tool = wire(new ManuscriptCreateDiagramTool(), new RecordingConfirmation(true));
    const result = await run(tool, {
      title: 'Курукшетра',
      spec: { nodes: [{ id: 'a', label: 'Арджуна' }, { id: 'k', label: 'Кришна' }], edges: [{ from: 'k', to: 'a' }] },
      evidence: CHAPTER
    });

    expect(result.ok).toBe(true);
    const scene = JSON.parse(await readFixtureFile(String(result.path))) as Record<string, unknown>;
    expect(scene.provenance).toEqual({ origin: 'explicit', evidence: { path: CHAPTER, evidenceKind: 'whole-file' } });
    expect(Array.isArray(scene.elements)).toBe(true);
  });

  test('front matter, который модель написала сама, сохраняется и дополняется', async () => {
    const tool = wire(new ManuscriptWriteNoteTool(), new RecordingConfirmation(true));
    const markdown = '---\ntitle: Разбор\nlanguage: ru\n---\n\n# Разбор\n';
    const result = await run(tool, { title: 'Разбор', markdown, evidence: CHAPTER });

    const text = await readFixtureFile(String(result.path));
    const front = parse(/^---\r?\n([\s\S]*?)\r?\n---/.exec(text)![1]) as Record<string, unknown>;
    expect(front).toEqual({
      title: 'Разбор',
      language: 'ru',
      origin: 'explicit',
      evidence: { path: CHAPTER, evidenceKind: 'whole-file' }
    });
  });
});

/* ------------------------------------------------------------------------- */
/* Требование 3 блока готовности — диалог получает то, что уходит на диск      */
/* ------------------------------------------------------------------------- */

describe('WP-8 — диалог получает ровно то, что уходит на диск', () => {
  test('карточка: запись подтверждения совпадает с файлом, а текст несёт тот же блок', async () => {
    for (const evidence of [undefined, CHAPTER, { path: CHAPTER, range: RANGE }]) {
      root = await newFixtureRoot();
      const confirmation = new RecordingConfirmation(true);
      const tool = wire(new ManuscriptCreateEntityTool(), confirmation);
      const result = await run(tool, { kind: 'character', name: 'Кришна', evidence });

      const text = await readFixtureFile(String(result.path));
      const request = confirmation.last;
      expect(request.path).toBe(String(result.path));
      expect(provenanceOnDisk('card', text)).toEqual(provenanceOnDisk('card', provenanceYamlBlock(request.provenance)));
      // И буквально: блок из диалога — подстрока файла.
      const block = provenanceYamlBlock(request.provenance);
      expect(text).toContain(block);
      expect(aiWriteConfirmationMessage(request)).toContain(block);
    }
  });

  test('заметка: запись подтверждения совпадает с front matter файла', async () => {
    const confirmation = new RecordingConfirmation(true);
    const tool = wire(new ManuscriptWriteNoteTool(), confirmation);
    const result = await run(tool, { title: 'Сводка', markdown: 'текст\n', evidence: { path: CHAPTER, range: RANGE } });

    const text = await readFixtureFile(String(result.path));
    const block = provenanceYamlBlock(confirmation.last.provenance);
    expect(text).toContain(block);
    expect(aiWriteConfirmationMessage(confirmation.last)).toContain(block);
    expect(provenanceOnDisk('note', text)).toEqual(provenanceOnDisk('card', block));
  });

  test('диаграмма: запись подтверждения совпадает с provenance сцены', async () => {
    const confirmation = new RecordingConfirmation(true);
    const tool = wire(new ManuscriptCreateDiagramTool(), confirmation);
    const result = await run(tool, { title: 'Схема', spec: { nodes: [{ id: 'a', label: 'A' }] }, evidence: CHAPTER });

    const text = await readFixtureFile(String(result.path));
    const block = provenanceYamlBlock(confirmation.last.provenance);
    expect(provenanceOnDisk('diagram', text)).toEqual(provenanceOnDisk('card', block));
    expect(aiWriteConfirmationMessage(confirmation.last)).toContain(block);
  });

  test('текст для НЕподтверждённого кандидата прямо называет его кандидатом', async () => {
    const confirmation = new RecordingConfirmation(true);
    const tool = wire(new ManuscriptCreateEntityTool(), confirmation);
    await run(tool, { kind: 'character', name: 'Кришна' });
    const message = aiWriteConfirmationMessage(confirmation.last);
    expect(message).toContain('origin: ai-candidate');
    expect(message.toUpperCase()).toContain('CANDIDATE');
  });
});

/* ------------------------------------------------------------------------- */
/* Отказы: чем доказывается, что запись именно ОТКЛОНЕНА                       */
/* ------------------------------------------------------------------------- */

describe('WP-8 — отказы', () => {
  test('автор отказал — ни один из трёх инструментов ничего не создаёт', async () => {
    const declining = () => new RecordingConfirmation(false);

    const entity = await run(wire(new ManuscriptCreateEntityTool(), declining()), { kind: 'character', name: 'Кришна' });
    expect(entity.ok).toBe(false);
    expect(await createdFiles()).toEqual([]);

    const note = await run(wire(new ManuscriptWriteNoteTool(), declining()), { title: 'X', markdown: 'y\n' });
    expect(note.ok).toBe(false);
    expect(await createdFiles()).toEqual([]);

    const diagram = await run(wire(new ManuscriptCreateDiagramTool(), declining()), {
      title: 'X', spec: { nodes: [{ id: 'a', label: 'A' }] }, evidence: CHAPTER
    });
    expect(diagram.ok).toBe(false);
    expect(await createdFiles()).toEqual([]);
  });

  test('спросить НЕКОГО — запись отклонена, а не выполнена по умолчанию', async () => {
    // Самая важная строка файла. «Гейта нет» обязано означать «нельзя», иначе
    // обязательное подтверждение тихо превращается в значение по умолчанию.
    const entity = await run(wire(new ManuscriptCreateEntityTool(), undefined), { kind: 'character', name: 'Кришна' });
    expect(entity.ok).toBe(false);
    expect(String(entity.error)).toContain('confirmation');
    expect(await createdFiles()).toEqual([]);

    const note = await run(wire(new ManuscriptWriteNoteTool(), undefined), { title: 'X', markdown: 'y\n', evidence: CHAPTER });
    expect(note.ok).toBe(false);
    expect(await createdFiles()).toEqual([]);
  });

  test('evidence на несуществующий файл — отказ, а не «explicit» по выдуманной ссылке', async () => {
    const confirmation = new RecordingConfirmation(true);
    const result = await run(wire(new ManuscriptCreateEntityTool(), confirmation), {
      kind: 'character', name: 'Кришна', evidence: 'content/chapter-07.md'
    });

    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('does not exist');
    expect(await createdFiles()).toEqual([]);
    expect(confirmation.requests).toEqual([]);
  });

  test('битый evidence — отказ, а не тихое понижение до кандидата', async () => {
    const confirmation = new RecordingConfirmation(true);
    const result = await run(wire(new ManuscriptCreateEntityTool(), confirmation), {
      kind: 'character', name: 'Кришна', evidence: { path: CHAPTER, range: { start: { line: 1 } } }
    });

    expect(result.ok).toBe(false);
    expect(result.origin).toBeUndefined();
    expect(await createdFiles()).toEqual([]);
  });

  test('заметка, которая штампует провенанс сама, отклонена', async () => {
    const result = await run(wire(new ManuscriptWriteNoteTool(), new RecordingConfirmation(true)), {
      title: 'X', markdown: '---\norigin: explicit\n---\n\nтекст\n'
    });
    expect(result.ok).toBe(false);
    expect(await createdFiles()).toEqual([]);
  });
});

/* ------------------------------------------------------------------------- */
/* Дескрипторы: контракт, который видит модель                                 */
/* ------------------------------------------------------------------------- */

describe('WP-8 — дескрипторы пишущих инструментов', () => {
  test('все три объявляют evidence и требуют дополнительного подтверждения', () => {
    for (const tool of [new ManuscriptCreateEntityTool(), new ManuscriptWriteNoteTool(), new ManuscriptCreateDiagramTool()]) {
      const request = tool.getTool();
      expect(request.parameters.properties.evidence).toBeDefined();
      expect(request.confirmAlwaysAllow).toBe(true);
    }
  });

  test('evidence обязателен ТОЛЬКО у диаграммы', () => {
    expect(new ManuscriptCreateDiagramTool().getTool().parameters.required).toContain('evidence');
    expect(new ManuscriptCreateEntityTool().getTool().parameters.required).not.toContain('evidence');
    expect(new ManuscriptWriteNoteTool().getTool().parameters.required).not.toContain('evidence');
  });
});
