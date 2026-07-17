import { injectable } from '@theia/core/shared/inversify';

/** Handle returned by {@link AiConnectStreamController.register}. */
export interface AiConnectStreamRegistration {
  /** Fed into the streaming call's `pauseSignal`; fires when this stream is paused. */
  readonly pauseSignal: AbortSignal;
  /** Deregisters the stream; MUST be called when the stream ends or throws. */
  done(): void;
}

/**
 * Tracks in-flight AI streaming requests so a user command can PAUSE the most
 * recent one (ai-connect `pauseSignal` semantics: a pause yields a terminal
 * `{type:'paused'}` that keeps the partial answer, unlike an abort). Each
 * streaming request calls {@link register} to obtain a fresh pause signal and
 * {@link AiConnectStreamRegistration.done} when it finishes. Registration order
 * is preserved so {@link pauseLatest} targets the newest still-active stream.
 */
@injectable()
export class AiConnectStreamController {
  /** Active registrations in registration order (oldest first). */
  protected readonly active: AbortController[] = [];

  register(): AiConnectStreamRegistration {
    const controller = new AbortController();
    this.active.push(controller);
    return {
      pauseSignal: controller.signal,
      done: () => {
        const index = this.active.indexOf(controller);
        if (index >= 0) {
          this.active.splice(index, 1);
        }
      }
    };
  }

  /**
   * Pauses the most-recently-registered stream that has not already been
   * paused. Returns whether a stream was paused.
   */
  pauseLatest(): boolean {
    for (let index = this.active.length - 1; index >= 0; index--) {
      const controller = this.active[index];
      if (!controller.signal.aborted) {
        controller.abort();
        return true;
      }
    }
    return false;
  }

  /** Pauses every active stream. */
  pauseAll(): void {
    for (const controller of this.active) {
      if (!controller.signal.aborted) {
        controller.abort();
      }
    }
  }
}
