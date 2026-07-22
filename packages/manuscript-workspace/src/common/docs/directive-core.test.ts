import { describe, expect, test } from 'bun:test';
import {
  DIRECTIVE_REGISTRY,
  findLabelMetacharacter,
  parseDirective,
  positionAt,
  scanDirectives,
  type ParseDirectiveResult,
  type ParsedDirective
} from './directive-core';

/** Unwrap a result that MUST have parsed, surfacing the error when it did not. */
function ok(result: ParseDirectiveResult): ParsedDirective {
  if (!result.ok) {
    throw new Error(`expected a parse, got ${result.code}: ${result.error}`);
  }
  return result.directive;
}

/** The diagnostic codes of a successful parse, in order. */
function warningCodes(result: ParseDirectiveResult): string[] {
  return result.ok ? result.warnings.map(warning => warning.code) : [`FATAL:${result.code}`];
}

/** The fatal code, or `'ok'` — lets a negative test assert one exact value. */
function failureCode(source: string, offset = 0): string {
  const result = parseDirective(source, offset);
  return result.ok ? 'ok' : result.code;
}

describe('DIRECTIVE_REGISTRY', () => {
  test('holds exactly the six directives of §A.6', () => {
    expect(Object.keys(DIRECTIVE_REGISTRY).sort()).toEqual([
      'action',
      'doc',
      'requires',
      'scenario',
      'settings',
      'steps'
    ]);
  });

  test('every entry names itself and declares at least one form', () => {
    for (const [name, spec] of Object.entries(DIRECTIVE_REGISTRY)) {
      expect(spec.name).toBe(name);
      expect(spec.forms.length).toBeGreaterThan(0);
    }
  });
});

describe('A.1 the three forms', () => {
  test('inline with label and attributes', () => {
    const directive = ok(parseDirective(':action[Открыть]{command="ai-focused-editor.open"}'));
    expect(directive.form).toBe('inline');
    expect(directive.name).toBe('action');
    expect(directive.label).toBe('Открыть');
    expect(directive.attributes).toEqual({ command: 'ai-focused-editor.open' });
    expect(directive.body).toBeUndefined();
  });

  test('inline without a label', () => {
    const directive = ok(parseDirective(':action{command="ai-focused-editor.open"}'));
    expect(directive.label).toBeUndefined();
    expect(directive.attributes.command).toBe('ai-focused-editor.open');
  });

  test('leaf on its own line', () => {
    const directive = ok(parseDirective('::settings[Настройки]{query="ai.model"}'));
    expect(directive.form).toBe('leaf');
    expect(directive.label).toBe('Настройки');
    expect(directive.attributes.query).toBe('ai.model');
  });

  test('container captures its body verbatim and stops at the closing fence', () => {
    const source = ':::requires{title="Требуется"}\n- одно\n- два\n:::\nхвост';
    const directive = ok(parseDirective(source));
    expect(directive.form).toBe('container');
    expect(directive.label).toBeUndefined();
    expect(directive.body).toBe('- одно\n- два');
    expect(source.slice(directive.end)).toBe('хвост');
  });

  test('container without attributes when none are required', () => {
    const directive = ok(parseDirective(':::requires\nтекст\n:::'));
    expect(directive.attributes).toEqual({});
    expect(directive.body).toBe('текст');
  });

  test('an empty container body is an empty string, not undefined', () => {
    const directive = ok(parseDirective(':::requires\n:::'));
    expect(directive.body).toBe('');
  });

  test('an inline directive is parsed at an offset inside a paragraph', () => {
    const source = 'Нажмите :action[Пуск]{command="ai-focused-editor.run"} чтобы начать.';
    const offset = source.indexOf(':action');
    const directive = ok(parseDirective(source, offset));
    expect(directive.label).toBe('Пуск');
    expect(directive.start).toBe(offset);
    expect(source.slice(directive.end)).toBe(' чтобы начать.');
  });

  test('neg: a form the directive does not declare', () => {
    // `doc` is inline-only, `scenario`/`steps`/`requires` are container-only.
    expect(failureCode('::doc{page="home"}')).toBe('invalid-form');
    expect(failureCode(':::doc{page="home"}\n:::')).toBe('invalid-form');
    expect(failureCode(':scenario{page="home"}')).toBe('invalid-form');
    expect(failureCode('::steps{id="a"}')).toBe('invalid-form');
  });

  test('neg: a fence longer than three colons', () => {
    expect(failureCode('::::requires\n:::')).toBe('invalid-form');
  });

  test('neg: a container carrying a label', () => {
    expect(failureCode(':::scenario[Метка]{page="home"}\n:::')).toBe('label-not-allowed');
  });

  test('neg: leaf and container must own their line', () => {
    const leaf = 'текст ::action{command="c"}';
    expect(failureCode(leaf, leaf.indexOf('::action'))).toBe('not-own-line');
    const container = 'текст :::requires\n:::';
    expect(failureCode(container, container.indexOf(':::requires'))).toBe('not-own-line');
  });

  test('neg: trailing content after a leaf directive', () => {
    expect(failureCode('::action{command="c"} и ещё текст')).toBe('trailing-content');
  });

  test('neg: trailing content after an opening container fence', () => {
    expect(failureCode(':::requires хвост\n:::')).toBe('trailing-content');
  });

  test('an indented leaf still owns its line', () => {
    const directive = ok(parseDirective('   ::action{command="c"}', 3));
    expect(directive.form).toBe('leaf');
  });
});

