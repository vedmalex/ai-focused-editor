import { nls } from '@theia/core/lib/common/nls';
import { injectable } from '@theia/core/shared/inversify';
import MarkdownIt from 'markdown-it';
import {
  DocsLang,
  DocsPage
} from '../../common/docs/docs-contract';
import {
  ParsedDirective,
  parseDirective,
  scanDirectives
} from '../../common/docs/directive-core';

/**
 * Everything the renderer needs from the widget to turn one page into HTML —
 * and nothing else. Keeping it a plain record (rather than handing the renderer
 * the `CommandRegistry`) is what makes {@link WelcomeDocsRenderer.renderPageHtml}
 * a pure function that can be tested without a DOM or a DI container.
 */
export interface DocsRenderContext {
  readonly pageId: string;
  readonly lang: DocsLang;
  /** Line 1 of the "no dead buttons" contract: is the command in THIS build? */
  readonly isCommandRegistered: (commandId: string) => boolean;
  /** Default caption for an `:action` that carries neither `[..]` nor `label`. */
  readonly commandLabel: (commandId: string) => string | undefined;
  readonly isStepChecked: (checklistId: string, index: number) => boolean;
}

/** Token type carrying one parsed directive through markdown-it. */
const DIRECTIVE_TOKEN = 'afe_directive';

/** Icon used by a `:::scenario` card that names none (§A.6). */
const DEFAULT_SCENARIO_ICON = 'codicon-book';

/**
 * Class of the marker element a ```mermaid fence renders to, and the attribute
 * the widget's DOM postprocessing scans for. NOT `data-afe-directive`: that
 * attribute is the delegated CLICK contract (§D.4 of the docs design) — a
 * mermaid diagram is not clickable, and reusing it would route diagram clicks
 * through `WelcomeWidget.onDocsClick`'s directive switch for no reason.
 */
export const MERMAID_MARKER_CLASS = 'afe-docs-mermaid';
export const MERMAID_MARKER_ATTRIBUTE = 'data-afe-mermaid';

/** What a markdown-it env carries for our renderer rules. */
interface DirectiveEnv {
  readonly ctx: DocsRenderContext;
}

/**
 * Renders one guide page: markdown through markdown-it, the six directives of
 * §A.6 through `directive-core` — the single parser in this codebase.
 *
 * TWO ENTRY POINTS ON PURPOSE. {@link renderPageHtml} is a pure
 * markdown+context → string function; {@link renderPage} is three lines on top
 * of it that hand back a `DocumentFragment`. The split is forced, not
 * stylistic: this repository has no DOM environment for tests (no jsdom, no
 * happy-dom), and the EMISSION-side tests the contract demands — every
 * interpolated author value escaped — would otherwise require introducing one,
 * which is both out of scope and a risk to the existing suite.
 *
 * EMISSION CONTRACT (§D.4):
 * 1. markdown-it runs with `html: false`, so raw HTML in a page body is text;
 * 2. EVERY interpolated author value — captions, command ids, queries, page
 *    ids, icon names, checklist ids — goes through `md.utils.escapeHtml`, in
 *    text nodes and in attribute values alike;
 * 3. exactly ONE element per directive carries `data-afe-directive`, so the
 *    widget's single delegated `closest()` handler is unambiguous.
 *
 * NEVER THROWS. A page can come from a substituted `DocsContentProvider` that
 * never passed through the generator's gates, so an unparsable occurrence
 * degrades to its own source text plus a `console.warn` (§A.4) instead of
 * taking the whole Welcome page down with it.
 */
@injectable()
export class WelcomeDocsRenderer {
  protected readonly md: MarkdownIt = this.createEngine();

  /** PURE: markdown + context → HTML. Tested without a DOM. */
  renderPageHtml(page: DocsPage, ctx: DocsRenderContext): string {
    // One scan of the whole page for reporting only: `scanDirectives` walks the
    // page exactly as the generator does, so what the console reports is what
    // the build would have refused. The rendering itself is driven by the
    // markdown-it rules below, which call the same `parseDirective`.
    for (const diagnostic of scanDirectives(page.markdown).diagnostics) {
      console.warn(
        `afe-docs: ${diagnostic.message} at ${page.id}:${diagnostic.position.line}:${diagnostic.position.column}`
      );
    }
    const env: DirectiveEnv = { ctx };
    const title = this.md.utils.escapeHtml(page.title);
    return `<h1 class="afe-docs-title">${title}</h1>${this.md.render(page.markdown, env)}`;
  }

