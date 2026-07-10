import {
  CommandContribution,
  CommandRegistry,
  MenuContribution,
  MenuModelRegistry,
  MessageService,
  QuickInputService,
  QuickPickItem
} from '@theia/core/lib/common';
import URI from '@theia/core/lib/common/uri';
import { PreferenceService } from '@theia/core/lib/common/preferences';
import {
  ApplicationShell,
  FrontendApplicationContribution,
  LabelProvider,
  WidgetFactory,
  WidgetManager
} from '@theia/core/lib/browser';
import { FileDialogService } from '@theia/filesystem/lib/browser';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import {
  ContainerModule,
  inject,
  injectable
} from '@theia/core/shared/inversify';
import {
  bookScaffoldEntries,
  DEFAULT_BOOK_LANGUAGE,
  DEFAULT_FIRST_CHAPTER_TITLE,
  NewBookOptions,
  slugifyBookFolderName
} from '../common/book-scaffold';
import { AiFocusedEditorMenus } from './ai-focused-editor-menu';
import { WelcomeCommands, WelcomeWidget } from './welcome-widget';
import { AI_FOCUSED_EDITOR_WELCOME_SHOW_ON_STARTUP } from './ai-focused-editor-preferences';

/**
 * Group for the Welcome action, placed after every existing Manuscript-menu
 * group ('1'..'7') so it reads as the last entry.
 */
const WELCOME_MENU = [...AiFocusedEditorMenus.MAIN, '9_welcome'];

/**
 * Shared per-section create group in the Manuscript menu (owned by
 * `author-materials-create-contribution.ts`, whose actions use numeric orders
 * '0'..'6').
 */
const CREATE_MENU = [...AiFocusedEditorMenus.MAIN, '1a_create'];

/**
 * Menu order for "New Book...". `sortString.localeCompare` (Theia's menu
 * comparator) sorts a punctuation-prefixed key strictly ahead of the numeric
 * '0'..'6' create-command orders, so this always heads the create group —
 * verified: `'-1_new_book'.localeCompare('0') < 0`.
 */
const NEW_BOOK_ORDER = '-1_new_book';

/** Available languages offered in the wizard's language step. */
const LANGUAGE_PRESETS: readonly { label: string; code: string }[] = [
  { label: 'Russian (ru)', code: 'ru' },
  { label: 'English (en)', code: 'en' }
];

/** Outcome of one wizard step: a value, a request to go back, or a cancel (Esc). */
type StepResult<T> = { type: 'value'; value: T } | { type: 'back' } | { type: 'cancel' };

interface LanguagePick extends QuickPickItem {
  code?: string;
  other?: boolean;
}

interface NewBookWizardState {
  title: string;
  author: string;
  language: string;
  parentUri?: URI;
  folderName: string;
}

/**
 * Frontend contribution behind the AI Focused Editor welcome page and the "New
 * Book..." wizard.
 *
 * - Registers the `welcome.open` and `book.newBook` commands and their menu
 *   entries (Welcome last in the Manuscript menu; New Book first in the shared
 *   create group).
 * - Auto-opens the welcome page as the active main tab on startup — via
 *   `onDidInitializeLayout`, which runs AFTER the restored/default layout is
 *   known — but only when the show-on-startup preference is true and the main
 *   area holds no editors (an empty main area = "no open files"). Guarded to
 *   never auto-open more than once per session.
 * - Runs the New Book wizard: a QuickInput flow (title → author → language →
 *   location) with Back buttons and Esc-to-cancel, then materializes the
 *   canonical book scaffold and reloads into the new workspace.
 *
 * Ships as its own standalone `theiaExtensions` frontend entry (bound below) so
 * it stays isolated from the main manuscript-workspace frontend module.
 */
