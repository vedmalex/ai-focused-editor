# VAN-разведка TASK-013: Правила резолюции wiki-ссылок Obsidian

(Отчёт research-агента sonnet, 2026-07-22, проверен оркестратором. Источники: obsidian.d.ts 1.13.1 из node_modules репо (S1), help.obsidian.md (S2), форумный ответ сотрудника Obsidian WhiteNoise + декомпиляция резолвера (S3), форумный консенсус (S4), негативное свидетельство плагина Front Matter Title (S5). Гист gist.github.com/dhpwd/... ОТКЛОНЁН как источник — это чужой AI-промпт, не документация Obsidian.)

## Псевдокод резолвера Obsidian

1. `parseLinktext(raw)` — деление по ПЕРВОМУ `#` на linktext/subpath.
2. `|alias` — ТОЛЬКО display-текст, в резолюции target не участвует.
3. `getFirstLinkpathDest(path, sourcePath)` — единственная точка входа:
   - путь с `/` → точный vault-relative путь (case-insensitive, `.md` добавляется);
   - иначе → ПЛОСКИЙ vault-wide индекс `uniqueFileLookup` (basename без .md, case-insensitive, ПО ВСЕМУ вольту). НЕТ приоритета текущей папки, НЕТ upward-поиска по каталогам. Front-matter aliases в индекс НЕ попадают (S3, прямая цитата разработчика).
   - несколько файлов с одним basename → недетерминировано; официальный способ снять — путь в ссылке.
4. subpath: `#Heading` — СЫРОЙ текст заголовка (без slug); цепочка `#H1#H2` снимает неоднозначность; `#^block` — блочные ссылки. Неудача subpath ≠ unresolved (файл резолвлен, нет прокрутки).
5. Файл не найден → unresolved; клик создаёт файл: путь в ссылке ПОБЕЖДАЕТ настройку Default location; bare — по настройке (Vault folder / Same folder / указанная папка).

## Ключевые подтверждённые факты

- Case-insensitive сравнение имён (S4).
- `.md` опционален для заметок; расширение ОБЯЗАТЕЛЬНО для не-md вложений (S2).
- Aliases = только автокомплит (автокомплит сам переписывает в `[[Имя|alias]]`) — резолвер их не видит (S3).
- Резолюции по title/H1 в core Obsidian НЕТ (S5) — это будет студийное РАСШИРЕНИЕ.
- «New link format» влияет только на ЗАПИСЬ новых ссылок, не на чтение (S4).

## НЕ подтверждено (не переносить как «факт Obsidian»)

- Tie-break при дубликатах basename (недетерминирован).
- Эквивалентность пробел/`-`/`_` (шла только из отклонённого гиста).
- Нормализация кириллицы в заголовках (экстраполяция).
- Точная эвристика resolveSubpath (только сигнатура в d.ts).

## Baseline в репо

- `packages/obsidian-plugin/src/reading-navigation.ts` — читает уже DOM-резолвленные Obsidian-анкоры (`data-href="kind:id"`), резолюцию не переизобретает; по границам UR-003 не трогать.
- `packages/manuscript-workspace/src/common/link-navigation.ts` — `parseBareEntityTags`, `resolveRelativeLink` (path-арифметика), Unicode-aware `slugifyBase`+`findHeadingLine` (slug-схема студии, используется EPUB/HTML-экспортёром).

## Рекомендации маппинга на цепочку entity→note→unresolved

1. Порядок entity→note→unresolved сохранить (entity `kind:id` — отдельное пространство имён, коллизий с basename-lookup нет).
2. Note-резолвер: flat vault-wide unique-basename lookup (КАК OBSIDIAN), а НЕ directory-upward из исходной формулировки UR — расхождение вынесено на подтверждение пользователю (решение VAN).
3. Резолюция по title/first-H1 — осознанное СТУДИЙНОЕ РАСШИРЕНИЕ (fallback после basename, перед unresolved); задокументировать как расширение сверх Obsidian-паритета.
4. `[[page|label]]` — только display (паритет); front-matter aliases в резолюции не участвуют (паритет).
5. Якоря: переиспользовать slugifyBase/findHeadingLine — сознательное расхождение с «сырым текстом» Obsidian ради согласованности с EPUB/HTML-экспортом (задокументировать).
6. `#^block` — out-of-scope.
7. Unresolved-клик: путь в ссылке побеждает; bare → папка текущей главы (аналог «Same folder as current file») — решить на PLAN.
8. Дубликаты basename: детерминированный выбор или пикер — сознательное улучшение против недокументированного поведения Obsidian — решить на PLAN.
