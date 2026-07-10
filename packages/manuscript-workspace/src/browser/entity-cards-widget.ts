import URI from '@theia/core/lib/common/uri';
import {
  open,
  OpenerService
} from '@theia/core/lib/browser';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import {
  inject,
  injectable,
  postConstruct
} from '@theia/core/shared/inversify';
import React from '@theia/core/shared/react';
import {
  NarrativeEntity,
  NarrativeEntityKind,
  NarrativeEntityService,
  NarrativeEntitySnapshot
} from '../common';

@injectable()
export class EntityCardsWidget extends ReactWidget {
  static readonly ID = 'ai-focused-editor.entity-cards';
  static readonly LABEL = 'Knowledge Cards';

  @inject(NarrativeEntityService)
  protected readonly entityService!: NarrativeEntityService;

  @inject(OpenerService)
  protected readonly openerService!: OpenerService;

  protected snapshot: NarrativeEntitySnapshot | undefined;

  @postConstruct()
  protected init(): void {
    this.id = EntityCardsWidget.ID;
    this.title.label = EntityCardsWidget.LABEL;
    this.title.caption = 'AI Focused Editor character and term cards';
    this.title.iconClass = 'fa fa-address-card';
    this.title.closable = true;
    this.addClass('afe-entity-cards-widget');
    void this.refresh();
  }

  async refresh(): Promise<void> {
    this.snapshot = await this.entityService.refresh();
    this.update();
  }

  protected render(): React.ReactNode {
    const snapshot = this.snapshot;
    if (!snapshot) {
      return React.createElement('div', { className: 'afe-entity-cards' }, 'Loading knowledge cards...');
    }

    const characters = snapshot.entities.filter(entity => entity.kind === 'character');
    const terms = snapshot.entities.filter(entity => entity.kind === 'term');
    const artifacts = snapshot.entities.filter(entity => entity.kind === 'artifact');
    const locations = snapshot.entities.filter(entity => entity.kind === 'location');

    return React.createElement(
      'div',
      { className: 'afe-entity-cards' },
      React.createElement(
        'div',
        { className: 'afe-entity-cards-header' },
        React.createElement('h3', undefined, 'Knowledge Cards'),
        React.createElement(
          'button',
          {
            className: 'theia-button secondary',
            onClick: () => this.refresh()
          },
          'Refresh'
        )
      ),
      this.renderDiagnostics(snapshot),
      this.renderEntityGroup('Characters', 'character', characters),
      this.renderEntityGroup('Artifacts', 'artifact', artifacts),
      this.renderEntityGroup('Locations', 'location', locations),
      this.renderEntityGroup('Terms', 'term', terms)
    );
  }

  protected renderDiagnostics(snapshot: NarrativeEntitySnapshot): React.ReactNode {
    if (snapshot.diagnostics.length === 0) {
      return undefined;
    }

    return React.createElement(
      'div',
      { className: 'afe-entity-cards-diagnostics' },
      ...snapshot.diagnostics.map((diagnostic, index) => React.createElement(
        'div',
        {
          key: `${diagnostic.source}-${index}`,
          className: `afe-entity-cards-diagnostic ${diagnostic.severity}`
        },
        `${diagnostic.severity}: ${diagnostic.message}`
      ))
    );
  }

  protected renderEntityGroup(
    title: string,
    kind: NarrativeEntityKind,
    entities: NarrativeEntity[]
  ): React.ReactNode {
    return React.createElement(
      'section',
      { className: `afe-entity-group ${kind}` },
      React.createElement('h4', undefined, `${title} (${entities.length})`),
      entities.length === 0
        ? React.createElement('p', { className: 'afe-empty-state' }, `No ${kind} entities found.`)
        : React.createElement(
          'div',
          { className: 'afe-entity-card-list' },
          ...entities.map(entity => this.renderEntityCard(entity))
        )
    );
  }

  protected renderEntityCard(entity: NarrativeEntity): React.ReactNode {
    const epithets = entity.epithets ?? [];
    const speechPatterns = entity.speechPatterns ?? [];
    return React.createElement(
      'article',
      {
        key: entity.uri,
        className: `afe-entity-card ${entity.kind}`
      },
      React.createElement(
        'div',
        { className: 'afe-entity-card-title' },
        React.createElement('strong', undefined, entity.label),
        React.createElement('span', { className: 'afe-entity-kind' }, entity.kind)
      ),
      React.createElement('div', { className: 'afe-entity-id' }, entity.id),
      entity.aliases.length > 0
        ? React.createElement('div', { className: 'afe-entity-aliases' }, `Aliases: ${entity.aliases.join(', ')}`)
        : undefined,
      epithets.length > 0
        ? React.createElement('div', { className: 'afe-entity-epithets' }, `Epithets: ${epithets.join(', ')}`)
        : undefined,
      entity.summary
        ? React.createElement('p', { className: 'afe-entity-summary' }, entity.summary)
        : undefined,
      entity.arc
        ? React.createElement(
          'div',
          { className: 'afe-entity-arc' },
          React.createElement('span', { className: 'afe-entity-field-label' }, 'Arc: '),
          entity.arc
        )
        : undefined,
      speechPatterns.length > 0
        ? this.renderCollapsible('Speech patterns', React.createElement(
          'ul',
          { className: 'afe-entity-speech-list' },
          ...speechPatterns.map((pattern, index) => React.createElement('li', { key: index }, pattern))
        ))
        : undefined,
      entity.backstory
        ? this.renderCollapsible('Backstory', React.createElement('p', { className: 'afe-entity-backstory' }, entity.backstory))
        : undefined,
      entity.notes
        ? this.renderCollapsible('Notes', React.createElement('p', { className: 'afe-entity-notes' }, entity.notes))
        : undefined,
      React.createElement('code', { className: 'afe-entity-path' }, entity.path),
      React.createElement(
        'button',
        {
          className: 'theia-button',
          onClick: () => this.openEntity(entity)
        },
        'Open YAML'
      )
    );
  }

  /**
   * Keep long-form fields (backstory, speech patterns, notes) out of the way so
   * the card stays scannable; writers expand only what they need.
   */
  protected renderCollapsible(label: string, body: React.ReactNode): React.ReactNode {
    return React.createElement(
      'details',
      { className: 'afe-entity-details' },
      React.createElement('summary', undefined, label),
      body
    );
  }

  protected async openEntity(entity: NarrativeEntity): Promise<void> {
    await open(this.openerService, new URI(entity.uri));
  }
}
