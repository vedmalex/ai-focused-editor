import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { StorageService } from '@theia/core/lib/browser/storage-service';
import { nls } from '@theia/core/lib/common/nls';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import {
  inject,
  injectable,
  postConstruct
} from '@theia/core/shared/inversify';
import React from '@theia/core/shared/react';
import {
  NarrativeIndexChangeWatcher,
  type NarrativeIndexChangedEvent,
  type NarrativeIndexChangeWatcher as NarrativeIndexChangeWatcherType,
  type NarrativeOrigin
} from '@ai-focused-editor/narrative-knowledge';
import {
  NarrativeGraphService,
  NarrativeGraphSnapshot,
  NarrativeOwnershipEntry,
  NarrativeOwnershipTransfer,
  NarrativeRelationEdge,
  NarrativeRelationNode,
  NarrativeTimelineChapter,
  WorkspaceDiagnostic
} from '../common';

const h = React.createElement;

/** SVG canvas geometry for the co-occurrence ring. */
const SVG_SIZE = 460;
const SVG_CENTER = SVG_SIZE / 2;
const RING_RADIUS = 150;
const LABEL_RADIUS = RING_RADIUS + 16;

/** One resolved graph edge, always carrying its origin (TASK-022 UR-044) — the
 *  shape `computeVisibleGraph` returns, after defaulting the protocol's
 *  optional `origin` so every downstream render function can rely on it. */
interface VisibleEdge extends NarrativeRelationEdge {
  origin: NarrativeOrigin;
}

@injectable()
export class NarrativeMapWidget extends ReactWidget {
  static readonly ID = 'ai-focused-editor.narrative-map';
  static readonly LABEL = 'Narrative Map';

  @inject(NarrativeGraphService)
  protected readonly graphService!: NarrativeGraphService;

  @inject(NarrativeIndexChangeWatcher)
  protected readonly indexChangeWatcher!: NarrativeIndexChangeWatcherType;

  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

  @inject(StorageService)
  protected readonly storageService!: StorageService;

  /** Persisted key for the "show co-mentions" toggle (TASK-022 UR-044b) — the
   *  same `StorageService` pattern `transcript-check-widget.ts` uses for its
   *  playback-position persistence, which is workspace-scoped by the
   *  `WorkspaceStorageService` binding underneath, so the choice survives a
   *  restart without leaking across different books. */
  protected static readonly SHOW_CO_OCCURRENCE_KEY = 'afe-narrative-map:show-co-occurrence';

  protected snapshot: NarrativeGraphSnapshot | undefined;
  protected loading = false;
  /** Whether co-occurrence (`origin: 'derived'`) edges/nodes are drawn.
   *  Defaults OFF (UR-044b: "на чистой карте только авторское") and is
   *  restored from `storageService` before the FIRST paint in `initialize()`
   *  — never flips visibly after an initial derived-edges-shown render. */
  protected showCoOccurrence = false;
  /** The workspace root this widget answers pushes for — resolved the same
   *  way every other narrative-knowledge consumer resolves it
   *  (`entity-cards-widget.ts`, `browser-narrative-graph-service.ts`), rather
   *  than reused from `snapshot.rootUri`: that field is rebuilt from the
   *  BACKEND's canonical filesystem path (`node-narrative-graph-service.ts`'s
   *  `FileUri.create(rootPath)`), which can differ byte-for-byte from the
   *  `file:` string this frontend cached — a realpath through a symlink on
   *  macOS being the ordinary case. Comparing against a SEPARATELY resolved,
   *  never-canonicalised value keeps the equality check exact. */
  protected rootUri: string | undefined;
  /** Set when a push arrives while this widget is closed or scrolled out of
   *  view (TASK-022 UR-043) — see `EntityCardsWidget`'s identical field for
   *  the full reasoning; the two widgets are the pair UR-043 names. */
  protected pendingRefresh = false;

