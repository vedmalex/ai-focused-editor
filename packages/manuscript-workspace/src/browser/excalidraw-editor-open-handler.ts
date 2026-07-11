import URI from '@theia/core/lib/common/uri';
import {
  NavigatableWidgetOpenHandler,
  WidgetOpenerOptions
} from '@theia/core/lib/browser';
import { nls } from '@theia/core/lib/common/nls';
import { injectable } from '@theia/core/shared/inversify';
import { ExcalidrawEditorWidget } from './excalidraw-editor-widget';

/**
 * Priority for `.excalidraw` files. The text editor's `EditorManager` returns
 * `100`, so `500` makes the diagram editor the default opener while the raw JSON
 * stays reachable through "Open With...".
 */
const EXCALIDRAW_PRIORITY = 500;

export function isExcalidrawFile(uri: URI): boolean {
  return uri.path.toString().toLowerCase().endsWith('.excalidraw');
}

@injectable()
export class ExcalidrawEditorOpenHandler extends NavigatableWidgetOpenHandler<ExcalidrawEditorWidget> {
  readonly id = ExcalidrawEditorWidget.FACTORY_ID;
  readonly label = nls.localize('ai-focused-editor/excalidraw/open-handler-label', 'Excalidraw Diagram Editor');

  canHandle(uri: URI, _options?: WidgetOpenerOptions): number {
    return isExcalidrawFile(uri) ? EXCALIDRAW_PRIORITY : 0;
  }
}
