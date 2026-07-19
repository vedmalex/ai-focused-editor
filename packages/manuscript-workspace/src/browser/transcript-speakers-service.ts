import URI from '@theia/core/lib/common/uri';
import { inject, injectable } from '@theia/core/shared/inversify';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import {
  SPEAKERS_FILE_NAME,
  SPEAKERS_REGISTRY_VERSION,
  SpeakersRegistryProblem,
  TranscriptSpeaker,
  parseSpeakersYaml,
  writeSpeakersYaml
} from '../common';

/** Result of {@link TranscriptSpeakersService.read}. */
export interface SpeakersReadResult {
  speakers: TranscriptSpeaker[];
  problems: SpeakersRegistryProblem[];
  /** Raw sidecar text for the comment-preserving round-trip on write. */
  existingText?: string;
}

/**
 * Per-set `speakers.yaml` persistence over `FileService` (browser+electron
 * safe), replacing the source app's `.transcriber-speakers.json` bridge calls.
 * All parsing/serialization stays in the pure `transcript-speakers.ts` module —
 * this service only moves bytes and threads the existing text through so
 * hand-written comments survive a write.
 */
@injectable()
export class TranscriptSpeakersService {
  @inject(FileService)
  protected readonly fileService!: FileService;

  /** `speakers.yaml` URI inside a set folder (`transcription/<slug>`). */
  speakersUri(setFolderUri: URI): URI {
    return setFolderUri.resolve(SPEAKERS_FILE_NAME);
  }

  /** Read + parse the set's `speakers.yaml`. A missing file yields an empty registry. */
  async read(setFolderUri: URI): Promise<SpeakersReadResult> {
    let text: string | undefined;
    try {
      text = (await this.fileService.read(this.speakersUri(setFolderUri))).value;
    } catch {
      return { speakers: [], problems: [] };
    }
    const { registry, problems } = parseSpeakersYaml(text);
    return { speakers: registry?.speakers ?? [], problems, existingText: text };
  }

  /**
   * Serialize + write the registry (comment-preserving against `existingText`),
   * stamping `updatedAt` with the current time. Returns the text written so the
   * caller can keep it as the next round-trip baseline.
   */
  async write(setFolderUri: URI, existingText: string | undefined, speakers: readonly TranscriptSpeaker[]): Promise<string> {
    const text = writeSpeakersYaml(existingText, {
      version: SPEAKERS_REGISTRY_VERSION,
      updatedAt: new Date().toISOString(),
      speakers: [...speakers]
    });
    await this.fileService.write(this.speakersUri(setFolderUri), text);
    return text;
  }
}