  /**
   * The public substitution point for the rendering engine (§7 of the design).
   *
   * Parses INERTLY through a `<template>`: its content is not part of the
   * document, so nothing in it executes or fetches while it is being built.
   */
  renderPage(page: DocsPage, ctx: DocsRenderContext): DocumentFragment {
    const template = document.createElement('template');
    template.innerHTML = this.renderPageHtml(page, ctx);
    return template.content;
  }

  protected createEngine(): MarkdownIt {
    const md = new MarkdownIt({ html: false, linkify: false, typographer: false });
    this.installDirectiveRules(md);
    this.installMermaidFenceRule(md);
    return md;
  }

  /**
   * Overrides ONLY the `mermaid` info-string case of the `fence` rule; every
   * other fenced block (including a bare ` ``` ` or `js`/`ts`/anything-else)
   * falls straight through to markdown-it's own default renderer, unchanged.
   *
   * WHY A MARKER, NOT A DIAGRAM. This engine runs with `html:false` and has no
   * DOM (§ renderPageHtml is a pure string function, tested with no jsdom —
   * see the class doc). Mermaid's `render()` is async and needs a live DOM, so
   * it cannot run here; the fence rule instead emits an INERT marker element
   * (the raw diagram source as its text content) for the widget's DOM
   * postprocessing ({@link WelcomeWidget}'s mermaid pass) to find and replace
   * with a rendered SVG after `renderPage`'s fragment is mounted — the same
   * split the KaTeX math rendering uses in the chapter preview.
   *
   * The code is `escapeHtml`-ed into the element's TEXT content (never an
   * attribute): the postprocessing reads it back via `textContent`, which the
   * browser un-escapes for free, so no double-escaping bookkeeping is needed
   * and a diagram containing `"` or `<` cannot break out of a marker attribute.
   */
  protected installMermaidFenceRule(md: MarkdownIt): void {
    const defaultFence = md.renderer.rules.fence!;
    md.renderer.rules.fence = (tokens, index, options, env, self) => {
      const token = tokens[index];
      const info = token.info ? md.utils.unescapeAll(token.info).trim() : '';
      const language = info.split(/\s+/)[0];
      if (language !== 'mermaid') {
        return defaultFence(tokens, index, options, env, self);
      }
      return `<pre class="${MERMAID_MARKER_CLASS}" ${MERMAID_MARKER_ATTRIBUTE}="true">`
        + `${md.utils.escapeHtml(token.content)}</pre>`;
    };
  }

  /**
   * Teaches markdown-it the directive grammar by DELEGATING every decision to
   * `parseDirective`. No second parser, no second notion of what a directive
   * is: the rules below only decide WHERE to try, never WHAT is valid.
   *
   * Consequence of hosting the grammar inside markdown-it rather than
   * pre-processing the source: directives inside fenced blocks and code spans
   * are never offered to us (markdown-it tokenizes code first), which is
   * exactly the "code is not scanned" rule `scanDirectives` implements — the
   * guide's own page about this syntax stays buildable.
   */
  protected installDirectiveRules(md: MarkdownIt): void {
    md.block.ruler.before('fence', 'afe-directive-container', (state, startLine, _endLine, silent) => {
      const start = state.bMarks[startLine] + state.tShift[startLine];
      if (state.src[start] !== ':') {
        return false;
      }
      const result = parseDirective(state.src, start);
      if (!result.ok || result.directive.form !== 'container') {
        return false;
      }
      if (!silent) {
        const token = state.push(DIRECTIVE_TOKEN, '', 0);
        token.block = true;
        token.map = [startLine, startLine];
        token.meta = result.directive;
      }
      state.line = startLine + consumedLines(state.src, start, result.directive.end);
      return true;
    }, { alt: ['paragraph', 'blockquote', 'list'] });

    md.inline.ruler.before('text', 'afe-directive', (state, silent) => {
      if (state.src[state.pos] !== ':') {
        return false;
      }
      const result = parseDirective(state.src, state.pos);
      // A container never appears here (the block rule owns it); an inline or
      // leaf occurrence that fails to parse falls through to the text rule and
      // renders as its own source, per §A.4.
      if (!result.ok || result.directive.form === 'container') {
        return false;
      }
      if (!silent) {
        const token = state.push(DIRECTIVE_TOKEN, '', 0);
        token.meta = result.directive;
      }
      state.pos = result.directive.end;
      return true;
    });

    md.renderer.rules[DIRECTIVE_TOKEN] = (tokens, index, _options, env) =>
      this.renderDirective(md, tokens[index].meta as ParsedDirective, env as DirectiveEnv);
  }

