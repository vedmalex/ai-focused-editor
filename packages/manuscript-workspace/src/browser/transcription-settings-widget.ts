import { MessageService } from '@theia/core/lib/common';
import { nls } from '@theia/core/lib/common/nls';
import {
  PreferenceScope,
  PreferenceService
} from '@theia/core/lib/common/preferences';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import {
  inject,
  injectable,
  postConstruct
} from '@theia/core/shared/inversify';
import React from '@theia/core/shared/react';
import {
  AudioConversionService,
  type MediaTranscriptionDoctorReport,
  type MediaTranscriptionDoctorRequest
} from '../common';
import {
  resolveEffectivePreference,
  splitGroqApiKeys,
  type PreferenceValueOrigin
} from '../common/transcription-settings';
import {
  MEDIA_TRANSCRIPTION_BACKEND,
  MEDIA_TRANSCRIPTION_FFMPEG_PATH,
  MEDIA_TRANSCRIPTION_FFPROBE_PATH,
  MEDIA_TRANSCRIPTION_GROQ_API_KEY,
  MEDIA_TRANSCRIPTION_GROQ_MODEL,
  MEDIA_TRANSCRIPTION_LANGUAGE,
  MEDIA_TRANSCRIPTION_MODEL_PATH,
  MEDIA_TRANSCRIPTION_SEGMENT_SECONDS,
  MEDIA_TRANSCRIPTION_THREADS,
  MEDIA_TRANSCRIPTION_WHISPER_CLI_PATH
} from './ai-focused-editor-preferences';

/** All `mediaTranscription.*` keys the panel manages (drives the refresh watch). */
const PANEL_PREFERENCE_KEYS = [
  MEDIA_TRANSCRIPTION_BACKEND,
  MEDIA_TRANSCRIPTION_WHISPER_CLI_PATH,
  MEDIA_TRANSCRIPTION_MODEL_PATH,
  MEDIA_TRANSCRIPTION_THREADS,
  MEDIA_TRANSCRIPTION_LANGUAGE,
  MEDIA_TRANSCRIPTION_GROQ_MODEL,
  MEDIA_TRANSCRIPTION_GROQ_API_KEY,
  MEDIA_TRANSCRIPTION_FFMPEG_PATH,
  MEDIA_TRANSCRIPTION_FFPROBE_PATH,
  MEDIA_TRANSCRIPTION_SEGMENT_SECONDS
];

/** The two scopes the user can SAVE into (the panel's target-scope selector). */
type TargetScope = PreferenceScope.User | PreferenceScope.Workspace;

/**
 * "Transcription Settings" panel — a settings-style view (mirroring the AI
 * Model Config widget) for the local/remote speech-recognition configuration:
 *
 *  - (a) Backend switch (local whisper.cpp | Groq API);
 *  - (b) Local whisper.cpp: whisper-cli path, ggml model path, threads, language;
 *  - (c) Remote Groq: model + API key (comma-separated key LIST — the backend
 *        GroqKeyManager shuffles the list per batch, rotates to the next key on
 *        quota/429 errors and retries on connection errors; keys are never
 *        logged), with the workspace-scope secret caveat;
 *  - (d) Media: ffmpeg/ffprobe paths, segment length.
 *
 * Every field shows its EFFECTIVE value and WHERE IT CAME FROM (default /
 * user / workspace / folder, via `PreferenceService.inspect`), and the panel's
 * target-scope selector chooses WHERE a save lands (User = `~/.theia/
 * settings.json`, Workspace = `<book>/.theia/settings.json`; workspace
 * overrides user in the Theia cascade). The "Check" action runs the backend
 * `AudioConversionService.doctor()` with the currently EFFECTIVE values and
 * renders the per-check results + advice inline.
 */
@injectable()
export class TranscriptionSettingsWidget extends ReactWidget {
  static readonly ID = 'ai-focused-editor.transcription-settings';
  static readonly LABEL = nls.localize('ai-focused-editor/transcription-settings/label', 'Transcription Settings');

  @inject(PreferenceService)
  protected readonly preferences!: PreferenceService;

  @inject(MessageService)
  protected readonly messages!: MessageService;

  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

  @inject(AudioConversionService)
  protected readonly audioConversion!: AudioConversionService;

