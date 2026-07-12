/**
 * Tiny two-language string table for the plugin UI. Kept inline (no bundler
 * asset loading) with a complete Russian set — the studio's primary language —
 * and an English fallback. `resolveLang` maps the Obsidian locale to one of the
 * two; the settings tab can force either.
 */

export type PluginLang = 'ru' | 'en';

export type StringKey =
  | 'panel.title'
  | 'panel.open'
  | 'panel.empty'
  | 'panel.entities'
  | 'panel.cloud'
  | 'panel.mentions'
  | 'panel.noMentions'
  | 'panel.noBook'
  | 'ribbon.open'
  | 'command.openPanel'
  | 'command.openCardUnderCursor'
  | 'command.searchEntities'
  | 'command.insertExcerpt'
  | 'command.openCard.notFound'
  | 'excerpt.placeholder'
  | 'excerpt.none'
  | 'search.placeholder'
  | 'create.title'
  | 'create.body'
  | 'create.confirm'
  | 'create.cancel'
  | 'create.noType'
  | 'card.kindBadge'
  | 'card.unresolvedType'
  | 'settings.yamlView.name'
  | 'settings.yamlView.desc'
  | 'settings.booksFolder.name'
  | 'settings.booksFolder.desc'
  | 'settings.language.name'
  | 'settings.language.desc'
  | 'settings.language.auto'
  | 'notice.reindexed'
  | 'notice.missingId'
  | 'notice.created'
  | 'hover.open'
  | 'hover.missingCard'
  | 'hover.field.id'
  | 'hover.field.name'
  | 'hover.field.term'
  | 'hover.field.aliases'
  | 'hover.field.epithets'
  | 'hover.field.summary'
  | 'hover.field.backstory'
  | 'hover.field.arc'
  | 'hover.field.speechPatterns'
  | 'hover.field.notes';

type Table = Record<StringKey, string>;

const RU: Table = {
  'panel.title': 'Рукопись',
  'panel.open': 'Открыть панель «Рукопись»',
  'panel.empty': 'В этой книге пока нет глав.',
  'panel.entities': 'Сущности',
  'panel.cloud': 'Облако',
  'panel.mentions': 'Упоминания',
  'panel.noMentions': 'Нет упоминаний в тексте.',
  'panel.noBook': 'Книга не найдена. Откройте папку с manifest.yaml как хранилище.',
  'ribbon.open': 'AFE: панель «Рукопись»',
  'command.openPanel': 'Открыть панель «Рукопись»',
  'command.openCardUnderCursor': 'Открыть карточку под курсором',
  'command.searchEntities': 'Поиск сущностей',
  'command.insertExcerpt': 'Вставить выдержку…',
  'command.openCard.notFound': 'Под курсором нет семантического тега.',
  'excerpt.placeholder': 'Поиск выдержки по тексту, заметке или источнику…',
  'excerpt.none': 'В книге нет выдержек (sources/excerpts.jsonl).',
  'search.placeholder': 'Поиск сущности по имени, id или псевдониму…',
  'create.title': 'Создать карточку сущности',
  'create.body': 'Карточка «{id}» не найдена. Создать её?',
  'create.confirm': 'Создать карточку',
  'create.cancel': 'Отмена',
  'create.noType': 'Тип «{kind}» не объявлен в книге — создание невозможно.',
  'card.kindBadge': 'Тип',
  'card.unresolvedType': 'Тип не распознан',
  'settings.yamlView.name': 'Открывать .yaml как карточку сущности',
  'settings.yamlView.desc': 'Показывает карточки сущностей в виде читаемого заголовка над редактируемым текстом. Внимание: настройка действует на ВСЕ .yaml/.yml файлы хранилища.',
  'settings.booksFolder.name': 'Папка книг (необязательно)',
  'settings.booksFolder.desc': 'Ограничить поиск книг этой папкой (путь относительно хранилища). Пусто — искать во всём хранилище.',
  'settings.language.name': 'Язык интерфейса плагина',
  'settings.language.desc': 'Язык строк плагина. По умолчанию определяется из языка Obsidian.',
  'settings.language.auto': 'Авто (из Obsidian)',
  'notice.reindexed': 'AFE: структура книги обновлена.',
  'notice.missingId': 'Сущность «{id}» не найдена.',
  'notice.created': 'Карточка создана: {path}',
  'hover.open': 'Открыть карточку',
  'hover.missingCard': 'Карточка для этого тега ещё не создана.',
  'hover.field.id': 'Идентификатор',
  'hover.field.name': 'Имя',
  'hover.field.term': 'Термин',
  'hover.field.aliases': 'Псевдонимы',
  'hover.field.epithets': 'Эпитеты',
  'hover.field.summary': 'Описание',
  'hover.field.backstory': 'Предыстория',
  'hover.field.arc': 'Арка',
  'hover.field.speechPatterns': 'Речевые особенности',
  'hover.field.notes': 'Заметки'
};