describe('A.1 container boundaries', () => {
  test('neg: unclosed container', () => {
    expect(failureCode(':::requires\nтело без забора')).toBe('unclosed-container');
    expect(failureCode(':::requires\n')).toBe('unclosed-container');
    expect(failureCode(':::requires')).toBe('unclosed-container');
  });

  test('neg: a nested container', () => {
    expect(failureCode(':::requires\n:::steps{id="a"}\n:::\n:::')).toBe('nested-container');
  });

  test('a bare ::: inside the body closes it — the fence is not content', () => {
    const directive = ok(parseDirective(':::requires\nодин\n:::\n:::steps{id="a"}\nдва\n:::'));
    expect(directive.body).toBe('один');
  });
});

describe('A.2 attributes', () => {
  test('several attributes separated by spaces, order-insensitive', () => {
    const first = ok(parseDirective(':::scenario{page="book/export" icon="codicon-book"}\nтело\n:::'));
    const second = ok(parseDirective(':::scenario{icon="codicon-book" page="book/export"}\nтело\n:::'));
    expect(first.attributes).toEqual({ page: 'book/export', icon: 'codicon-book' });
    expect(second.attributes).toEqual(first.attributes);
  });

  test('tabs and padding inside the braces are separators, not content', () => {
    const directive = ok(parseDirective(':::scenario{\tpage="home"\ticon="codicon-book" }\nт\n:::'));
    expect(directive.attributes).toEqual({ page: 'home', icon: 'codicon-book' });
  });

  test('an empty attribute value is preserved, not silently dropped', () => {
    const directive = ok(parseDirective(':::requires{title=""}\nт\n:::'));
    expect(directive.attributes).toEqual({ title: '' });
  });

  test(String.raw`\" and \\ are the two escapes of an attribute value`, () => {
    const directive = ok(parseDirective(String.raw`:action{command="a\"b\\c"}`));
    expect(directive.attributes.command).toBe(String.raw`a"b\c`);
  });

  test('an attribute value may hold anything else, including cyrillic and braces', () => {
    const directive = ok(parseDirective(':::requires{title="Нужно: {A} & <B>"}\nт\n:::'));
    expect(directive.attributes.title).toBe('Нужно: {A} & <B>');
  });

  test('neg: an unquoted value', () => {
    expect(failureCode(':action{command=value}')).toBe('invalid-attribute-syntax');
  });

  test('neg: a single-quoted value', () => {
    expect(failureCode(":action{command='value'}")).toBe('invalid-attribute-syntax');
  });

  test('neg: the #id and .class shorthands remark-directive allows', () => {
    expect(failureCode(':action{#some-id}')).toBe('invalid-attribute-syntax');
    expect(failureCode(':action{.some-class}')).toBe('invalid-attribute-syntax');
    expect(failureCode(':action{command="c" #some-id}')).toBe('invalid-attribute-syntax');
  });

  test('neg: an uppercase-initial attribute name', () => {
    expect(failureCode(':action{Command="c"}')).toBe('invalid-attribute-syntax');
  });

  test('neg: a repeated key never silently loses the author intent', () => {
    const result = parseDirective(':action{command="first" command="second"}');
    expect(result.ok).toBe(false);
    expect(failureCode(':action{command="first" command="second"}')).toBe('duplicate-attribute');
    if (!result.ok) {
      expect(result.error).toContain("duplicate attribute 'command'");
    }
  });

  test('neg: two attributes with no whitespace between them', () => {
    expect(failureCode(':::scenario{page="home"icon="codicon-book"}\nт\n:::')).toBe(
      'invalid-attribute-syntax'
    );
  });

  test('neg: unterminated braces and unterminated value', () => {
    expect(failureCode(':action{command="c"')).toBe('unterminated-attributes');
    expect(failureCode(':action{command="c}')).toBe('unterminated-attributes');
    expect(failureCode(':action{command="c\nnext"}')).toBe('unterminated-attributes');
  });

  test(String.raw`neg: an escape other than \" or \\ inside a value`, () => {
    expect(failureCode(String.raw`:action{command="a\nb"}`)).toBe('invalid-escape');
    expect(failureCode(String.raw`:action{command="a\]b"}`)).toBe('invalid-escape');
  });

  test('neg: whitespace between the name and the braces', () => {
    expect(failureCode(':action {command="c"}')).toBe('space-before-attributes');
    expect(failureCode(':action[Пуск] {command="c"}')).toBe('space-before-attributes');
    expect(failureCode(':action\t{command="c"}')).toBe('space-before-attributes');
  });

  test('neg: whitespace between the name and the label', () => {
    expect(failureCode(':action [Пуск]{command="c"}')).toBe('space-before-label');
  });

  test('a bracketed markdown link after a labelled directive stays legal prose', () => {
    const source = ':doc[Экспорт]{page="book/export"} [и ссылка](http://x)';
    const directive = ok(parseDirective(source));
    expect(directive.label).toBe('Экспорт');
    expect(source.slice(directive.end)).toBe(' [и ссылка](http://x)');
  });
});

