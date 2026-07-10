import { DisposableCollection } from '@theia/core/lib/common';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { injectable } from '@theia/core/shared/inversify';
import * as monaco from '@theia/monaco-editor-core';

const MARKDOWN_LANGUAGE_ID = 'markdown';

/**
 * Registers a Monarch tokenizer so `.md` / `.markdown` files are syntax
 * highlighted in the Monaco editor.
 *
 * The browser bundle of `@theia/monaco-editor-core` ships no VS Code builtin
 * TextMate grammars, so Markdown opens unhighlighted even though the `markdown`
 * language id is registered (our semantic providers already attach to it). We
 * add the well-known Monarch grammar to close that gap. Semantic
 * `[[kind:id|label]]` decorations are layered on top via editor decorations, so
 * they keep rendering above this tokenization.
 *
 * `markdownTokenizer` is a compact reimplementation of the Markdown grammar from
 * `monaco-editor`'s `basic-languages` package
 * (microsoft/monaco-editor, MIT licensed), which is not available in this build.
 */
@injectable()
export class MarkdownLanguageContribution implements FrontendApplicationContribution {
  protected readonly toDispose = new DisposableCollection();

  onStart(): void {
    if (!monaco.languages.getLanguages().some(language => language.id === MARKDOWN_LANGUAGE_ID)) {
      monaco.languages.register({
        id: MARKDOWN_LANGUAGE_ID,
        extensions: ['.md', '.markdown', '.mdown', '.mkdn', '.mkd', '.mdwn'],
        aliases: ['Markdown', 'markdown']
      });
    }

    this.toDispose.push(
      monaco.languages.setMonarchTokensProvider(MARKDOWN_LANGUAGE_ID, markdownTokenizer)
    );
    this.toDispose.push(
      monaco.languages.setLanguageConfiguration(MARKDOWN_LANGUAGE_ID, markdownLanguageConfiguration)
    );
  }

  onStop(): void {
    this.toDispose.dispose();
  }
}

const markdownLanguageConfiguration: monaco.languages.LanguageConfiguration = {
  comments: { blockComment: ['<!--', '-->'] },
  brackets: [
    ['{', '}'],
    ['[', ']'],
    ['(', ')']
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '`', close: '`' },
    { open: '"', close: '"' },
    { open: "'", close: "'" }
  ],
  surroundingPairs: [
    { open: '(', close: ')' },
    { open: '[', close: ']' },
    { open: '`', close: '`' },
    { open: '_', close: '_' },
    { open: '*', close: '*' },
    { open: '"', close: '"' },
    { open: "'", close: "'" }
  ]
};

