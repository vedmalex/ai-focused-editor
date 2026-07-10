import { execFile } from 'child_process';
import { isAbsolute, resolve } from 'path';
import { FileUri } from '@theia/core/lib/common/file-uri';
import { injectable } from '@theia/core/shared/inversify';
import {
  GitStatusService,
  GitWorkspaceStatus,
  SemanticHistoryChange,
  SemanticHistoryEntry,
  SemanticHistoryResult
} from '../common';

const GIT_TIMEOUT_MS = 4000;
const HISTORY_DEFAULT_LIMIT = 50;
const HISTORY_MAX_LIMIT = 500;

/** ASCII control chars keep the header unambiguous even when a subject
 *  contains tabs or other punctuation. */
const RECORD_SEP = '\x1e';
const FIELD_SEP = '\x1f';
const HISTORY_FORMAT = `${RECORD_SEP}%H${FIELD_SEP}%h${FIELD_SEP}%aI${FIELD_SEP}%an${FIELD_SEP}%s`;

/** Semantic-domain paths tracked by the history view (spec §5.6/§6 FR-017). */
const HISTORY_PATHSPECS = ['entities/', 'knowledge/', 'manifest.yaml', 'metadata.yaml'];

const ENTITY_KIND_BY_DIR: Record<string, string> = {
  characters: 'character',
  terms: 'term',
  artifacts: 'artifact',
  locations: 'location'
};

const ENTITY_PATH_RE = /^entities\/(characters|terms|artifacts|locations)\/([^/]+)\.ya?ml$/;

@injectable()
export class NodeGitStatusService implements GitStatusService {
  async getStatus(rootUri?: string): Promise<GitWorkspaceStatus> {
    if (!rootUri) {
      return { isRepository: false };
    }
    const rootPath = this.toRootPath(rootUri);

    const branch = await this.git(rootPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (branch === undefined) {
      return { isRepository: false };
    }

    const porcelain = await this.git(rootPath, ['status', '--porcelain']);
    const dirtyCount = porcelain
      ? porcelain.split('\n').filter(line => line.trim().length > 0).length
      : 0;

    let ahead: number | undefined;
    let behind: number | undefined;
    const counts = await this.git(rootPath, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']);
    if (counts) {
      const [behindRaw, aheadRaw] = counts.split(/\s+/);
      behind = Number.parseInt(behindRaw, 10) || 0;
      ahead = Number.parseInt(aheadRaw, 10) || 0;
    }

    return {
      isRepository: true,
      branch: branch || 'HEAD',
      dirtyCount,
      ahead,
      behind
    };
  }

  async initRepository(rootUri?: string): Promise<{ ok: boolean; message: string }> {
    if (!rootUri) {
      return { ok: false, message: 'Open a workspace folder first.' };
    }
    const rootPath = this.toRootPath(rootUri);
    const insideWorkTree = await this.git(rootPath, ['rev-parse', '--is-inside-work-tree']);
    if (insideWorkTree === 'true') {
      return { ok: false, message: 'This folder is already a git repository.' };
    }
    const output = await this.git(rootPath, ['init']);
    if (output === undefined) {
      return { ok: false, message: 'git init failed — is git installed and on PATH?' };
    }
    return { ok: true, message: output || 'Initialized empty git repository.' };
  }

  async getSemanticHistory(rootUri?: string, limit?: number): Promise<SemanticHistoryResult> {
    if (!rootUri) {
      return { isRepository: false, entries: [] };
    }
    const rootPath = this.toRootPath(rootUri);

    const insideWorkTree = await this.git(rootPath, ['rev-parse', '--is-inside-work-tree']);
    if (insideWorkTree !== 'true') {
      return { isRepository: false, entries: [] };
    }

    const count = limit && limit > 0 ? Math.min(limit, HISTORY_MAX_LIMIT) : HISTORY_DEFAULT_LIMIT;
    const raw = await this.git(rootPath, [
      'log',
      '--name-status',
      '--find-renames',
      `--pretty=format:${HISTORY_FORMAT}`,
      '-n',
      String(count),
      '--',
      ...HISTORY_PATHSPECS
    ]);
    if (!raw) {
      // Repository with no commits touching the semantic-domain paths.
      return { isRepository: true, entries: [] };
    }

    return { isRepository: true, entries: this.parseSemanticHistory(raw) };
  }

  /** Parse the token-separated header lines + name-status lines defensively. */
  protected parseSemanticHistory(raw: string): SemanticHistoryEntry[] {
    const entries: SemanticHistoryEntry[] = [];
    let current: SemanticHistoryEntry | undefined;

    for (const line of raw.split('\n')) {
      if (line.startsWith(RECORD_SEP)) {
        const fields = line.slice(RECORD_SEP.length).split(FIELD_SEP);
        current = {
          commit: fields[0] ?? '',
          shortCommit: fields[1] ?? '',
          date: fields[2] ?? '',
          author: fields[3] ?? '',
          subject: fields.slice(4).join(FIELD_SEP),
          changes: []
        };
        entries.push(current);
        continue;
      }
      if (!current) {
        continue;
      }
      const change = this.parseNameStatusLine(line);
      if (change) {
        current.changes.push(change);
      }
    }

    return entries;
  }

  /**
   * `A\tpath`, `M\tpath`, `D\tpath`, or `R100\told\tnew` (and `C…` copies).
   * Renames/copies resolve to the new path with the normalised status letter.
   */
  protected parseNameStatusLine(line: string): SemanticHistoryChange | undefined {
    if (!line) {
      return undefined;
    }
    const parts = line.split('\t');
    if (parts.length < 2) {
      return undefined;
    }
    const statusLetter = parts[0].charAt(0).toUpperCase();
    if (!/^[A-Z]$/.test(statusLetter)) {
      return undefined;
    }
    const isRenameOrCopy = statusLetter === 'R' || statusLetter === 'C';
    const path = isRenameOrCopy && parts.length >= 3 ? parts[parts.length - 1] : parts[1];
    if (!path) {
      return undefined;
    }

    const change: SemanticHistoryChange = { path, status: statusLetter };
    const match = ENTITY_PATH_RE.exec(path);
    if (match) {
      change.entityKind = ENTITY_KIND_BY_DIR[match[1]];
      change.entityId = match[2];
    }
    return change;
  }

  /** Runs a git command; undefined on any failure (missing git, not a repo, timeout). */
  protected git(cwd: string, args: string[]): Promise<string | undefined> {
    return new Promise(resolvePromise => {
      execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS }, (error, stdout) => {
        resolvePromise(error ? undefined : stdout.trim());
      });
    });
  }

  protected toRootPath(rootUri: string): string {
    if (rootUri.startsWith('file:')) {
      return FileUri.fsPath(rootUri);
    }
    return isAbsolute(rootUri) ? rootUri : resolve(process.cwd(), rootUri);
  }
}
