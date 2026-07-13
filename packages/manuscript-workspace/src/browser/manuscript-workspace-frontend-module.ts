import '../../src/browser/style/index.css';
import {
  Container,
  ContainerModule,
  interfaces
} from '@theia/core/shared/inversify';
import {
  CommandContribution,
  MenuContribution,
  PreferenceContribution
} from '@theia/core/lib/common';
import {
  KeybindingContribution,
  LabelProviderContribution,
  FrontendApplicationContribution,
  WidgetFactory
} from '@theia/core/lib/browser';
import { ServiceConnectionProvider } from '@theia/core/lib/browser/messaging/service-connection-provider';
import { TabBarToolbarContribution } from '@theia/core/lib/browser/shell/tab-bar-toolbar';
import { bindViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { createTreeContainer } from '@theia/core/lib/browser/tree';
import { AIVariableContribution } from '@theia/ai-core';
import { bindToolProvider } from '@theia/ai-core/lib/common/tool-invocation-registry';
import { TaskContribution } from '@theia/task/lib/browser/task-contribution';
import { AiDebugContextProvider } from '@ai-focused-editor/ai-connect-theia/lib/browser';
import { AiFocusedEditorPreferenceContribution } from './ai-focused-editor-preferences';
import {
  AiModeRegistry,
  AiModeRegistryBackendService,
  AiModeRegistryBackendServicePath,
  BookBuildService,
  BookBuildServicePath,
  GitStatusService,
  GitStatusServicePath,
  ManuscriptWorkspaceBackendService,
  ManuscriptWorkspaceBackendServicePath,
  ManuscriptWorkspaceService,
  NarrativeEntityBackendService,
  NarrativeEntityBackendServicePath,
  NarrativeEntityService,
  SourceLibraryBackendService,
  SourceLibraryBackendServicePath,
  SourceLibraryService
} from '../common';
import { BrowserAiModeRegistry } from './browser-ai-mode-registry';
import { BrowserManuscriptWorkspaceService } from './browser-manuscript-workspace-service';
import { BrowserNarrativeEntityService } from './browser-narrative-entity-service';
import { BrowserSourceLibraryService } from './browser-source-library-service';
import { AiModeContribution } from './ai-mode-contribution';
import { BookBuildContribution } from './book-build-contribution';
import { FootnoteLinkContribution } from './footnote-link-contribution';
import { SemanticLinkContribution } from './semantic-link-contribution';
import { SemanticEntityHoverContribution } from './semantic-entity-hover-contribution';
import { EntityCardsViewContribution } from './entity-cards-view-contribution';
import { EntityCardsWidget } from './entity-cards-widget';
import { GitActionsContribution } from './git-actions-contribution';
import { ManuscriptAiContextAssembler } from './manuscript-ai-context-assembler';
import { ManuscriptContextVariableContribution } from './manuscript-context-variable-contribution';
import { ChatContextActionsContribution } from './chat-context-actions-contribution';
import { ChatContextSetsContribution } from './chat-context-sets-contribution';
import { ManuscriptChatAgentContribution } from './manuscript-chat-agent-contribution';
import {
  ManuscriptCreateDiagramTool,
  ManuscriptCreateEntityTool,
  ManuscriptFindEntitiesTool,
  ManuscriptGetChapterTool,
  ManuscriptListChaptersTool,
  ManuscriptWriteNoteTool
} from './manuscript-tools-contribution';
import { DiagramAuthorPromptFragmentContribution } from './diagram-author-prompt-fragment-contribution';
import { MarkdownLanguageContribution } from './markdown-language-contribution';
import { AiModePromptFragmentContribution } from './ai-mode-prompt-fragment-contribution';
import { EntityTypeRegistryService } from './entity-type-registry-service';
import { ManuscriptTreeItemFactory } from './manuscript-tree-item-factory';
import { ManuscriptTreeLabelProvider } from './manuscript-tree-label-provider';
import { ManuscriptTreeModel } from './manuscript-tree-model';
import { ManuscriptTreeViewContribution } from './manuscript-tree-view-contribution';
import { ManuscriptTreeWidget } from './manuscript-tree-widget';
import { AiConnectMenuContribution } from './ai-connect-menu-contribution';
import { ManuscriptAiDebugContextProvider } from './manuscript-ai-debug-context-provider';
import { SemanticMarkdownActionsContribution } from './semantic-markdown-actions-contribution';
import { SemanticMarkdownCompletionProvider } from './semantic-markdown-completion-provider';
import { SemanticMarkdownDecorationService } from './semantic-markdown-decoration-service';
import { SemanticMarkdownDocumentSymbolProvider } from './semantic-markdown-document-symbol-provider';
import { SemanticMarkdownPreviewContribution } from './semantic-markdown-preview-contribution';
import { SemanticMarkdownPreviewWidget } from './semantic-markdown-preview-widget';
import { SourceLibraryViewContribution } from './source-library-view-contribution';
import { SourceLibraryWidget } from './source-library-widget';
import {
  ManuscriptWorkspaceCommandContribution,
  ManuscriptWorkspaceKeybindingContribution,
  ManuscriptWorkspaceMenuContribution
} from './manuscript-workspace-contribution';
import { WritingModeContribution } from './writing-mode-contribution';
import { DeviceThemeContribution } from './device-theme-contribution';

function createManuscriptTreeContainer(parent: interfaces.Container): Container {
  return createTreeContainer(parent, {
    model: ManuscriptTreeModel,
    widget: ManuscriptTreeWidget,
    props: {
      contextMenuPath: ManuscriptTreeWidget.CONTEXT_MENU,
      multiSelect: false,
      search: true
    }
  });
}

export default new ContainerModule(bind => {
  bind(BookBuildService).toDynamicValue(ctx =>
    ServiceConnectionProvider.createProxy(ctx.container, BookBuildServicePath)
  ).inSingletonScope();
  bind(GitStatusService).toDynamicValue(ctx =>
    ServiceConnectionProvider.createProxy(ctx.container, GitStatusServicePath)
  ).inSingletonScope();
  bind(ManuscriptWorkspaceBackendService).toDynamicValue(ctx =>
    ServiceConnectionProvider.createProxy(ctx.container, ManuscriptWorkspaceBackendServicePath)
  ).inSingletonScope();
  bind(NarrativeEntityBackendService).toDynamicValue(ctx =>
    ServiceConnectionProvider.createProxy(ctx.container, NarrativeEntityBackendServicePath)
  ).inSingletonScope();
  bind(SourceLibraryBackendService).toDynamicValue(ctx =>
    ServiceConnectionProvider.createProxy(ctx.container, SourceLibraryBackendServicePath)
  ).inSingletonScope();
  bind(AiModeRegistryBackendService).toDynamicValue(ctx =>
    ServiceConnectionProvider.createProxy(ctx.container, AiModeRegistryBackendServicePath)
  ).inSingletonScope();
  bind(AiModeRegistry).to(BrowserAiModeRegistry).inSingletonScope();
  bind(ManuscriptWorkspaceService).to(BrowserManuscriptWorkspaceService).inSingletonScope();
  bind(NarrativeEntityService).to(BrowserNarrativeEntityService).inSingletonScope();
  bind(SourceLibraryService).to(BrowserSourceLibraryService).inSingletonScope();
  bind(EntityTypeRegistryService).toSelf().inSingletonScope();
  bind(ManuscriptTreeItemFactory).toSelf().inSingletonScope();
  bind(ManuscriptTreeLabelProvider).toSelf().inSingletonScope();
  bind(ManuscriptAiContextAssembler).toSelf().inSingletonScope();
  // Populate the ai-connect Debug view's manuscript context/modes section.
  bind(ManuscriptAiDebugContextProvider).toSelf().inSingletonScope();
  bind(AiDebugContextProvider).toService(ManuscriptAiDebugContextProvider);
  bind(ManuscriptContextVariableContribution).toSelf().inSingletonScope();
  bind(AIVariableContribution).toService(ManuscriptContextVariableContribution);
  bind(ChatContextActionsContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(ChatContextActionsContribution);
  bind(MenuContribution).toService(ChatContextActionsContribution);
  bind(ChatContextSetsContribution).toSelf().inSingletonScope();
  bind(AIVariableContribution).toService(ChatContextSetsContribution);
  bind(CommandContribution).toService(ChatContextSetsContribution);
  bind(MenuContribution).toService(ChatContextSetsContribution);
  bind(GitActionsContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(GitActionsContribution);
  bind(MenuContribution).toService(GitActionsContribution);
  // Thin menu placement for the ai-connect package's commands (the package
  // registers the commands + views; the Manuscript menu placement lives here).
  bind(AiConnectMenuContribution).toSelf().inSingletonScope();
  bind(MenuContribution).toService(AiConnectMenuContribution);
  bind(LabelProviderContribution).toService(ManuscriptTreeLabelProvider);
  bind(PreferenceContribution).toConstantValue(AiFocusedEditorPreferenceContribution);
  bindViewContribution(bind, ManuscriptTreeViewContribution);
  bind(FrontendApplicationContribution).toService(ManuscriptTreeViewContribution);
  bind(TabBarToolbarContribution).toService(ManuscriptTreeViewContribution);
  bindViewContribution(bind, EntityCardsViewContribution);
  bindViewContribution(bind, SourceLibraryViewContribution);
  bindViewContribution(bind, SemanticMarkdownPreviewContribution);
  bind(TabBarToolbarContribution).toService(SemanticMarkdownPreviewContribution);
  bind(FrontendApplicationContribution).to(MarkdownLanguageContribution).inSingletonScope();
  bind(FrontendApplicationContribution).to(SemanticMarkdownDecorationService).inSingletonScope();
  bind(FrontendApplicationContribution).to(SemanticMarkdownDocumentSymbolProvider).inSingletonScope();
  bind(FrontendApplicationContribution).to(SemanticMarkdownCompletionProvider).inSingletonScope();
  bind(FrontendApplicationContribution).to(FootnoteLinkContribution).inSingletonScope();
  bind(FrontendApplicationContribution).to(SemanticLinkContribution).inSingletonScope();
  bind(FrontendApplicationContribution).to(SemanticEntityHoverContribution).inSingletonScope();
  bind(AiModePromptFragmentContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(AiModePromptFragmentContribution);
  bind(ManuscriptChatAgentContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(ManuscriptChatAgentContribution);
  bindToolProvider(ManuscriptFindEntitiesTool, bind);
  bindToolProvider(ManuscriptListChaptersTool, bind);
  bindToolProvider(ManuscriptGetChapterTool, bind);
  bindToolProvider(ManuscriptCreateEntityTool, bind);
  bindToolProvider(ManuscriptWriteNoteTool, bind);
  bindToolProvider(ManuscriptCreateDiagramTool, bind);
  bind(DiagramAuthorPromptFragmentContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(DiagramAuthorPromptFragmentContribution);
  bind(WidgetFactory).toDynamicValue(ctx => ({
    id: ManuscriptTreeWidget.ID,
    createWidget: () => createManuscriptTreeContainer(ctx.container).get(ManuscriptTreeWidget)
  })).inSingletonScope();
  bind(SemanticMarkdownPreviewWidget).toSelf();
  bind(WidgetFactory).toDynamicValue(ctx => ({
    id: SemanticMarkdownPreviewWidget.ID,
    createWidget: () => ctx.container.get(SemanticMarkdownPreviewWidget)
  })).inSingletonScope();
  bind(EntityCardsWidget).toSelf();
  bind(WidgetFactory).toDynamicValue(ctx => ({
    id: EntityCardsWidget.ID,
    createWidget: () => ctx.container.get(EntityCardsWidget)
  })).inSingletonScope();
  bind(SourceLibraryWidget).toSelf();
  bind(WidgetFactory).toDynamicValue(ctx => ({
    id: SourceLibraryWidget.ID,
    createWidget: () => ctx.container.get(SourceLibraryWidget)
  })).inSingletonScope();
  bind(CommandContribution).to(ManuscriptWorkspaceCommandContribution).inSingletonScope();
  bind(MenuContribution).to(ManuscriptWorkspaceMenuContribution).inSingletonScope();
  bind(KeybindingContribution).to(ManuscriptWorkspaceKeybindingContribution).inSingletonScope();
  bind(BookBuildContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(BookBuildContribution);
  bind(MenuContribution).toService(BookBuildContribution);
  bind(TaskContribution).toService(BookBuildContribution);
  bind(SemanticMarkdownActionsContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(SemanticMarkdownActionsContribution);
  bind(MenuContribution).toService(SemanticMarkdownActionsContribution);
  bind(AiModeContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(AiModeContribution);
  bind(MenuContribution).toService(AiModeContribution);
  bind(WritingModeContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(WritingModeContribution);
  bind(MenuContribution).toService(WritingModeContribution);
  bind(TabBarToolbarContribution).toService(WritingModeContribution);
  bind(FrontendApplicationContribution).toService(WritingModeContribution);
  bind(DeviceThemeContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(DeviceThemeContribution);
  bind(MenuContribution).toService(DeviceThemeContribution);
  bind(FrontendApplicationContribution).toService(DeviceThemeContribution);
});