  @postConstruct()
  protected init(): void {
    this.id = NarrativeMapWidget.ID;
    this.title.label = nls.localize('ai-focused-editor/entities/map-title', NarrativeMapWidget.LABEL);
    this.title.caption = nls.localize('ai-focused-editor/entities/map-caption', 'AI Focused Editor narrative timeline and relationship map');
    this.title.iconClass = 'fa fa-share-alt';
    this.title.closable = true;
    this.addClass('afe-narrative-map');
    this.toDispose.push(this.indexChangeWatcher.onDidIndexChange(event => this.onIndexChanged(event)));
    this.toDispose.push(this.onDidChangeVisibility(visible => {
      if (visible && this.pendingRefresh) {
        this.pendingRefresh = false;
        void this.refresh();
      }
    }));
    void this.initialize();
  }

  /** Restore the persisted toggle BEFORE the first `refresh()`/paint, so the
   *  map never flashes "co-mentions shown" and then hides them a tick later
   *  (the flash `transcript-check-widget.ts:836` avoids the same way for its
   *  own persisted playback state). */
  protected async initialize(): Promise<void> {
    this.showCoOccurrence = (await this.storageService.getData<boolean>(
      NarrativeMapWidget.SHOW_CO_OCCURRENCE_KEY
    )) ?? false;
    await this.refresh();
  }

  protected async setShowCoOccurrence(value: boolean): Promise<void> {
    if (this.showCoOccurrence === value) {
      return;
    }
    this.showCoOccurrence = value;
    this.update();
    await this.storageService.setData(NarrativeMapWidget.SHOW_CO_OCCURRENCE_KEY, value);
  }

  async refresh(): Promise<void> {
    this.loading = true;
    this.update();
    try {
      this.rootUri = await this.getRootUri();
      this.snapshot = await this.graphService.refresh();
    } finally {
      this.loading = false;
      this.update();
    }
  }

  protected async getRootUri(): Promise<string | undefined> {
    await this.workspaceService.ready;
    const root = this.workspaceService.tryGetRoots()[0] ?? (await this.workspaceService.roots)[0];
    return root?.resource.toString();
  }

  /** See `EntityCardsWidget.onIndexChanged` for the full reasoning — this is
   *  the same filter and the same visibility guard, applied here. */
  protected onIndexChanged(event: NarrativeIndexChangedEvent): void {
    if (this.rootUri === undefined || event.rootUri !== this.rootUri) {
      return;
    }
    if (this.isVisible) {
      void this.refresh();
    } else {
      this.pendingRefresh = true;
    }
  }

  protected render(): React.ReactNode {
    const snapshot = this.snapshot;
    return h(
      'div',
      { className: 'afe-narrative-map-body' },
      this.renderHeader(),
      !snapshot
        ? h('p', { className: 'afe-empty-state' }, this.loading
          ? nls.localize('ai-focused-editor/entities/loading-map', 'Loading narrative map...')
          : nls.localize('ai-focused-editor/entities/no-data', 'No data yet.'))
        : h(
          React.Fragment,
          undefined,
          this.renderDiagnostics(snapshot.diagnostics),
          this.renderTimeline(snapshot),
          this.renderRelations(snapshot)
        )
    );
  }

  protected renderHeader(): React.ReactNode {
    return h(
      'div',
      { className: 'afe-narrative-map-header' },
      h('h3', undefined, nls.localize('ai-focused-editor/entities/map-title', 'Narrative Map')),
      h(
        'button',
        {
          className: 'theia-button secondary',
          disabled: this.loading,
          onClick: () => this.refresh()
        },
        this.loading
          ? nls.localize('ai-focused-editor/entities/refreshing', 'Refreshing...')
          : nls.localize('ai-focused-editor/entities/refresh', 'Refresh')
      )
    );
  }

  protected renderDiagnostics(diagnostics: WorkspaceDiagnostic[]): React.ReactNode {
    if (diagnostics.length === 0) {
      return undefined;
    }
    return h(
      'div',
      { className: 'afe-narrative-map-diagnostics' },
      ...diagnostics.map((diagnostic, index) => h(
        'div',
        {
          key: `${diagnostic.source}-${index}`,
          className: `afe-narrative-map-diagnostic ${diagnostic.severity}`
        },
        `${diagnostic.severity}: ${diagnostic.message}`
      ))
    );
  }

