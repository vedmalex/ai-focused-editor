import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { Message } from '@theia/core/shared/@lumino/messaging';
import { Disposable, nls } from '@theia/core/lib/common';
import { MessageService } from '@theia/core/lib/common/message-service';
import URI from '@theia/core/lib/common/uri';
import {
  Key,
  SelectableTreeNode,
  codiconArray,
  createIconButton,
  setEnabled
} from '@theia/core/lib/browser';
import {
  OpenFileDialog,
  OpenFileDialogProps
} from '@theia/filesystem/lib/browser/file-dialog';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { DirNode } from '@theia/filesystem/lib/browser/file-tree';

export const NEW_FOLDER_BUTTON_CLASS = 'afe-NewFolderButton';
export const NEW_FOLDER_DIALOG_CLASS = 'afe-FileDialogWithNewFolder';
export const NEW_FOLDER_INPUT_PANEL_CLASS = 'afe-NewFolderInputPanel';
export const NEW_FOLDER_NAME_INPUT_CLASS = 'afe-NewFolderNameInput';
export const NEW_FOLDER_ERROR_CLASS = 'afe-NewFolderError';

/**
 * Drop-in replacement for Theia's {@link OpenFileDialog} that adds a
 * "New Folder" icon button to the dialog's navigation panel (next to the
 * back/forward/home/up buttons), so a user browsing for a folder to open can
 * create one on the spot — like the Finder / VS Code open dialogs.
 *
 * Clicking the button reveals an inline name-input row inside the dialog
 * (mirroring the SaveFileDialog's inline filename field). Enter creates the
 * folder in the currently browsed directory, refreshes the tree, and selects
 * the freshly created folder; Escape dismisses the row. The dialog stays open
 * the whole time.
 *
 * Why an inline row and NOT `QuickInputService.input(...)`: the modal
 * `AbstractDialog` marks every other body child `inert`
 * (`preventTabbingOutsideDialog`) — including monaco's startup-created
 * `#quick-input-container` — so a quick input opened above this dialog
 * renders but cannot take keyboard focus. (Verified live; additionally the
 * quick input's Enter/Escape handling proved unreliable in this app even
 * without a dialog open.) The inline row lives inside the dialog node, so
 * modality cannot break it.
 *
 * Installed via a `rebind(OpenFileDialogFactory)` in the frontend module;
 * the Save dialog factory is left untouched.
 */
@injectable()
export class NewFolderOpenFileDialog extends OpenFileDialog {

  @inject(FileService)
  protected readonly fileService!: FileService;

  @inject(MessageService)
  protected readonly messageService!: MessageService;

  protected newFolderButton: HTMLSpanElement | undefined;
  protected newFolderPanel: HTMLDivElement | undefined;
  protected newFolderInput: HTMLInputElement | undefined;
  protected newFolderError: HTMLSpanElement | undefined;

  /** Monotonic token so a stale async validation never overwrites a newer one. */
  protected newFolderValidationSeq = 0;

  constructor(@inject(OpenFileDialogProps) props: OpenFileDialogProps) {
    super(props);
  }

  @postConstruct()
  override init(): void {
    super.init();
    this.appendNewFolderControls();
  }

  protected appendNewFolderControls(): void {
    if (this.newFolderButton) {
      // Guard: init() must never append the controls twice.
      return;
    }
    // The base FileDialog.init() creates the navigation panel and stores the
    // icon buttons (back/forward/home/up) on `this`; the panel itself is a
    // local variable there, so reach it through the last button it appended.
    const navigationPanel = this.up?.parentElement;
    if (!navigationPanel) {
      return;
    }
    this.contentNode.classList.add(NEW_FOLDER_DIALOG_CLASS);

    this.newFolderButton = createIconButton(...codiconArray('new-folder', true));
    this.newFolderButton.classList.add(NEW_FOLDER_BUTTON_CLASS);
    this.newFolderButton.title = nls.localize('ai-focused-editor/file-dialog/new-folder', 'New Folder');
    // Keep the icon row together: insert right after "up", before the location list.
    this.up.insertAdjacentElement('afterend', this.newFolderButton);

    this.newFolderPanel = document.createElement('div');
    this.newFolderPanel.classList.add(NEW_FOLDER_INPUT_PANEL_CLASS);
    this.newFolderPanel.style.display = 'none';

    this.newFolderInput = document.createElement('input');
    this.newFolderInput.type = 'text';
    this.newFolderInput.spellcheck = false;
    this.newFolderInput.classList.add('theia-input', NEW_FOLDER_NAME_INPUT_CLASS);
    this.newFolderInput.placeholder = nls.localize('ai-focused-editor/file-dialog/new-folder-placeholder', 'Folder name');
    this.newFolderInput.title = nls.localize('ai-focused-editor/file-dialog/new-folder-prompt', 'Enter a name for the new folder');
    this.newFolderPanel.appendChild(this.newFolderInput);

    this.newFolderError = document.createElement('span');
    this.newFolderError.classList.add(NEW_FOLDER_ERROR_CLASS);
    this.newFolderPanel.appendChild(this.newFolderError);

    navigationPanel.insertAdjacentElement('afterend', this.newFolderPanel);

    const onInput = () => { this.runLiveValidation(); };
    this.newFolderInput.addEventListener('input', onInput);
    this.toDispose.push(Disposable.create(() =>
      this.newFolderInput?.removeEventListener('input', onInput)));
  }

