import {
  Command,
  CommandContribution,
  CommandRegistry,
  MenuContribution,
  MenuModelRegistry,
  MessageService
} from '@theia/core/lib/common';
import URI from '@theia/core/lib/common/uri';
import {
  open,
  OpenerService
} from '@theia/core/lib/browser';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import type { TextEditor } from '@theia/editor/lib/browser/editor';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { inject, injectable } from '@theia/core/shared/inversify';
import { stringify } from 'yaml';
import {
  AiConnectionService,
  AiModeRegistry,
  generateWithFailover
} from '../common';
import {
  coerceKnowledge,
  slugifyChapter,
  type KnowledgeCoercion,
  type KnowledgeDocument,
  type KnowledgeKind,
  type KnowledgeMeta
} from '../common/knowledge-generation';
import { AiProfilePreferenceService } from './ai-profile-preference-service';
import {
  AiHistoryRecord,
  AiHistoryService
} from './ai-history-service';
import { AiFocusedEditorMenus } from './ai-focused-editor-menu';

const AI_FOCUSED_EDITOR_CATEGORY = 'AI Focused Editor';

export namespace AiFocusedEditorKnowledgeCommands {
  export const SUMMARIZE_CHAPTER: Command = {
    id: 'ai-focused-editor.knowledge.summarizeChapter',
    category: AI_FOCUSED_EDITOR_CATEGORY,
    label: 'Summarize Current Chapter'
  };

  export const GENERATE_SCENE_PLAN: Command = {
    id: 'ai-focused-editor.knowledge.generateScenePlan',
    category: AI_FOCUSED_EDITOR_CATEGORY,
    label: 'Generate Scene Plan for Current Chapter'
  };

  export const GENERATE_AUTHOR_QUESTIONS: Command = {
    id: 'ai-focused-editor.knowledge.generateAuthorQuestions',
    category: AI_FOCUSED_EDITOR_CATEGORY,
    label: 'Generate Author Questions for Current Chapter'
  };
}

interface KnowledgeCommandConfig {
  readonly command: Command;
  /** AiMode id looked up in the project's `custom-modes.yaml`. */
  readonly modeId: string;
  /** logContext id when no project mode is defined. */
  readonly builtinModeId: string;
  /** `knowledge/<subdir>/<slug>.yaml`. */
  readonly subdir: string;
  /** Human-readable noun for notifications. */
  readonly title: string;
  /** Progress-bar verb phrase. */
  readonly progressLabel: string;
  /** AiHistory event kind. */
  readonly historyKind: string;
  /** STRICT-JSON system prompt used when no project mode overrides it. */
  readonly builtinSystemPrompt: string;
}

const KNOWLEDGE_COMMANDS: Record<KnowledgeKind, KnowledgeCommandConfig> = {
  summary: {
    command: AiFocusedEditorKnowledgeCommands.SUMMARIZE_CHAPTER,
    modeId: 'summarize-chapter',
    builtinModeId: 'builtin-summarize-chapter',
    subdir: 'summaries',
    title: 'Chapter summary',
    progressLabel: 'summarizing chapter',
    historyKind: 'ai-knowledge-summary',
    builtinSystemPrompt: [
      'You are an editorial assistant for a Markdown manuscript with [[kind:id|label]] semantic tags.',
      'Write a concise, faithful synopsis of the chapter in the manuscript language.',
      'Respond ONLY with a JSON object of the exact shape {"summary": string}.',
      'The summary must be plain prose (no markdown headings). No text outside the JSON.'
    ].join('\n')
  },
  plan: {
    command: AiFocusedEditorKnowledgeCommands.GENERATE_SCENE_PLAN,
    modeId: 'plan-scenes',
    builtinModeId: 'builtin-plan-scenes',
    subdir: 'plans',
    title: 'Scene plan',
    progressLabel: 'planning scenes',
    historyKind: 'ai-knowledge-plan',
    builtinSystemPrompt: [
      'You are a developmental editor planning the scene structure of a manuscript chapter.',
      'Break the chapter into its scenes in reading order.',
      'Respond ONLY with a JSON object of the exact shape',
      '{"scenes": [{"title": string, "purpose": string, "beats": [string]}]}.',
      'Each scene "purpose" is one sentence; "beats" lists the key story beats. No text outside the JSON.'
    ].join('\n')
  },
  questions: {
    command: AiFocusedEditorKnowledgeCommands.GENERATE_AUTHOR_QUESTIONS,
    modeId: 'author-questions',
    builtinModeId: 'builtin-author-questions',
    subdir: 'questions',
    title: 'Author questions',
    progressLabel: 'generating author questions',
    historyKind: 'ai-knowledge-questions',
    builtinSystemPrompt: [
      'You are a developmental editor helping an author strengthen a manuscript chapter.',
      'Produce probing developmental questions about plot holes, motivation, pacing, and continuity.',
      'Respond ONLY with a JSON object of the exact shape {"questions": [string]}.',
      'Each question is a single sentence. No text outside the JSON.'
    ].join('\n')
  }
};

