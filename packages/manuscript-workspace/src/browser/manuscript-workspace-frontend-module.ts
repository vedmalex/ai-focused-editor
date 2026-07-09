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
  LabelProviderContribution,
  FrontendApplicationContribution,
  WidgetFactory
} from '@theia/core/lib/browser';
import { ServiceConnectionProvider } from '@theia/core/lib/browser/messaging/service-connection-provider';
import { bindViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { createTreeContainer } from '@theia/core/lib/browser/tree';
import {
  AIVariableContribution,
  LanguageModelProvider
} from '@theia/ai-core';
import { AiFocusedEditorPreferenceContribution } from './ai-focused-editor-preferences';
import { AiConnectTheiaLanguageModel } from './ai-connect-theia-language-model';
import { AiDebugViewContribution } from './ai-debug-view-contribution';
import { AiDebugWidget } from './ai-debug-widget';
import {
  AiConnectionService,
  AiModeRegistry,
  BookBuildService,
  BookBuildServicePath,
  GitHistoryService,
  GitHistoryServicePath,
  LocalAiConnectionService,
  LocalAiConnectionServicePath,
  ManuscriptWorkspaceService,
  NarrativeEntityService,
  SourceLibraryService
} from '../common';
import { BrowserAiConnectionService } from './browser-ai-connection-service';
import { BrowserAiModeRegistry } from './browser-ai-mode-registry';
import { BrowserManuscriptWorkspaceService } from './browser-manuscript-workspace-service';
import { BrowserNarrativeEntityService } from './browser-narrative-entity-service';
import { BrowserSourceLibraryService } from './browser-source-library-service';
import { AiModeContribution } from './ai-mode-contribution';
import { BookBuildContribution } from './book-build-contribution';
import { EntityCardsViewContribution } from './entity-cards-view-contribution';
import { EntityCardsWidget } from './entity-cards-widget';
import { GitHistoryContribution } from './git-history-contribution';
import { GitHistoryResourceResolver } from './git-history-resource';
import { ManuscriptAiContextAssembler } from './manuscript-ai-context-assembler';
import { ManuscriptContextVariableContribution } from './manuscript-context-variable-contribution';
import { ManuscriptChatAgentContribution } from './manuscript-chat-agent-contribution';
import { AiHistoryService } from './ai-history-service';
import { ManuscriptTreeItemFactory } from './manuscript-tree-item-factory';
import { ManuscriptTreeLabelProvider } from './manuscript-tree-label-provider';
import { ManuscriptTreeModel } from './manuscript-tree-model';
import { ManuscriptTreeViewContribution } from './manuscript-tree-view-contribution';
import { ManuscriptTreeWidget } from './manuscript-tree-widget';
import { AiProfilePreferenceService } from './ai-profile-preference-service';
import { ModelConfigViewContribution } from './model-config-view-contribution';
import { ModelConfigWidget } from './model-config-widget';
import { SemanticMarkdownActionsContribution } from './semantic-markdown-actions-contribution';
import { SemanticMarkdownDecorationService } from './semantic-markdown-decoration-service';
import { SemanticMarkdownPreviewContribution } from './semantic-markdown-preview-contribution';
import { SemanticMarkdownPreviewWidget } from './semantic-markdown-preview-widget';
import { SourceLibraryViewContribution } from './source-library-view-contribution';
import { SourceLibraryWidget } from './source-library-widget';
import { YamlSchemaValidator } from './yaml-schema-validator';
import {
  ManuscriptWorkspaceCommandContribution,
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
  bind(LocalAiConnectionService).toDynamicValue(ctx =>
    ServiceConnectionProvider.createProxy(ctx.container, LocalAiConnectionServicePath)
  ).inSingletonScope();
  bind(GitHistoryService).toDynamicValue(ctx =>
    ServiceConnectionProvider.createProxy(ctx.container, GitHistoryServicePath)
  ).inSingletonScope();
  bind(BookBuildService).toDynamicValue(ctx =>
    ServiceConnectionProvider.createProxy(ctx.container, BookBuildServicePath)
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
  bind(AiHistoryService).toSelf().inSingletonScope();
  bind(YamlSchemaValidator).toSelf().inSingletonScope();
  bind(GitHistoryResourceResolver).toSelf().inSingletonScope();
  bind(ResourceResolver).toService(GitHistoryResourceResolver);
  bind(LabelProviderContribution).toService(ManuscriptTreeLabelProvider);
  bind(PreferenceContribution).toConstantValue(AiFocusedEditorPreferenceContribution);
  bindViewContribution(bind, ManuscriptTreeViewContribution);
  bindViewContribution(bind, EntityCardsViewContribution);
  bindViewContribution(bind, SourceLibraryViewContribution);
  bindViewContribution(bind, SemanticMarkdownPreviewContribution);
  bindViewContribution(bind, ModelConfigViewContribution);
  bindViewContribution(bind, AiDebugViewContribution);
  bind(FrontendApplicationContribution).to(SemanticMarkdownDecorationService).inSingletonScope();
  bind(ManuscriptChatAgentContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(ManuscriptChatAgentContribution);
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
  bind(GitHistoryContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(GitHistoryContribution);
  bind(MenuContribution).toService(GitHistoryContribution);
  bind(FrontendApplicationContribution).toService(GitHistoryContribution);
  bind(BookBuildContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(BookBuildContribution);
  bind(MenuContribution).toService(BookBuildContribution);
  bind(SemanticMarkdownActionsContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(SemanticMarkdownActionsContribution);
  bind(MenuContribution).toService(SemanticMarkdownActionsContribution);
  bind(AiModeContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(AiModeContribution);
  bind(MenuContribution).toService(AiModeContribution);
});
