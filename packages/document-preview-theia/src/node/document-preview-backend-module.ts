import { ContainerModule } from '@theia/core/shared/inversify';
import { ConnectionHandler } from '@theia/core/lib/common/messaging/handler';
import { RpcConnectionHandler } from '@theia/core/lib/common/messaging/proxy-factory';
import {
  DocumentPreviewService,
  DocumentPreviewServicePath
} from '../common';
import { NodeDocumentPreviewService } from './node-document-preview-service';

/**
 * Backend module for the document preview: binds the node conversion service
 * and exposes it over RPC on {@link DocumentPreviewServicePath} (the frontend
 * module binds the matching proxy). Extracted verbatim from
 * manuscript-workspace's backend module.
 */
export default new ContainerModule(bind => {
  bind(NodeDocumentPreviewService).toSelf().inSingletonScope();
  bind(DocumentPreviewService).toService(NodeDocumentPreviewService);
  bind(ConnectionHandler).toDynamicValue(ctx =>
    new RpcConnectionHandler(DocumentPreviewServicePath, () =>
      ctx.container.get(DocumentPreviewService)
    )
  ).inSingletonScope();
});