describe('A.3 label escaping and edge cases', () => {
  test('a label may hold quotes, apostrophes and cyrillic', () => {
    const directive = ok(parseDirective(':action[Он сказал "да", а не \'нет\']{command="c"}'));
    expect(directive.label).toBe('Он сказал "да", а не \'нет\'');
    expect(warningCodes(parseDirective(':action[Он сказал "да"]{command="c"}'))).toEqual([]);
  });

  // NB: these fixtures are plain quoted strings, not `String.raw` templates —
  // the bundler ASCII-escapes non-ASCII inside a template's RAW text, which
  // would silently hand the parser `р…` instead of the cyrillic label.
  test('\\] yields a literal ] inside the label', () => {
    const directive = ok(parseDirective(':action[режим \\] готов]{command="c"}'));
    expect(directive.label).toBe('режим ] готов');
  });

  test('\\\\ yields a literal backslash and does not escape the next ]', () => {
    const directive = ok(parseDirective(':action[путь C:\\\\]{command="c"}'));
    expect(directive.label).toBe('путь C:\\');
  });

  test('an unescaped ] closes the label — the rest is no longer the directive', () => {
    // The label ends at the FIRST unescaped `]`, so `{command="c"}` sits behind
    // prose and never reaches the directive: `command` is therefore missing.
    expect(failureCode(':action[метка] хвост]{command="c"}')).toBe('missing-attribute');
    const source = ':action[метка]{command="c"} хвост]';
    expect(ok(parseDirective(source)).label).toBe('метка');
    expect(source.slice(ok(parseDirective(source)).end)).toBe(' хвост]');
  });

  test('the §A.3 worked example parses clean, with no warnings', () => {
    const source =
      ':action[Открыть «Сверку» — режим \\] & <проверка>]{command="ai-focused-editor.proofreading.toggleMode"}';
    const result = parseDirective(source);
    expect(warningCodes(result)).toEqual([]);
    expect(ok(result).label).toBe('Открыть «Сверку» — режим ] & <проверка>');
  });

  test('neg: any escape other than \\] or \\\\ inside a label', () => {
    expect(failureCode(':action[строка\\nдалее]{command="c"}')).toBe('invalid-escape');
    expect(failureCode(':action[\\x41]{command="c"}')).toBe('invalid-escape');
    expect(failureCode(':action[звёзд\\*очка]{command="c"}')).toBe('invalid-escape');
  });

  test('neg: an unterminated label, including a trailing backslash', () => {
    expect(failureCode(':action[метка без конца')).toBe('unterminated-label');
    expect(failureCode(':action[метка\nдалее]{command="c"}')).toBe('unterminated-label');
    expect(failureCode(':action[метка\\')).toBe('invalid-escape');
  });
});

