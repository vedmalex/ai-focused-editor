import type { WorkspaceDiagnostic } from '../common';
import { NodeBookBuildService } from './node-book-build-service';

async function main(): Promise<void> {
  const { format, rootUri, outputPath } = parseArgs(process.argv.slice(2));
  if (!rootUri) {
    console.error('Usage: node book-build-task-cli.js [--format markdown|html|epub|pdf] <root-uri> [output-path]');
    process.exitCode = 2;
    return;
  }

  console.log(`AI Focused Editor: building manuscript ${format.toUpperCase()}`);
  console.log(`Workspace: ${rootUri}`);

  const service = new NodeBookBuildService();
  const method = format === 'html'
    ? 'buildHtml'
    : format === 'epub'
      ? 'buildEpub'
      : format === 'pdf'
        ? 'buildPdf'
        : 'buildMarkdown';
  const result = await service[method]({
    rootUri,
    outputPath
  });

  for (const diagnostic of result.diagnostics) {
    const line = formatDiagnostic(diagnostic);
    if (diagnostic.severity === 'error') {
      console.error(line);
    } else {
      console.log(line);
    }
  }

  const errors = result.diagnostics.filter(diagnostic => diagnostic.severity === 'error');
  const warnings = result.diagnostics.filter(diagnostic => diagnostic.severity === 'warning');
  if (errors.length > 0) {
    console.error(`Book build failed: ${errors.length} error(s), ${warnings.length} warning(s).`);
    for (const error of errors) {
      console.error(`  - ${formatDiagnostic(error)}`);
    }
    process.exitCode = 1;
    return;
  }

  // EPUB and PDF outputs are binary files, so report their size in bytes; the
  // text formats (markdown/html) report their character count.
  const sizeSummary = format === 'epub' || format === 'pdf'
    ? `${result.contentLength} bytes`
    : `${result.contentLength} characters`;
  console.log(`Book build completed: ${result.chapters.length} chapter(s), ${sizeSummary}, ${warnings.length} warning(s).`);
  console.log(`Output: ${result.outputPath}`);
}

function formatDiagnostic(diagnostic: WorkspaceDiagnostic): string {
  const location = diagnostic.uri ? ` ${diagnostic.uri}` : '';
  const position = diagnostic.range
    ? `:${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1}`
    : '';
  return `[${diagnostic.severity.toUpperCase()}]${location}${position} ${diagnostic.message}`;
}

function parseArgs(args: string[]): { format: 'markdown' | 'html' | 'epub' | 'pdf'; rootUri?: string; outputPath?: string } {
  let format: 'markdown' | 'html' | 'epub' | 'pdf' = 'markdown';
  const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--format') {
      const value = args[++index];
      if (value !== 'markdown' && value !== 'html' && value !== 'epub' && value !== 'pdf') {
        throw new Error(`Unsupported book build format: ${value ?? ''}`);
      }
      format = value;
    } else {
      positional.push(arg);
    }
  }
  return {
    format,
    rootUri: positional[0],
    outputPath: positional[1]
  };
}

main().catch(error => {
  console.error(`Book build failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
