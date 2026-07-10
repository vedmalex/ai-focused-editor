/*
 * Derived from the owner's telegraph-publisher library
 * (~/work/BhaktiVaibhava/telegraph-publisher, v1.5.0). Extracted to the
 * self-contained EPUB export closure for AI Focused Editor.
 */
import * as fs from 'node:fs';
import { dirname, isAbsolute, join, resolve as pathResolve } from 'node:path';

/**
 * PathResolver provides a unified mechanism for resolving file paths.
 * This class is designed to be a singleton or instantiated once and passed around.
 */
export class PathResolver {
  private static instance: PathResolver;
  private projectRootCache: Map<string, string> = new Map();

  private constructor() { }

  public static getInstance(): PathResolver {
    if (!PathResolver.instance) {
      PathResolver.instance = new PathResolver();
    }
    return PathResolver.instance;
  }

  /**
   * Finds the project root directory by searching upwards for package.json or .git.
   * Results are cached for performance.
   * @param startPath The path to start searching from.
   * @returns The absolute path to the project root.
   */
  public findProjectRoot(startPath: string): string {
    const normalizedStartPath = pathResolve(startPath);
    if (this.projectRootCache.has(normalizedStartPath)) {
      return this.projectRootCache.get(normalizedStartPath)!;
    }

    let currentPath = dirname(normalizedStartPath);
    const root = pathResolve('/');

    while (currentPath !== root) {
      if (fs.existsSync(join(currentPath, 'package.json')) || fs.existsSync(join(currentPath, '.git'))) {
        this.projectRootCache.set(normalizedStartPath, currentPath);
        return currentPath;
      }

      const parentPath = dirname(currentPath);
      if (parentPath === currentPath) {
        break; // Reached the file system root
      }
      currentPath = parentPath;
    }

    // If no project root found, use the directory containing the start file/path
    const finalRoot = dirname(normalizedStartPath);
    this.projectRootCache.set(normalizedStartPath, finalRoot);
    return finalRoot;
  }

  /**
   * Resolves a link path relative to a base path or the project root.
   * @param fromPath The base path (usually the source file's path).
   * @param linkHref The link href to resolve.
   * @returns The absolute resolved path.
   */
  public resolve(fromPath: string, linkHref: string): string {
    // If linkHref starts with /, resolve relative to the project root.
    if (isAbsolute(linkHref)) {
      const projectRoot = this.findProjectRoot(fromPath);
      return pathResolve(projectRoot, linkHref.slice(1)); // Remove leading slash
    }

    // If linkHref is relative (e.g., ./ or ../), resolve relative to the directory of fromPath.
    const fromDir = dirname(fromPath);
    return pathResolve(fromDir, linkHref);
  }
}