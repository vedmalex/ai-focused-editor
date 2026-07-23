import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { KatexModule, renderMathInto } from './welcome-docs-katex';

/**
 * DOM-harness for the {@link renderMathInto} SEAM (TASK-018 WP-DOM-1/2,
 * UR-003/ISS-180). `renderKatexMath` itself stays untested here — it is only a
 * guard + a lazy `import('katex')` wrapper around this seam (see that
 * function's own doc-comment) — so exercising `renderMathInto` directly with a
 * FAKE {@link KatexModule} pins the actual DOM-mutation contract without ever
 * pulling in the real (heavy) `katex` bundle.
 *
 * A fresh `happy-dom` `Window` is created PER TEST (never a global/bunfig
 * preload) — see plan.md §3 "Per-test import, НЕ bunfig preload": this repo's
 * two-pass DOM postprocessing load order is fragile enough that a shared
 * global document risks cross-test leakage the mermaid/katex passes were
 * never designed against.
 */

/** A fake `katex` whose `renderToString` emits a `data-display`-tagged stub span, so a test can assert on it without depending on real KaTeX markup. */
function stubKatex(): KatexModule {
  return {
    renderToString(tex: string, options?: { displayMode?: boolean; throwOnError?: boolean }): string {
      const display = options?.displayMode ? '1' : '0';
      return `<span class="katex-stub" data-display="${display}">${tex}</span>`;
    }
  };
}

/** A fake `katex` whose `renderToString` always throws, exercising the {@link renderFormula} error fallback. */
function throwingKatex(message: string): KatexModule {
  return {
    renderToString(): string {
      throw new Error(message);
    }
  };
}

/**
 * Create a fresh `happy-dom` `Document` for one test and stitch in the ONE
 * ambient global {@link renderMathInto} relies on (`NodeFilter`, used the same
 * way a real browser/Electron renderer exposes it — {@link welcome-docs-katex.ts}
 * never imports it, since production code runs where it is already global).
 * Deliberately per-test (never a bunfig preload / module-level `beforeAll`) so
 * each test gets an isolated `document` and there is no shared global DOM state
 * to leak between tests — see plan.md §3.
 */
function freshDocument(): Document {
  const window = new Window();
  (globalThis as unknown as { NodeFilter: unknown }).NodeFilter = (window as unknown as { NodeFilter: unknown }).NodeFilter;
  return window.document as unknown as Document;
}

describe('renderMathInto — the DOM-postprocessing seam (TASK-018 WP-DOM-1/2)', () => {
  test('an inline $x^2$ is replaced by the stub span; surrounding text survives', () => {
    const document = freshDocument();
    const root = document.createElement('div') as unknown as HTMLElement;
    root.textContent = 'До $x^2$ после.';
    document.body.appendChild(root as never);

    renderMathInto(root, stubKatex());

    const stub = root.querySelector('.katex-stub');
    expect(stub).not.toBeNull();
    expect(stub?.getAttribute('data-display')).toBe('0');
    expect(stub?.textContent).toBe('x^2');
    expect(root.textContent).toBe('До x^2 после.');
    expect(root.textContent).toContain('До');
    expect(root.textContent).toContain('после.');
  });

  test('a block $$\\int$$ is replaced by a display-mode stub span', () => {
    const document = freshDocument();
    const root = document.createElement('div') as unknown as HTMLElement;
    root.textContent = '$$\\int$$';
    document.body.appendChild(root as never);

    renderMathInto(root, stubKatex());

    const stub = root.querySelector('.katex-stub');
    expect(stub).not.toBeNull();
    expect(stub?.getAttribute('data-display')).toBe('1');
    expect(stub?.textContent).toBe('\\int');
  });

  test('$a$ inside <code>/<pre> is left untouched (MATH_SKIP_TAGS)', () => {
    const document = freshDocument();
    const root = document.createElement('div') as unknown as HTMLElement;
    root.innerHTML = '<p>прочти <code>$a$</code></p><pre>$b$</pre>';
    document.body.appendChild(root as never);

    renderMathInto(root, stubKatex());

    expect(root.querySelector('.katex-stub')).toBeNull();
    expect(root.querySelector('code')?.textContent).toBe('$a$');
    expect(root.querySelector('pre')?.textContent).toBe('$b$');
  });

  test('text without any $ is not mutated at all', () => {
    const document = freshDocument();
    const root = document.createElement('div') as unknown as HTMLElement;
    root.innerHTML = '<p>Обычный абзац без формул.</p>';
    const before = root.innerHTML;

    renderMathInto(root, stubKatex());

    expect(root.innerHTML).toBe(before);
    expect(root.querySelector('.katex-stub')).toBeNull();
  });

  test('an already-rendered .katex subtree is skipped (not re-rendered)', () => {
    const document = freshDocument();
    const root = document.createElement('div') as unknown as HTMLElement;
    root.innerHTML = '<span class="katex">$x$</span>';
    document.body.appendChild(root as never);
    const before = root.innerHTML;

    renderMathInto(root, stubKatex());

    expect(root.innerHTML).toBe(before);
    expect(root.querySelector('.katex-stub')).toBeNull();
  });

  test('a KaTeX renderToString throw falls back to the ERROR_CLASS span with raw text', () => {
    const document = freshDocument();
    const root = document.createElement('div') as unknown as HTMLElement;
    root.textContent = 'Плохая формула $x^$ тут.';
    document.body.appendChild(root as never);

    renderMathInto(root, throwingKatex('unexpected end of input'));

    const errorSpan = root.querySelector('.afe-docs-katex-error');
    expect(errorSpan).not.toBeNull();
    expect(errorSpan?.textContent).toBe('$x^$');
    expect(root.querySelector('.katex-stub')).toBeNull();
    expect(root.textContent).toContain('Плохая формула');
    expect(root.textContent).toContain('тут.');
  });
});
