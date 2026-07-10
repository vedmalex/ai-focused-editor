import {
  normalizeSemanticMarkdownTags,
  parseSemanticMarkdown
} from '@ai-focused-editor/semantic-markdown';
import {
  Command,
  CommandContribution,
  CommandRegistry,
  MenuContribution,
  MenuModelRegistry,
  MessageService
} from '@theia/core/lib/common';
import { ClipboardService } from '@theia/core/lib/browser/clipboard-service';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import type { TextEditor } from '@theia/editor/lib/browser/editor';
import {
  EDITOR_CONTEXT_MENU,
  EditorContextMenu
} from '@theia/editor/lib/browser/editor-menu';
import { inject, injectable } from '@theia/core/shared/inversify';
import {
  AI_FOCUSED_EDITOR_MENU_LABEL,
  AiFocusedEditorMenus
} from './ai-focused-editor-menu';

type SemanticQuickActionKind = 'char' | 'term' | 'artifact';

export namespace SemanticMarkdownActionCommands {
  export const WRAP_SELECTION_AS_CHARACTER: Command = {
    id: 'ai-focused-editor.semanticMarkdown.wrapSelectionAsCharacter',
    label: 'AI Focused Editor: Wrap Selection as Character Tag'
  };

  export const WRAP_SELECTION_AS_TERM: Command = {
    id: 'ai-focused-editor.semanticMarkdown.wrapSelectionAsTerm',
    label: 'AI Focused Editor: Wrap Selection as Term Tag'
  };

  export const WRAP_SELECTION_AS_ARTIFACT: Command = {
    id: 'ai-focused-editor.semanticMarkdown.wrapSelectionAsArtifact',
    label: 'AI Focused Editor: Wrap Selection as Artifact Tag'
  };

  export const COPY_TAG_SUMMARY: Command = {
    id: 'ai-focused-editor.semanticMarkdown.copyTagSummary',
    label: 'AI Focused Editor: Copy Semantic Tag Summary'
  };

  export const NORMALIZE_TAGS: Command = {
    id: 'ai-focused-editor.semanticMarkdown.normalizeTags',
    label: 'AI Focused Editor: Normalize Semantic Markdown Tags'
  };
}

@injectable()
export class SemanticMarkdownActionsContribution implements CommandContribution, MenuContribution {
  @inject(EditorManager)
  protected readonly editorManager!: EditorManager;

  @inject(MessageService)
  protected readonly messages!: MessageService;

  @inject(ClipboardService)
  protected readonly clipboard!: ClipboardService;

  registerCommands(registry: CommandRegistry): void {
    registry.registerCommand(SemanticMarkdownActionCommands.WRAP_SELECTION_AS_CHARACTER, {
      execute: () => this.wrapSelection('char')
    });
    registry.registerCommand(SemanticMarkdownActionCommands.WRAP_SELECTION_AS_TERM, {
      execute: () => this.wrapSelection('term')
    });
    registry.registerCommand(SemanticMarkdownActionCommands.WRAP_SELECTION_AS_ARTIFACT, {
      execute: () => this.wrapSelection('artifact')
    });
    registry.registerCommand(SemanticMarkdownActionCommands.COPY_TAG_SUMMARY, {
      execute: () => this.copyTagSummary()
    });
    registry.registerCommand(SemanticMarkdownActionCommands.NORMALIZE_TAGS, {
      execute: () => this.normalizeTags()
    });
  }

  registerMenus(menus: MenuModelRegistry): void {
    const menuPath = AiFocusedEditorMenus.SEMANTIC_MARKDOWN;
    for (const command of [
      SemanticMarkdownActionCommands.WRAP_SELECTION_AS_CHARACTER,
      SemanticMarkdownActionCommands.WRAP_SELECTION_AS_TERM,
      SemanticMarkdownActionCommands.WRAP_SELECTION_AS_ARTIFACT,
      SemanticMarkdownActionCommands.COPY_TAG_SUMMARY,
      SemanticMarkdownActionCommands.NORMALIZE_TAGS
    ]) {
      menus.registerMenuAction(menuPath, {
        commandId: command.id
      });
    }

    const editorMenuPath = [...EDITOR_CONTEXT_MENU, ...EditorContextMenu.MODIFICATION];
    menus.registerMenuAction(editorMenuPath, {
      commandId: SemanticMarkdownActionCommands.WRAP_SELECTION_AS_CHARACTER.id
    });
    menus.registerMenuAction(editorMenuPath, {
      commandId: SemanticMarkdownActionCommands.WRAP_SELECTION_AS_TERM.id
    });
    menus.registerMenuAction(editorMenuPath, {
      commandId: SemanticMarkdownActionCommands.WRAP_SELECTION_AS_ARTIFACT.id
    });
    menus.registerMenuAction(editorMenuPath, {
      commandId: SemanticMarkdownActionCommands.NORMALIZE_TAGS.id
    });
  }

