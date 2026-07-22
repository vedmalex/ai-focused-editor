/**
 * Data contract of the in-app guide (tech_spec §B.1, WP-A).
 *
 * Declared HERE and not inside the generated content module on purpose (§2):
 * `docs-content.generated.ts` must be an IMPLEMENTATION of
 * {@link DocsContentProvider}, not its source. If the interface lived in the
 * generated file, an alternative provider — the very thing readiness criterion
 * 8 proves the swap with — would have to import its type from the artifact it
 * replaces. That is not a substitution point, only the look of one.
 *
 * Deliberately NOT re-exported from `src/common/index.ts`: that barrel is the
 * package's public API (`package.json` `main: lib/common/index.js`), whereas
 * these contracts are intra-package. Browser code imports them by path, the
 * way `welcome-widget.ts` already imports `../common/book-catalog`.
 */

/** Languages of the guide. In TASK-009 only 'ru' is complete (UR-007). */
export type DocsLang = 'ru' | 'en';

/** The one language guaranteed to hold a full set; the resolver's fallback. */
export const DEFAULT_DOCS_LANG: DocsLang = 'ru';

/**
 * A page's claim to cover a feature. A string is an exact inventory id; an
 * object is a glob (trailing `*` only) and MUST carry a non-empty `reason` —
 * the `covers` discipline of §2a/F-D2-1, which exists so glob absorption can
 * never grow silently.
 */
export type DocsCoverageClaim =
  | string
  | { readonly pattern: string; readonly reason: string };

/** One guide page in one language. */
export interface DocsPage {
  /** Extension-less path id: 'home', 'book/export'. */
  readonly id: string;
  readonly lang: DocsLang;
  /** Frontmatter `title` — heading in the navigation and on the page. */
  readonly title: string;
  /** Frontmatter `order` — position within a section; smaller sorts higher. */
  readonly order: number;
  /** Frontmatter `section` — navigation group; absent for top-level pages. */
  readonly section?: string;
  /** Page body without the frontmatter, byte-for-byte as in the `.md`. */
  readonly markdown: string;
  /**
   * Frontmatter `covers`; consumed by the generator only, never by the UI.
   * This is ONE of the two halves of the coverage carrier (the explicit
   * claim). The other is implicit: every `command=`/`query=` of the page
   * itself, which the generator extracts from `markdown`. Full definition —
   * §C.7.
   */
  readonly covers: readonly DocsCoverageClaim[];
}

/** One navigation entry — a page reduced to what the nav needs to draw it. */
export interface DocsManifestEntry {
  readonly id: string;
  readonly title: string;
  readonly order: number;
  readonly section?: string;
}

/** Navigation tree of one language. `entries` are already sorted (§B.3). */
export interface DocsManifest {
  readonly lang: DocsLang;
  readonly entries: readonly DocsManifestEntry[];
}

/**
 * The content-source substitution point (§1, §7 of the design). The generated
 * module is ONE implementation; readiness criterion 8 is proved by a second
 * one that needs no `.md` edited.
 *
 * `getManifest` is NON-optional: an incomplete language set is handled by
 * `resolveDocsManifest` (§E), not by an absent method.
 */
export interface DocsContentProvider {
  getPage(lang: DocsLang, id: string): DocsPage | undefined;
  getManifest(lang: DocsLang): DocsManifest;
}

/** DI symbol for binding the provider (`welcome-frontend-module.ts`). */
export const DocsContentProvider = Symbol('DocsContentProvider');
