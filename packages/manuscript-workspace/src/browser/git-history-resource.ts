import {
  Resource,
  ResourceError,
  ResourceResolver
} from '@theia/core/lib/common/resource';
import URI from '@theia/core/lib/common/uri';
import { injectable, inject } from '@theia/core/shared/inversify';
import {
  GitFileContentRequest,
  GitHistoryService
} from '../common';

export const AI_FOCUSED_GIT_RESOURCE_SCHEME = 'ai-focused-git';

export function createGitHistoryResourceUri(uri: string, ref = 'HEAD'): URI {
  const params = new URLSearchParams({
    uri,
    ref
  });
  return new URI(`${AI_FOCUSED_GIT_RESOURCE_SCHEME}:/resource`).withQuery(params.toString());
}

@injectable()
export class GitHistoryResourceResolver implements ResourceResolver {
  @inject(GitHistoryService)
  protected readonly gitHistory!: GitHistoryService;

  resolve(uri: URI): Resource {
    if (uri.scheme !== AI_FOCUSED_GIT_RESOURCE_SCHEME) {
      throw ResourceError.NotFound({ uri });
    }
    return new GitHistoryResource(uri, this.gitHistory);
  }
}

class GitHistoryResource implements Resource {
  readonly readOnly = true;

  constructor(
    readonly uri: URI,
    protected readonly gitHistory: GitHistoryService
  ) {}

  dispose(): void {
    // Stateless read-only resource.
  }

  async readContents(): Promise<string> {
    const content = await this.gitHistory.getFileContent(this.parseUri());
    if (!content.exists) {
      throw ResourceError.NotFound({ uri: this.uri });
    }
    return content.content;
  }

  protected parseUri(): GitFileContentRequest {
    const params = new URLSearchParams(this.uri.query);
    const sourceUri = params.get('uri');
    if (!sourceUri) {
      throw ResourceError.NotFound({ uri: this.uri });
    }
    return {
      uri: sourceUri,
      ref: params.get('ref') || 'HEAD'
    };
  }
}