  /** Where a save lands. Defaults to User (machine-specific paths are naturally global). */
  protected targetScope: TargetScope = PreferenceScope.User;
  /** Per-field in-progress edits keyed by preference id (absent = show effective). */
  protected drafts: Record<string, string> = {};
  /** Last backend doctor report (the "Check" action), if any. */
  protected checkReport: MediaTranscriptionDoctorReport | undefined;
  protected checkError: string | undefined;
  protected checking = false;

  @postConstruct()
  protected init(): void {
    this.id = TranscriptionSettingsWidget.ID;
    this.title.label = TranscriptionSettingsWidget.LABEL;
    this.title.caption = nls.localize(
      'ai-focused-editor/transcription-settings/caption',
      'Local/remote speech-recognition settings (global and per-project)'
    );
    this.title.iconClass = 'fa fa-microphone';
    this.title.closable = true;
    this.addClass('afe-transcription-settings-widget');

    this.toDispose.push(this.preferences.onPreferencesChanged(changes => {
      if (PANEL_PREFERENCE_KEYS.some(key => key in changes)) {
        this.update();
      }
    }));
    this.update();
  }

  refresh(): void {
    this.drafts = {};
    this.update();
  }

  /* ------------------------------------------------------------------ */
  /* Effective values                                                    */
  /* ------------------------------------------------------------------ */

  /** The effective value + origin for a preference, via `PreferenceService.inspect`. */
  protected effective<T extends string | number>(key: string): { value: T | undefined; origin: PreferenceValueOrigin } {
    const inspection = this.preferences.inspect<T>(key);
    if (!inspection) {
      return { value: undefined, origin: 'default' };
    }
    return resolveEffectivePreference<T>(inspection);
  }

  protected effectiveString(key: string): { value: string; origin: PreferenceValueOrigin } {
    const { value, origin } = this.effective<string>(key);
    return { value: typeof value === 'string' ? value : '', origin };
  }

  protected originLabel(origin: PreferenceValueOrigin): string {
    switch (origin) {
      case 'user':
        return nls.localize('ai-focused-editor/transcription-settings/origin-user', 'User settings');
      case 'workspace':
        return nls.localize('ai-focused-editor/transcription-settings/origin-workspace', 'Workspace settings');
      case 'folder':
        return nls.localize('ai-focused-editor/transcription-settings/origin-folder', 'Workspace folder settings');
      default:
        return nls.localize('ai-focused-editor/transcription-settings/origin-default', 'default');
    }
  }

  /* ------------------------------------------------------------------ */
  /* Saving                                                              */
  /* ------------------------------------------------------------------ */

  protected async saveValue(key: string, value: string | number | undefined): Promise<void> {
    if (this.targetScope === PreferenceScope.Workspace && !this.workspaceService.opened) {
      await this.messages.warn(nls.localize(
        'ai-focused-editor/transcription-settings/no-workspace',
        'Open a workspace before saving a workspace-scope value.'
      ));
      return;
    }
    try {
      await this.preferences.set(key, value, this.targetScope);
      delete this.drafts[key];
      this.update();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.messages.error(nls.localize(
        'ai-focused-editor/transcription-settings/save-failed',
        'Could not save {0}: {1}', key, detail
      ));
    }
  }

  protected async clearValue(key: string): Promise<void> {
    await this.saveValue(key, undefined);
  }

  protected draftOf(key: string, fallback: string): string {
    return this.drafts[key] ?? fallback;
  }

  protected setDraft(key: string, value: string): void {
    this.drafts = { ...this.drafts, [key]: value };
    this.update();
  }

  /* ------------------------------------------------------------------ */
  /* Render                                                              */
  /* ------------------------------------------------------------------ */

  protected render(): React.ReactNode {
    return React.createElement(
      'div',
      { className: 'afe-model-config afe-transcription-settings' },
      React.createElement('h3', undefined, nls.localize('ai-focused-editor/transcription-settings/heading', 'Transcription Settings')),
      React.createElement(
        'p',
        { className: 'afe-model-config-help' },
        nls.localize(
          'ai-focused-editor/transcription-settings/help',
          'Speech-recognition settings for transcript sets. Every setting can be stored globally (User, ~/.theia/settings.json) or per-project (Workspace, <book>/.theia/settings.json); a workspace value overrides the user value. Each field shows its effective value and where it came from.'
        )
      ),
      this.renderScopeSelector(),
      this.renderBackendSection(),
      this.renderLocalSection(),
      this.renderGroqSection(),
      this.renderMediaSection(),
      this.renderCheckSection()
    );
  }