  // ---------- timeline ----------

  protected renderTimeline(snapshot: NarrativeGraphSnapshot): React.ReactNode {
    return h(
      'section',
      { className: 'afe-narrative-map-section' },
      h('h4', undefined, nls.localize('ai-focused-editor/entities/timeline', 'Timeline')),
      this.renderOwnership(snapshot.ownership),
      snapshot.timeline.length === 0
        ? h('p', { className: 'afe-empty-state' }, nls.localize('ai-focused-editor/entities/no-chapters', 'No chapters found in the manifest.'))
        : h(
          'div',
          { className: 'afe-narrative-timeline' },
          ...snapshot.timeline.map(chapter => this.renderTimelineRow(chapter))
        )
    );
  }

  protected renderTimelineRow(chapter: NarrativeTimelineChapter): React.ReactNode {
    return h(
      'div',
      {
        key: `${chapter.order}-${chapter.path}`,
        className: `afe-narrative-timeline-row${chapter.buildIncluded ? '' : ' excluded'}`
      },
      h(
        'div',
        { className: 'afe-narrative-timeline-chapter' },
        h('span', { className: 'afe-narrative-timeline-order' }, `${chapter.order + 1}`),
        h('span', { className: 'afe-narrative-timeline-title' }, chapter.title),
        chapter.buildIncluded ? undefined : h('span', { className: 'afe-narrative-timeline-flag' }, nls.localize('ai-focused-editor/entities/excluded', 'excluded'))
      ),
      chapter.entities.length === 0
        ? h('span', { className: 'afe-narrative-chip-empty' }, nls.localize('ai-focused-editor/entities/no-tagged-entities', 'no tagged entities'))
        : h(
          'div',
          { className: 'afe-narrative-chip-row' },
          ...chapter.entities.map(entity => h(
            'span',
            {
              key: `${entity.kind}:${entity.id}`,
              className: `afe-narrative-chip ${entity.kind}`,
              title: `${entity.kind}:${entity.id}`
            },
            `${entity.label} × ${entity.count}`
          ))
        )
    );
  }

  protected renderOwnership(ownership: NarrativeOwnershipTransfer[]): React.ReactNode {
    if (ownership.length === 0) {
      return undefined;
    }
    return h(
      'div',
      { className: 'afe-narrative-ownership' },
      h('h5', undefined, nls.localize('ai-focused-editor/entities/artifact-ownership', 'Artifact ownership')),
      ...ownership.map(transfer => this.renderOwnershipTransfer(transfer))
    );
  }

  protected renderOwnershipTransfer(transfer: NarrativeOwnershipTransfer): React.ReactNode {
    const chain: React.ReactNode[] = [];
    transfer.entries.forEach((entry, index) => {
      if (index > 0) {
        chain.push(h('span', { key: `${transfer.artifactId}-arrow-${index}` }, ' → '));
      }
      chain.push(this.renderOwnershipLink(transfer.artifactId, entry, index));
    });
    const detailed = transfer.entries.filter(entry => this.ownershipDetail(entry));
    return h(
      'div',
      { key: transfer.artifactId, className: 'afe-narrative-ownership-item' },
      h(
        'div',
        { className: 'afe-narrative-ownership-chain' },
        h('strong', undefined, `${transfer.artifactLabel}: `),
        ...chain
      ),
      detailed.length === 0
        ? undefined
        : h(
          'ul',
          { className: 'afe-narrative-ownership-notes' },
          ...detailed.map((entry, index) => h(
            'li',
            { key: `${transfer.artifactId}-${index}` },
            `${entry.ownerLabel}${this.ownershipDetail(entry)}`
          ))
        )
    );
  }

