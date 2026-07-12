/**
 * Live Preview semantic-tag decorations — the editor-mode counterpart of the
 * reading-mode {@link SemanticReadingProcessor}. Obsidian's Live Preview keeps the
 * raw `[[kind:id|label]]` source in the CodeMirror 6 document, so (unlike reading
 * mode, which post-processes rendered anchors) this is a CM6 `ViewPlugin` that
 * scans the VISIBLE line text with the pure {@link scanSemanticTags} core scanner
 * and lays kind-accent `mark` decorations over each tag whose kind is an effective
 * tag kind (or entity kind) of the current book ({@link BookContext}).
 *
 * The tag the main selection/cursor is currently touching is left UNDECORATED, so
 * the author edits raw `[[…]]` syntax undisturbed (the decoration re-appears once
 * the caret moves away). `Mod`+click opens the entity card (an unknown id routes
 * to the create-card modal); `mouseover` drives the SAME {@link HoverPreview}
 * popover used by reading mode. Registered from `main.ts` via
 * `registerEditorExtension`. The `@codemirror/*` packages are Obsidian-provided
 * bundle externals — imported for types + the runtime values it injects.
 */

import { RangeSetBuilder, type Extension } from '@codemirror/state';
import {
  Decoration,
  ViewPlugin,
  type DecorationSet,
  type EditorView,
  type PluginValue,
  type ViewUpdate
} from '@codemirror/view';
import { editorInfoField } from 'obsidian';
import type { BookContext } from './book-context';
import type { EntityIndexEntry } from './core/book-model';
import { scanSemanticTags } from './core/tag-at-position';
import type { HoverPreview } from './hover-preview';
import { cssKind } from './manuscript-view';

/** CSS marker class every decorated Live-Preview tag carries (for click/hover hit-testing). */
const TAG_CLASS = 'afe-lp-tag';

export interface LivePreviewDeps {
  books: BookContext;
  /** Shared hover popover; omitted on mobile (no pointer hover). */
  hover?: HoverPreview;
  openCard: (entry: EntityIndexEntry) => void;
  onMissing: (sourcePath: string, kind: string, id: string) => void;
}

/** The vault-relative path of the file backing an editor, or `''` if unknown. */
function sourcePathOf(view: EditorView): string {
  return view.state.field(editorInfoField, false)?.file?.path ?? '';
}

/** The nearest decorated-tag element for an event target, or null. */
function tagElement(target: EventTarget | null): HTMLElement | null {
  const el = target instanceof HTMLElement ? target : null;
  return el?.closest(`.${TAG_CLASS}`) as HTMLElement | null;
}

function buildDecorations(view: EditorView, books: BookContext): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const book = books.bookForPath(sourcePathOf(view)) ?? books.getBooks()[0];
  if (!book) {
    return builder.finish();
  }
  const tagKinds = new Set(books.tagKindsFor(book).map(kind => kind.toLowerCase()));
  const kindIds = new Set(book.types.map(type => type.id.toLowerCase()));
  const selection = view.state.selection.main;

  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      for (const tag of scanSemanticTags(line.text)) {
        if (!tag.kind) {
          continue; // a bare [[id]] carries no kind accent
        }
        const kind = tag.kind.toLowerCase();
        if (!tagKinds.has(kind) && !kindIds.has(kind)) {
          continue; // unknown kind — leave ordinary wikilinks alone
        }
        const start = line.from + tag.start;
        const end = line.from + tag.end;
        // Skip the tag the caret/selection currently touches (raw editing undisturbed).
        if (selection.from <= end && selection.to >= start) {
          continue;
        }
        builder.add(
          start,
          end,
          Decoration.mark({
            class: `${TAG_CLASS} afe-kind-${cssKind(tag.kind)}`,
            attributes: { 'data-afe-kind': tag.kind, 'data-afe-id': tag.id }
          })
        );
      }
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

/** Build the CM6 editor extension that decorates + wires semantic tags in Live Preview. */
export function createLivePreviewExtension(deps: LivePreviewDeps): Extension {
  return ViewPlugin.fromClass(
    class implements PluginValue {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, deps.books);
      }

      update(update: ViewUpdate): void {
        if (update.docChanged || update.viewportChanged || update.selectionSet) {
          this.decorations = buildDecorations(update.view, deps.books);
        }
      }
    },
    {
      decorations: plugin => plugin.decorations,
      eventHandlers: {
        mousedown(event: MouseEvent, view: EditorView): boolean {
          if (!(event.metaKey || event.ctrlKey)) {
            return false;
          }
          const el = tagElement(event.target);
          if (!el) {
            return false;
          }
          const kind = el.getAttribute('data-afe-kind') ?? '';
          const id = el.getAttribute('data-afe-id') ?? '';
          if (!id) {
            return false;
          }
          const sourcePath = sourcePathOf(view);
          const entry = deps.books.findEntity(sourcePath, kind || undefined, id);
          if (entry) {
            deps.openCard(entry);
          } else {
            deps.onMissing(sourcePath, kind, id);
          }
          event.preventDefault();
          return true;
        },
        mouseover(event: MouseEvent, view: EditorView): boolean {
          if (!deps.hover) {
            return false;
          }
          const el = tagElement(event.target);
          if (!el) {
            return false;
          }
          const kind = el.getAttribute('data-afe-kind') ?? '';
          const id = el.getAttribute('data-afe-id') ?? '';
          if (!id) {
            return false;
          }
          deps.hover.show(el.getBoundingClientRect(), sourcePathOf(view), kind, id);
          return false;
        },
        mouseout(event: MouseEvent): boolean {
          if (deps.hover && tagElement(event.target)) {
            deps.hover.hide();
          }
          return false;
        }
      }
    }
  );
}