describe('A.5 the nine label metacharacters', () => {
  test.each([
    ['*', ':action[a*b*c]{command="c"}'],
    ['_', ':action[a_b_c]{command="c"}'],
    ['`', ':action[a`b`c]{command="c"}'],
    ['[', ':action[a[b]{command="c"}'],
    ['~', ':action[a~b~c]{command="c"}'],
    ['{', ':action[a{x}]{command="c"}'],
    ['}', ':action[b}c]{command="c"}']
  ])('unconditional metacharacter %s is reported', (char, source) => {
    const result = parseDirective(source);
    expect(warningCodes(result)).toEqual(['label-metacharacter']);
    if (result.ok) {
      expect(result.warnings[0].message).toContain(`metacharacter '${char}'`);
      // Degradable, not fatal: the runtime still renders the button (§A.4).
      expect(result.directive.label).toBeDefined();
    }
  });

  test('the position of a metacharacter points at the character itself', () => {
    const source = ':action[ab*c]{command="c"}';
    const result = parseDirective(source);
    if (!result.ok) {
      throw new Error('expected a parse');
    }
    expect(result.warnings[0].position.offset).toBe(source.indexOf('*'));
    expect(result.warnings[0].position.column).toBe(source.indexOf('*') + 1);
  });

  test('< is contextual: a tag-like follower is reported', () => {
    expect(warningCodes(parseDirective(':action[<b>жирный</b>]{command="c"}'))).toEqual([
      'label-metacharacter'
    ]);
    expect(warningCodes(parseDirective(':action[<https://x>]{command="c"}'))).toEqual([
      'label-metacharacter'
    ]);
  });

  test('< is contextual: ordinary prose is NOT reported', () => {
    expect(warningCodes(parseDirective(':action[если x < y, то]{command="c"}'))).toEqual([]);
    expect(warningCodes(parseDirective(':action[<проверка>]{command="c"}'))).toEqual([]);
  });

  test('& is contextual: a character reference is reported', () => {
    expect(warningCodes(parseDirective(':action[A&amp;B]{command="c"}'))).toEqual([
      'label-metacharacter'
    ]);
    expect(warningCodes(parseDirective(':action[A&#65;B]{command="c"}'))).toEqual([
      'label-metacharacter'
    ]);
    expect(warningCodes(parseDirective(':action[A&#x41;B]{command="c"}'))).toEqual([
      'label-metacharacter'
    ]);
  });

  test('& is contextual: ordinary prose is NOT reported', () => {
    expect(warningCodes(parseDirective(':action[A & B]{command="c"}'))).toEqual([]);
    expect(warningCodes(parseDirective(':action[Смит&Сын]{command="c"}'))).toEqual([]);
  });

  test('a decoded backslash is not mistaken for the row-8 rule', () => {
    expect(warningCodes(parseDirective(':action[путь C:\\\\]{command="c"}'))).toEqual([]);
  });

  test('findLabelMetacharacter reports the first violation and its rule', () => {
    expect(findLabelMetacharacter('обычный текст')).toBeUndefined();
    expect(findLabelMetacharacter('a{b*c')).toEqual({ char: '{', index: 1, rule: 9 });
    expect(findLabelMetacharacter('x<a href')).toEqual({ char: '<', index: 1, rule: 6 });
  });

  test('attribute values are OUT of scope of the metacharacter rule (§A.8)', () => {
    // Named boundary, not an oversight: `label=`/`title=` are free text.
    expect(warningCodes(parseDirective(':action{command="c" label="a*b{c}"}'))).toEqual([]);
  });
});

