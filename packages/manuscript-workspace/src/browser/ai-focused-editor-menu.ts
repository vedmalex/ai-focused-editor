import { MAIN_MENU_BAR, MenuPath } from '@theia/core/lib/common/menu';

/**
 * Shared menu paths for the AI Focused Editor product menu.
 *
 * The top-level product menu must live under MAIN_MENU_BAR — a bare
 * ['ai-focused-editor'] path is a detached root that Theia never renders.
 */
export const AI_FOCUSED_EDITOR_MENU: MenuPath = [...MAIN_MENU_BAR, '8_ai_focused_editor'];
export const AI_FOCUSED_EDITOR_MENU_LABEL = 'Manuscript';

export const AiFocusedEditorMenus = {
  MAIN: AI_FOCUSED_EDITOR_MENU,
  SEMANTIC_MARKDOWN: [...AI_FOCUSED_EDITOR_MENU, '2_semantic-markdown'] as MenuPath,
  BUILD: [...AI_FOCUSED_EDITOR_MENU, '3_build'] as MenuPath,
  KNOWLEDGE: [...AI_FOCUSED_EDITOR_MENU, '4_knowledge'] as MenuPath,
  SOURCES: [...AI_FOCUSED_EDITOR_MENU, '5_sources'] as MenuPath,
  AI_MODES: [...AI_FOCUSED_EDITOR_MENU, '6_ai-modes'] as MenuPath,
  AI_DEBUG: [...AI_FOCUSED_EDITOR_MENU, '7_ai-debug'] as MenuPath
};
