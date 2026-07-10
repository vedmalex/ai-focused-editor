import { injectable } from '@theia/core/shared/inversify';
import type {
  LocalAiStreamClient,
  LocalAiStreamWireEvent
} from '../common';

/**
 * Frontend endpoint of the backend→frontend stream channel: the backend calls
 * onLocalAiStreamEvent over JSON-RPC and events are dispatched to the
 * consumer registered for that streamId.
 */
@injectable()
export class LocalAiStreamClientImpl implements LocalAiStreamClient {
  protected readonly handlers = new Map<string, (event: LocalAiStreamWireEvent) => void>();

  onLocalAiStreamEvent(streamId: string, event: LocalAiStreamWireEvent): void {
    this.handlers.get(streamId)?.(event);
  }

  register(streamId: string, handler: (event: LocalAiStreamWireEvent) => void): void {
    this.handlers.set(streamId, handler);
  }

  unregister(streamId: string): void {
    this.handlers.delete(streamId);
  }
}