const EN: Table = {
  'panel.title': 'Manuscript',
  'panel.open': 'Open the Manuscript panel',
  'panel.empty': 'This book has no chapters yet.',
  'panel.entities': 'Entities',
  'panel.cloud': 'Cloud',
  'panel.mentions': 'Mentions',
  'panel.noMentions': 'No mentions in the text.',
  'panel.noBook': 'No book found. Open a folder containing manifest.yaml as a vault.',
  'ribbon.open': 'AFE: Manuscript panel',
  'command.openPanel': 'Open the Manuscript panel',
  'command.openCardUnderCursor': 'Open the entity card under the cursor',
  'command.searchEntities': 'Search entities',
  'command.insertExcerpt': 'Insert excerpt…',
  'command.openCard.notFound': 'No semantic tag under the cursor.',
  'excerpt.placeholder': 'Search an excerpt by text, note, or source…',
  'excerpt.none': 'This book has no excerpts (sources/excerpts.jsonl).',
  'search.placeholder': 'Search an entity by name, id, or alias…',
  'create.title': 'Create entity card',
  'create.body': 'Card “{id}” was not found. Create it?',
  'create.confirm': 'Create card',
  'create.cancel': 'Cancel',
  'create.noType': 'Type “{kind}” is not declared in this book — cannot create.',
  'card.kindBadge': 'Type',
  'card.unresolvedType': 'Unresolved type',
  'settings.yamlView.name': 'Open .yaml as an entity card',
  'settings.yamlView.desc': 'Shows entity cards as a readable header above the editable text. Warning: this applies to ALL .yaml/.yml files in the vault.',
  'settings.booksFolder.name': 'Books folder (optional)',
  'settings.booksFolder.desc': 'Limit book discovery to this folder (vault-relative path). Empty scans the whole vault.',
  'settings.language.name': 'Plugin UI language',
  'settings.language.desc': 'Language of the plugin strings. Defaults to the Obsidian locale.',
  'settings.language.auto': 'Auto (from Obsidian)',
  'notice.reindexed': 'AFE: book structure refreshed.',
  'notice.missingId': 'Entity “{id}” was not found.',
  'notice.created': 'Card created: {path}',
  'hover.open': 'Open card',
  'hover.missingCard': 'No card found for this tag yet.',
  'hover.field.id': 'Id',
  'hover.field.name': 'Name',
  'hover.field.term': 'Term',
  'hover.field.aliases': 'Aliases',
  'hover.field.epithets': 'Epithets',
  'hover.field.summary': 'Summary',
  'hover.field.backstory': 'Backstory',
  'hover.field.arc': 'Arc',
  'hover.field.speechPatterns': 'Speech patterns',
  'hover.field.notes': 'Notes'
};

const TABLES: Record<PluginLang, Table> = { ru: RU, en: EN };

/** Map an Obsidian/browser locale string to one of the two supported languages. */
export function resolveLang(locale: string | undefined): PluginLang {
  return (locale ?? '').toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

/**
 * A bound translator. `params` interpolate `{name}` placeholders. Unknown keys
 * fall back to the key itself so a missing string is visible, not silent.
 */
export function createTranslator(lang: PluginLang): (key: StringKey, params?: Record<string, string>) => string {
  const table = TABLES[lang] ?? EN;
  return (key, params) => {
    let value = table[key] ?? EN[key] ?? key;
    if (params) {
      for (const [name, replacement] of Object.entries(params)) {
        value = value.replace(new RegExp(`\\{${name}\\}`, 'g'), replacement);
      }
    }
    return value;
  };
}

export type Translator = ReturnType<typeof createTranslator>;
