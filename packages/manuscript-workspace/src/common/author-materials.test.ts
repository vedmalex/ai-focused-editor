import { describe, expect, test } from 'bun:test';
import {
  AUTHOR_MATERIALS_SECTION_ORDER,
  buildAuthorMaterialsSections,
  citationLabel,
  countManuscriptFiles,
  formatSectionLabel,
  isAllowedMaterialFile,
  isKnowledgeFile,
  joinUri,
  type AuthorMaterialsInput
} from './author-materials';
import type { ManuscriptNode } from './manuscript-workspace-protocol';
import type { NarrativeEntity, NarrativeEntityKind } from './narrative-entity-protocol';
import type { CitationEntry, SourceLibraryItem } from './source-library-protocol';
import {
  BASE_ENTITY_TYPES,
  mergeEntityTypes,
  type EntityTypeDescriptor
} from './entity-type-registry';

const ROOT = 'file:///workspace';

function entity(kind: NarrativeEntityKind, id: string, label: string): NarrativeEntity {
  return {
    kind,
    id,
    label,
    path: `entities/${kind}/${id}.yaml`,
    uri: `${ROOT}/entities/${kind}/${id}.yaml`,
    aliases: []
  };
}

function manuscriptFile(name: string): ManuscriptNode {
  return { id: name, name, path: `content/${name}`, type: 'file', order: 0, buildIncluded: true };
}

function manuscriptFolder(name: string, children: ManuscriptNode[]): ManuscriptNode {
  return { id: name, name, path: `content/${name}`, type: 'folder', order: 0, buildIncluded: true, children };
}

function baseInput(overrides: Partial<AuthorMaterialsInput> = {}): AuthorMaterialsInput {
  return {
    rootUri: ROOT,
    manuscript: [],
    entities: [],
    citations: [],
    citationsUri: `${ROOT}/sources/citations.yaml`,
    sources: [],
    knowledge: [],
    skills: [],
    ...overrides
  };
}

describe('section ordering', () => {
  test('sections are emitted in the fixed navigator order', () => {
    const sections = buildAuthorMaterialsSections(baseInput());
    expect(sections.map(section => section.kind)).toEqual([...AUTHOR_MATERIALS_SECTION_ORDER]);
  });

  test('only manuscript is expanded by default', () => {
    const sections = buildAuthorMaterialsSections(baseInput());
    for (const section of sections) {
      expect(section.expandedByDefault).toBe(section.kind === 'manuscript');
    }
  });
});

describe('counts', () => {
  test('per-section counts reflect their inputs', () => {
    const sections = buildAuthorMaterialsSections(baseInput({
      manuscript: [manuscriptFile('a.md'), manuscriptFolder('part', [manuscriptFile('b.md'), manuscriptFile('c.md')])],
      entities: [
        entity('character', 'alice', 'Alice'),
        entity('character', 'bob', 'Bob'),
        entity('term', 'flux', 'Flux'),
        entity('artifact', 'sword', 'Sword'),
        entity('location', 'keep', 'Keep')
      ],
      citations: [{ id: 'c1', title: 'Cite One' }],
      sources: [
        { name: 'a.pdf', path: 'sources/a.pdf', uri: `${ROOT}/sources/a.pdf`, type: 'file' },
        { name: 'nested', path: 'sources/nested', uri: `${ROOT}/sources/nested`, type: 'directory' }
      ],
      knowledge: [
        { name: 'world.md', path: 'knowledge/world.md', uri: `${ROOT}/knowledge/world.md` },
        { name: 'notes.txt', path: 'knowledge/notes.txt', uri: `${ROOT}/knowledge/notes.txt` }
      ],
      skills: [
        { id: 'style-guide', label: 'Style Guide', path: '.prompts/skills/style-guide/SKILL.md', uri: `${ROOT}/.prompts/skills/style-guide/SKILL.md` }
      ]
    }));
    const byKind = Object.fromEntries(sections.map(section => [section.kind, section.count]));
    expect(byKind.manuscript).toBe(3); // recursive file count
    expect(byKind.characters).toBe(2);
    expect(byKind.terms).toBe(1);
    expect(byKind.artifacts).toBe(1);
    expect(byKind.locations).toBe(1);
    expect(byKind.citations).toBe(1);
    expect(byKind.sources).toBe(1); // directory excluded
    expect(byKind.knowledge).toBe(1); // .txt excluded
    expect(byKind.skills).toBe(1);
  });

  test('countManuscriptFiles counts leaves recursively', () => {
    expect(countManuscriptFiles([])).toBe(0);
    expect(countManuscriptFiles([
      manuscriptFolder('p', [manuscriptFolder('q', [manuscriptFile('x.md')]), manuscriptFile('y.md')])
    ])).toBe(2);
  });

  test('formatSectionLabel appends the count', () => {
    const [manuscript] = buildAuthorMaterialsSections(baseInput({ manuscript: [manuscriptFile('a.md')] }));
    expect(formatSectionLabel(manuscript)).toBe('Manuscript (1)');
  });
});

