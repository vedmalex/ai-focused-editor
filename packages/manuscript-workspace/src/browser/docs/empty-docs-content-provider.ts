import { DEFAULT_DOCS_LANG, DocsContentProvider } from '../../common/docs/docs-contract';

/**
 * A `DocsContentProvider` that holds no pages.
 *
 * WHY IT EXISTS. The real content module, `src/browser/docs/docs-content.generated.ts`,
 * is produced by the build and is git-ignored, so the package cannot import it
 * unconditionally — a clean checkout would not compile. This provider is the
 * binding the widget runs against until the generator lands; swapping it is a
 * ONE-LINE change in `welcome-frontend-module.ts`:
 *
 * ```ts
 * import { generatedDocsContentProvider } from './docs/docs-content.generated';
 * bind(DocsContentProvider).toConstantValue(generatedDocsContentProvider);
 * ```
 *
 * It is not a stub in the pejorative sense: every consumer already has to cope
 * with a page that does not resolve (the widget degrades to the home route, and
 * `openDocs` warns), so an empty content set exercises exactly those paths
 * instead of inventing placeholder pages nobody wrote.
 */
export const EMPTY_DOCS_CONTENT_PROVIDER: DocsContentProvider = {
  getPage: () => undefined,
  getManifest: lang => ({ lang: lang ?? DEFAULT_DOCS_LANG, entries: [] })
};