  /**
   * One owner in the chain (TASK-022 UR-044a/UR-026). An `ai-candidate` hop
   * gets a TEXT suffix, not just a `className` — the requirement is explicit
   * that distinction may not rest on colour alone, and a suffix is legible
   * even to a reader who never sees the CSS (a screen reader, a colourblind
   * theme, a screenshot). `explicit` renders exactly as before (no suffix, no
   * behavioural change to the common case).
   */
  protected renderOwnershipLink(artifactId: string, entry: NarrativeOwnershipEntry, index: number): React.ReactNode {
    return h(
      'span',
      {
        key: `${artifactId}-link-${index}`,
        className: `afe-narrative-ownership-link origin-${entry.origin}`
      },
      entry.origin === 'ai-candidate'
        ? nls.localize('ai-focused-editor/entities/ownership-ai-candidate', '{0} (AI-suggested)', entry.ownerLabel)
        : entry.ownerLabel
    );
  }

  /** Compose the freeform story-time range and note for one ownership hop. */
  protected ownershipDetail(entry: NarrativeOwnershipEntry): string {
    let range = '';
    if (entry.from && entry.to) {
      range = ` (${entry.from} → ${entry.to})`;
    } else if (entry.from) {
      range = nls.localize('ai-focused-editor/entities/ownership-from', ' (from {0})', entry.from);
    } else if (entry.to) {
      range = nls.localize('ai-focused-editor/entities/ownership-until', ' (until {0})', entry.to);
    }
    const note = entry.note ? ` — ${entry.note}` : '';
    return `${range}${note}`;
  }

  // ---------- relations ----------

  /**
   * Resolve what the graph actually draws (TASK-022 UR-044), given the
   * persisted `showCoOccurrence` toggle:
   *
   * - ai-candidate and explicit (authored) edges are ALWAYS drawn — the
   *   toggle is scoped to "показывать совместные упоминания" (co-mentions)
   *   only, never to agent-proposed or author-written connections.
   * - `origin: 'derived'` (co-occurrence) edges/nodes are drawn ONLY when the
   *   toggle is on.
   *
   * NODE SET FOLLOWS THE VISIBLE EDGE SET, not a fixed list — with the toggle
   * off, only entities reachable by an authored edge get a node (the point of
   * UR-044b: "на чистой карте только авторское"). A co-occurrence node that
   * happens to ALSO be an authored-edge endpoint (e.g. an artifact mentioned
   * in prose that also has an ownership chain) still shows, resolved from
   * `nodes` rather than duplicated — the same co-occurrence-wins rule the
   * assembler already applies when building `authoredNodes`.
   */
  protected computeVisibleGraph(snapshot: NarrativeGraphSnapshot): {
    nodes: NarrativeRelationNode[];
    edges: VisibleEdge[];
  } {
    const authoredEdges: VisibleEdge[] = (snapshot.authoredEdges ?? []).map(edge => ({
      ...edge,
      origin: edge.origin ?? 'explicit'
    }));
    const authoredNodeById = new Map((snapshot.authoredNodes ?? []).map(node => [node.id, node]));
    const coNodeById = new Map(snapshot.nodes.map(node => [node.id, node]));

    if (this.showCoOccurrence) {
      const derivedEdges: VisibleEdge[] = snapshot.relations.map(edge => ({
        ...edge,
        origin: edge.origin ?? 'derived'
      }));
      return {
        nodes: [...snapshot.nodes, ...(snapshot.authoredNodes ?? [])],
        // Authored edges paint LAST (on top): a co-occurrence and an
        // authored edge between the SAME two endpoints (e.g. Arjuna and
        // Gandiva both co-occur in prose and have an ownership hop) overlap
        // exactly on the ring — painting the authored one last means the
        // "заметное" (noticeable) edge wins the overlap, which is what
        // UR-044a asks for even in this coincidental case.
        edges: [...derivedEdges, ...authoredEdges]
      };
    }

    const neededIds = new Set<string>();
    for (const edge of authoredEdges) {
      neededIds.add(edge.source);
      neededIds.add(edge.target);
    }
    const nodes: NarrativeRelationNode[] = [];
    for (const id of neededIds) {
      const node = coNodeById.get(id) ?? authoredNodeById.get(id);
      if (node) {
        nodes.push(node);
      }
    }
    return { nodes, edges: authoredEdges };
  }