  protected renderDirective(md: MarkdownIt, directive: ParsedDirective, env: DirectiveEnv): string {
    switch (directive.name) {
      case 'action':
        return this.renderAction(md, directive, env.ctx);
      case 'settings':
        return this.renderSettings(md, directive);
      case 'doc':
        return this.renderDocLink(md, directive);
      case 'scenario':
        return this.renderScenario(md, directive, env);
      case 'steps':
        return this.renderSteps(md, directive, env);
      case 'requires':
        return this.renderRequires(md, directive, env);
      default:
        // Unreachable through `parseDirective` (the registry is a closed
        // whitelist), but a `default` that silently drops content would be the
        // dead-affordance class this whole contract exists to prevent.
        console.warn(`afe-docs: no renderer for directive '${directive.name}'`);
        return '';
    }
  }

  /**
   * Line 1 of the contract lives here: a command absent from THIS build is
   * rendered `disabled` with an explaining tooltip rather than as a button that
   * does nothing. Whether it is currently ENABLED is decided at click time
   * instead (§D.5) — that answer changes with the open workspace and would go
   * stale in the markup.
   */
  protected renderAction(md: MarkdownIt, directive: ParsedDirective, ctx: DocsRenderContext): string {
    const command = directive.attributes.command;
    const caption = directive.label
      ?? directive.attributes.label
      ?? ctx.commandLabel(command)
      ?? command;
    const registered = ctx.isCommandRegistered(command);
    const unavailable = nls.localize(
      'ai-focused-editor/welcome/docs-command-unavailable',
      'This command is not available in this build'
    );
    const guard = registered ? '' : ` disabled title="${md.utils.escapeHtml(unavailable)}"`;
    return `<button class="theia-button afe-welcome-action secondary" type="button"`
      + ` data-afe-directive="action" data-afe-command="${md.utils.escapeHtml(command)}"${guard}>`
      + `${md.utils.escapeHtml(caption)}</button>`;
  }

  protected renderSettings(md: MarkdownIt, directive: ParsedDirective): string {
    const query = directive.attributes.query;
    const caption = directive.label ?? directive.attributes.label ?? query;
    return `<button class="theia-button afe-welcome-action secondary" type="button"`
      + ` data-afe-directive="settings" data-afe-query="${md.utils.escapeHtml(query)}">`
      + `${md.utils.escapeHtml(caption)}</button>`;
  }

  protected renderDocLink(md: MarkdownIt, directive: ParsedDirective): string {
    const page = directive.attributes.page;
    const caption = directive.label ?? page;
    // `href="#"` and not a real URL: navigation happens inside the widget, and
    // the delegated handler calls `preventDefault()`. An anchor (rather than a
    // button) keeps an in-prose cross-reference reading like a link.
    return `<a href="#" data-afe-directive="doc" data-afe-page="${md.utils.escapeHtml(page)}">`
      + `${md.utils.escapeHtml(caption)}</a>`;
  }

  protected renderScenario(md: MarkdownIt, directive: ParsedDirective, env: DirectiveEnv): string {
    const page = directive.attributes.page;
    const icon = directive.attributes.icon ?? DEFAULT_SCENARIO_ICON;
    const body = md.render(directive.body ?? '', env);
    return `<button class="afe-docs-card" type="button"`
      + ` data-afe-directive="scenario" data-afe-page="${md.utils.escapeHtml(page)}">`
      + `<span class="afe-docs-card-icon codicon ${md.utils.escapeHtml(icon)}"></span>`
      + `${body}</button>`;
  }