describe('entity items', () => {
  test('entities are routed to their section and sorted by label', () => {
    const sections = buildAuthorMaterialsSections(baseInput({
      entities: [entity('character', 'bob', 'Bob'), entity('character', 'alice', 'Alice')]
    }));
    const characters = sections.find(section => section.kind === 'characters')!;
    expect(characters.items.map(item => item.label)).toEqual(['Alice', 'Bob']);
    expect(characters.items[0]).toMatchObject({
      id: 'alice',
      description: 'alice',
      uri: `${ROOT}/entities/character/alice.yaml`
    });
  });

  test('entity label falls back to id when blank', () => {
    const sections = buildAuthorMaterialsSections(baseInput({
      entities: [entity('term', 'flux', '   ')]
    }));
    const terms = sections.find(section => section.kind === 'terms')!;
    expect(terms.items[0].label).toBe('flux');
  });
});

describe('citation label fallbacks', () => {
  test('uses title when present, id otherwise', () => {
    expect(citationLabel({ id: 'c1', title: 'A Title' })).toBe('A Title');
    expect(citationLabel({ id: 'c2', title: '' })).toBe('c2');
    expect(citationLabel({ id: 'c3', title: '   ' })).toBe('c3');
  });

  test('citation opens the cited file when a path is present, else citations.yaml', () => {
    const withPath: CitationEntry = { id: 'c1', title: 'Cited', path: 'sources/ref one.pdf' };
    const withoutPath: CitationEntry = { id: 'c2', title: 'Bare' };
    const sections = buildAuthorMaterialsSections(baseInput({ citations: [withPath, withoutPath] }));
    const citations = sections.find(section => section.kind === 'citations')!;
    const bare = citations.items.find(item => item.id === 'c2')!;
    const cited = citations.items.find(item => item.id === 'c1')!;
    expect(bare.uri).toBe(`${ROOT}/sources/citations.yaml`);
    expect(cited.uri).toBe(`${ROOT}/sources/ref%20one.pdf`);
  });

  test('id is shown as description only when the label is the title', () => {
    const sections = buildAuthorMaterialsSections(baseInput({
      citations: [
        { id: 'titled', title: 'Human Title', source: 'src.pdf' },
        { id: 'untitled', title: '', source: 'src.pdf' }
      ]
    }));
    const citations = sections.find(section => section.kind === 'citations')!;
    expect(citations.items.find(item => item.id === 'titled')!.description).toBe('titled');
    // label === id here, so the source is surfaced instead of a duplicate id.
    expect(citations.items.find(item => item.id === 'untitled')!.description).toBe('src.pdf');
  });
});

describe('knowledge filtering', () => {
  test('keeps .yaml/.yml/.md and drops everything else', () => {
    expect(isKnowledgeFile('world.yaml')).toBe(true);
    expect(isKnowledgeFile('World.YML')).toBe(true);
    expect(isKnowledgeFile('notes.md')).toBe(true);
    expect(isKnowledgeFile('data.json')).toBe(false);
    expect(isKnowledgeFile('image.png')).toBe(false);
    expect(isKnowledgeFile('README')).toBe(false);
  });

  test('nested knowledge files keep their folder structure', () => {
    const sections = buildAuthorMaterialsSections(baseInput({
      knowledge: [
        { name: 'zeta.md', path: 'knowledge/zeta.md', uri: `${ROOT}/knowledge/zeta.md` },
        { name: 'alpha.yaml', path: 'knowledge/sub/alpha.yaml', uri: `${ROOT}/knowledge/sub/alpha.yaml` },
        { name: 'skip.bin', path: 'knowledge/skip.bin', uri: `${ROOT}/knowledge/skip.bin` },
        { name: '.gitignore', path: 'knowledge/.gitignore', uri: `${ROOT}/knowledge/.gitignore` }
      ]
    }));
    const knowledge = sections.find(section => section.kind === 'knowledge')!;
    expect(knowledge.count).toBe(2);
    // Folders sort first, then files.
    expect(knowledge.items.map(item => item.label)).toEqual(['sub', 'zeta.md']);
    expect(knowledge.items[0].itemType).toBe('folder');
    expect(knowledge.items[0].children!.map(item => item.label)).toEqual(['alpha.yaml']);
    expect(knowledge.items[0].children![0].description).toBe('knowledge/sub/alpha.yaml');
  });
});

