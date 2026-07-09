import {
  AIContextVariable,
  AIVariableContribution,
  AIVariableContext,
  AIVariableResolutionRequest,
  AIVariableService,
  ResolvedAIContextVariable
} from '@theia/ai-core';
import { injectable, inject } from '@theia/core/shared/inversify';
import { ManuscriptAiContextAssembler } from './manuscript-ai-context-assembler';

export const MANUSCRIPT_CONTEXT_VARIABLE: AIContextVariable = {
  id: 'ai-focused-editor.manuscript-context',
  name: 'manuscript',
  label: 'Manuscript',
  description: 'Current AI Focused Editor manuscript manifest, diagnostics, entities, and source summary.',
  iconClasses: ['fa', 'fa-book'],
  isContextVariable: true
};

@injectable()
export class ManuscriptContextVariableContribution implements AIVariableContribution {
  @inject(ManuscriptAiContextAssembler)
  protected readonly contextAssembler!: ManuscriptAiContextAssembler;

  registerVariables(service: AIVariableService): void {
    service.registerVariable(MANUSCRIPT_CONTEXT_VARIABLE);
    service.registerResolver(MANUSCRIPT_CONTEXT_VARIABLE, this);
  }

  canResolve(request: AIVariableResolutionRequest, _context: AIVariableContext): number {
    return request.variable.name === MANUSCRIPT_CONTEXT_VARIABLE.name ? 100 : 0;
  }

  async resolve(
    request: AIVariableResolutionRequest,
    _context: AIVariableContext
  ): Promise<ResolvedAIContextVariable | undefined> {
    const value = await this.contextAssembler.assemble();
    return {
      variable: request.variable,
      arg: request.arg,
      value,
      contextValue: value
    };
  }
}
