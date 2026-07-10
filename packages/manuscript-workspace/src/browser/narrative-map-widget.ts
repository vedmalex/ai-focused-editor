import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import {
  inject,
  injectable,
  postConstruct
} from '@theia/core/shared/inversify';
import React from '@theia/core/shared/react';
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

@injectable()
export class NarrativeMapWidget extends ReactWidget {
  static readonly ID = 'ai-focused-editor.narrative-map';
  static readonly LABEL = 'Narrative Map';

  @inject(NarrativeGraphService)
  protected readonly graphService!: NarrativeGraphService;

  protected snapshot: NarrativeGraphSnapshot | undefined;
  protected loading = false;

  @postConstruct()
  protected init(): void {
    this.id = NarrativeMapWidget.ID;
    this.title.label = NarrativeMapWidget.LABEL;
    this.title.caption = 'AI Focused Editor narrative timeline and relationship map';
    this.title.iconClass = 'fa fa-project-diagram';
    this.title.closable = true;
    this.addClass('afe-narrative-map');
    void this.refresh();
  }

  async refresh(): Promise<void> {
    this.loading = true;
    this.update();
    try {
      this.snapshot = await this.graphService.refresh();
    } finally {
      this.loading = false;
      this.update();
    }
  }

  protected render(): React.ReactNode {
    const snapshot = this.snapshot;
    return h(
      'div',
      { className: 'afe-narrative-map-body' },
      this.renderHeader(),
      !snapshot
        ? h('p', { className: 'afe-empty-state' }, this.loading ? 'Loading narrative map...' : 'No data yet.')
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
      h('h3', undefined, 'Narrative Map'),
      h(
        'button',
        {
          className: 'theia-button secondary',
          disabled: this.loading,
          onClick: () => this.refresh()
        },
        this.loading ? 'Refreshing...' : 'Refresh'
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
      h('h4', undefined, 'Timeline'),
      this.renderOwnership(snapshot.ownership),
      snapshot.timeline.length === 0
        ? h('p', { className: 'afe-empty-state' }, 'No chapters found in the manifest.')
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
        chapter.buildIncluded ? undefined : h('span', { className: 'afe-narrative-timeline-flag' }, 'excluded')
      ),
      chapter.entities.length === 0
        ? h('span', { className: 'afe-narrative-chip-empty' }, 'no tagged entities')
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
      h('h5', undefined, 'Artifact ownership'),
      ...ownership.map(transfer => this.renderOwnershipTransfer(transfer))
    );
  }

  protected renderOwnershipTransfer(transfer: NarrativeOwnershipTransfer): React.ReactNode {
    const chain = transfer.entries.map(entry => entry.ownerLabel).join(' → ');
    const detailed = transfer.entries.filter(entry => this.ownershipDetail(entry));
    return h(
      'div',
      { key: transfer.artifactId, className: 'afe-narrative-ownership-item' },
      h(
        'div',
        { className: 'afe-narrative-ownership-chain' },
        h('strong', undefined, `${transfer.artifactLabel}: `),
        chain
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

  /** Compose the freeform story-time range and note for one ownership hop. */
  protected ownershipDetail(entry: NarrativeOwnershipEntry): string {
    let range = '';
    if (entry.from && entry.to) {
      range = ` (${entry.from} → ${entry.to})`;
    } else if (entry.from) {
      range = ` (from ${entry.from})`;
    } else if (entry.to) {
      range = ` (until ${entry.to})`;
    }
    const note = entry.note ? ` — ${entry.note}` : '';
    return `${range}${note}`;
  }

  // ---------- relations ----------

  protected renderRelations(snapshot: NarrativeGraphSnapshot): React.ReactNode {
    const { nodes, relations, truncated, totalEntities } = snapshot;
    return h(
      'section',
      { className: 'afe-narrative-map-section' },
      h('h4', undefined, 'Relations'),
      truncated
        ? h(
          'p',
          { className: 'afe-narrative-truncation' },
          `Showing the top ${nodes.length} of ${totalEntities} entities by appearances.`
        )
        : undefined,
      nodes.length < 2
        ? h('p', { className: 'afe-empty-state' }, 'Not enough co-occurring entities to draw a graph.')
        : this.renderGraph(nodes, relations)
    );
  }

  protected renderGraph(nodes: NarrativeRelationNode[], relations: NarrativeRelationEdge[]): React.ReactNode {
    const positions = new Map<string, { x: number; y: number; angle: number }>();
    nodes.forEach((node, index) => {
      const angle = -Math.PI / 2 + (2 * Math.PI * index) / nodes.length;
      positions.set(node.id, {
        x: SVG_CENTER + RING_RADIUS * Math.cos(angle),
        y: SVG_CENTER + RING_RADIUS * Math.sin(angle),
        angle
      });
    });

    const maxWeight = relations.reduce((max, edge) => Math.max(max, edge.weight), 1);
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
          'aria-label': 'Entity co-occurrence graph'
        },
        h('g', { className: 'afe-narrative-graph-edges' }, ...relations.map(edge =>
          this.renderEdge(edge, positions, maxWeight))),
        h('g', { className: 'afe-narrative-graph-nodes' }, ...nodes.map(node =>
          this.renderNode(node, positions, maxAppearances)))
      )
    );
  }

  protected renderEdge(
    edge: NarrativeRelationEdge,
    positions: Map<string, { x: number; y: number }>,
    maxWeight: number
  ): React.ReactNode {
    const source = positions.get(edge.source);
    const target = positions.get(edge.target);
    if (!source || !target) {
      return undefined;
    }
    const strokeWidth = 1 + (edge.weight / maxWeight) * 5;
    return h(
      'line',
      {
        key: `${edge.source}|${edge.target}`,
        className: 'afe-narrative-graph-edge',
        x1: source.x,
        y1: source.y,
        x2: target.x,
        y2: target.y,
        strokeWidth
      },
      h('title', undefined, `${edge.sourceLabel} ↔ ${edge.targetLabel}: ${edge.weight} chapters`)
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
        h('title', undefined, `${node.label} (${node.appearances} appearances)`)
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