  /** Target-scope selector: where the Save buttons write (User / Workspace). */
  protected renderScopeSelector(): React.ReactNode {
    const options: Array<{ scope: TargetScope; label: string }> = [
      { scope: PreferenceScope.User, label: nls.localize('ai-focused-editor/transcription-settings/scope-user', 'User (global, ~/.theia/settings.json)') },
      { scope: PreferenceScope.Workspace, label: nls.localize('ai-focused-editor/transcription-settings/scope-workspace', 'Workspace (this book, .theia/settings.json)') }
    ];
    return React.createElement(
      'div',
      { className: 'afe-model-config-section afe-transcription-scope' },
      React.createElement('h3', undefined, nls.localize('ai-focused-editor/transcription-settings/scope-heading', 'Save changes to')),
      React.createElement(
        'div',
        { className: 'afe-transcription-scope-options' },
        ...options.map(option => React.createElement(
          'label',
          { key: option.scope, className: 'afe-transcription-scope-option' },
          React.createElement('input', {
            type: 'radio',
            name: 'afe-transcription-target-scope',
            checked: this.targetScope === option.scope,
            disabled: option.scope === PreferenceScope.Workspace && !this.workspaceService.opened,
            onChange: () => { this.targetScope = option.scope; this.update(); }
          }),
          React.createElement('span', undefined, option.label)
        ))
      )
    );
  }

  /* --------------------------- sections ------------------------------ */

  protected renderBackendSection(): React.ReactNode {
    const { value, origin } = this.effectiveString(MEDIA_TRANSCRIPTION_BACKEND);
    const backend = value === 'groq' ? 'groq' : 'local';
    return React.createElement(
      'div',
      { className: 'afe-model-config-section', 'data-testid': 'afe-ts-section-backend' },
      React.createElement('h3', undefined, nls.localize('ai-focused-editor/transcription-settings/backend-heading', 'Recognition Backend')),
      React.createElement(
        'label',
        { className: 'afe-model-config-field' },
        React.createElement('span', undefined, nls.localize('ai-focused-editor/transcription-settings/backend-label', 'Backend')),
        React.createElement(
          'select',
          {
            value: backend,
            'data-pref': MEDIA_TRANSCRIPTION_BACKEND,
            onChange: (event: React.ChangeEvent<HTMLSelectElement>) => {
              void this.saveValue(MEDIA_TRANSCRIPTION_BACKEND, event.currentTarget.value);
            }
          },
          React.createElement('option', { value: 'local' }, nls.localize('ai-focused-editor/transcription-settings/backend-local', 'local — whisper.cpp on this machine')),
          React.createElement('option', { value: 'groq' }, nls.localize('ai-focused-editor/transcription-settings/backend-groq', 'groq — Groq cloud API'))
        ),
        this.renderOriginBadge(origin)
      ),
      React.createElement(
        'p',
        { className: 'afe-model-config-help' },
        nls.localize(
          'ai-focused-editor/transcription-settings/backend-help',
          'Selecting saves immediately into the chosen target scope. "local" runs whisper.cpp on this machine; "groq" sends audio segments to the Groq API (requires an API key).'
        )
      )
    );
  }

  protected renderLocalSection(): React.ReactNode {
    return React.createElement(
      'div',
      { className: 'afe-model-config-section', 'data-testid': 'afe-ts-section-local' },
      React.createElement('h3', undefined, nls.localize('ai-focused-editor/transcription-settings/local-heading', 'Local whisper.cpp')),
      this.renderTextField(
        MEDIA_TRANSCRIPTION_WHISPER_CLI_PATH,
        nls.localize('ai-focused-editor/transcription-settings/whisper-cli-label', 'whisper-cli path'),
        nls.localize('ai-focused-editor/transcription-settings/whisper-cli-ph', '<whisper.cpp>/build/bin/whisper-cli')
      ),
      this.renderTextField(
        MEDIA_TRANSCRIPTION_MODEL_PATH,
        nls.localize('ai-focused-editor/transcription-settings/model-path-label', 'ggml model path'),
        nls.localize('ai-focused-editor/transcription-settings/model-path-ph', '<whisper.cpp>/models/ggml-large-v3-turbo.bin')
      ),
      this.renderNumberField(
        MEDIA_TRANSCRIPTION_THREADS,
        nls.localize('ai-focused-editor/transcription-settings/threads-label', 'Threads'),
        1
      ),
      this.renderTextField(
        MEDIA_TRANSCRIPTION_LANGUAGE,
        nls.localize('ai-focused-editor/transcription-settings/language-label', 'Language hint'),
        nls.localize('ai-focused-editor/transcription-settings/language-ph', 'e.g. ru or en; empty = auto-detect')
      )
    );
  }

