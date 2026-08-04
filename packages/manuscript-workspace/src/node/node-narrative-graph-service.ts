import { isAbsolute, resolve } from 'path';
import { FileUri } from '@theia/core/lib/common/file-uri';
import { inject, injectable } from '@theia/core/shared/inversify';
import {
  NarrativeKnowledgeService,
  OWNERSHIP_REL_TYPE,
  type NarrativeKnowledgeService as NarrativeKnowledgeServiceType,
  type NarrativeMention
} from '@ai-focused-editor/narrative-knowledge';
import {
  assembleNarrativeGraphSnapshot,
  type NarrativeGraphBackendService,
  type NarrativeGraphChapterInput,
  type NarrativeGraphSnapshot
} from '../common';

/**
 * Thin adapter over `NarrativeKnowledgeService` (TASK-022 WP-7, tech_spec
 * TECH_SPEC WP-7 §1 and §7).
 *
 * WHY THIS CLASS STILL EXISTS AT ALL. `relations-map-contribution.ts:73-74`
 * injects `NarrativeGraphService` (the frontend interface this class's backend
 * counterpart serves over RPC) and is a LIVING CONSUMER outside WP-7's four —
 * an earlier brief that assumed it could be deleted was wrong, corrected by
 * reading the code (tech_spec TECH_SPEC WP-7 §1). Deleting it would break that
 * contribution's "Generate Relations Map..." command. So `NarrativeGraphService`
 * / `BrowserNarrativeGraphService` / `narrative-graph-protocol.ts` stay BYTE
 * FOR BYTE — this class satisfies their existing RPC contract precisely,
 * exactly as `NodeNarrativeEntityService` (`node-domain-knowledge-service.ts`)
 * now does for the entity-card protocol.
 *
 * WHAT CHANGED: it no longer scans `entities/**`, reads `manifest.yaml` off
 * disk, or calls `parseSemanticMarkdown` itself — every one of those was an
 * independent source of narrative knowledge, exactly what readiness check #5
 * (ISS-307) forbids. All of it is now delegated to `NarrativeKnowledgeService`
 * in-process (same Node process, no RPC hop — `NodeNarrativeEntityService`
 * establishes the same pattern), and the actual assembly is
 * `assembleNarrativeGraphSnapshot` (`../common/narrative-graph-assembler.ts`),
 * a pure function with no Theia import so it can be unit-tested without this
 * class at all.
 *
 * SCOPE NOTE, RECORDED RATHER THAN IMPLIED (deviation from tech_spec TECH_SPEC
 * WP-7 §7 point 6). The §7 sketch floats the SAME assembler being called a
 * second time from `narrative-map-widget.ts` in the browser, bypassing this
 * class and `NarrativeGraphService` entirely. That migration is NOT done here:
 * nothing in the WP-7 readiness block (checks #1 and #5) requires touching the
 * widget, `BrowserNarrativeGraphService`, or `relations-map-contribution.ts` —
 * both checks are about independent FS scanning, and the only class that ever
 * scanned is this one. The widget keeps getting its `NarrativeGraphSnapshot`
 * over the SAME unchanged RPC path; it is now index-sourced by construction,
 * with zero risk to a path that carries no test coverage of its own.
 */
@injectable()
export class NodeNarrativeGraphService implements NarrativeGraphBackendService {
  @inject(NarrativeKnowledgeService)
  protected readonly knowledge!: NarrativeKnowledgeServiceType;

  getSnapshot(rootUri?: string): Promise<NarrativeGraphSnapshot> {
    if (!rootUri) {
      return Promise.resolve({
        timeline: [],
        ownership: [],
        nodes: [],
        relations: [],
        truncated: false,
        totalEntities: 0,
        diagnostics: [{
          severity: 'info',
          source: 'narrative-graph',
          message: 'Open a manuscript workspace to view the narrative map.'
        }]
      });
    }

    return this.compute(rootUri);
  }

  refresh(rootUri?: string): Promise<NarrativeGraphSnapshot> {
    return this.getSnapshot(rootUri);
  }

  protected async compute(rootUri: string): Promise<NarrativeGraphSnapshot> {
    const rootPath = toRootPath(rootUri);

    const [manifestEnvelope, documentsEnvelope, entitiesEnvelope, ownershipEnvelope] = await Promise.all([
      this.knowledge.getManifestChapters(rootUri),
      this.knowledge.listDocuments(rootUri),
      this.knowledge.findEntities(rootUri),
      this.knowledge.getRelations(rootUri, { relType: OWNERSHIP_REL_TYPE, origin: 'explicit' })
    ]);

    const manifest = manifestEnvelope.data;
    const indexedChapterPaths = new Set(
      documentsEnvelope.data.filter(document => document.kind === 'chapter').map(document => document.relPath)
    );

    const presentManifestChapters = manifest.chapters.filter(chapter => indexedChapterPaths.has(chapter.path));
    const missingChapterPaths = manifest.chapters
      .filter(chapter => !indexedChapterPaths.has(chapter.path))
      .map(chapter => chapter.path);

    const mentionsByPath = new Map<string, readonly NarrativeMention[]>(
      await Promise.all(presentManifestChapters.map(async chapter => {
        const mentions = await this.knowledge.getMentions(rootUri, { relPath: chapter.path });
        return [chapter.path, mentions.data] as const;
      }))
    );

    const presentChapters: NarrativeGraphChapterInput[] = presentManifestChapters.map(chapter => ({
      path: chapter.path,
      title: chapter.title,
      order: chapter.order,
      buildIncluded: chapter.buildIncluded,
      mentions: mentionsByPath.get(chapter.path) ?? []
    }));

    return assembleNarrativeGraphSnapshot({
      rootUri: FileUri.create(rootPath).toString(),
      manifestPresent: manifest.present,
      manifestProblems: manifest.problems,
      presentChapters,
      missingChapterPaths,
      entities: entitiesEnvelope.data,
      ownershipRelations: ownershipEnvelope.data,
      toUri: relPath => FileUri.create(resolve(rootPath, relPath)).toString()
    });
  }
}

function toRootPath(rootUri: string): string {
  if (rootUri.startsWith('file:')) {
    return FileUri.fsPath(rootUri);
  }
  return isAbsolute(rootUri) ? rootUri : resolve(process.cwd(), rootUri);
}
