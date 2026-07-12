import { injectable } from '@theia/core/shared/inversify';
import { Emitter, Event } from '@theia/core/lib/common/event';
import {
  BASE_ENTITY_TYPES,
  mergeEntityTypes,
  type EffectiveEntityType,
  type EntityTypeProblem
} from '../common';

/**
 * Frontend cache of the EFFECTIVE entity types (built-in + author-declared)
 * for the open book. It is intentionally DUMB — a cache plus an emitter. It is
 * seeded with the built-in set so consumers always have a usable list before
 * the first snapshot arrives, and it is refreshed from narrative-entity
 * snapshots by whoever receives them (the manuscript tree model). Consumers
 * (tree, creation, tags, doctor) read {@link getEffectiveTypes} and subscribe
 * to {@link onDidChange} to re-render when the author edits `entities/types.yaml`.
 */
@injectable()
export class EntityTypeRegistryService {
  protected effectiveTypes: EffectiveEntityType[] = mergeEntityTypes(BASE_ENTITY_TYPES, []);
  protected problems: EntityTypeProblem[] = [];

  protected readonly onDidChangeEmitter = new Emitter<void>();
  readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;

  /** The effective type list — built-ins first, then valid author types. */
  getEffectiveTypes(): EffectiveEntityType[] {
    return this.effectiveTypes;
  }

  /** Validation problems from the last parsed `entities/types.yaml` (empty if none). */
  getTypeProblems(): EntityTypeProblem[] {
    return this.problems;
  }

  /**
   * Feed a fresh narrative-entity snapshot's effective types + problems. Falls
   * back to the built-in-only set when the snapshot carries no types (e.g. the
   * no-workspace snapshot). Fires {@link onDidChange} only when the effective
   * list or the problem set actually changed, so subscribers do not churn.
   */
  update(
    effectiveTypes: EffectiveEntityType[] | undefined,
    problems: EntityTypeProblem[] | undefined
  ): void {
    const nextTypes = effectiveTypes && effectiveTypes.length > 0
      ? effectiveTypes
      : mergeEntityTypes(BASE_ENTITY_TYPES, []);
    const nextProblems = problems ?? [];

    if (this.sameTypes(nextTypes) && this.sameProblems(nextProblems)) {
      return;
    }
    this.effectiveTypes = nextTypes;
    this.problems = nextProblems;
    this.onDidChangeEmitter.fire();
  }

  protected sameTypes(next: EffectiveEntityType[]): boolean {
    if (next.length !== this.effectiveTypes.length) {
      return false;
    }
    return next.every((type, index) => {
      const current = this.effectiveTypes[index];
      return current
        && current.id === type.id
        && current.origin === type.origin
        && current.tagKind === type.tagKind
        && current.directory === type.directory
        && current.label === type.label;
    });
  }

  protected sameProblems(next: EntityTypeProblem[]): boolean {
    if (next.length !== this.problems.length) {
      return false;
    }
    return next.every((problem, index) => {
      const current = this.problems[index];
      return current && current.code === problem.code && current.id === problem.id && current.message === problem.message;
    });
  }
}