describe('A.6 the registry, directive by directive', () => {
  test('action: full, minimal, and missing its required attribute', () => {
    expect(ok(parseDirective(':action[Пуск]{command="c"}')).attributes).toEqual({ command: 'c' });
    expect(ok(parseDirective(':action{command="c"}')).label).toBeUndefined();
    expect(ok(parseDirective(':action{command="c" label="Пуск"}')).attributes.label).toBe('Пуск');
    expect(failureCode(':action{label="Пуск"}')).toBe('missing-attribute');
    expect(failureCode(':action')).toBe('missing-attribute');
  });

  test('settings: full, minimal, and missing its required attribute', () => {
    expect(ok(parseDirective(':settings[Модель]{query="ai.model"}')).attributes).toEqual({
      query: 'ai.model'
    });
    expect(ok(parseDirective('::settings{query="ai.model"}')).form).toBe('leaf');
    expect(failureCode(':settings{label="Модель"}')).toBe('missing-attribute');
  });

  test('doc: full, minimal, and missing its required attribute', () => {
    expect(ok(parseDirective(':doc[Экспорт]{page="book/export"}')).attributes.page).toBe('book/export');
    expect(ok(parseDirective(':doc{page="home"}')).label).toBeUndefined();
    expect(failureCode(':doc')).toBe('missing-attribute');
    expect(failureCode(':doc{}')).toBe('missing-attribute');
  });

  test('scenario: full, minimal, and missing its required attribute', () => {
    const full = ok(parseDirective(':::scenario{page="book/export" icon="codicon-book"}\nтело\n:::'));
    expect(full.attributes).toEqual({ page: 'book/export', icon: 'codicon-book' });
    expect(ok(parseDirective(':::scenario{page="home"}\nтело\n:::')).attributes).toEqual({
      page: 'home'
    });
    // §A.6 РЕШЕНИЕ: `page` was hardened to required against the design table.
    expect(failureCode(':::scenario{icon="codicon-book"}\nтело\n:::')).toBe('missing-attribute');
    expect(failureCode(':::scenario\nтело\n:::')).toBe('missing-attribute');
  });

  test('steps: full, minimal, and missing its required attribute', () => {
    const directive = ok(parseDirective(':::steps{id="setup"}\n1. раз\n2. два\n:::'));
    expect(directive.attributes.id).toBe('setup');
    expect(directive.body).toBe('1. раз\n2. два');
    expect(failureCode(':::steps\n1. раз\n:::')).toBe('missing-attribute');
  });

  test('requires: full and minimal — it has no required attribute', () => {
    expect(ok(parseDirective(':::requires{title="Нужно"}\nт\n:::')).attributes.title).toBe('Нужно');
    expect(ok(parseDirective(':::requires\nт\n:::')).attributes).toEqual({});
  });

  test('neg: [label] and label= together are refused rather than ranked', () => {
    expect(failureCode(':action[Пуск]{command="c" label="Пуск"}')).toBe('ambiguous-label');
    expect(failureCode(':settings[Модель]{query="q" label="Модель"}')).toBe('ambiguous-label');
  });

  test('neg: an unknown directive name', () => {
    const result = parseDirective(':unknown{command="c"}');
    expect(failureCode(':unknown{command="c"}')).toBe('unknown-directive');
    expect(failureCode(':::unknown\n:::')).toBe('unknown-directive');
    if (!result.ok) {
      expect(result.error).toContain('action, doc, requires, scenario, settings, steps');
    }
  });

  test('neg: an invalid directive name', () => {
    expect(failureCode(':Action{command="c"}')).toBe('invalid-name');
    expect(failureCode(':1action{command="c"}')).toBe('invalid-name');
    expect(failureCode(': action{command="c"}')).toBe('invalid-name');
  });

  test('an unknown attribute degrades: dropped, reported, directive survives', () => {
    const result = parseDirective(':action{command="c" bogus="x"}');
    expect(warningCodes(result)).toEqual(['unknown-attribute']);
    expect(ok(result).attributes).toEqual({ command: 'c' });
  });

  test('an icon failing /^codicon-[a-z0-9-]+$/ is dropped and reported', () => {
    const result = parseDirective(':::scenario{page="home" icon="evil onerror="}\nт\n:::');
    expect(warningCodes(result)).toEqual(['invalid-attribute-value']);
    // "иконка не выводится" (§A.4): the attribute never reaches the renderer.
    expect(ok(result).attributes).toEqual({ page: 'home' });
  });

  test('a well-formed icon is kept', () => {
    const result = parseDirective(':::scenario{page="home" icon="codicon-book"}\nт\n:::');
    expect(warningCodes(result)).toEqual([]);
    expect(ok(result).attributes.icon).toBe('codicon-book');
  });

  test.each([['codicon-Book'], ['codicon-'], ['book'], ['codicon-book '], ['codicon-book;x']])(
    'icon %p is rejected by the pattern',
    icon => {
      const result = parseDirective(`:::scenario{page="home" icon="${icon}"}\nт\n:::`);
      expect(warningCodes(result)).toEqual(['invalid-attribute-value']);
    }
  );
});

