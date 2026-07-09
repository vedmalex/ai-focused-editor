import { execFile } from 'child_process';
import { dirname, isAbsolute, relative, resolve } from 'path';
import { promisify } from 'util';
import { FileUri } from '@theia/core/lib/common/file-uri';
import { injectable } from '@theia/core/shared/inversify';
import {
  GitFileContent,
  GitFileContentRequest,
  GitHistoryService,
  GitStatusFile,
  GitStatusSnapshot
} from '../common';

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT_BUFFER = 10 * 1024 * 1024;

@injectable()
export class NodeGitHistoryService implements GitHistoryService {
  async getStatus(rootUri?: string): Promise<GitStatusSnapshot> {
    const cwd = this.toWorkingDirectory(rootUri);
    const repository = await this.getRepositoryRoot(cwd);
    if (!repository) {
      return {
        available: false,
        clean: true,
        files: [],
        message: 'No Git repository found for the current workspace.'
      };
    }

    const [branch, status] = await Promise.all([
      this.git(['branch', '--show-current'], repository).then(output => output.trim()).catch(() => ''),
      this.git(['status', '--porcelain=v1', '-uall'], repository)
    ]);
    const files = this.parseStatus(status, repository);

    return {
      available: true,
      clean: files.length === 0,
      rootUri: FileUri.create(repository).toString(),
      branch: branch || 'HEAD',
      files
    };
  }

  async getFileContent(request: GitFileContentRequest): Promise<GitFileContent> {
    const ref = request.ref || 'HEAD';
    const filePath = FileUri.fsPath(request.uri);
    const repository = await this.getRepositoryRoot(dirname(filePath));
    if (!repository) {
      return {
        uri: request.uri,
        ref,
        exists: false,
        content: ''
      };
    }

    const pathInRepository = this.toGitPath(relative(repository, filePath));
    try {
      const content = await this.git(['show', `${ref}:${pathInRepository}`], repository);
      return {
        uri: request.uri,
        ref,
        exists: true,
        content
      };
    } catch {
      return {
        uri: request.uri,
        ref,
        exists: false,
        content: ''
      };
    }
  }

  protected async getRepositoryRoot(cwd: string): Promise<string | undefined> {
    try {
      return (await this.git(['rev-parse', '--show-toplevel'], cwd)).trim();
    } catch {
      return undefined;
    }
  }

  protected parseStatus(output: string, repository: string): GitStatusFile[] {
    return output
      .split(/\r?\n/)
      .map(line => line.trimEnd())
      .filter(line => line.length > 0)
      .map(line => this.parseStatusLine(line, repository));
  }

  protected parseStatusLine(line: string, repository: string): GitStatusFile {
    const indexStatus = line.charAt(0) || ' ';
    const workingTreeStatus = line.charAt(1) || ' ';
    const rawPath = line.slice(3);
    const path = rawPath.includes(' -> ') ? rawPath.slice(rawPath.indexOf(' -> ') + 4) : rawPath;
    const absolutePath = resolve(repository, path);
    return {
      path,
      uri: FileUri.create(absolutePath).toString(),
      indexStatus,
      workingTreeStatus
    };
  }

  protected async git(args: string[], cwd: string): Promise<string> {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      maxBuffer: MAX_GIT_OUTPUT_BUFFER
    });
    return stdout;
  }

  protected toWorkingDirectory(rootUri: string | undefined): string {
    if (!rootUri) {
      return process.cwd();
    }
    if (rootUri.startsWith('file:')) {
      return FileUri.fsPath(rootUri);
    }
    return isAbsolute(rootUri) ? rootUri : process.cwd();
  }

  protected toGitPath(path: string): string {
    return path.split('\\').join('/');
  }
}