  protected override onAfterAttach(msg: Message): void {
    super.onAfterAttach(msg);
    if (this.newFolderButton) {
      this.addKeyListener(this.newFolderButton, Key.ENTER, () => {
        this.addTransformEffectToIcon(this.newFolderButton!);
        this.toggleNewFolderInput();
      }, 'click');
    }
    if (this.newFolderInput) {
      // These listeners consume the events (addKeyListener stops propagation
      // unless the handler returns false), so the dialog's own document-level
      // ENTER (accept) / ESCAPE (close) handling never fires while the user
      // is typing a folder name.
      this.addKeyListener(this.newFolderInput, Key.ENTER, () => {
        this.confirmNewFolder();
      });
      this.addKeyListener(this.newFolderInput, Key.ESCAPE, () => {
        this.hideNewFolderInput();
      });
    }
  }

  protected override onUpdateRequest(msg: Message): void {
    super.onUpdateRequest(msg);
    if (this.newFolderButton) {
      setEnabled(this.newFolderButton, !!this.model.location);
    }
  }

  protected toggleNewFolderInput(): void {
    if (!this.newFolderPanel || !this.newFolderInput) {
      return;
    }
    if (this.newFolderPanel.style.display === 'none') {
      this.showNewFolderInput();
    } else {
      this.hideNewFolderInput();
    }
  }

  protected showNewFolderInput(): void {
    if (!this.newFolderPanel || !this.newFolderInput || !this.model.location) {
      return;
    }
    this.newFolderPanel.style.display = 'flex';
    this.newFolderInput.value = '';
    this.setNewFolderError(undefined);
    this.newFolderInput.focus();
  }

  protected hideNewFolderInput(): void {
    if (!this.newFolderPanel) {
      return;
    }
    this.newFolderPanel.style.display = 'none';
    this.setNewFolderError(undefined);
    // Hand focus back to the dialog so keyboard navigation keeps working.
    this.widget.activate();
  }

  protected setNewFolderError(message: string | undefined): void {
    if (this.newFolderError) {
      this.newFolderError.textContent = message ?? '';
    }
  }

  protected async runLiveValidation(): Promise<string | undefined> {
    if (!this.newFolderInput) {
      return undefined;
    }
    const parent = this.model.location;
    if (!parent) {
      return undefined;
    }
    const seq = ++this.newFolderValidationSeq;
    const message = await this.validateFolderName(parent, this.newFolderInput.value);
    if (seq === this.newFolderValidationSeq) {
      this.setNewFolderError(message);
    }
    return message;
  }

  protected async validateFolderName(parent: URI, value: string): Promise<string | undefined> {
    const name = value.trim();
    if (!name) {
      return nls.localize('ai-focused-editor/file-dialog/name-empty', 'Folder name cannot be empty');
    }
    if (/[/\\]/.test(name) || name === '.' || name === '..') {
      return nls.localize('ai-focused-editor/file-dialog/name-invalid', 'Folder name must not contain path separators');
    }
    if (await this.fileService.exists(parent.resolve(name))) {
      return nls.localize('ai-focused-editor/file-dialog/name-exists', "A file or folder '{0}' already exists here", name);
    }
    return undefined;
  }

  protected async confirmNewFolder(): Promise<void> {
    if (!this.newFolderInput) {
      return;
    }
    const parent = this.model.location;
    if (!parent) {
      return;
    }
    const name = this.newFolderInput.value.trim();
    const validationMessage = await this.validateFolderName(parent, name);
    if (validationMessage) {
      this.setNewFolderError(validationMessage);
      return;
    }
    const newFolderUri = parent.resolve(name);
    try {
      await this.fileService.createFolder(newFolderUri);
    } catch (error) {
      this.messageService.error(nls.localize(
        'ai-focused-editor/file-dialog/create-failed',
        "Failed to create folder '{0}': {1}",
        name,
        error instanceof Error ? error.message : String(error)
      ));
      return; // keep the dialog AND the input row open
    }
    this.hideNewFolderInput();
    await this.revealNewFolder(newFolderUri);
  }

  /**
   * Refresh the browsed directory so the new folder shows up, then select it
   * so the user can immediately press "Open". Falls back to navigating into
   * the new folder if its node cannot be found after the refresh.
   */
  protected async revealNewFolder(newFolderUri: URI): Promise<void> {
    await this.model.refresh();
    const node = Array.from(this.model.getNodesByUri(newFolderUri))
      .find(SelectableTreeNode.is);
    if (node) {
      this.model.selectNode(node);
    } else {
      // Deterministic fallback: enter the new folder (same mechanics as the
      // FileTreeModel `location` setter, but awaitable).
      const fileStat = await this.fileService.resolve(newFolderUri);
      await this.model.navigateTo(DirNode.createRoot(fileStat));
    }
    this.update();
  }
}
