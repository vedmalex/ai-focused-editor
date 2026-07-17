import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { nls } from '@theia/core/lib/common/nls';
import { inject, injectable } from '@theia/core/shared/inversify';
import { CustomAgentFactory } from '@theia/ai-chat/lib/browser/custom-agent-factory';
import { AiConnectTheiaLanguageModel } from '@ai-focused-editor/ai-connect-theia/lib/browser';

const MANUSCRIPT_AGENT_ID = 'ai-focused-editor.manuscript';

@injectable()
export class ManuscriptChatAgentContribution implements FrontendApplicationContribution {
  @inject(CustomAgentFactory)
  protected readonly customAgentFactory!: CustomAgentFactory;

  protected registered = false;

  onStart(): void {
    if (this.registered) {
      return;
    }
    this.registered = true;
    this.customAgentFactory(
      MANUSCRIPT_AGENT_ID,
      // The agent NAME doubles as the @mention token; kept English/ASCII so the
      // chat mention parser resolves it. Only the human-readable description is
      // localized (systemPrompt below stays English — it steers the model).
      'Manuscript',
      nls.localize(
        'ai-focused-editor/workspace/agent-description',
        'Writer-focused AI agent for manuscript editing, semantic Markdown, project entities, and source-aware review.'
      ),
      [
        'You are the Manuscript agent inside AI Focused Editor.',
        'Help writers and translators improve long-form Markdown manuscripts while preserving authorial control.',
        'Use the manuscript workspace context when available: {{manuscript}}',
        'You can call tools to inspect the project instead of guessing:',
        '~{manuscript_find_entities}',
        '~{manuscript_list_chapters}',
        '~{manuscript_get_chapter}',
        'You can also create book artifacts on request (the author enables these per session):',
        '~{manuscript_create_entity}',
        '~{manuscript_write_note}',
        '~{manuscript_create_diagram}',
        'Prefer a diagram for relations/structure and a note for prose or formulas ($$...$$ KaTeX).',
        'Never claim to have changed files unless a tool or explicit command has actually done it.',
        'When proposing text edits, explain the rationale briefly and keep changes inspectable.'
      ].join('\n'),
      AiConnectTheiaLanguageModel.ID,
      true
    );
  }
}
