import { nls } from '@theia/core/lib/common/nls';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { inject, injectable } from '@theia/core/shared/inversify';
import { PromptService } from '@theia/ai-core/lib/common/prompt-service';

/** Stable id of the diagram-authoring prompt fragment (mirrors the AI-mode fragment id shape). */
const DIAGRAM_AUTHOR_FRAGMENT_ID = 'ai-focused-editor.diagram-author';

/**
 * Registers a built-in prompt fragment that teaches the Manuscript agent how to
 * BUILD diagrams and formulas from a description — the "скилл, чтобы агент мог
 * строить по описанию диаграммы и формулы". It mirrors the registration shape of
 * {@link AiModePromptFragmentContribution} (a `BasePromptFragment` published via
 * {@link PromptService.addBuiltInPromptFragment}, exposed as a slash command), so
 * an author can drop `{{prompt:ai-focused-editor.diagram-author}}` into a mode or
 * invoke it as `/afe-diagram-author`.
 *
 * The template is a compact RUSSIAN instruction (the product is Russian-first)
 * covering: the `manuscript_create_diagram` spec format, that entity links
 * strengthen the world map, when to prefer a diagram over a note, and that
 * formulas go into notes/chapters as `$$...$$` (KaTeX).
 */
@injectable()
export class DiagramAuthorPromptFragmentContribution implements FrontendApplicationContribution {
  @inject(PromptService)
  protected readonly promptService!: PromptService;

  protected registered = false;

  onStart(): void {
    if (this.registered) {
      return;
    }
    this.registered = true;
    this.promptService.addBuiltInPromptFragment({
      id: DIAGRAM_AUTHOR_FRAGMENT_ID,
      name: nls.localize('ai-focused-editor/workspace/diagram-author-fragment-name', 'Diagram & Formula Author'),
      description: nls.localize(
        'ai-focused-editor/workspace/diagram-author-fragment-description',
        'Teaches the agent to build Excalidraw diagrams from a structured spec and to write formulas as KaTeX.'
      ),
      template: DIAGRAM_AUTHOR_TEMPLATE,
      isCommand: true,
      commandName: 'afe-diagram-author',
      commandDescription: nls.localize(
        'ai-focused-editor/workspace/diagram-author-fragment-command',
        'Insert diagram/formula authoring guidance'
      )
    });
  }
}

/**
 * The instruction body. Russian content (steers the model), not a UI string, so
 * it lives inline here rather than in the i18n dictionaries — only the fragment's
 * human name/description/command label are localized above.
 */
const DIAGRAM_AUTHOR_TEMPLATE = [
  'Ты умеешь строить диаграммы и формулы по описанию.',
  '',
  'ДИАГРАММЫ. Чтобы построить схему, вызывай инструмент ~{manuscript_create_diagram}.',
  'Передавай title и структурированный spec:',
  '{ "nodes": [{ "id", "label", "entity"?: { "kind", "id" } }],',
  '  "edges"?: [{ "from", "to", "label"? }],',
  '  "texts"?: [{ "text", "x"?, "y"? }] }.',
  'Узлы — это прямоугольники с подписью (раскладка по сетке считается автоматически),',
  'рёбра — стрелки между центрами узлов (from/to ссылаются на id узлов),',
  'texts — свободные подписи. Если у узла указан entity { kind, id }, он становится',
  'кликабельной ссылкой на карточку сущности (afe-entity://kind/id) — это УКРЕПЛЯЕТ',
  'карту мира книги, поэтому связывай узлы с реальными сущностями, когда они есть.',
  '',
  'КОГДА ДИАГРАММА, А КОГДА ЗАМЕТКА. Диаграмма — для связей и структуры (кто с кем',
  'связан, порядок событий, карта отношений). Если материал в основном текстовый',
  '(рассуждение, план, конспект, вывод формулы), создавай заметку через',
  '~{manuscript_write_note}, а не диаграмму.',
  '',
  'ФОРМУЛЫ. Математику вставляй прямо в Markdown заметок или глав как $$...$$',
  '(отображается через KaTeX). Отдельного инструмента для формул нет — они живут',
  'в тексте заметки или главы.'
].join('\n');
