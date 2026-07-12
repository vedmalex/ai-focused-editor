import { describe, expect, test } from 'bun:test';
import { buildEntityHoverMarkdown, type EntityHoverLocalizeHooks } from './entity-hover';
import {
  BASE_ENTITY_TYPES,
  entityTypeById,
  parseEntityTypesYaml,
  type EntityFieldDescriptor,
  type EntityTypeDescriptor
} from './entity-type-registry';

function capitalize(value: string): string {
  return value.length > 0 ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

/** Deterministic hooks: field label = capitalized name, type label = descriptor.label. */
function hooks(overrides: Partial<EntityHoverLocalizeHooks> = {}): EntityHoverLocalizeHooks {
  return {
    fieldLabel: (field: EntityFieldDescriptor) => capitalize(field.name),
    typeLabel: (type: EntityTypeDescriptor) => type.label,
    openLabel: 'Open card',
    missingCardText: 'No card found for this tag yet.',
    ...overrides
  };
}

const characterType = entityTypeById('character')!;

/** The author `sloka` descriptor, parsed exactly as the runtime loads it. */
const slokaType = parseEntityTypesYaml(`
types:
  - id: sloka
    label: Шлока
    fields:
      - name: name
        kind: text
      - name: summary
        kind: textarea
      - name: notes
        kind: textarea
`).types[0];

describe('buildEntityHoverMarkdown — built-in character card', () => {
  const cardYaml = [
    'id: krishna',
    'name: Krishna',
    'aliases:',
    '  - Govinda',
    '  - Madhava',
    'epithets:',
    '  - Slayer of Madhu',
    'summary: Divine guide and speaker whose counsel frames the chapter.',
    "speechPatterns:",
    '  - Answers a question with a wider principle'
  ].join('\n');

  const markdown = buildEntityHoverMarkdown({
    cardYaml,
    descriptor: characterType,
    tagLabel: 'Krishna',
    id: 'krishna',
    openCommandUri: 'command:open?%5B%22uri%22%5D',
    localize: hooks()
  });

  test('header folds the label and id, showing the type label', () => {
    expect(markdown.startsWith('**Krishna** — Character · krishna')).toBe(true);
  });

  test('list fields render as comma-joined values', () => {
    expect(markdown).toContain('Aliases: Govinda, Madhava');
    expect(markdown).toContain('Epithets: Slayer of Madhu');
    expect(markdown).toContain('SpeechPatterns: Answers a question with a wider principle');
  });

  test('textarea fields render as their own label paragraph plus value', () => {
    expect(markdown).toContain('Summary:\n\nDivine guide and speaker whose counsel frames the chapter.');
  });

  test('empty schema fields are skipped', () => {
    expect(markdown).not.toContain('Backstory:');
    expect(markdown).not.toContain('Arc:');
    expect(markdown).not.toContain('Notes:');
  });

  test('id and label roles are not repeated as their own rows', () => {
    expect(markdown).not.toContain('Id:');
    expect(markdown).not.toContain('Name:');
  });

  test('footer link uses the encoded open command uri', () => {
    expect(markdown.endsWith('[Open card](command:open?%5B%22uri%22%5D)')).toBe(true);
  });
});

describe('buildEntityHoverMarkdown — author sloka card', () => {
  const cardYaml = [
    'id: bg-2-47',
    'name: Право на действие (2.47)',
    'summary: >-',
    '  «У тебя есть право на действие, но не на его плоды.»',
    'notes: Опорная шлока для главы о поле решения.'
  ].join('\n');

  const markdown = buildEntityHoverMarkdown({
    cardYaml,
    descriptor: slokaType,
    tagLabel: 'bg-2-47',
    id: 'bg-2-47',
    localize: hooks()
  });

  test('header uses the card name and localized type label', () => {
    expect(markdown.startsWith('**Право на действие (2.47)** — Шлока · bg-2-47')).toBe(true);
  });

  test('renders both author textarea fields', () => {
    expect(markdown).toContain('Summary:\n\n«У тебя есть право на действие, но не на его плоды.»');
    expect(markdown).toContain('Notes:\n\nОпорная шлока для главы о поле решения.');
  });

  test('no footer when no open command uri is given', () => {
    expect(markdown).not.toContain('[Open card]');
  });
});

describe('buildEntityHoverMarkdown — truncation and unknown keys', () => {
  test('long textarea values are truncated on a word boundary with an ellipsis', () => {
    const word = 'lorem ';
    const longSummary = word.repeat(80).trim(); // ~479 chars
    const markdown = buildEntityHoverMarkdown({
      cardYaml: `id: x\nname: X\nsummary: ${longSummary}`,
      descriptor: characterType,
      tagLabel: 'X',
      id: 'x',
      localize: hooks()
    });
    const summaryLine = markdown.split('\n\n').find(block => block.startsWith('lorem'))!;
    expect(summaryLine.endsWith('…')).toBe(true);
    expect(summaryLine.length).toBeLessThanOrEqual(281);
    expect(summaryLine).not.toContain('loremlorem');
  });

  test('extra top-level keys not in the schema render with their raw key as label', () => {
    const markdown = buildEntityHoverMarkdown({
      cardYaml: [
        'id: gada',
        'name: Gada',
        'ownership: Bhima',
        'tags:',
        '  - weapon',
        '  - divine'
      ].join('\n'),
      descriptor: entityTypeById('artifact')!,
      tagLabel: 'Gada',
      id: 'gada',
      localize: hooks()
    });
    expect(markdown).toContain('ownership: Bhima');
    expect(markdown).toContain('tags: weapon, divine');
  });
});

describe('buildEntityHoverMarkdown — malformed yaml and escaping', () => {
  test('malformed yaml degrades to header plus the missing-card text, never throwing', () => {
    const markdown = buildEntityHoverMarkdown({
      cardYaml: 'id: [unterminated\n  : : :',
      descriptor: characterType,
      tagLabel: 'Broken',
      id: 'broken',
      openCommandUri: 'command:open?args',
      localize: hooks()
    });
    expect(markdown).toContain('**Broken** — Character · broken');
    expect(markdown).toContain('No card found for this tag yet.');
    expect(markdown.endsWith('[Open card](command:open?args)')).toBe(true);
  });

  test('empty card yaml falls back to the missing-card text', () => {
    const markdown = buildEntityHoverMarkdown({
      cardYaml: '',
      descriptor: characterType,
      tagLabel: 'Nobody',
      id: 'nobody',
      localize: hooks()
    });
    expect(markdown).toContain('**Nobody** — Character · nobody');
    expect(markdown).toContain('No card found for this tag yet.');
  });

  test('markdown-sensitive characters in values are backslash-escaped', () => {
    const markdown = buildEntityHoverMarkdown({
      cardYaml: [
        'id: x',
        'name: "Evil <b> [x](y)"',
        'summary: "see [here](http://evil) and <script>"'
      ].join('\n'),
      descriptor: characterType,
      tagLabel: 'X',
      id: 'x',
      localize: hooks()
    });
    expect(markdown).toContain('**Evil \\<b\\> \\[x\\](y)**');
    expect(markdown).toContain('see \\[here\\](http://evil) and \\<script\\>');
    expect(markdown).not.toContain('<script>');
  });

  test('descriptors with no fields still render a header from the tag', () => {
    const bareType: EntityTypeDescriptor = {
      id: 'ghost',
      tagKind: 'ghost',
      directory: 'ghosts',
      label: 'Ghost',
      sectionKind: 'ghosts',
      icon: '',
      sectionIcon: '',
      fields: []
    };
    const markdown = buildEntityHoverMarkdown({
      cardYaml: undefined,
      descriptor: bareType,
      tagLabel: 'Casper',
      id: 'casper',
      localize: hooks()
    });
    expect(markdown).toBe('**Casper** — Ghost · casper\n\nNo card found for this tag yet.');
  });
});

describe('BASE_ENTITY_TYPES sanity', () => {
  test('the character type exposes id and label roles the header folds', () => {
    const roles = BASE_ENTITY_TYPES[0].fields.filter(field => field.role);
    expect(roles.map(field => field.role)).toEqual(['id', 'label']);
  });
});