  protected renderGroqSection(): React.ReactNode {
    return React.createElement(
      'div',
      { className: 'afe-model-config-section', 'data-testid': 'afe-ts-section-groq' },
      React.createElement('h3', undefined, nls.localize('ai-focused-editor/transcription-settings/groq-heading', 'Remote Groq API')),
      this.renderTextField(
        MEDIA_TRANSCRIPTION_GROQ_MODEL,
        nls.localize('ai-focused-editor/transcription-settings/groq-model-label', 'Groq model'),
        nls.localize('ai-focused-editor/transcription-settings/groq-model-ph', 'whisper-large-v3-turbo')
      ),
      this.renderGroqKeyField(),
      React.createElement(
        'p',
        { className: 'afe-model-config-help' },
        nls.localize(
          'ai-focused-editor/transcription-settings/groq-rotation-help',
          'Comma-separate multiple keys to enable rotation: the backend shuffles the key list per batch, rotates to the next key on quota/429 rate limits, and retries on connection errors. Keys are never logged.'
        )
      ),
      React.createElement(
        'p',
        { className: 'afe-model-config-help afe-transcription-secret-warning' },
        nls.localize(
          'ai-focused-editor/transcription-settings/groq-key-caveat',
          'Caution: a WORKSPACE-scope key is stored in <book>/.theia/settings.json and can be committed to git. Prefer User scope for the key, or gitignore .theia/settings.json (the Book Doctor offers this fix).'
        )
      )
    );
  }

  protected renderMediaSection(): React.ReactNode {
    return React.createElement(
      'div',
      { className: 'afe-model-config-section', 'data-testid': 'afe-ts-section-media' },
      React.createElement('h3', undefined, nls.localize('ai-focused-editor/transcription-settings/media-heading', 'Media Conversion')),
      this.renderTextField(
        MEDIA_TRANSCRIPTION_FFMPEG_PATH,
        nls.localize('ai-focused-editor/transcription-settings/ffmpeg-label', 'ffmpeg path'),
        nls.localize('ai-focused-editor/transcription-settings/ffmpeg-ph', 'empty = use "ffmpeg" from PATH')
      ),
      this.renderTextField(
        MEDIA_TRANSCRIPTION_FFPROBE_PATH,
        nls.localize('ai-focused-editor/transcription-settings/ffprobe-label', 'ffprobe path'),
        nls.localize('ai-focused-editor/transcription-settings/ffprobe-ph', 'empty = use "ffprobe" from PATH')
      ),
      this.renderNumberField(
        MEDIA_TRANSCRIPTION_SEGMENT_SECONDS,
        nls.localize('ai-focused-editor/transcription-settings/segment-seconds-label', 'Segment length (seconds)'),
        60
      )
    );
  }

  /* ---------------------------- fields ------------------------------- */

  protected renderOriginBadge(origin: PreferenceValueOrigin): React.ReactNode {
    return React.createElement(
      'span',
      {
        className: `afe-transcription-origin ${origin}`,
        'data-origin': origin,
        title: nls.localize('ai-focused-editor/transcription-settings/origin-title', 'Where the effective value comes from')
      },
      nls.localize('ai-focused-editor/transcription-settings/origin-from', 'from: {0}', this.originLabel(origin))
    );
  }

