import { describe, expect, test } from 'bun:test';
import { DocsPage } from '../../common/docs/docs-contract';
import { DocsRenderContext, WelcomeDocsRenderer } from './welcome-docs-renderer';

/**
 * EMISSION-side tests (tech_spec §F.5). Everything here runs over the pure
 * `renderPageHtml`, so no DOM is involved.
 *
 * NOTE ON FIXTURES: plain quoted strings only — NEVER `String.raw`. Under Bun,
 * Cyrillic inside a `String.raw` template is replaced by escape sequences, and
 * a fixture that silently stops containing what it claims to contain makes
 * every assertion over it meaningless.
 */

const renderer = new WelcomeDocsRenderer();

function page(markdown: string, overrides: Partial<DocsPage> = {}): DocsPage {
  return {
    id: 'sample',
    lang: 'ru',
    title: 'Заголовок',
    order: 0,
    markdown,
    covers: [],
    ...overrides
  };
}

function context(overrides: Partial<DocsRenderContext> = {}): DocsRenderContext {
  return {
    pageId: 'sample',
    lang: 'ru',
    isCommandRegistered: () => true,
    commandLabel: () => undefined,
    isStepChecked: () => false,
    ...overrides
  };
}

function render(markdown: string, ctx: DocsRenderContext = context(), overrides: Partial<DocsPage> = {}): string {
  return renderer.renderPageHtml(page(markdown, overrides), ctx);
}

/** Occurrences of `needle` in `haystack` — used for "exactly one carrier". */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * Every directive element that is a `<button>` AND encloses another directive
 * element — the ISS-094 hazard, reported as `outer > inner`.
 *
 * WHY THIS IS A STRING SCAN. `<button>` inside `<button>` is not a rendering
 * nuisance, it is a PARSER rewrite: the HTML tree constructor closes the outer
 * button at the inner start tag, so the inner one ends up a SIBLING and the
 * remaining row content lands outside any directive element. The delegated
 * `closest('[data-afe-directive]')` then answers with the wrong element. This
 * repository has no HTML parser to demonstrate that directly (no jsdom, no
 * happy-dom, no parse5 — see §F.5), so the test asserts the property that
 * PRECEDES the rewrite: we never EMIT the nesting in the first place. That is
 * the thing this code controls; the browser's reaction to it is not negotiable.
 */
function nestedDirectiveButtons(html: string): string[] {
  const hazards: string[] = [];
  const opener = /<button\b[^>]*\bdata-afe-directive="([^"]+)"[^>]*>/g;
  for (let match = opener.exec(html); match !== null; match = opener.exec(html)) {
    let depth = 1;
    let cursor = match.index + match[0].length;
    const start = cursor;
    while (depth > 0 && cursor < html.length) {
      const open = html.indexOf('<button', cursor);
      const close = html.indexOf('</button', cursor);
      if (close < 0) {
        break;
      }
      if (open >= 0 && open < close) {
        depth++;
        cursor = open + 7;
      } else {
        depth--;
        cursor = close + 8;
      }
    }
    const inner = html.slice(start, Math.max(start, cursor - 8));
    const nested = inner.match(/data-afe-directive="([^"]+)"/);
    if (nested) {
      hazards.push(`${match[1]} > ${nested[1]}`);
    }
  }
  return hazards;
}

describe('escaping of interpolated author values', () => {
  test('a double quote in a label becomes &quot; and does not break out of the attribute', () => {
    const html = render(':action{command="app.run" label="say \\"hi\\""}');
    expect(html).toContain('&quot;hi&quot;');
    expect(html).not.toContain('label="say "hi""');
    // The button element must still be a single well-formed tag.
    expect(count(html, '<button')).toBe(1);
    expect(html).toContain('data-afe-command="app.run"');
  });

  test('<, & and \' in a bracket label are escaped in the text node', () => {
    const html = render(":action[a &amp b < c 'd']{command=\"app.run\"}");
    expect(html).toContain('&amp;');
    expect(html).toContain('&lt;');
    expect(html).not.toContain('b < c');
  });

  test('a fully Cyrillic label survives unmangled', () => {
    const html = render(':action[Создать книгу]{command="app.run"}');
    expect(html).toContain('Создать книгу');
    expect(html).not.toContain('\\u');
  });

  test('a double quote inside a command id is escaped in data-afe-command', () => {
    const html = render(':action[Пуск]{command="app.\\"x\\""}');
    expect(html).toContain('data-afe-command="app.&quot;x&quot;"');
    expect(html).not.toContain('data-afe-command="app."x""');
  });

  test('the page title is escaped too', () => {
    const html = render('текст', context(), { title: 'Заголовок <b>&' });
    expect(html).toContain('<h1 class="afe-docs-title">Заголовок &lt;b&gt;&amp;</h1>');
  });
});

