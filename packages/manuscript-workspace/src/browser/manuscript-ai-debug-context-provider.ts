import { inject, injectable } from '@theia/core/shared/inversify';
import type {
  AiDebugContextProvider,
  AiDebugContextSnapshot
} from '@ai-focused-editor/ai-connect-theia/lib/browser';
import { AiModeRegistry } from '../common';
import { ManuscriptAiContextAssembler } from './manuscript-ai-context-assembler';

/**
 * Host implementation of the ai-connect package's `AiDebugContextProvider`
 * seam: feeds the AI Debug view the manuscript's project AI modes, mode
 * diagnostics, and the assembled always-on context string.
 */
@injectable()
export class ManuscriptAiDebugContextProvider implements AiDebugContextProvider {
  @inject(AiModeRegistry)
  protected readonly aiModes!: AiModeRegistry;

  @inject(ManuscriptAiContextAssembler)
  protected readonly contextAssembler!: ManuscriptAiContextAssembler;

  async collect(): Promise<AiDebugContextSnapshot> {
    const [modeSnapshot, manuscriptContext] = await Promise.all([
      this.aiModes.refresh(),
      this.contextAssembler.assemble()
    ]);
    return {
      modes: modeSnapshot.modes.map(mode => ({
        id: mode.id,
        label: mode.label,
        parameters: mode.parameters
      })),
      diagnostics: modeSnapshot.diagnostics.map(diagnostic => ({
        source: diagnostic.source,
        severity: String(diagnostic.severity),
        message: diagnostic.message
      })),
      manuscriptContext
    };
  }
}