// Monarch Markdown grammar, ported from monaco-editor basic-languages/markdown
// (microsoft/monaco-editor, MIT). Trimmed to a self-contained definition.
const markdownTokenizer: monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.md',

  // escape codes
  control: /[\\`*_[\]{}()#+\-.!]/,
  noncontrol: /[^\\`*_[\]{}()#+\-.!]/,
  escapes: /\\(?:@control)/,

  // escape codes for javascript/html
  // eslint-disable-next-line no-useless-escape
  jsescapes: /\\(?:[btnfr\\"']|[0-7][0-7]?|[0-3][0-7]{2})/,

  // non matched elements
  empty: [
    'area', 'base', 'basefont', 'br', 'col', 'frame',
    'hr', 'img', 'input', 'isindex', 'link', 'meta', 'param'
  ],

  tokenizer: {
    root: [
      // headers (with #)
      [/^(\s{0,3})(#+)((?:[^\\#]|@escapes)+)((?:#+)?)/, ['white', 'keyword', 'keyword', 'keyword']],

      // headers (with =)
      [/^\s*(=+|-+)\s*$/, 'keyword'],

      // headers (with ***)
      [/^\s*((\*[ ]?)+)\s*$/, 'meta.separator'],

      // quote
      [/^\s*>+/, 'comment'],

      // list (starting with * or number)
      [/^\s*([*\-+:]|\d+\.)\s/, 'keyword'],

      // code block (4 spaces indentation)
      [/^(\t|[ ]{4})[^ ].*$/, 'string'],

      // code block (3 tilde)
      [/^\s*~~~\s*((?:\w|[/\-#])+)?\s*$/, { token: 'string', next: '@codeblock' }],

      // github style code blocks (with backticks and language)
      [/^\s*```\s*((?:\w|[/\-#])+).*$/, { token: 'string', next: '@codeblockgh' }],

      // github style code blocks (with backticks but no language)
      [/^\s*```\s*$/, { token: 'string', next: '@codeblock' }],

      // markup within lines
      { include: '@linecontent' }
    ],

    codeblock: [
      [/^\s*~~~\s*$/, { token: 'string', next: '@pop' }],
      [/^\s*```\s*$/, { token: 'string', next: '@pop' }],
      [/.*$/, 'variable.source']
    ],

    // github style code blocks
    codeblockgh: [
      [/```\s*$/, { token: 'string', next: '@pop' }],
      [/[^`]+/, 'variable.source']
    ],

    linecontent: [
      // escapes
      [/&\w+;/, 'string.escape'],
      [/@escapes/, 'escape'],

      // various markup
      [/\b__([^\\_]|@escapes|_(?!_))+__\b/, 'strong'],
      [/\*\*([^\\*]|@escapes|\*(?!\*))+\*\*/, 'strong'],
      [/\b_[^_]+_\b/, 'emphasis'],
      [/\*([^\\*]|@escapes)+\*/, 'emphasis'],

      // strikethrough (GFM)
      [/~~([^\\~]|@escapes)+~~/, 'strikethrough'],

      // code block (with backticks)
      [/`([^\\`]|@escapes)+`/, 'variable'],

      // links
      [/\{+[^}]+\}+/, 'string.target'],
      [/(!?\[)((?:[^\]\\]|@escapes)*)(\]\([^)]+\))/, ['string.link', '', 'string.link']],
      [/(!?\[)((?:[^\]\\]|@escapes)*)(\])/, 'string.link'],

      // or html
      { include: 'html' }
    ],

    // Note: it is tempting to rather switch to the real HTML mode instead of
    // building a simplified html here, but that would break markdown highlighting
    // when the closing tag is on a different line.
    html: [
      // html tags
      [/<(\w+)\/>/, 'tag'],
      [
        /<(\w+)(\-|\w)*/,
        {
          cases: {
            '@empty': { token: 'tag', next: '@tag.$1' },
            '@default': { token: 'tag', next: '@tag.$1' }
          }
        }
      ],
      [/<\/(\w+)(\-|\w)*\s*>/, { token: 'tag' }],

      [/<!--/, 'comment', '@comment']
    ],

    comment: [
      [/[^<-]+/, 'comment.content'],
      [/-->/, 'comment', '@pop'],
      [/<!--/, 'comment.content.invalid'],
      [/[<-]/, 'comment.content']
    ],

    // Almost full HTML tag matching, complete with embedded scripts & styles
    tag: [
      [/[ \t\r\n]+/, 'white'],
      [
        /(type)(\s*=\s*)(")([^"]+)(")/,
        ['attribute.name.html', 'delimiter.html', 'string.html', 'string.html', 'string.html']
      ],
      [
        /(type)(\s*=\s*)(')([^']+)(')/,
        ['attribute.name.html', 'delimiter.html', 'string.html', 'string.html', 'string.html']
      ],
      [/(\w+)(\s*=\s*)("[^"]*"|'[^']*')/, ['attribute.name.html', 'delimiter.html', 'string.html']],
      [/\w+/, 'attribute.name.html'],
      [/\/>/, 'tag', '@pop'],
      [/>/, { token: 'tag', next: '@pop' }]
    ],

  }
};