describe('allowed material types', () => {
  test('accepts documents, images, and structural files; rejects dotfiles and binaries', () => {
    expect(isAllowedMaterialFile('notes.md')).toBe(true);
    expect(isAllowedMaterialFile('scan.PDF')).toBe(true);
    expect(isAllowedMaterialFile('map.png')).toBe(true);
    expect(isAllowedMaterialFile('data.jsonl')).toBe(true);
    expect(isAllowedMaterialFile('meta.yaml')).toBe(true);
    expect(isAllowedMaterialFile('chapter.docx')).toBe(true);
    expect(isAllowedMaterialFile('budget.xlsx')).toBe(true);
    expect(isAllowedMaterialFile('legacy.xls')).toBe(true);
    expect(isAllowedMaterialFile('sheet.ods')).toBe(true);
    expect(isAllowedMaterialFile('deck.pptx')).toBe(true);
    expect(isAllowedMaterialFile('old.ppt')).toBe(true);
    expect(isAllowedMaterialFile('scene.excalidraw')).toBe(true);
    expect(isAllowedMaterialFile('Diagram.EXCALIDRAW')).toBe(true);
    expect(isAllowedMaterialFile('.gitignore')).toBe(false);
    expect(isAllowedMaterialFile('.DS_Store')).toBe(false);
    expect(isAllowedMaterialFile('binary.exe')).toBe(false);
    expect(isAllowedMaterialFile('archive.zip')).toBe(false);
    expect(isAllowedMaterialFile('')).toBe(false);
  });

  test('sources keep nested folder structure and drop disallowed files', () => {
    const sections = buildAuthorMaterialsSections(baseInput({
      sources: [
        { name: 'gita-notes.md', path: 'sources/documents/gita-notes.md', uri: `${ROOT}/sources/documents/gita-notes.md`, type: 'file' },
        { name: 'map.png', path: 'sources/images/maps/map.png', uri: `${ROOT}/sources/images/maps/map.png`, type: 'file' },
        { name: '.gitignore', path: 'sources/.gitignore', uri: `${ROOT}/sources/.gitignore`, type: 'file' },
        { name: 'documents', path: 'sources/documents', uri: `${ROOT}/sources/documents`, type: 'directory' }
      ]
    }));
    const sources = sections.find(section => section.kind === 'sources')!;
    expect(sources.count).toBe(2);
    expect(sources.items.map(item => `${item.itemType}:${item.label}`)).toEqual(['folder:documents', 'folder:images']);
    const images = sources.items[1];
    expect(images.children![0].itemType).toBe('folder');
    expect(images.children![0].label).toBe('maps');
    expect(images.children![0].children![0].label).toBe('map.png');
  });
});

describe('skill items', () => {
  test('skills are listed, sorted by label, and open their SKILL.md', () => {
    const sections = buildAuthorMaterialsSections(baseInput({
      skills: [
        { id: 'voice', label: 'Voice', description: 'Narrative voice', path: '.prompts/skills/voice/SKILL.md', uri: `${ROOT}/.prompts/skills/voice/SKILL.md` },
        { id: 'style-guide', label: 'Style Guide', path: '.prompts/skills/style-guide/SKILL.md', uri: `${ROOT}/.prompts/skills/style-guide/SKILL.md` }
      ]
    }));
    const skills = sections.find(section => section.kind === 'skills')!;
    expect(skills.count).toBe(2);
    expect(skills.items.map(item => item.label)).toEqual(['Style Guide', 'Voice']);
    expect(skills.items[0]).toMatchObject({
      id: 'style-guide',
      // no frontmatter description -> path is surfaced as secondary text
      description: '.prompts/skills/style-guide/SKILL.md',
      uri: `${ROOT}/.prompts/skills/style-guide/SKILL.md`
    });
    expect(skills.items[1].description).toBe('Narrative voice');
  });

  test('skill label falls back to the slug when the frontmatter name is blank', () => {
    const sections = buildAuthorMaterialsSections(baseInput({
      skills: [
        { id: 'raw-slug', label: '   ', path: '.prompts/skills/raw-slug/SKILL.md', uri: `${ROOT}/.prompts/skills/raw-slug/SKILL.md` }
      ]
    }));
    const skills = sections.find(section => section.kind === 'skills')!;
    expect(skills.items[0].label).toBe('raw-slug');
  });
});

