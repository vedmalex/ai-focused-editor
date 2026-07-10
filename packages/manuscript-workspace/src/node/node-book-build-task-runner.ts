import { join } from 'path';
import { inject, injectable } from '@theia/core/shared/inversify';
import { TaskTerminalProcessFactory } from '@theia/process/lib/node';
import { TaskConfiguration } from '@theia/task/lib/common';
import {
  TaskRunner,
  TaskRunnerContribution,
  TaskRunnerRegistry
} from '@theia/task/lib/node/task-runner';
import {
  TaskFactory as ProcessTaskFactory
} from '@theia/task/lib/node/process/process-task';
import {
  BookBuildTaskConfiguration,
  BookBuildTaskType
} from '../common';

@injectable()
export class NodeBookBuildTaskRunner implements TaskRunner {
  @inject(TaskTerminalProcessFactory)
  protected readonly taskTerminalProcessFactory!: TaskTerminalProcessFactory;

  @inject(ProcessTaskFactory)
  protected readonly processTaskFactory!: ProcessTaskFactory;

  async run(taskConfig: TaskConfiguration, ctx?: string) {
    const buildTask = taskConfig as BookBuildTaskConfiguration;
    if (!buildTask.rootUri) {
      throw new Error('Book build task is missing rootUri.');
    }

    const cliPath = join(__dirname, 'book-build-task-cli.js');
    const format = buildTask.format ?? 'markdown';
    const args = buildTask.outputPath
      ? [cliPath, '--format', format, buildTask.rootUri, buildTask.outputPath]
      : [cliPath, '--format', format, buildTask.rootUri];
    const command = process.execPath;
    const terminal = this.taskTerminalProcessFactory({
      command,
      args,
      options: {
        cwd: process.cwd(),
        env: process.env
      }
    });

    return this.processTaskFactory({
      context: ctx,
      config: taskConfig,
      label: taskConfig.label,
      process: terminal,
      processType: 'process',
      command: `${command} ${args.map(arg => JSON.stringify(arg)).join(' ')}`
    });
  }
}

@injectable()
export class NodeBookBuildTaskRunnerContribution implements TaskRunnerContribution {
  @inject(NodeBookBuildTaskRunner)
  protected readonly runner!: NodeBookBuildTaskRunner;

  registerRunner(runners: TaskRunnerRegistry): void {
    runners.registerRunner(BookBuildTaskType, this.runner);
  }
}