  /**
   * A checklist whose checked state lives in the widget (and therefore in the
   * saved layout), not in the markup: the same page re-renders with a different
   * `isStepChecked` after every toggle.
   *
   * THE ROW IS A `<span role="checkbox">`, NOT A `<button>` (ISS-094).
   *
   * A step is a natural place for an action — "Завести книгу" wants the
   * `::action[Создать новую книгу…]` button right inside it. With a `<button>`
   * row that is `<button>` inside `<button>`, which is not merely invalid HTML:
   * the PARSER unnests it. The outer button is closed early, the inner one
   * becomes its SIBLING, the rest of the row falls outside any step — and the
   * delegated `closest('[data-afe-directive]')` then resolves clicks to the
   * wrong element. Nothing catches it: the generator sees legal directives, the
   * emission tests see the intended string, and only a browser disagrees.
   *
   * The fix keeps the affordance and drops the nesting hazard. A `<span>` is
   * phrasing content: the parser leaves an inner `<button>` exactly where the
   * author put it, so `closest()` finds the INNER directive for a click on the
   * action and the step for a click anywhere else — which is the behaviour a
   * reader expects. The alternative — keep `<button>` and fail the build on an
   * interactive directive inside `:::steps` — was rejected: it makes the guide
   * worse by forbidding the editorially right page.
   *
   * The cost of leaving `<button>` behind is that the element is no longer
   * focusable or keyboard-activatable for free. Both are restored explicitly:
   * `tabindex="0"` here, and Space/Enter in the widget's delegated `keydown`
   * handler (§D.4), which is the same single-listener design as the clicks.
   */
  protected renderSteps(md: MarkdownIt, directive: ParsedDirective, env: DirectiveEnv): string {
    const checklistId = directive.attributes.id;
    const items = topLevelListItems(md, directive.body ?? '', env);
    if (items.length === 0) {
      // A `:::steps` with no list is an authoring mistake the generator would
      // have caught; at runtime it degrades to its own content rather than to
      // an empty block that silently swallows the author's text.
      console.warn(`afe-docs: :::steps{id=${checklistId}} contains no list items`);
      return `<div class="afe-docs-steps">${md.render(directive.body ?? '', env)}</div>`;
    }
    const rows = items.map((item, index) => {
      const checked = env.ctx.isStepChecked(checklistId, index);
      const modifier = checked ? ' afe-docs-step--checked' : '';
      return `<li><span class="afe-docs-step${modifier}" role="checkbox" tabindex="0"`
        + ` aria-checked="${checked ? 'true' : 'false'}" data-afe-directive="step"`
        + ` data-afe-step="${md.utils.escapeHtml(checklistId)}" data-afe-step-index="${index}">`
        + `${item}</span></li>`;
    });
    return `<ul class="afe-docs-steps" role="group">${rows.join('')}</ul>`;
  }

  protected renderRequires(md: MarkdownIt, directive: ParsedDirective, env: DirectiveEnv): string {
    const title = directive.attributes.title
      ?? nls.localize('ai-focused-editor/welcome/docs-requires-title', 'Required');
    return `<section class="afe-docs-requires">`
      + `<h3 class="afe-docs-requires-title">${md.utils.escapeHtml(title)}</h3>`
      + `${md.render(directive.body ?? '', env)}</section>`;
  }
}

/**
 * How many source lines a container occupied, so the block rule can hand the
 * right resume point back to markdown-it.
 */
function consumedLines(source: string, start: number, end: number): number {
  const consumed = source.slice(start, end);
  let lines = 0;
  for (const char of consumed) {
    if (char === '\n') {
      lines++;
    }
  }
  return consumed.endsWith('\n') ? lines : lines + 1;
}

/**
 * The rendered HTML of each TOP-LEVEL list item of `body` — the checklist rows
 * of `:::steps`. Nested lists stay inside their own item.
 *
 * Uses markdown-it's own token stream rather than splitting lines: "what is a
 * list item" is a markdown question, and answering it a second time by hand is
 * how the two answers start to disagree.
 */
function topLevelListItems(md: MarkdownIt, body: string, env: DirectiveEnv): string[] {
  const tokens = md.parse(body, env);
  const items: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].type !== 'list_item_open' || tokens[index].level !== 1) {
      continue;
    }
    let depth = 0;
    let close = index + 1;
    for (; close < tokens.length; close++) {
      if (tokens[close].type === 'list_item_open') {
        depth++;
      } else if (tokens[close].type === 'list_item_close') {
        if (depth === 0) {
          break;
        }
        depth--;
      }
    }
    items.push(md.renderer.render(tokens.slice(index + 1, close), md.options, env));
    index = close;
  }
  return items;
}