  protected async wrapSelection(kind: SemanticQuickActionKind): Promise<void> {
    const editor = this.getMarkdownEditor();
    if (!editor) {
      await this.messages.warn('Open a Markdown editor before wrapping a semantic tag.');
      return;
    }

    const selectedText = editor.document.getText(editor.selection);
    const label = selectedText.trim();
    if (!label) {
      await this.messages.warn('Select text before wrapping it as a semantic tag.');
      return;
    }
    if (/[\r\n]/.test(label)) {
      await this.messages.warn('Semantic tag quick actions support single-line selections only.');
      return;
    }
    if (label.startsWith('[[') && label.endsWith(']]')) {
      await this.messages.warn('Selection already looks like a semantic tag.');
      return;
    }

    const safeLabel = label.replace(/[|\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!safeLabel) {
      await this.messages.warn('Selection cannot be converted to a semantic tag label.');
      return;
    }

    const leading = selectedText.match(/^\s*/)?.[0] ?? '';
    const trailing = selectedText.match(/\s*$/)?.[0] ?? '';
    const id = this.createSemanticId(kind, safeLabel);
    const replacement = `${leading}[[${kind}:${id}|${safeLabel}]]${trailing}`;
    const replaced = await editor.replaceText({
      source: `ai-focused-editor.semanticMarkdown.wrap.${kind}`,
      replaceOperations: [{
        range: editor.selection,
        text: replacement
      }]
    });

    if (replaced) {
      await this.messages.info(`Wrapped selection as ${this.getKindLabel(kind)} tag: ${kind}:${id}`);
    } else {
      await this.messages.warn('Theia editor did not apply the semantic tag replacement.');
    }
  }

  protected async copyTagSummary(): Promise<void> {
    const editor = this.getMarkdownEditor();
    if (!editor) {
      await this.messages.warn('Open a Markdown editor before copying semantic tag summary.');
      return;
    }

    const tags = parseSemanticMarkdown(editor.document.getText()).tags;
    if (tags.length === 0) {
      await this.messages.warn('No semantic tags found in the active Markdown editor.');
      return;
    }

    const lines = [
      `# Semantic Tags: ${editor.uri.path.base}`,
      '',
      ...tags.map(tag => `- ${tag.kind}:${tag.id} -> ${tag.label} (line ${tag.range.start.line + 1})`)
    ];
    await this.clipboard.writeText(lines.join('\n'));
    await this.messages.info(`Copied ${tags.length} semantic tag(s) to clipboard.`);
  }

  protected async normalizeTags(): Promise<void> {
    const editor = this.getMarkdownEditor();
    if (!editor) {
      await this.messages.warn('Open a Markdown editor before normalizing semantic tags.');
      return;
    }

    const text = editor.document.getText();
    const normalized = normalizeSemanticMarkdownTags(text);
    if (normalized === text) {
      await this.messages.info('Semantic Markdown tags are already normalized.');
      return;
    }

    const replaced = await editor.replaceText({
      source: SemanticMarkdownActionCommands.NORMALIZE_TAGS.id,
      replaceOperations: [{
        range: this.fullDocumentRange(text),
        text: normalized
      }]
    });

    if (replaced) {
      await this.messages.info('Semantic Markdown tags normalized.');
    } else {
      await this.messages.warn('Theia editor did not apply semantic tag normalization.');
    }
  }

  protected getMarkdownEditor(): TextEditor | undefined {
    const editor = this.editorManager.currentEditor?.editor ?? this.editorManager.activeEditor?.editor;
    if (!editor || !this.isMarkdownEditor(editor)) {
      return undefined;
    }
    return editor;
  }

  protected isMarkdownEditor(editor: TextEditor): boolean {
    return editor.uri.path.ext.toLowerCase() === '.md' || editor.document.languageId === 'markdown';
  }

  protected createSemanticId(kind: SemanticQuickActionKind, label: string): string {
    const slug = label.normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9_.:-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48);

    return slug || `${kind}-${this.hashLabel(label)}`;
  }

  protected hashLabel(label: string): string {
    let hash = 0;
    for (let index = 0; index < label.length; index++) {
      hash = ((hash << 5) - hash + label.charCodeAt(index)) | 0;
    }
    return Math.abs(hash).toString(36);
  }

  protected getKindLabel(kind: SemanticQuickActionKind): string {
    switch (kind) {
      case 'char':
        return 'character';
      case 'term':
        return 'term';
      case 'artifact':
        return 'artifact';
    }
  }

  protected fullDocumentRange(text: string): TextEditor['selection'] {
    const lines = text.split(/\r?\n/);
    const lastLine = Math.max(0, lines.length - 1);
    return {
      start: {
        line: 0,
        character: 0
      },
      end: {
        line: lastLine,
        character: lines[lastLine]?.length ?? 0
      },
      direction: 'ltr'
    };
  }
}
