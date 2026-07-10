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
import { ResourceResolver } from '@theia/core/lib/common/resource';
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
import {
  AIVariableContribution,
  LanguageModelProvider
} from '@theia/ai-core';
import { bindToolProvider } from '@theia/ai-core/lib/common/tool-invocation-registry';
import { TaskContribution } from '@theia/task/lib/browser/task-contribution';
import { AiFocusedEditorPreferenceContribution } from './ai-focused-editor-preferences';
import { AiConnectTheiaLanguageModel } from './ai-connect-theia-language-model';
import { AiDebugViewContribution } from './ai-debug-view-contribution';
import { AiDebugWidget } from './ai-debug-widget';
import {
  AiConnectionService,
  AiModeRegistry,
  AiModeRegistryBackendService,
  AiModeRegistryBackendServicePath,
  BookBuildService,
  BookBuildServicePath,
  GitStatusService,
  GitStatusServicePath,
  LocalAiConnectionService,
  LocalAiConnectionServicePath,
  ManuscriptWorkspaceBackendService,
  ManuscriptWorkspaceBackendServicePath,
  ManuscriptWorkspaceService,
  ModelProviderRegistry,
  NarrativeEntityBackendService,
  NarrativeEntityBackendServicePath,
  NarrativeEntityService,
  SourceLibraryBackendService,
  SourceLibraryBackendServicePath,
  SourceLibraryService
} from '../common';
import { BrowserAiConnectionService } from './browser-ai-connection-service';
import { LocalAiStreamClientImpl } from './local-ai-stream-client';
import { BrowserAiModeRegistry } from './browser-ai-mode-registry';
import { BrowserManuscriptWorkspaceService } from './browser-manuscript-workspace-service';
import { BrowserNarrativeEntityService } from './browser-narrative-entity-service';
import { BrowserSourceLibraryService } from './browser-source-library-service';
import { AiModeContribution } from './ai-mode-contribution';
import { BookBuildContribution } from './book-build-contribution';
import { EntityCardsViewContribution } from './entity-cards-view-contribution';
import { EntityCardsWidget } from './entity-cards-widget';
import { AiProfileStatusBarContribution } from './ai-profile-status-bar-contribution';
import { GitActionsContribution } from './git-actions-contribution';
import { GitStatusBarContribution } from './git-status-bar-contribution';
import { ManuscriptAiContextAssembler } from './manuscript-ai-context-assembler';
import { ManuscriptContextVariableContribution } from './manuscript-context-variable-contribution';
import { ManuscriptChatAgentContribution } from './manuscript-chat-agent-contribution';
import {
  ManuscriptFindEntitiesTool,
  ManuscriptGetChapterTool,
  ManuscriptListChaptersTool
} from './manuscript-tools-contribution';
import { AiHistoryService } from './ai-history-service';
import { MarkdownLanguageContribution } from './markdown-language-contribution';
import { AiModePromptFragmentContribution } from './ai-mode-prompt-fragment-contribution';
import { ManuscriptTreeItemFactory } from './manuscript-tree-item-factory';
import { ManuscriptTreeLabelProvider } from './manuscript-tree-label-provider';
import { ManuscriptTreeModel } from './manuscript-tree-model';
import { ManuscriptTreeViewContribution } from './manuscript-tree-view-contribution';
import { ManuscriptTreeWidget } from './manuscript-tree-widget';
import { AiProfilePreferenceService } from './ai-profile-preference-service';
import { ModelConfigViewContribution } from './model-config-view-contribution';
import { ModelConfigWidget } from './model-config-widget';
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
  bind(LocalAiStreamClientImpl).toSelf().inSingletonScope();
  bind(LocalAiConnectionService).toDynamicValue(ctx =>
    ServiceConnectionProvider.createProxy(
      ctx.container,
      LocalAiConnectionServicePath,
      ctx.container.get(LocalAiStreamClientImpl)
    )
  ).inSingletonScope();
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
  bind(AiConnectionService).to(BrowserAiConnectionService).inSingletonScope();
  bind(AiModeRegistry).to(BrowserAiModeRegistry).inSingletonScope();
  bind(AiConnectTheiaLanguageModel).toSelf().inSingletonScope();
  bind(LanguageModelProvider).toDynamicValue(ctx => async () => [
    ctx.container.get(AiConnectTheiaLanguageModel)
  ]).inSingletonScope();
  bind(ManuscriptWorkspaceService).to(BrowserManuscriptWorkspaceService).inSingletonScope();
  bind(NarrativeEntityService).to(BrowserNarrativeEntityService).inSingletonScope();
  bind(SourceLibraryService).to(BrowserSourceLibraryService).inSingletonScope();
  bind(ManuscriptTreeItemFactory).toSelf().inSingletonScope();
  bind(ManuscriptTreeLabelProvider).toSelf().inSingletonScope();
  bind(ManuscriptAiContextAssembler).toSelf().inSingletonScope();
  bind(ManuscriptContextVariableContribution).toSelf().inSingletonScope();
  bind(AIVariableContribution).toService(ManuscriptContextVariableContribution);
  bind(AiProfilePreferenceService).toSelf().inSingletonScope();
  bind(ModelProviderRegistry).toService(AiProfilePreferenceService);
  bind(AiProfileStatusBarContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(AiProfileStatusBarContribution);
  bind(GitStatusBarContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(GitStatusBarContribution);
  bind(GitActionsContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(GitActionsContribution);
  bind(MenuContribution).toService(GitActionsContribution);
  bind(AiHistoryService).toSelf().inSingletonScope();
  bind(LabelProviderContribution).toService(ManuscriptTreeLabelProvider);
  bind(PreferenceContribution).toConstantValue(AiFocusedEditorPreferenceContribution);
  bindViewContribution(bind, ManuscriptTreeViewContribution);
  bind(FrontendApplicationContribution).toService(ManuscriptTreeViewContribution);
  bindViewContribution(bind, EntityCardsViewContribution);
  bindViewContribution(bind, SourceLibraryViewContribution);
  bindViewContribution(bind, SemanticMarkdownPreviewContribution);
  bind(TabBarToolbarContribution).toService(SemanticMarkdownPreviewContribution);
  bindViewContribution(bind, ModelConfigViewContribution);
  bindViewContribution(bind, AiDebugViewContribution);
  bind(FrontendApplicationContribution).to(MarkdownLanguageContribution).inSingletonScope();
  bind(FrontendApplicationContribution).to(SemanticMarkdownDecorationService).inSingletonScope();
  bind(FrontendApplicationContribution).to(SemanticMarkdownDocumentSymbolProvider).inSingletonScope();
  bind(FrontendApplicationContribution).to(SemanticMarkdownCompletionProvider).inSingletonScope();
  bind(AiModePromptFragmentContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(AiModePromptFragmentContribution);
  bind(ManuscriptChatAgentContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(ManuscriptChatAgentContribution);
  bindToolProvider(ManuscriptFindEntitiesTool, bind);
  bindToolProvider(ManuscriptListChaptersTool, bind);
  bindToolProvider(ManuscriptGetChapterTool, bind);
  bind(WidgetFactory).toDynamicValue(ctx => ({
    id: ManuscriptTreeWidget.ID,
    createWidget: () => createManuscriptTreeContainer(ctx.container).get(ManuscriptTreeWidget)
  })).inSingletonScope();
  bind(SemanticMarkdownPreviewWidget).toSelf();
  bind(WidgetFactory).toDynamicValue(ctx => ({
    id: SemanticMarkdownPreviewWidget.ID,
    createWidget: () => ctx.container.get(SemanticMarkdownPreviewWidget)
  })).inSingletonScope();
  bind(ModelConfigWidget).toSelf();
  bind(WidgetFactory).toDynamicValue(ctx => ({
    id: ModelConfigWidget.ID,
    createWidget: () => ctx.container.get(ModelConfigWidget)
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
  bind(AiDebugWidget).toSelf();
  bind(WidgetFactory).toDynamicValue(ctx => ({
    id: AiDebugWidget.ID,
    createWidget: () => ctx.container.get(AiDebugWidget)
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
});
