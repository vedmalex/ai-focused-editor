import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { inject, injectable } from '@theia/core/shared/inversify';
import { CustomAgentFactory } from '@theia/ai-chat/lib/browser/custom-agent-factory';
import { AiConnectTheiaLanguageModel } from './ai-connect-theia-language-model';

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
      'Manuscript',
      'Writer-focused AI agent for manuscript editing, semantic Markdown, project entities, and source-aware review.',
      [
        'You are the Manuscript agent inside AI Focused Editor.',
        'Help writers and translators improve long-form Markdown manuscripts while preserving authorial control.',
        'Use the manuscript workspace context when available: {{manuscript}}',
        'Never claim to have changed files unless a tool or explicit command has actually done it.',
        'When proposing text edits, explain the rationale briefly and keep changes inspectable.'
      ].join('\n'),
      AiConnectTheiaLanguageModel.ID,
      true
    );
  }
}
