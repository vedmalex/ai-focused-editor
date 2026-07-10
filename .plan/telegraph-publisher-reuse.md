# Переиспользование telegraph-publisher для экспорта (решение)

Источник: ~/work/BhaktiVaibhava/telegraph-publisher (v1.5.0, research 2026-07-09).

## Рекомендация (вариант b — извлечение мини-пакета)
Прямая npm/file: зависимость непрактична: нет exports map, пакет публикует только CLI-бандл + сырые .ts (~643 файла).
Создать `packages/book-export` и скопировать замкнутый набор (~12 файлов, EPUB-путь без внешних runtime-зависимостей):
- src/epub/EpubGenerator.ts (удалить 3 мёртвых импорта: DependencyManager, PathResolver, MetadataManager)
- src/markdownConverter.ts (custom AST {tag,attrs,children}; EPUB рендерится из него, НЕ из markdown-it)
- src/utils/AnchorGenerator.ts (Telegra.ph-конвенция якорей: кейс/юникод сохраняются, H5/H6 префиксы >/>>)
- src/content/ContentProcessor.ts, src/metadata/MetadataManager.ts (транзитивно), src/links/{LinkResolver,types,utils/regex,utils/fs}.ts, src/types/metadata.ts, src/utils/PathResolver.ts
- новый telegraph-node.ts — только интерфейс TelegraphNode (из telegraphPublisher.ts:35), чтобы не тащить API-клиент

Ключевые ценности: EPUB 3 генератор с ВЛОЖЕННЫМ NCX TOC (generateNcx, стек уровней), самодельный ZIP writer (CRC-32, без jszip/archiver), OPF/NCX/XHTML/CSS шаблоны.

## Блокер-решение до интеграции: конвенция якорей
- ai-editor-3 slugifyBase: lowercase, не-буквы→дефис, dedupe -2/-3
- telegraph-publisher AnchorGenerator: кейс/юникод сохраняются, пробелы→'-', '<' удаляется
Один slug-модуль должен использоваться всеми экспортёрами (md/html/epub). Решить при реализации EPUB: пересадить slugifyBase в EpubGenerator (минимальный диф к нашим html-якорям) ИЛИ принять AnchorGenerator везде (богаче: ссылки в заголовках, inline-markdown strip).

## PDF (позже)
src/svg/PdfGenerator.ts — marked + puppeteer-core + системный Chrome. Тяжёлая зависимость; рассматривать как опциональный/electron-only экспортёр. SVG и Telegra.ph-metadata не брать.

## Точки интеграции ai-editor-3
- common/book-build-protocol.ts: BookBuildFormat += 'epub' (позже 'pdf')
- node/node-book-build-service.ts build(): ветка epub → EpubGenerator; главы уже собраны в manifest-порядке; semantic-теги предварительно снять renderSemanticLabels