describe('line 1 of the no-dead-buttons contract (render time)', () => {
  test('an unregistered command renders disabled with an explaining tooltip', () => {
    const html = render(':action[Пуск]{command="ghost.command"}', context({ isCommandRegistered: () => false }));
    expect(html).toContain('disabled');
    expect(html).toContain('title="');
  });

  test('a registered command renders WITHOUT disabled', () => {
    const html = render(':action[Пуск]{command="app.run"}', context({ isCommandRegistered: () => true }));
    expect(html).not.toContain('disabled');
  });

  test('the caption falls back to the registry label, then to the raw id', () => {
    const labelled = render(':action{command="app.run"}', context({ commandLabel: () => 'Запустить' }));
    expect(labelled).toContain('>Запустить</button>');
    const bare = render(':action{command="app.run"}', context({ commandLabel: () => undefined }));
    expect(bare).toContain('>app.run</button>');
  });
});

describe('the data-afe-* scheme of the delegated handler', () => {
  const cases: readonly { markdown: string; directive: string; attribute: string }[] = [
    { markdown: ':action[A]{command="app.run"}', directive: 'action', attribute: 'data-afe-command="app.run"' },
    { markdown: ':settings[B]{query="editor.font"}', directive: 'settings', attribute: 'data-afe-query="editor.font"' },
    { markdown: ':doc[C]{page="book/export"}', directive: 'doc', attribute: 'data-afe-page="book/export"' },
    { markdown: ':::scenario{page="start"}\nтекст\n:::', directive: 'scenario', attribute: 'data-afe-page="start"' },
    { markdown: ':::steps{id="first"}\n- один\n:::', directive: 'step', attribute: 'data-afe-step="first"' }
  ];

  for (const item of cases) {
    test(`${item.directive} emits its data-afe-directive and payload`, () => {
      const html = render(item.markdown);
      expect(html).toContain(`data-afe-directive="${item.directive}"`);
      expect(html).toContain(item.attribute);
    });
  }

  test('requires renders a block and carries NO data-afe-directive (it is not clickable)', () => {
    const html = render(':::requires{title="Нужно"}\n- открытая книга\n:::');
    expect(html).toContain('class="afe-docs-requires"');
    expect(html).toContain('Нужно');
    expect(count(html, 'data-afe-directive')).toBe(0);
  });

  test('requires without a title falls back to a localized heading', () => {
    const html = render(':::requires\n- открытая книга\n:::');
    expect(html).toContain('class="afe-docs-requires-title"');
  });

  test('exactly ONE element carries data-afe-directive per occurrence', () => {
    const html = render(':action[A]{command="app.run"} и :settings[B]{query="q"}');
    expect(count(html, 'data-afe-directive')).toBe(2);
  });

  test('a step index is emitted per item, zero-based', () => {
    const html = render(':::steps{id="s"}\n- один\n- два\n- три\n:::');
    expect(html).toContain('data-afe-step-index="0"');
    expect(html).toContain('data-afe-step-index="1"');
    expect(html).toContain('data-afe-step-index="2"');
    expect(html).not.toContain('data-afe-step-index="3"');
  });
});

describe('class convention of §D.8', () => {
  test('action and settings buttons carry the existing afe-welcome-action class', () => {
    expect(render(':action[A]{command="app.run"}')).toContain('afe-welcome-action');
    expect(render(':settings[B]{query="q"}')).toContain('afe-welcome-action');
  });

  test('containers carry their afe-docs-* classes', () => {
    expect(render(':::steps{id="s"}\n- один\n:::')).toContain('class="afe-docs-steps"');
    expect(render(':::steps{id="s"}\n- один\n:::')).toContain('class="afe-docs-step"');
    expect(render(':::requires\n- x\n:::')).toContain('class="afe-docs-requires"');
    expect(render(':::scenario{page="start"}\nтекст\n:::')).toContain('class="afe-docs-card"');
    expect(render(':::scenario{page="start"}\nтекст\n:::')).toContain('afe-docs-card-icon');
  });

  test('a scenario without an icon gets codicon-book; a declared icon wins', () => {
    expect(render(':::scenario{page="start"}\nтекст\n:::')).toContain('codicon codicon-book');
    expect(render(':::scenario{page="start" icon="codicon-rocket"}\nтекст\n:::')).toContain('codicon codicon-rocket');
  });
});

describe('checklist state reaches the markup', () => {
  test('with isStepChecked(1) the SECOND item is checked and the others are not', () => {
    const html = render(
      ':::steps{id="setup"}\n- один\n- два\n- три\n:::',
      context({ isStepChecked: (id, index) => id === 'setup' && index === 1 })
    );
    expect(count(html, 'afe-docs-step--checked')).toBe(1);
    expect(count(html, 'aria-checked="true"')).toBe(1);
    expect(count(html, 'aria-checked="false"')).toBe(2);
    const checkedRow = html.split('<li>')[2];
    expect(checkedRow).toContain('aria-checked="true"');
    expect(checkedRow).toContain('два');
  });
});

