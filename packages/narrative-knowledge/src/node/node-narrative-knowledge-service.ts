import { injectable } from '@theia/core/shared/inversify';
import {
  NOT_BUILT_INDEX_STATE,
  type IndexState,
  type NarrativeKnowledgeService
} from '../common';

/**
 * Backend implementation of {@link NarrativeKnowledgeService} (TASK-022 WP-0).
 *
 * WP-0 SCOPE — this is the round-trip probe and nothing else. There is no
 * store, no watcher and no extraction yet, so the only state it can HONESTLY
 * report is `absent`/`not-built`: a manuscript may well exist, but this
 * service has never built an index for it. Reporting `ready` here would be the
 * failure mode the whole `IndexState` envelope exists to prevent — an empty
 * answer that claims to be an authoritative one.
 *
 * The store, the generation counter and the real state machine arrive in WP-3
 * and WP-4a; this class is their seam, which is what makes the frontend
 * proxy, the RPC path and the app wiring provable NOW instead of at the end.
 */
@injectable()
export class NodeNarrativeKnowledgeService implements NarrativeKnowledgeService {
  async getIndexStatus(): Promise<IndexState> {
    return NOT_BUILT_INDEX_STATE;
  }
}