  protected renderSaveClearButtons(key: string, onSave: () => void): React.ReactNode[] {
    return [
      React.createElement('button', {
        key: 'save',
        className: 'theia-button main afe-transcription-save',
        type: 'button',
        title: nls.localize('ai-focused-editor/transcription-settings/save-title', 'Save this value into the selected target scope'),
        onClick: onSave
      }, nls.localize('ai-focused-editor/transcription-settings/save', 'Save')),
      React.createElement('button', {
        key: 'clear',
        className: 'theia-button secondary afe-transcription-clear',
        type: 'button',
        title: nls.localize('ai-focused-editor/transcription-settings/clear-title', 'Remove the value stored at the selected target scope (other scopes are untouched)'),
        onClick: () => { void this.clearValue(key); }
      }, nls.localize('ai-focused-editor/transcription-settings/clear', 'Clear'))
    ];
  }

  protected renderTextField(key: string, label: string, placeholder: string): React.ReactNode {
    const { value: effective, origin } = this.effectiveString(key);
    const draft = this.draftOf(key, effective);
    return React.createElement(
      'div',
      { className: 'afe-model-config-field afe-transcription-field', 'data-field': key },
      React.createElement('span', { className: 'afe-transcription-field-label' }, label),
      React.createElement('input', {
        value: draft,
        placeholder,
        'data-pref': key,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => this.setDraft(key, event.currentTarget.value)
      }),
      this.renderOriginBadge(origin),
      ...this.renderSaveClearButtons(key, () => { void this.saveValue(key, this.draftOf(key, effective).trim()); })
    );
  }

  protected renderNumberField(key: string, label: string, minimum: number): React.ReactNode {
    const { value, origin } = this.effective<number>(key);
    const effective = typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
    const draft = this.draftOf(key, effective);
    const save = (): void => {
      const raw = this.draftOf(key, effective).trim();
      const parsed = Number(raw);
      if (!raw || !Number.isFinite(parsed) || parsed < minimum) {
        void this.messages.warn(nls.localize(
          'ai-focused-editor/transcription-settings/invalid-number',
          '{0} must be a number ≥ {1}.', label, minimum
        ));
        return;
      }
      void this.saveValue(key, parsed);
    };
    return React.createElement(
      'div',
      { className: 'afe-model-config-field afe-transcription-field', 'data-field': key },
      React.createElement('span', { className: 'afe-transcription-field-label' }, label),
      React.createElement('input', {
        value: draft,
        type: 'number',
        min: minimum,
        'data-pref': key,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => this.setDraft(key, event.currentTarget.value)
      }),
      this.renderOriginBadge(origin),
      ...this.renderSaveClearButtons(key, save)
    );
  }

  /**
   * The Groq API key field. The input NEVER shows the stored secret (it starts
   * blank; saving writes only a non-blank draft), mirroring the Model Config
   * API-key field. The effective state surfaces as a key COUNT + origin badge.
   */
  protected renderGroqKeyField(): React.ReactNode {
    const key = MEDIA_TRANSCRIPTION_GROQ_API_KEY;
    const { value: effective, origin } = this.effectiveString(key);
    const keyCount = splitGroqApiKeys(effective).length;
    const draft = this.drafts[key] ?? '';
    const placeholder = keyCount > 0
      ? nls.localize('ai-focused-editor/transcription-settings/groq-key-configured-ph', '{0} key(s) configured — leave blank to keep', keyCount)
      : nls.localize('ai-focused-editor/transcription-settings/groq-key-ph', 'gsk_… (comma-separate multiple keys)');
    const save = (): void => {
      const raw = draft.trim();
      if (!raw) {
        void this.messages.warn(nls.localize(
          'ai-focused-editor/transcription-settings/groq-key-blank',
          'Enter a key to save, or use Clear to remove the key stored at the selected scope.'
        ));
        return;
      }
      void this.saveValue(key, raw);
    };
    return React.createElement(
      'div',
      { className: 'afe-model-config-field afe-transcription-field', 'data-field': key },
      React.createElement('span', { className: 'afe-transcription-field-label' },
        nls.localize('ai-focused-editor/transcription-settings/groq-key-label', 'Groq API key(s)')),
      React.createElement('input', {
        type: 'password',
        value: draft,
        placeholder,
        'data-pref': key,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => this.setDraft(key, event.currentTarget.value)
      }),
      this.renderOriginBadge(origin),
      ...this.renderSaveClearButtons(key, save)
    );
  }

  /* ---------------------------- check -------------------------------- */