  protected renderRelations(snapshot: NarrativeGraphSnapshot): React.ReactNode {
    const { truncated, totalEntities } = snapshot;
    const { nodes, edges } = this.computeVisibleGraph(snapshot);
    return h(
      'section',
      { className: 'afe-narrative-map-section' },
      h('h4', undefined, nls.localize('ai-focused-editor/entities/relations', 'Relations')),
      this.renderGraphControls(),
      truncated && this.showCoOccurrence
        ? h(
          'p',
          { className: 'afe-narrative-truncation' },
          nls.localize('ai-focused-editor/entities/showing-top', 'Showing the top {0} of {1} entities by appearances.', snapshot.nodes.length, totalEntities)
        )
        : undefined,
      nodes.length < 2
        ? h('p', { className: 'afe-empty-state' }, nls.localize('ai-focused-editor/entities/not-enough-entities', 'Not enough connected entities to draw a graph.'))
        : this.renderGraph(nodes, edges)
    );
  }

  /** The toggle (UR-044b) plus the origin legend (UR-044a) — placed together
   *  since the legend only makes sense once the reader knows the toggle can
   *  change what it describes. */
  protected renderGraphControls(): React.ReactNode {
    return h(
      'div',
      { className: 'afe-narrative-graph-controls' },
      h(
        'label',
        { className: 'afe-narrative-graph-toggle' },
        h('input', {
          type: 'checkbox',
          checked: this.showCoOccurrence,
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => void this.setShowCoOccurrence(event.target.checked)
        }),
        nls.localize('ai-focused-editor/entities/show-co-occurrence', 'Show co-mentions')
      ),
      this.renderGraphLegend()
    );
  }

  protected renderGraphLegend(): React.ReactNode {
    return h(
      'ul',
      { className: 'afe-narrative-graph-legend' },
      h('li', { className: 'afe-narrative-graph-legend-item origin-explicit' },
        nls.localize('ai-focused-editor/entities/legend-explicit', 'Authored')),
      h('li', { className: 'afe-narrative-graph-legend-item origin-ai-candidate' },
        nls.localize('ai-focused-editor/entities/legend-ai-candidate', 'AI-suggested')),
      h('li', { className: 'afe-narrative-graph-legend-item origin-derived' },
        nls.localize('ai-focused-editor/entities/legend-derived', 'Co-mentioned'))
    );
  }

  protected renderGraph(nodes: NarrativeRelationNode[], edges: VisibleEdge[]): React.ReactNode {
    const positions = new Map<string, { x: number; y: number; angle: number }>();
    nodes.forEach((node, index) => {
      const angle = -Math.PI / 2 + (2 * Math.PI * index) / nodes.length;
      positions.set(node.id, {
        x: SVG_CENTER + RING_RADIUS * Math.cos(angle),
        y: SVG_CENTER + RING_RADIUS * Math.sin(angle),
        angle
      });
    });

    const derivedWeights = edges.filter(edge => edge.origin === 'derived');
    const maxWeight = derivedWeights.reduce((max, edge) => Math.max(max, edge.weight), 1);
    const maxAppearances = nodes.reduce((max, node) => Math.max(max, node.appearances), 1);

    return h(
      'div',
      { className: 'afe-narrative-graph' },
      h(
        'svg',
        {
          className: 'afe-narrative-graph-svg',
          viewBox: `0 0 ${SVG_SIZE} ${SVG_SIZE}`,
          role: 'img',
          'aria-label': nls.localize('ai-focused-editor/entities/graph-aria', 'Entity relationship graph')
        },
        h('g', { className: 'afe-narrative-graph-edges' }, ...edges.map(edge =>
          this.renderEdge(edge, positions, maxWeight))),
        h('g', { className: 'afe-narrative-graph-nodes' }, ...nodes.map(node =>
          this.renderNode(node, positions, maxAppearances)))
      )
    );
  }