/**
 * FR-011 (spec §5.3, §6): generate chapter summaries, scene plans, and author
 * questions from the active Markdown editor and persist them under the
 * workspace `knowledge/` convention (spec §4.1).
 *
 * Isolated in its own frontend module so it can evolve in parallel with
 * `manuscript-workspace-contribution.ts`; the AI-call and history-append shapes
 * are replicated locally rather than shared to avoid cross-file coupling.
 */
@injectable()
export class KnowledgeGenerationContribution implements CommandContribution, MenuContribution {
  @inject(MessageService)
  protected readonly messages!: MessageService;

  @inject(EditorManager)
  protected readonly editorManager!: EditorManager;

  @inject(AiConnectionService)
  protected readonly aiConnection!: AiConnectionService;

  @inject(AiProfilePreferenceService)
  protected readonly aiProfilePreferences!: AiProfilePreferenceService;

  @inject(AiModeRegistry)
  protected readonly aiModes!: AiModeRegistry;

  @inject(AiHistoryService)
  protected readonly aiHistory!: AiHistoryService;

  @inject(FileService)
  protected readonly fileService!: FileService;

  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

  @inject(OpenerService)
  protected readonly openerService!: OpenerService;

  registerCommands(registry: CommandRegistry): void {
    registry.registerCommand(AiFocusedEditorKnowledgeCommands.SUMMARIZE_CHAPTER, {
      execute: () => this.generate('summary')
    });
    registry.registerCommand(AiFocusedEditorKnowledgeCommands.GENERATE_SCENE_PLAN, {
      execute: () => this.generate('plan')
    });
    registry.registerCommand(AiFocusedEditorKnowledgeCommands.GENERATE_AUTHOR_QUESTIONS, {
      execute: () => this.generate('questions')
    });
  }

  registerMenus(menus: MenuModelRegistry): void {
    const menuPath = AiFocusedEditorMenus.KNOWLEDGE;
    menus.registerMenuAction(menuPath, {
      commandId: AiFocusedEditorKnowledgeCommands.SUMMARIZE_CHAPTER.id
    });
    menus.registerMenuAction(menuPath, {
      commandId: AiFocusedEditorKnowledgeCommands.GENERATE_SCENE_PLAN.id
    });
    menus.registerMenuAction(menuPath, {
      commandId: AiFocusedEditorKnowledgeCommands.GENERATE_AUTHOR_QUESTIONS.id
    });
  }