describe('dynamic author-type sections', () => {
  const faction: EntityTypeDescriptor = {
    id: 'faction',
    tagKind: 'faction',
    directory: 'factions',
    label: 'Фракция',
    sectionKind: 'factions',
    icon: 'codicon codicon-organization',
    sectionIcon: 'codicon codicon-organization',
    accentClass: 'afe-ico-faction',
    fields: []
  };
  const effective = mergeEntityTypes(BASE_ENTITY_TYPES, [faction]);

  test('author section is inserted after the built-in entity sections, before citations', () => {
    const sections = buildAuthorMaterialsSections(baseInput({ effectiveEntityTypes: effective }));
    expect(sections.map(section => section.kind)).toEqual([
      'manuscript', 'characters', 'terms', 'artifacts', 'locations', 'factions',
      'citations', 'sources', 'knowledge', 'skills'
    ]);
  });

  test('author section uses its label verbatim and carries a book-origin descriptor', () => {
    const sections = buildAuthorMaterialsSections(baseInput({ effectiveEntityTypes: effective }));
    const factions = sections.find(section => section.kind === 'factions')!;
    expect(factions.label).toBe('Фракция');
    expect(factions.expandedByDefault).toBe(false);
    expect(factions.entityType?.origin).toBe('book');
    expect(factions.entityType?.icon).toBe('codicon codicon-organization');
  });

  test('entities route to the author section by their kind id', () => {
    const sections = buildAuthorMaterialsSections(baseInput({
      effectiveEntityTypes: effective,
      entities: [
        entity('faction' as NarrativeEntityKind, 'rebels', 'Повстанцы'),
        entity('faction' as NarrativeEntityKind, 'empire', 'Империя'),
        entity('character', 'alice', 'Alice')
      ]
    }));
    const factions = sections.find(section => section.kind === 'factions')!;
    expect(factions.count).toBe(2);
    expect(factions.items.map(item => item.label)).toEqual(['Империя', 'Повстанцы']);
    // Built-in sections are unaffected by the author kind.
    const characters = sections.find(section => section.kind === 'characters')!;
    expect(characters.items.map(item => item.label)).toEqual(['Alice']);
  });

  test('built-in entity sections carry a built-in-origin descriptor and plural label', () => {
    const sections = buildAuthorMaterialsSections(baseInput({ effectiveEntityTypes: effective }));
    const characters = sections.find(section => section.kind === 'characters')!;
    expect(characters.entityType?.origin).toBe('built-in');
    expect(characters.label).toBe('Characters');
  });

  test('an effective list with no author types yields exactly the base section order', () => {
    const builtInOnly = mergeEntityTypes(BASE_ENTITY_TYPES, []);
    const sections = buildAuthorMaterialsSections(baseInput({ effectiveEntityTypes: builtInOnly }));
    expect(sections.map(section => section.kind)).toEqual([...AUTHOR_MATERIALS_SECTION_ORDER]);
  });
});

describe('joinUri', () => {
  test('encodes segments and normalises slashes', () => {
    expect(joinUri('file:///root/', 'sources/a b.pdf')).toBe('file:///root/sources/a%20b.pdf');
    expect(joinUri(undefined, 'x')).toBeUndefined();
  });
});

describe('source items', () => {
  test('only files are listed and are openable', () => {
    const sources: SourceLibraryItem[] = [
      { name: 'b.pdf', path: 'sources/b.pdf', uri: `${ROOT}/sources/b.pdf`, type: 'file' },
      { name: 'a.pdf', path: 'sources/a.pdf', uri: `${ROOT}/sources/a.pdf`, type: 'file' },
      { name: 'dir', path: 'sources/dir', uri: `${ROOT}/sources/dir`, type: 'directory' }
    ];
    const sections = buildAuthorMaterialsSections(baseInput({ sources }));
    const section = sections.find(entry => entry.kind === 'sources')!;
    expect(section.items.map(item => item.label)).toEqual(['a.pdf', 'b.pdf']);
    expect(section.items[0].uri).toBe(`${ROOT}/sources/a.pdf`);
  });
});
