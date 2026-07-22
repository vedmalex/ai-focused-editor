/**
 * Language resolution for the in-app guide (tech_spec §E, §E.1).
 *
 * Pure functions over {@link DocsContentProvider}: they are the ONLY place that
 * knows the guide is complete in exactly one language. Both the runtime (widget
 * navigation, scenario cards, page opening) and the tests go through them, so
 * "which language does the user actually see" has a single answer.
 *
 * The two resolvers are deliberately SYMMETRIC — both fall back PER ITEM, never
 * all-or-nothing:
 *
 * - {@link resolveDocsPage}: requested language → default language → undefined;
 * - {@link resolveDocsManifest}: the SET of pages always comes from the default
 *   language, while titles/order come from the requested language wherever they
 *   exist (§E.1). An all-or-nothing manifest swap would collapse the navigation
 *   to one item as soon as a single page got translated, while
 *   {@link resolveDocsPage} kept serving every page — pages reachable but
 *   invisible.
 */

import {
  DEFAULT_DOCS_LANG,
  DocsContentProvider,
  DocsLang,
  DocsManifest,
  DocsManifestEntry,
  DocsPage
} from './docs-contract';

/** Every language the guide declares. `DocsLang` has no runtime form of its own. */
export const DOCS_LANGS: readonly DocsLang[] = ['ru', 'en'];

/**
 * `'ru-RU'` → `'ru'`, `'EN_us'` → `'en'`; anything unknown or empty →
 * {@link DEFAULT_DOCS_LANG}.
 *
 * Both `-` and `_` split the region off: BCP-47 uses the hyphen, but Theia's
 * `nls.locale` is filled from the environment, where `ru_RU` occurs.
 */
export function resolveDocsLang(
  locale: string | undefined,
  available: readonly DocsLang[]
): DocsLang {
  const base = (locale ?? '').trim().toLowerCase().split(/[-_]/, 1)[0];
  return available.find(lang => lang === base) ?? DEFAULT_DOCS_LANG;
}

/**
 * The page in the requested language, else in the default one, else
 * `undefined`.
 *
 * The third step is only reachable for a FOREIGN provider: for the generated
 * one, gate 4 of the build makes a page missing from the default set
 * impossible. The widget degrades an `undefined` to the home route (§D.6).
 */
export function resolveDocsPage(
  provider: DocsContentProvider,
  locale: string | undefined,
  pageId: string
): DocsPage | undefined {
  const lang = resolveDocsLang(locale, DOCS_LANGS);
  const page = provider.getPage(lang, pageId);
  if (page) {
    return page;
  }
  return lang === DEFAULT_DOCS_LANG ? undefined : provider.getPage(DEFAULT_DOCS_LANG, pageId);
}

/**
 * The manifest the navigation draws: the default-language entry list with every
 * entry REPLACED by its same-`id` counterpart from the requested language where
 * one exists (§E.1), re-sorted by §B.3 because a localized entry may carry a
 * different `order`/`section`.
 *
 * An empty requested manifest is a special case of the same formula (the lookup
 * map is empty, so the result equals the default manifest) — not a separate
 * branch. That matters: `content/en` is empty in this task, so an explicitly
 * English user would otherwise get an empty navigation and zero scenario cards.
 */
export function resolveDocsManifest(
  provider: DocsContentProvider,
  locale: string | undefined
): DocsManifest {
  const lang = resolveDocsLang(locale, DOCS_LANGS);
  const fallback = provider.getManifest(DEFAULT_DOCS_LANG);
  if (lang === DEFAULT_DOCS_LANG) {
    return fallback;
  }
  const requested = provider.getManifest(lang);
  const byId = new Map(requested.entries.map(entry => [entry.id, entry]));
  const merged = fallback.entries.map(entry => byId.get(entry.id) ?? entry);
  return { lang, entries: sortDocsManifestEntries(merged) };
}

/**
 * The §B.3 order, applied after a merge: groups by ascending minimum `order`
 * (the section-less group always first), then by `order` inside a group, then
 * by `id`.
 *
 * String comparison is by code unit, NOT `localeCompare`: the sorted manifest
 * ends up in a committed coverage report, and a locale-sensitive comparator
 * would make that report depend on the machine that produced it.
 */
export function sortDocsManifestEntries(
  entries: readonly DocsManifestEntry[]
): readonly DocsManifestEntry[] {
  const groups = new Map<string | undefined, DocsManifestEntry[]>();
  for (const entry of entries) {
    const key = entry.section;
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(entry);
    } else {
      groups.set(key, [entry]);
    }
  }
  const ordered = [...groups.entries()].sort((left, right) => {
    if (left[0] === undefined || right[0] === undefined) {
      return left[0] === right[0] ? 0 : left[0] === undefined ? -1 : 1;
    }
    const byOrder = minOrder(left[1]) - minOrder(right[1]);
    return byOrder !== 0 ? byOrder : compareStrings(left[0], right[0]);
  });
  const result: DocsManifestEntry[] = [];
  for (const [, bucket] of ordered) {
    bucket.sort((left, right) => (left.order - right.order) || compareStrings(left.id, right.id));
    result.push(...bucket);
  }
  return result;
}

function minOrder(entries: readonly DocsManifestEntry[]): number {
  return entries.reduce((least, entry) => Math.min(least, entry.order), Number.POSITIVE_INFINITY);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
