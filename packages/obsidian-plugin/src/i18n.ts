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
  | 'panel.noBook'
  | 'ribbon.open'
  | 'command.openPanel'
  | 'command.openCardUnderCursor'
  | 'command.searchEntities'
  | 'command.openCard.notFound'
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
  | 'notice.created';

type Table = Record<StringKey, string>;

const RU: Table = {
  'panel.title': 'Рукопись',
  'panel.open': 'Открыть панель «Рукопись»',
  'panel.empty': 'В этой книге пока нет глав.',
  'panel.entities': 'Сущности',
  'panel.noBook': 'Книга не найдена. Откройте папку с manifest.yaml как хранилище.',
  'ribbon.open': 'AFE: панель «Рукопись»',
  'command.openPanel': 'Открыть панель «Рукопись»',
  'command.openCardUnderCursor': 'Открыть карточку под курсором',
  'command.searchEntities': 'Поиск сущностей',
  'command.openCard.notFound': 'Под курсором нет семантического тега.',
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
  'notice.created': 'Карточка создана: {path}'
};

const EN: Table = {
  'panel.title': 'Manuscript',
  'panel.open': 'Open the Manuscript panel',
  'panel.empty': 'This book has no chapters yet.',
  'panel.entities': 'Entities',
  'panel.noBook': 'No book found. Open a folder containing manifest.yaml as a vault.',
  'ribbon.open': 'AFE: Manuscript panel',
  'command.openPanel': 'Open the Manuscript panel',
  'command.openCardUnderCursor': 'Open the entity card under the cursor',
  'command.searchEntities': 'Search entities',
  'command.openCard.notFound': 'No semantic tag under the cursor.',
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
  'notice.created': 'Card created: {path}'
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
