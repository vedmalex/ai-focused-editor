// *****************************************************************************
// Copyright (C) 2017 TypeFox and others.
//
// This program and the accompanying materials are made available under the
// terms of the Eclipse Public License v. 2.0 which is available at
// http://www.eclipse.org/legal/epl-2.0.
//
// This Source Code may also be made available under the following Secondary
// Licenses when the conditions for such availability set forth in the Eclipse
// Public License v. 2.0 are satisfied: GNU General Public License, version 2
// with the GNU Classpath Exception which is available at
// https://www.gnu.org/software/classpath/license.html.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

import * as fs from '@theia/core/shared/fs-extra';
import { promises as nodeFs, Dirent } from 'fs';
import * as path from 'path';
import { GitLocator, GitLocateOptions } from './git-locator-protocol';

export type FindGitRepositories = (path: string, progressCb: (repos: string[]) => void) => Promise<string[]>;

/**
 * FORK CHANGE: pure-JS replacement for the `find-git-repositories` native
 * addon. `theia rebuild:browser/electron` kept flipping the addon between the
 * Node and Electron ABIs, breaking whichever target was built second. A
 * bounded directory walk needs no native code and behaves identically for
 * writing-project workspaces.
 */
const FIND_GIT_MAX_DEPTH = 6;
const FIND_GIT_SKIP_DIRS = new Set(['node_modules', '.Trash', 'Library', '.cache', '.npm', '.bun']);

const findGitRepositories: FindGitRepositories = async (basePath, progressCb) => {
    const found: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
        if (depth > FIND_GIT_MAX_DEPTH) {
            return;
        }
        let entries: Dirent[];
        try {
            entries = await nodeFs.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        const subdirectories: string[] = [];
        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }
            if (entry.name === '.git') {
                // Match the native addon's contract: report the `.git` folder.
                found.push(path.join(dir, entry.name));
                progressCb([path.join(dir, entry.name)]);
                continue;
            }
            if (entry.name.startsWith('.') || FIND_GIT_SKIP_DIRS.has(entry.name)) {
                continue;
            }
            subdirectories.push(path.join(dir, entry.name));
        }
        for (const subdirectory of subdirectories) {
            await walk(subdirectory, depth + 1);
        }
    };
    await walk(basePath, 0);
    return found;
};

export interface GitLocateContext {
    maxCount: number
    readonly visited: Map<string, boolean>
}

export class GitLocatorImpl implements GitLocator {

    protected readonly options: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        info: (message: string, ...args: any[]) => void
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        error: (message: string, ...args: any[]) => void
    };

    constructor(options?: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        info?: (message: string, ...args: any[]) => void
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        error?: (message: string, ...args: any[]) => void
    }) {
        this.options = {
            info: (message, ...args) => console.info(message, ...args),
            error: (message, ...args) => console.error(message, ...args),
            ...options
        };
    }

    dispose(): void {
    }

    async locate(basePath: string, options: GitLocateOptions): Promise<string[]> {
        return this.doLocate(basePath, {
            maxCount: typeof options.maxCount === 'number' ? options.maxCount : -1,
            visited: new Map<string, boolean>()
        });
    }

    protected async doLocate(basePath: string, context: GitLocateContext): Promise<string[]> {
        const realBasePath = await fs.realpath(basePath);
        if (context.visited.has(realBasePath)) {
            return [];
        }
        context.visited.set(realBasePath, true);
        try {
            const stat = await fs.stat(realBasePath);
            if (!stat.isDirectory()) {
                return [];
            }
            const progress: string[] = [];
            const paths = await findGitRepositories(realBasePath, repositories => {
                progress.push(...repositories);
                if (context.maxCount >= 0 && progress.length >= context.maxCount) {
                    return progress.slice(0, context.maxCount).map(GitLocatorImpl.map);
                }
            });
            if (context.maxCount >= 0 && paths.length >= context.maxCount) {
                return await Promise.all(paths.slice(0, context.maxCount).map(GitLocatorImpl.map));
            }
            const repositoryPaths = await Promise.all(paths.map(GitLocatorImpl.map));
            return this.locateFrom(
                newContext => this.generateNested(repositoryPaths, newContext),
                context,
                repositoryPaths
            );
        } catch (e) {
            return [];
        }
    }

    protected * generateNested(repositoryPaths: string[], context: GitLocateContext): IterableIterator<Promise<string[]>> {
        for (const repository of repositoryPaths) {
            yield this.locateNested(repository, context);
        }
    }
    protected locateNested(repositoryPath: string, context: GitLocateContext): Promise<string[]> {
        return new Promise<string[]>(resolve => {
            fs.readdir(repositoryPath, async (err, files) => {
                if (err) {
                    this.options.error(err.message, err);
                    resolve([]);
                } else {
                    resolve(this.locateFrom(
                        newContext => this.generateRepositories(repositoryPath, files, newContext),
                        context
                    ));
                }
            });
        });
    }

    protected * generateRepositories(repositoryPath: string, files: string[], context: GitLocateContext): IterableIterator<Promise<string[]>> {
        for (const file of files) {
            if (file !== '.git') {
                yield this.doLocate(path.join(repositoryPath, file), {
                    ...context
                });
            }
        }
    }

    protected async locateFrom(
        generator: (context: GitLocateContext) => IterableIterator<Promise<string[]>>, parentContext: GitLocateContext, initial?: string[]
    ): Promise<string[]> {
        const result: string[] = [];
        if (initial) {
            result.push(...initial);
        }
        const context = {
            ...parentContext,
            maxCount: parentContext.maxCount - result.length
        };
        for (const locateRepositories of generator(context)) {
            const repositories = await locateRepositories;
            result.push(...repositories);
            if (context.maxCount >= 0) {
                if (result.length >= context.maxCount) {
                    return result.slice(0, context.maxCount);
                }
                context.maxCount -= repositories.length;
            }
        }
        return result;
    }

    static async map(repository: string): Promise<string> {
        return fs.realpath(path.dirname(repository));
    }

}