  protected async generate(kind: KnowledgeKind): Promise<void> {
    const config = KNOWLEDGE_COMMANDS[kind];

    const editorWidget = this.editorManager.currentEditor ?? this.editorManager.activeEditor;
    const editor = editorWidget?.editor;
    if (!editor) {
      await this.messages.warn('Open a Markdown chapter in the editor before generating knowledge.');
      return;
    }
    if (!this.isMarkdown(editor)) {
      await this.messages.warn('The active editor is not a Markdown chapter.');
      return;
    }

    const chapterText = editor.document.getText().trim();
    if (!chapterText) {
      await this.messages.warn('The active chapter is empty.');
      return;
    }

    const documentUri = editor.uri.toString();
    const profile = await this.aiProfilePreferences.getConfiguredProfile(documentUri);
    if (!profile) {
      await this.messages.warn('Configure the AI profile (Model Config view) before generating knowledge.');
      return;
    }

    const root = await this.getWorkspaceRoot();
    if (!root) {
      await this.messages.warn('Open a manuscript workspace folder before generating knowledge.');
      return;
    }

    const title = this.deriveChapterTitle(chapterText, editor.uri);
    const chapterPath = this.toWorkspaceRelative(root, editor.uri);
    const mode = await this.aiModes.getMode(config.modeId);

    const progress = await this.messages.showProgress({
      text: `AI Focused Editor: ${config.progressLabel}...`
    });
    try {
      const chain = await this.aiProfilePreferences.getFailoverChain(documentUri);
      const result = await generateWithFailover(this.aiConnection, chain.length > 0 ? chain : [profile], {
        messages: [
          {
            role: 'system',
            content: mode?.systemPrompt || config.builtinSystemPrompt
          },
          {
            role: 'user',
            content: [
              mode?.userPrompt,
              `Chapter title: ${title}`,
              `Chapter path: ${chapterPath}`,
              '',
              'Chapter Markdown:',
              chapterText
            ].filter((line): line is string => line !== undefined).join('\n')
          }
        ],
        parameters: mode?.parameters ?? { temperature: 0.2 },
        logContext: {
          command: config.command.id,
          aiModeId: mode?.id ?? config.builtinModeId,
          documentUri,
          workspaceRootUri: root.toString()
        }
      });

      const meta: KnowledgeMeta = {
        chapter: chapterPath,
        title,
        generated_at: new Date().toISOString(),
        provider: result.route?.provider ?? result.profileUsed.provider,
        model: result.route?.model ?? result.profileUsed.model
      };

      const coercion: KnowledgeCoercion<KnowledgeDocument> = coerceKnowledge(kind, meta, result.text);
      const slug = slugifyChapter(title);
      const relativeTarget = `knowledge/${config.subdir}/${slug}.yaml`;
      const targetUri = await this.writeKnowledgeFile(root, config.subdir, slug, stringify(coercion.document));

      if (coercion.parsed) {
        await this.messages.info(`${config.title} written to ${relativeTarget}.`);
      } else {
        await this.messages.warn(
          `${config.title} response was not valid JSON; stored the raw model text in ${relativeTarget}.`
        );
      }

      await this.tryOpen(targetUri);
      await this.tryAppendChatEvent({
        kind: config.historyKind,
        command: config.command.id,
        documentUri,
        data: {
          outputUri: targetUri.toString(),
          parsed: coercion.parsed,
          aiModeId: mode?.id ?? config.builtinModeId,
          route: result.route,
          warnings: result.warnings,
          usage: result.usage
        }
      });
    } catch (error) {
      await this.tryAppendChatEvent({
        kind: 'ai-command-error',
        command: config.command.id,
        documentUri,
        data: {
          error: error instanceof Error ? error.message : String(error)
        }
      });
      await this.messages.error(`${config.title} failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      progress.cancel();
    }
  }

  protected isMarkdown(editor: TextEditor): boolean {
    return editor.uri.path.ext.toLowerCase() === '.md' || editor.document.languageId === 'markdown';
  }

  /**
   * Chapter title: the first ATX H1 heading if present, otherwise the file name
   * (without extension). Falls back to `Chapter` for untitled documents.
   */
  protected deriveChapterTitle(text: string, uri: URI): string {
    const headingMatch = text.match(/^\s{0,3}#\s+(.+?)\s*#*\s*$/m);
    if (headingMatch) {
      const heading = headingMatch[1].trim();
      if (heading) {
        return heading;
      }
    }
    return uri.path.name || 'Chapter';
  }

  protected toWorkspaceRelative(root: URI, uri: URI): string {
    const relative = root.relative(uri);
    return relative ? relative.toString() : uri.path.toString();
  }

  protected async writeKnowledgeFile(root: URI, subdir: string, slug: string, content: string): Promise<URI> {
    await this.ensureKnowledgeDir(root, subdir);
    const target = root.resolve('knowledge').resolve(subdir).resolve(`${slug}.yaml`);
    // Regeneration overwrites the prior artifact for this chapter slug.
    await this.fileService.create(target, content, { overwrite: true });
    return target;
  }

  protected async ensureKnowledgeDir(root: URI, subdir: string): Promise<void> {
    let current = root;
    for (const segment of ['knowledge', subdir]) {
      current = current.resolve(segment);
      try {
        await this.fileService.createFolder(current);
      } catch {
        // Existing folders are expected.
      }
    }
  }

  protected async tryOpen(uri: URI): Promise<void> {
    try {
      await open(this.openerService, uri);
    } catch {
      // Opening the generated file is best-effort; the write already succeeded.
    }
  }

  protected async tryAppendChatEvent(record: AiHistoryRecord): Promise<void> {
    try {
      await this.aiHistory.appendChatEvent(record);
    } catch {
      // History is append-only observability; command UX should not fail when logging fails.
    }
  }

  protected async getWorkspaceRoot(): Promise<URI | undefined> {
    await this.workspaceService.ready;
    return (this.workspaceService.tryGetRoots()[0] ?? (await this.workspaceService.roots)[0])?.resource;
  }
}