  /** Build the backend doctor request from the currently EFFECTIVE values. */
  protected buildDoctorRequest(): MediaTranscriptionDoctorRequest {
    const stringPref = (key: string): string | undefined =>
      this.effectiveString(key).value.trim() || undefined;
    const backend = this.effectiveString(MEDIA_TRANSCRIPTION_BACKEND).value === 'groq' ? 'groq' : 'local';
    const keys = splitGroqApiKeys(this.effectiveString(MEDIA_TRANSCRIPTION_GROQ_API_KEY).value);
    return {
      backend,
      ffmpegPath: stringPref(MEDIA_TRANSCRIPTION_FFMPEG_PATH),
      ffprobePath: stringPref(MEDIA_TRANSCRIPTION_FFPROBE_PATH),
      whisperCliPath: stringPref(MEDIA_TRANSCRIPTION_WHISPER_CLI_PATH),
      modelPath: stringPref(MEDIA_TRANSCRIPTION_MODEL_PATH),
      groqApiKeys: keys.length > 0 ? keys : undefined
    };
  }

  protected async runCheck(): Promise<void> {
    this.checking = true;
    this.checkError = undefined;
    this.update();
    try {
      this.checkReport = await this.audioConversion.doctor(this.buildDoctorRequest());
    } catch (error) {
      this.checkReport = undefined;
      this.checkError = error instanceof Error ? error.message : String(error);
    } finally {
      this.checking = false;
      this.update();
    }
  }

  protected renderCheckSection(): React.ReactNode {
    return React.createElement(
      'div',
      { className: 'afe-model-config-section', 'data-testid': 'afe-ts-section-check' },
      React.createElement('h3', undefined, nls.localize('ai-focused-editor/transcription-settings/check-heading', 'Environment Check')),
      React.createElement(
        'p',
        { className: 'afe-model-config-help' },
        nls.localize(
          'ai-focused-editor/transcription-settings/check-help',
          'Runs the backend toolchain doctor with the currently effective values: ffmpeg/ffprobe, and — per the selected backend — whisper-cli + model, or the Groq API key.'
        )
      ),
      React.createElement(
        'div',
        { className: 'afe-model-config-actions' },
        React.createElement('button', {
          className: 'theia-button',
          type: 'button',
          disabled: this.checking,
          'data-testid': 'afe-ts-check-button',
          onClick: () => { void this.runCheck(); }
        }, this.checking
          ? nls.localize('ai-focused-editor/transcription-settings/checking', 'Checking…')
          : nls.localize('ai-focused-editor/transcription-settings/check', 'Check'))
      ),
      this.renderCheckResults()
    );
  }

  protected renderCheckResults(): React.ReactNode {
    if (this.checkError) {
      return React.createElement('div', { className: 'afe-transcription-check-error' },
        nls.localize('ai-focused-editor/transcription-settings/check-failed', 'Check failed: {0}', this.checkError));
    }
    const report = this.checkReport;
    if (!report) {
      return undefined;
    }
    const summary = report.ok
      ? nls.localize('ai-focused-editor/transcription-settings/check-ok', '✓ Everything the selected backend needs is available.')
      : nls.localize('ai-focused-editor/transcription-settings/check-issues', '✗ Some checks failed — see the advice below.');
    return React.createElement(
      'div',
      { className: 'afe-transcription-check-results', 'data-testid': 'afe-ts-check-results' },
      React.createElement('div', { className: `afe-transcription-check-summary ${report.ok ? 'ok' : 'fail'}` }, summary),
      React.createElement(
        'ul',
        { className: 'afe-transcription-check-list' },
        ...report.checks.map(check => React.createElement(
          'li',
          { key: check.id, className: `afe-transcription-check-item ${check.ok ? 'ok' : 'fail'}`, 'data-check': check.id },
          React.createElement('div', { className: 'afe-transcription-check-row' },
            React.createElement('span', { className: 'afe-transcription-check-icon' }, check.ok ? '✓' : '✗'),
            React.createElement('span', { className: 'afe-transcription-check-label' }, check.label),
            React.createElement('span', { className: 'afe-transcription-check-detail' }, check.detail)
          ),
          check.ok || !check.advice
            ? undefined
            : React.createElement('div', { className: 'afe-transcription-check-advice' }, check.advice)
        ))
      )
    );
  }
}
