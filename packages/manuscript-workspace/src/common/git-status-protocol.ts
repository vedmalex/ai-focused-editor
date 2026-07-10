export const GitStatusService = Symbol('GitStatusService');
export const GitStatusServicePath = '/services/ai-focused-editor/git-status';

/**
 * Read-only git snapshot for the status bar (spec §5.6/§7: branch/status
 * indicators). Mutating git operations stay with the user and standard
 * tooling — this service never writes to the repository.
 */
export interface GitWorkspaceStatus {
  isRepository: boolean;
  branch?: string;
  /** Number of changed (staged + unstaged + untracked) paths. */
  dirtyCount?: number;
  ahead?: number;
  behind?: number;
}

/**
 * One file touched by a commit, as reported by `git log --name-status`.
 * Entity metadata is derived from paths shaped like
 * `entities/<dir>/<file>.yaml`; non-entity domain files (manifest.yaml,
 * knowledge/*, …) carry only `path` + `status`.
 */
export interface SemanticHistoryChange {
  path: string;
  /** Normalised git status letter: 'A' add, 'M' modify, 'D' delete, 'R' rename. */
  status: 'A' | 'M' | 'D' | 'R' | string;
  /** 'character' | 'term' | 'artifact' | 'location' when the path is an entity file. */
  entityKind?: string;
  /** Entity file basename without extension. */
  entityId?: string;
}

/**
 * A single commit and the semantic-domain files it changed (spec §5.6/§6
 * FR-017). Read-only history surface — this never mutates the repository.
 */
export interface SemanticHistoryEntry {
  commit: string;
  shortCommit: string;
  /** Author date, strict ISO 8601. */
  date: string;
  author: string;
  subject: string;
  changes: SemanticHistoryChange[];
}

export interface SemanticHistoryResult {
  isRepository: boolean;
  entries: SemanticHistoryEntry[];
}

export interface GitStatusService {
  getStatus(rootUri?: string): Promise<GitWorkspaceStatus>;
  /**
   * Recent commits that touched semantic-domain paths (entities/, knowledge/,
   * manifest.yaml, metadata.yaml), newest first. `limit` defaults to 50.
   */
  getSemanticHistory(rootUri?: string, limit?: number): Promise<SemanticHistoryResult>;
}