@injectable()
export class WelcomeContribution
  implements CommandContribution, MenuContribution, FrontendApplicationContribution {
  @inject(ApplicationShell)
  protected readonly shell!: ApplicationShell;

  @inject(WidgetManager)
  protected readonly widgetManager!: WidgetManager;

  @inject(PreferenceService)
  protected readonly preferenceService!: PreferenceService;

  @inject(QuickInputService)
  protected readonly quickInput!: QuickInputService;

  @inject(FileService)
  protected readonly fileService!: FileService;

  @inject(FileDialogService)
  protected readonly fileDialogService!: FileDialogService;

  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

  @inject(MessageService)
  protected readonly messages!: MessageService;

  @inject(LabelProvider)
  protected readonly labelProvider!: LabelProvider;

  /** Ensures the startup auto-open runs at most once per session. */
  protected autoOpened = false;

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(WelcomeCommands.OPEN, {
      execute: () => this.openWelcome(true)
    });
    commands.registerCommand(WelcomeCommands.NEW_BOOK, {
      execute: () => this.runNewBookWizard()
    });
  }

  registerMenus(menus: MenuModelRegistry): void {
    menus.registerMenuAction(WELCOME_MENU, {
      commandId: WelcomeCommands.OPEN.id,
      order: '0'
    });
    menus.registerMenuAction(CREATE_MENU, {
      commandId: WelcomeCommands.NEW_BOOK.id,
      order: NEW_BOOK_ORDER
    });
  }

  /**
   * Runs after the shell layout has been restored (or the default layout
   * built). Reveals the welcome page as the active main tab when the user has
   * not disabled it and there are no open editors.
   */
  async onDidInitializeLayout(): Promise<void> {
    if (this.autoOpened) {
      return;
    }
    this.autoOpened = true;
    if (!this.isShowOnStartup()) {
      return;
    }
    if (this.shell.getWidgets('main').length > 0) {
      return;
    }
    await this.openWelcome(true);
  }

  protected isShowOnStartup(): boolean {
    return this.preferenceService.get<boolean>(AI_FOCUSED_EDITOR_WELCOME_SHOW_ON_STARTUP, true) !== false;
  }

  /** Open (creating if needed) the welcome widget in the main area. */
  protected async openWelcome(activate: boolean): Promise<void> {
    const widget = await this.widgetManager.getOrCreateWidget<WelcomeWidget>(WelcomeWidget.ID);
    if (!widget.isAttached) {
      await this.shell.addWidget(widget, { area: 'main' });
    }
    if (activate) {
      await this.shell.activateWidget(widget.id);
    } else {
      await this.shell.revealWidget(widget.id);
    }
  }

  // ===========================================================================
  // New Book wizard
  // ===========================================================================

  protected async runNewBookWizard(): Promise<void> {
    const state: NewBookWizardState = {
      title: '',
      author: '',
      language: DEFAULT_BOOK_LANGUAGE,
      folderName: ''
    };
    const totalSteps = 4;

    // Index-based step machine so a Back button returns to the previous step
    // with all prior input preserved; Esc (a step's cancel) aborts the wizard.
    let index = 0;
    while (index < totalSteps) {
      if (index === 0) {
        const result = await this.inputStep({
          title: 'New Book — 1/4: title',
          step: 1,
          totalSteps,
          prompt: 'Book title',
          placeholder: 'e.g. The Great Novel',
          value: state.title,
          showBack: false,
          validate: value => (value.trim() ? undefined : 'Title cannot be empty.')
        });
        if (result.type !== 'value') {
          return; // step 1 has no Back, so cancel === abort
        }
        state.title = result.value;
        index = 1;
      } else if (index === 1) {
        const result = await this.inputStep({
          title: 'New Book — 2/4: author',
          step: 2,
          totalSteps,
          prompt: 'Author (optional)',
          placeholder: 'e.g. Jane Doe',
          value: state.author,
          showBack: true
        });
        if (result.type === 'cancel') {
          return;
        }
        if (result.type === 'back') {
          index = 0;
          continue;
        }
        state.author = result.value;
        index = 2;
      } else if (index === 2) {
        const result = await this.languageStep(state.language);
        if (result.type === 'cancel') {
          return;
        }
        if (result.type === 'back') {
          index = 1;
          continue;
        }
        state.language = result.value;
        index = 3;
      } else {
        const defaultName = state.folderName || slugifyBookFolderName(state.title);
        const result = await this.locationStep(defaultName);
        if (result.type === 'cancel') {
          return;
        }
        if (result.type === 'back') {
          index = 2;
          continue;
        }
        state.parentUri = result.value.parentUri;
        state.folderName = result.value.folderName;
        index = 4;
      }
    }

    if (!state.parentUri) {
      return;
    }
    await this.createBook(state.parentUri, state.folderName, {
      title: state.title,
      author: state.author.trim() || undefined,
      language: state.language,
      firstChapterTitle: DEFAULT_FIRST_CHAPTER_TITLE
    });
  }

  /** Step 3: choose a preset language or enter a custom code via "Other...". */
  protected async languageStep(current: string): Promise<StepResult<string>> {
    while (true) {
      const items: LanguagePick[] = [
        ...LANGUAGE_PRESETS.map(preset => ({ label: preset.label, code: preset.code })),
        { label: 'Other...', description: 'enter a custom language code', other: true }
      ];
      const picked = await this.pickStep<LanguagePick>({
        title: 'New Book — 3/4: language',
        step: 3,
        totalSteps: 4,
        placeholder: 'Choose the book language',
        items,
        showBack: true
      });
      if (picked.type !== 'value') {
        return picked;
      }
      if (picked.value.code) {
        return { type: 'value', value: picked.value.code };
      }

      // "Other...": free-text code, whose Back returns to this language picker.
      const isCustomCurrent = current.trim() !== '' && !LANGUAGE_PRESETS.some(preset => preset.code === current);
      const free = await this.inputStep({
        title: 'New Book — 3/4: language',
        step: 3,
        totalSteps: 4,
        prompt: 'Language code',
        placeholder: 'e.g. fr, de, es, uk',
        value: isCustomCurrent ? current : '',
        showBack: true,
        validate: value => (value.trim() ? undefined : 'Language code cannot be empty.')
      });
      if (free.type === 'cancel') {
        return { type: 'cancel' };
      }
      if (free.type === 'value') {
        return { type: 'value', value: free.value.trim() };
      }
      // free.type === 'back' → loop and re-show the language picker.
    }
  }

  /**
   * Step 4: pick the parent directory (folder dialog), then the new book's
   * folder name (validated to not already exist). Cancelling the dialog steps
   * back to the language step.
   */
  protected async locationStep(defaultName: string): Promise<StepResult<{ parentUri: URI; folderName: string }>> {
    const startFolder = this.workspaceService.tryGetRoots()[0];
    const selection = await this.fileDialogService.showOpenDialog(
      {
        title: 'New Book — 4/4: choose the parent folder',
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false
      },
      startFolder
    );
    const parentUri = Array.isArray(selection) ? selection[0] : selection;
    if (!parentUri) {
      return { type: 'back' };
    }

    const nameResult = await this.inputStep({
      title: 'New Book — 4/4: folder name',
      step: 4,
      totalSteps: 4,
      prompt: `New book folder inside ${this.labelProvider.getLongName(parentUri)}`,
      placeholder: 'book-folder-name',
      value: defaultName,
      showBack: true,
      validate: async value => {
        const trimmed = value.trim();
        if (!trimmed) {
          return 'Folder name cannot be empty.';
        }
        if (/[\\/]/.test(trimmed)) {
          return 'Folder name must not contain path separators.';
        }
        const exists = await this.fileService.exists(parentUri.resolve(trimmed));
        return exists ? 'A file or folder with this name already exists here.' : undefined;
      }
    });
    if (nameResult.type === 'cancel') {
      return { type: 'cancel' };
    }
    if (nameResult.type === 'back') {
      return { type: 'back' };
    }
    return { type: 'value', value: { parentUri, folderName: nameResult.value.trim() } };
  }

  /**
   * Materialize the canonical scaffold under `parentUri/folderName` in order
   * (parents before children), then reload into the new folder as the workspace.
   */
  protected async createBook(parentUri: URI, folderName: string, options: NewBookOptions): Promise<void> {
    const bookUri = parentUri.resolve(folderName);
    try {
      await this.fileService.createFolder(bookUri);
      for (const entry of bookScaffoldEntries(options)) {
        const target = bookUri.resolve(entry.path);
        if (entry.kind === 'folder') {
          await this.fileService.createFolder(target);
        } else {
          await this.fileService.create(target, entry.seed ?? '', { overwrite: false });
        }
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.messages.error(`Could not create the book: ${detail}`);
      return;
    }
    // Reloads the window into the new workspace folder.
    this.workspaceService.open(bookUri);
  }

  // ===========================================================================
  // QuickInput step helpers (Back button + Esc-cancel)
  // ===========================================================================

  protected inputStep(opts: {
    title: string;
    step: number;
    totalSteps: number;
    prompt: string;
    placeholder?: string;
    value?: string;
    showBack: boolean;
    validate?: (value: string) => Promise<string | undefined> | string | undefined;
  }): Promise<StepResult<string>> {
    return new Promise<StepResult<string>>(resolve => {
      const input = this.quickInput.createInputBox();
      input.title = opts.title;
      input.step = opts.step;
      input.totalSteps = opts.totalSteps;
      input.prompt = opts.prompt;
      input.value = opts.value ?? '';
      input.placeholder = opts.placeholder;
      input.ignoreFocusOut = true;
      input.buttons = opts.showBack ? [this.quickInput.backButton] : [];

      let settled = false;
      const finish = (result: StepResult<string>): void => {
        if (settled) {
          return;
        }
        settled = true;
        input.hide();
        resolve(result);
      };

      input.onDidChangeValue(() => {
        input.validationMessage = undefined;
      });
      input.onDidTriggerButton(button => {
        if (button === this.quickInput.backButton) {
          finish({ type: 'back' });
        }
      });
      input.onDidAccept(async () => {
        const value = (input.value ?? '').trim();
        if (opts.validate) {
          input.busy = true;
          const error = await opts.validate(value);
          input.busy = false;
          if (error) {
            input.validationMessage = error;
            return;
          }
        }
        finish({ type: 'value', value });
      });
      input.onDidHide(() => {
        input.dispose();
        if (!settled) {
          settled = true;
          resolve({ type: 'cancel' });
        }
      });
      input.show();
    });
  }

  protected pickStep<T extends QuickPickItem>(opts: {
    title: string;
    step: number;
    totalSteps: number;
    placeholder: string;
    items: T[];
    showBack: boolean;
  }): Promise<StepResult<T>> {
    return new Promise<StepResult<T>>(resolve => {
      const quickPick = this.quickInput.createQuickPick<T>();
      quickPick.title = opts.title;
      quickPick.step = opts.step;
      quickPick.totalSteps = opts.totalSteps;
      quickPick.placeholder = opts.placeholder;
      quickPick.items = opts.items;
      quickPick.ignoreFocusOut = true;
      quickPick.buttons = opts.showBack ? [this.quickInput.backButton] : [];

      let settled = false;
      const finish = (result: StepResult<T>): void => {
        if (settled) {
          return;
        }
        settled = true;
        quickPick.hide();
        resolve(result);
      };

      quickPick.onDidTriggerButton(button => {
        if (button === this.quickInput.backButton) {
          finish({ type: 'back' });
        }
      });
      quickPick.onDidAccept(() => {
        const selected = quickPick.selectedItems[0] ?? quickPick.activeItems[0];
        if (selected) {
          finish({ type: 'value', value: selected });
        }
      });
      quickPick.onDidHide(() => {
        quickPick.dispose();
        if (!settled) {
          settled = true;
          resolve({ type: 'cancel' });
        }
      });
      quickPick.show();
    });
  }
}

/**
 * Standalone frontend module for the welcome page + New Book wizard.
 *
 * Registered as its own `theiaExtensions` frontend entry so it stays isolated
 * from `manuscript-workspace-frontend-module.ts`. The welcome widget is a
 * main-area singleton created through a {@link WidgetFactory}; the contribution
 * wires commands, menus and the startup auto-open.
 */
export default new ContainerModule(bind => {
  bind(WelcomeWidget).toSelf().inSingletonScope();
  bind(WidgetFactory).toDynamicValue(ctx => ({
    id: WelcomeWidget.ID,
    createWidget: () => ctx.container.get(WelcomeWidget)
  })).inSingletonScope();

  bind(WelcomeContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(WelcomeContribution);
  bind(MenuContribution).toService(WelcomeContribution);
  bind(FrontendApplicationContribution).toService(WelcomeContribution);
});
