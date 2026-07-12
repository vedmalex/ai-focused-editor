/**
 * Reading-mode navigation. Obsidian parses `[[char:krishna|Krishna]]` into an
 * internal-link anchor (`data-href="char:krishna"`, text = the label) BEFORE any
 * markdown post-processor runs — so there is no `[[…]]` source text left to scan
 * in the DOM. This processor therefore rewrites the already-created anchors whose
 * href reads as a `<kind>:<id>` semantic tag into styled, kind-coloured spans
 * that open the entity card (or, for an unknown id, offer to create it). Plain
 * `[[Note]]` wikilinks (no `kind:` prefix / unknown kind) are left untouched, so
 * ordinary Obsidian linking keeps working.
 *
 * (The studio's `parseSemanticMarkdown` is a SOURCE-text parser and cannot apply
 * here for that reason; the shared `entity-type-registry` — the substantive
 * reuse — still drives which kinds are considered semantic.)
 */

import type { MarkdownPostProcessorContext } from 'obsidian';
import type { BookContext } from './book-context';
import type { EntityIndexEntry } from './core/book-model';
import type { HoverPreview } from './hover-preview';
import { cssKind } from './manuscript-view';

/** Split an internal-link href into a semantic `<kind>:<id>`, or null. */
export function parseTagHref(href: string): { kind: string; id: string } | null {
  const value = href.trim();
  const colon = value.indexOf(':');
  if (colon <= 0) {
    return null;
  }
  const kind = value.slice(0, colon).trim();
  // Strip a possible `#anchor`/subpath from the id part.
  const id = value.slice(colon + 1).split(/[#|]/)[0].trim();
  if (!kind || !id) {
    return null;
  }
  return { kind, id };
}

export class SemanticReadingProcessor {
  constructor(
    private readonly books: BookContext,
    private readonly openCard: (entry: EntityIndexEntry) => void,
    private readonly onMissing: (sourcePath: string, kind: string, id: string) => void,
    /** Shared hover popover; omitted on mobile (no pointer hover). */
    private readonly hover?: HoverPreview
  ) {}

  /** Bound as `plugin.registerMarkdownPostProcessor(this.process)`. */
  process = (el: HTMLElement, ctx: MarkdownPostProcessorContext): void => {
    const book = this.books.bookForPath(ctx.sourcePath) ?? this.books.getBooks()[0];
    if (!book) {
      return;
    }
    const tagKinds = new Set(this.books.tagKindsFor(book).map(kind => kind.toLowerCase()));
    const kindIds = new Set(book.types.map(type => type.id.toLowerCase()));

    const anchors = Array.from(el.querySelectorAll('a.internal-link')) as HTMLAnchorElement[];
    for (const anchor of anchors) {
      const href = anchor.getAttribute('data-href') ?? anchor.getAttribute('href') ?? '';
      const parsed = parseTagHref(href);
      if (!parsed) {
        continue;
      }
      const kind = parsed.kind.toLowerCase();
      if (!tagKinds.has(kind) && !kindIds.has(kind)) {
        continue; // a real wikilink like [[Some: subtitle]] with an unknown kind — leave it.
      }
      const entry = this.books.findEntity(ctx.sourcePath, parsed.kind, parsed.id);
      const label = anchor.textContent && anchor.textContent.trim() ? anchor.textContent : `${parsed.kind}:${parsed.id}`;
      const span = this.buildSpan(parsed, label, entry, ctx.sourcePath);
      anchor.replaceWith(span);
    }
  };

  private buildSpan(
    parsed: { kind: string; id: string },
    label: string,
    entry: EntityIndexEntry | undefined,
    sourcePath: string
  ): HTMLElement {
    const span = document.createElement('span');
    const tagKind = entry?.tagKind ?? parsed.kind;
    span.className = `afe-semantic-tag afe-kind-${cssKind(tagKind)}`;
    span.setAttr('data-afe-kind', parsed.kind);
    span.setAttr('data-afe-id', parsed.id);
    const dot = document.createElement('span');
    dot.className = 'afe-kind-dot';
    span.appendChild(dot);
    span.appendChild(document.createTextNode(label));

    if (entry) {
      span.addClass('afe-tag-resolved');
      span.setAttr('aria-label', `${entry.kind}: ${entry.label}`);
      span.onClickEvent(() => this.openCard(entry));
    } else {
      span.addClass('afe-tag-missing');
      span.setAttr('aria-label', `${parsed.kind}: ${parsed.id} (missing)`);
      span.onClickEvent(() => this.onMissing(sourcePath, parsed.kind, parsed.id));
    }

    if (this.hover) {
      span.addEventListener('mouseover', () =>
        this.hover!.show(span.getBoundingClientRect(), sourcePath, parsed.kind, parsed.id)
      );
      span.addEventListener('mouseout', () => this.hover!.hide());
    }
    return span;
  }
}
