/**
 * Host seam for the AI Debug view's manuscript-specific section.
 *
 * The AI Debug widget is connection-level, but it also surfaces the host
 * application's assembled AI context and project "modes" for inspection. Rather
 * than depend on manuscript-workspace types, the package defines this optional
 * provider; the host binds an implementation. When no provider is bound the
 * widget simply renders an empty manuscript section (connection debugging still
 * works standalone).
 */
export const AiDebugContextProvider = Symbol('AiDebugContextProvider');

/** Minimal shape of a project AI mode the debug view renders. */
export interface AiDebugModeInfo {
  id: string;
  label: string;
  parameters?: unknown;
}

/** Minimal shape of a workspace diagnostic the debug view renders. */
export interface AiDebugDiagnosticInfo {
  source: string;
  severity: string;
  message: string;
}

export interface AiDebugContextSnapshot {
  modes: AiDebugModeInfo[];
  diagnostics: AiDebugDiagnosticInfo[];
  /** The assembled always-on context string (empty when none). */
  manuscriptContext: string;
}

export interface AiDebugContextProvider {
  collect(): Promise<AiDebugContextSnapshot>;
}