describe('A.4 the never-throws contract', () => {
  const garbage = [
    '',
    ':',
    '::',
    ':::',
    '::::',
    ':::::::::',
    ':a',
    ':action[',
    ':action]',
    ':action{',
    ':action}',
    ':action{"',
    ':action{=}',
    ':action{command=}',
    ':action{command="}',
    ':action[]{}',
    ':action[]',
    '\\',
    '\\\\',
    ':action[\\',
    ':::\n:::\n:::',
    ':::steps{id="a"}\n:::steps{id="b"}\n:::',
    'обычный текст без директив',
    ':action[«»—…]{command="c"}',
    ': {a="b"}',
    ':action{command=" "}',
    '::::::action[x]{y="z"}',
    ':action{command="c"}'.repeat(50)
  ];

  test.each(garbage)('parseDirective(%p) returns a result instead of throwing', source => {
    const result = parseDirective(source);
    expect(typeof result.ok).toBe('boolean');
    if (!result.ok) {
      expect(result.error.length).toBeGreaterThan(0);
      expect(result.position.line).toBeGreaterThanOrEqual(1);
      expect(result.position.column).toBeGreaterThanOrEqual(1);
    }
  });

  test('every prefix and every offset of a valid directive is survivable', () => {
    const source = ':::scenario{page="home" icon="codicon-book"}\nтело [x] "y"\n:::';
    for (let cut = 0; cut <= source.length; cut++) {
      expect(() => parseDirective(source.slice(0, cut))).not.toThrow();
      expect(() => parseDirective(source, cut)).not.toThrow();
    }
  });

  test('a random fuzz of directive-ish characters never throws', () => {
    const alphabet = ':{}[]"\\\n abcz-=*_`~<&#.19';
    let seed = 20260721;
    const nextInt = (bound: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % bound;
    };
    for (let iteration = 0; iteration < 3000; iteration++) {
      let source = '';
      for (let index = 0; index < nextInt(24); index++) {
        source += alphabet[nextInt(alphabet.length)];
      }
      expect(() => parseDirective(source)).not.toThrow();
    }
  });

  test('a fatal result carries a code, a message and a 1-based position', () => {
    const result = parseDirective('текст\n:action{command=oops}', 6);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('invalid-attribute-syntax');
      expect(result.position.line).toBe(2);
      expect(result.position.column).toBe(17);
      expect(result.error).toContain('double-quoted');
    }
  });
});

/** `name@offset` for every occurrence a scan found, in source order. */
function found(source: string): string[] {
  return scanDirectives(source).directives.map(directive => `${directive.name}@${directive.start}`);
}

/** `severity:code` for every finding of a scan, in source order. */
function findings(source: string): string[] {
  return scanDirectives(source).diagnostics.map(
    diagnostic => `${diagnostic.severity}:${diagnostic.code}`
  );
}

