/*
 * Local copy of the `TelegraphNode` interface (originally telegraphPublisher.ts:35
 * in the owner's telegraph-publisher library). Extracted on its own so the EPUB
 * closure does not pull in the telegra.ph API client.
 */

/**
 * Custom AST node the Markdown converter emits and the EPUB renderer consumes.
 * `{ tag, attrs, children }` mirrors the shape the Telegra.ph API expects.
 */
export interface TelegraphNode {
  tag?: string;
  attrs?: Record<string, string>;
  children?: (string | TelegraphNode)[];
}