  /**
   * Origin-driven line style (TASK-022 UR-044a). Every value here is a
   * SVG-attribute the returned React element carries in `props` — verifiable
   * directly by a test walking the element tree, and NEVER relying on colour
   * alone (the requirement's own boundary): `explicit` is solid and thick,
   * `ai-candidate` is a coarse dash at a medium fixed width, `derived` is a
   * fine dash whose width still scales with `weight` (preserves the existing
   * "more shared chapters -> thicker line" signal, just visually receding
   * relative to the two authored kinds).
   */
  protected edgeStyle(origin: NarrativeOrigin, weight: number, maxWeight: number): {
    strokeWidth: number;
    strokeDasharray?: string;
  } {
    switch (origin) {
      case 'explicit':
        return { strokeWidth: 3.5 };
      case 'ai-candidate':
        return { strokeWidth: 2.25, strokeDasharray: '5 3' };
      case 'derived':
      default:
        return { strokeWidth: 1 + (weight / maxWeight) * 4, strokeDasharray: '1 3' };
    }
  }

  protected edgeTitle(edge: VisibleEdge): string {
    if (edge.origin === 'derived') {
      return nls.localize('ai-focused-editor/entities/edge-title', '{0} ↔ {1}: {2} chapters', edge.sourceLabel, edge.targetLabel, edge.weight);
    }
    const kindLabel = edge.origin === 'ai-candidate'
      ? nls.localize('ai-focused-editor/entities/edge-ai-candidate', 'AI-suggested')
      : nls.localize('ai-focused-editor/entities/edge-explicit', 'Authored');
    return edge.relType
      ? `${edge.sourceLabel} → ${edge.targetLabel} (${edge.relType}, ${kindLabel})`
      : `${edge.sourceLabel} → ${edge.targetLabel} (${kindLabel})`;
  }

  protected renderEdge(
    edge: VisibleEdge,
    positions: Map<string, { x: number; y: number }>,
    maxWeight: number
  ): React.ReactNode {
    const source = positions.get(edge.source);
    const target = positions.get(edge.target);
    if (!source || !target) {
      return undefined;
    }
    const style = this.edgeStyle(edge.origin, edge.weight, maxWeight);
    return h(
      'line',
      {
        key: `${edge.source}|${edge.target}|${edge.origin}`,
        className: `afe-narrative-graph-edge origin-${edge.origin}`,
        x1: source.x,
        y1: source.y,
        x2: target.x,
        y2: target.y,
        strokeWidth: style.strokeWidth,
        strokeDasharray: style.strokeDasharray
      },
      h('title', undefined, this.edgeTitle(edge))
    );
  }

  protected renderNode(
    node: NarrativeRelationNode,
    positions: Map<string, { x: number; y: number; angle: number }>,
    maxAppearances: number
  ): React.ReactNode {
    const position = positions.get(node.id);
    if (!position) {
      return undefined;
    }
    const radius = 4 + (node.appearances / maxAppearances) * 5;
    const cos = Math.cos(position.angle);
    const labelX = SVG_CENTER + LABEL_RADIUS * cos;
    const labelY = SVG_CENTER + LABEL_RADIUS * Math.sin(position.angle);
    const anchor = cos > 0.2 ? 'start' : cos < -0.2 ? 'end' : 'middle';
    return h(
      'g',
      { key: node.id, className: `afe-narrative-graph-node ${node.kind}` },
      h(
        'circle',
        { className: 'afe-narrative-graph-dot', cx: position.x, cy: position.y, r: radius },
        h('title', undefined, nls.localize('ai-focused-editor/entities/node-title', '{0} ({1} appearances)', node.label, node.appearances))
      ),
      h(
        'text',
        {
          className: 'afe-narrative-graph-label',
          x: labelX,
          y: labelY,
          textAnchor: anchor,
          dominantBaseline: 'middle'
        },
        node.label
      )
    );
  }
}