describe('scanDirectives', () => {
  test('an empty page yields nothing', () => {
    expect(scanDirectives('')).toEqual({ directives: [], diagnostics: [] });
  });

  test('a page with no directives yields nothing', () => {
    const source = '# Заголовок\n\nОбычный абзац текста.\n';
    expect(scanDirectives(source)).toEqual({ directives: [], diagnostics: [] });
  });

  test('several occurrences in one paragraph are all found, in order', () => {
    const source =
      'Нажмите :action[Пуск]{command="a.run"}, затем :settings[Модель]{query="ai.model"} и :doc[дальше]{page="next"}.';
    const result = scanDirectives(source);
    expect(result.directives.map(directive => directive.name)).toEqual([
      'action',
      'settings',
      'doc'
    ]);
    expect(result.directives.map(directive => directive.label)).toEqual([
      'Пуск',
      'Модель',
      'дальше'
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  test('two adjacent occurrences with no separator are both found', () => {
    expect(found(':doc{page="a"}:doc{page="b"}')).toEqual(['doc@0', 'doc@14']);
  });

  test('all three forms on one page', () => {
    const source = [
      '# Экспорт',
      '',
      ':::requires{title="Нужно"}',
      'Собранная книга.',
      ':::',
      '',
      'Откройте :doc[настройки]{page="settings"} заранее.',
      '',
      '::action[Собрать]{command="ai-focused-editor.book.build"}',
      '',
      ':::steps{id="export"}',
      '1. раз',
      '2. два',
      ':::'
    ].join('\n');
    const result = scanDirectives(source);
    expect(result.directives.map(directive => `${directive.name}/${directive.form}`)).toEqual([
      'requires/container',
      'doc/inline',
      'action/leaf',
      'steps/container'
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  test('a container body is scanned too — nested inline directives are found', () => {
    const source = ':::requires{title="Нужно"}\nСначала :doc[это]{page="x"}.\n\n::action{command="c"}\n:::';
    const result = scanDirectives(source);
    expect(result.directives.map(directive => directive.name)).toEqual([
      'requires',
      'doc',
      'action'
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  test('every finding of a page is collected in ONE pass, not just the first', () => {
    const source = [
      ':action{command=oops}',
      '',
      ':unknown{a="b"}',
      '',
      ':doc[метка*звезда]{page="p"}',
      '',
      ':settings{query="q" bogus="x"}',
      '',
      ':action[Пуск]{command="c" command="d"}'
    ].join('\n');
    expect(findings(source)).toEqual([
      'error:invalid-attribute-syntax',
      'error:unknown-directive',
      'warning:label-metacharacter',
      'warning:unknown-attribute',
      'error:duplicate-attribute'
    ]);
  });

  test('a failed occurrence is absent from directives; a degraded one is present', () => {
    const result = scanDirectives(':unknown{a="b"} и :action{command="c" bogus="x"}');
    expect(result.directives.map(directive => directive.name)).toEqual(['action']);
    expect(result.diagnostics.map(diagnostic => diagnostic.severity)).toEqual([
      'error',
      'warning'
    ]);
    // The degraded directive still lost its bad attribute (§A.4).
    expect(result.directives[0].attributes).toEqual({ command: 'c' });
  });

  test('findings carry a usable 1-based position for <file>:<line>:<col>', () => {
    const source = 'строка один\n\n:unknown{a="b"}\n';
    const [diagnostic] = scanDirectives(source).diagnostics;
    expect(diagnostic.position.line).toBe(3);
    expect(diagnostic.position.column).toBe(2);
  });
});

describe('scanDirectives and code', () => {
  test('a fenced block is skipped entirely — no directives AND no diagnostics', () => {
    const source = [
      'Пример разметки:',
      '',
      '```markdown',
      ':action[Пуск]{command="a.run"}',
      ':::scenario{page="home"}',
      'карточка',
      ':::',
      ':сломано{command=oops}',
      '```',
      '',
      'Настоящая кнопка: :action[Пуск]{command="a.run"}.'
    ].join('\n');
    const result = scanDirectives(source);
    // Exactly one — the one OUTSIDE the fence.
    expect(result.directives.length).toBe(1);
    expect(result.directives[0].start).toBe(source.lastIndexOf(':action'));
    expect(result.diagnostics).toEqual([]);
  });

  test('a ~~~ fence and a longer fence are honoured', () => {
    expect(scanDirectives('~~~\n:action{command="c"}\n~~~').directives).toEqual([]);
    expect(scanDirectives('````\n```\n:action{command="c"}\n```\n````').directives).toEqual([]);
  });

  test('an indented fence (up to three spaces) is still a fence', () => {
    expect(scanDirectives('   ```\n   :action{command="c"}\n   ```').directives).toEqual([]);
  });

  test('an unclosed fence swallows the rest of the page, as in CommonMark', () => {
    const result = scanDirectives('```\n:action{command="c"}\n:unknown{}\n');
    expect(result.directives).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  test('an inline code span is skipped, including a broken directive inside it', () => {
    const source = 'Пишите `:action[X]{command="c"}` или `:сломано{`, а кнопка — :doc{page="p"}.';
    const result = scanDirectives(source);
    expect(result.directives.map(directive => directive.name)).toEqual(['doc']);
    expect(result.diagnostics).toEqual([]);
  });

  test('a double-backtick span may hold a single backtick', () => {
    expect(scanDirectives('``:action[`]{command="c"}`` и :doc{page="p"}').directives.length).toBe(1);
  });

  test('an unclosed backtick run is literal text, so what follows is still scanned', () => {
    const result = scanDirectives('текст ` и :doc{page="p"}');
    expect(result.directives.map(directive => directive.name)).toEqual(['doc']);
  });

  test('a code span does not swallow across a blank line', () => {
    const result = scanDirectives('текст `открыт\n\n:doc{page="p"}\n\nи `закрыт');
    expect(result.directives.map(directive => directive.name)).toEqual(['doc']);
  });

  test('NAMED BOUNDARY: an indented code block is NOT recognised', () => {
    // Four-space indentation is a CommonMark code block, but telling it from a
    // list continuation needs block state we deliberately do not keep.
    expect(found('    :doc{page="p"}')).toEqual(['doc@4']);
  });
});

describe('scanDirectives and colons in prose', () => {
  test.each([
    ['Примечание: обычный текст.'],
    ['Время сбора 10:30 в среду.'],
    ['Ссылка https://example.com/path сюда.'],
    ['Соотношение 3:4 и путь C:/temp.'],
    ['Заголовок:\nследующая строка'],
    ['Двоеточие в конце:']
  ])('%p yields neither a directive nor a finding', source => {
    expect(scanDirectives(source)).toEqual({ directives: [], diagnostics: [] });
  });

  test('a backslash before the colon opts out explicitly', () => {
    expect(scanDirectives('\\:action[X]{command="c"}')).toEqual({
      directives: [],
      diagnostics: []
    });
  });

  test('NAMED COST: an ascii word pair after a colon IS read as an attempt', () => {
    // The trade is deliberate: ignoring anything not already in the registry
    // would make `:actoin[…]` render silently as text — a dead affordance.
    expect(findings('см. mailto:foo для связи')).toEqual(['error:unknown-directive']);
    expect(findings(':actoin[Пуск]{command="c"}')).toEqual(['error:unknown-directive']);
  });

  test('a lone ::: line, such as a stray closing fence, is not an attempt', () => {
    expect(scanDirectives('текст\n:::\nещё')).toEqual({ directives: [], diagnostics: [] });
  });
});

describe('scanDirectives never throws', () => {
  test('over arbitrary prefixes of a rich page', () => {
    const source = [
      '# Заголовок',
      '```ts',
      'const x: number = 1;',
      '```',
      ':::scenario{page="home" icon="codicon-book"}',
      'Текст с `кодом` и :action[Пуск]{command="c"}.',
      ':::',
      ':сломано{',
      '`незакрытый'
    ].join('\n');
    for (let cut = 0; cut <= source.length; cut++) {
      expect(() => scanDirectives(source.slice(0, cut))).not.toThrow();
    }
  });

  test('over a fuzz of directive-ish and markdown-ish characters', () => {
    const alphabet = ':{}[]"\\\n` ~abcz-=*_<&#.19';
    let seed = 20260722;
    const nextInt = (bound: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % bound;
    };
    for (let iteration = 0; iteration < 3000; iteration++) {
      let source = '';
      for (let index = 0; index < nextInt(60); index++) {
        source += alphabet[nextInt(alphabet.length)];
      }
      expect(() => scanDirectives(source)).not.toThrow();
    }
  });

  test('terminates on pathological colon runs', () => {
    expect(() => scanDirectives(':'.repeat(500))).not.toThrow();
    expect(() => scanDirectives(':::a\n'.repeat(200))).not.toThrow();
    expect(() => scanDirectives('`'.repeat(400))).not.toThrow();
  });
});

describe('positionAt', () => {
  test('counts lines and columns from one', () => {
    expect(positionAt('abc', 0)).toEqual({ offset: 0, line: 1, column: 1 });
    expect(positionAt('abc', 2)).toEqual({ offset: 2, line: 1, column: 3 });
    expect(positionAt('a\nbc', 2)).toEqual({ offset: 2, line: 2, column: 1 });
    expect(positionAt('a\nbc', 3)).toEqual({ offset: 3, line: 2, column: 2 });
  });

  test('clamps an out-of-range offset instead of returning NaN', () => {
    expect(positionAt('ab', 99)).toEqual({ offset: 2, line: 1, column: 3 });
    expect(positionAt('ab', -5)).toEqual({ offset: 0, line: 1, column: 1 });
  });
});