describe('a checklist step hosts an action without nesting buttons (ISS-094)', () => {
  const STEP_WITH_ACTION =
    ':::steps{id="first-run"}\n'
    + '- Завести книгу\n\n'
    + '  ::action[Создать новую книгу…]{command="ai-focused-editor.book.newBook"}\n'
    + '- Подключить модель\n'
    + ':::';

  test('the emitted page contains NO directive button enclosing another directive', () => {
    expect(nestedDirectiveButtons(render(STEP_WITH_ACTION))).toEqual([]);
  });

  test('the hazard detector itself bites — it reports a hand-built nesting', () => {
    // Without this the previous test would also pass on a detector that always
    // returns []. The fixture is the exact markup the renderer used to emit.
    const hazard =
      '<li><button class="afe-docs-step" data-afe-directive="step" data-afe-step="s">'
      + 'Завести книгу<button data-afe-directive="action" data-afe-command="x">Создать</button>'
      + '</button></li>';
    expect(nestedDirectiveButtons(hazard)).toEqual(['step > action']);
  });

  test('the step row is not a button at all', () => {
    const html = render(':::steps{id="s"}\n- один\n:::');
    expect(html).toContain('<span class="afe-docs-step"');
    expect(html).not.toMatch(/<button[^>]*data-afe-directive="step"/);
  });

  test('the action inside a step is still a real directive element of its own', () => {
    const html = render(STEP_WITH_ACTION);
    expect(count(html, 'data-afe-directive="step"')).toBe(2);
    expect(count(html, 'data-afe-directive="action"')).toBe(1);
    // Nested INSIDE the step it belongs to, so `closest()` from the action
    // resolves to the action and from anywhere else in the row to the step.
    const row = html.slice(html.indexOf('data-afe-directive="step"'));
    expect(row.slice(0, row.indexOf('</span>'))).toContain('data-afe-directive="action"');
  });

  test('losing the button, the row keeps its accessible checkbox semantics', () => {
    const html = render(
      ':::steps{id="s"}\n- один\n- два\n:::',
      context({ isStepChecked: (_id, index) => index === 0 })
    );
    expect(count(html, 'role="checkbox"')).toBe(2);
    expect(count(html, 'tabindex="0"')).toBe(2);
    expect(count(html, 'aria-checked="true"')).toBe(1);
    expect(count(html, 'aria-checked="false"')).toBe(1);
    expect(html).toContain('class="afe-docs-steps" role="group"');
  });
});

describe('the html:false half of the emission contract', () => {
  test('a script tag in the page body is escaped, not emitted as a tag', () => {
    const html = render('<script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('raw HTML inside a container body is escaped as well', () => {
    const html = render(':::requires\n<img src=x onerror=1>\n:::');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});

describe('degradation instead of failure (§A.4)', () => {
  test('an invalid icon is dropped, the card still renders with the default icon', () => {
    const html = render(':::scenario{page="start" icon="not-a-codicon"}\nтекст\n:::');
    expect(html).toContain('data-afe-directive="scenario"');
    expect(html).toContain('codicon codicon-book');
    expect(html).not.toContain('not-a-codicon');
  });

  test('an unknown directive stays plain text and does not become an element', () => {
    const html = render(':actoin[Пуск]{command="app.run"}');
    expect(html).not.toContain('data-afe-directive');
    expect(html).toContain(':actoin');
  });

  test('an :action without its required command stays plain text', () => {
    const html = render(':action[Пуск]');
    expect(html).not.toContain('data-afe-directive');
    expect(html).toContain(':action');
  });

  test('a directive inside a fenced code block is left alone', () => {
    const html = render('```\n:action[A]{command="app.run"}\n```');
    expect(html).not.toContain('data-afe-directive');
    expect(html).toContain('<code>');
  });
});

describe('directives inside prose and inside containers', () => {
  test('an inline directive keeps its surrounding paragraph intact', () => {
    const html = render('Нажмите :action[Пуск]{command="app.run"} чтобы начать.');
    expect(count(html, '<p>')).toBe(1);
    expect(html).toContain('Нажмите <button');
    expect(html).toContain('</button> чтобы начать.');
  });

  test('a nested directive inside a container body is rendered too', () => {
    const html = render(':::requires\n- :action[Пуск]{command="app.run"}\n:::');
    expect(html).toContain('data-afe-directive="action"');
  });

  test('a leaf directive on its own line renders as a button', () => {
    const html = render('текст\n\n::action[Пуск]{command="app.run"}\n\nещё');
    expect(html).toContain('data-afe-directive="action"');
  });
});
