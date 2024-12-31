/* eslint-disable no-unused-vars */
/* eslint-disable no-undef */
import * as vscode from 'vscode';
import simpleGit, { SimpleGit, SimpleGitOptions } from 'simple-git';
import * as path from 'path';
import { EventEmitter } from 'events';
import { OutputChannel } from 'vscode';
import { promisify } from 'util';
import { exec } from 'child_process';
import { execSync } from 'child_process';
const execAsync = promisify(exec);
import * as fs from 'fs';

interface GitServiceEvents {
  commit: (message: string) => void;
  error: (error: Error) => void;
  'operation:start': (operation: string) => void;
  'operation:end': (operation: string) => void;
  retry: (operation: string, attempt: number) => void;
  push: (branch: string) => void;
}
export class GitService extends EventEmitter {
  private git!: SimpleGit;
  private repoPath!: string;
  private outputChannel: OutputChannel;
  private operationQueue: Promise<any> = Promise.resolve();
  private static MAX_RETRIES = 3;
  private static RETRY_DELAY = 1000;
  private readonly isWindows: boolean = process.platform === 'win32';
  private static readonly MAX_LISTENERS = 10;
  private boundListeners: Set<{
    event: keyof GitServiceEvents;
    listener: Function;
  }> = new Set();

  constructor(outputChannel: OutputChannel) {
    super();
    this.setMaxListeners(GitService.MAX_LISTENERS);
    this.outputChannel = outputChannel;
    this.initializeWorkspace();
    this.setupDefaultErrorHandler();
  }
  private setupDefaultErrorHandler(): void {
    if (this.listenerCount('error') === 0) {
      this.on('error', (error: Error) => {
        this.outputChannel.appendLine(
          `DevTrack: Unhandled Git error - ${error.message}`
        );
      });
    }
  }

  // Type-safe event emitter methods
  public on<E extends keyof GitServiceEvents>(
    event: E,
    listener: GitServiceEvents[E]
  ): this {
    if (
      event === 'error' &&
      this.listenerCount('error') >= GitService.MAX_LISTENERS - 1
    ) {
      this.outputChannel.appendLine(
        'DevTrack: Warning - Too many error listeners'
      );
      return this;
    }

    this.boundListeners.add({ event, listener });
    return super.on(event, listener);
  }

  public once<E extends keyof GitServiceEvents>(
    event: E,
    listener: GitServiceEvents[E]
  ): this {
    const onceListener = ((...args: Parameters<GitServiceEvents[E]>) => {
      this.boundListeners.delete({ event, listener });
      return (listener as Function).apply(this, args);
    }) as unknown as GitServiceEvents[E];

    this.boundListeners.add({ event, listener: onceListener });
    return super.once(event, onceListener);
  }

  public removeListener<E extends keyof GitServiceEvents>(
    event: E,
    listener: GitServiceEvents[E]
  ): this {
    this.boundListeners.delete({ event, listener });
    return super.removeListener(event, listener);
  }

  public removeAllListeners(event?: keyof GitServiceEvents): this {
    if (event) {
      this.boundListeners.forEach((listener) => {
        if (listener.event === event) {
          this.boundListeners.delete(listener);
        }
      });
    } else {
      this.boundListeners.clear();
    }
    return super.removeAllListeners(event);
  }

  // Safe emit method with type checking
  protected emitSafe<E extends keyof GitServiceEvents>(
    event: E,
    ...args: Parameters<GitServiceEvents[E]>
  ): boolean {
    try {
      if (this.listenerCount(event) === 0 && event !== 'error') {
        // If no listeners for non-error events, log it
        this.outputChannel.appendLine(
          `DevTrack: No listeners for event - ${String(event)}`
        );
        return false;
      }
      return super.emit(event, ...args);
    } catch (error) {
      this.outputChannel.appendLine(
        `DevTrack: Error emitting event ${String(event)} - ${error}`
      );
      this.emit('error', new Error(`Event emission failed: ${error}`));
      return false;
    }
  }

  private async initializeWorkspace(): Promise<void> {
    try {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        this.outputChannel.appendLine('DevTrack: No workspace folder is open.');
        return;
      }

      this.repoPath = workspaceFolders[0].uri.fsPath;

      // Get Git executable path
      const gitPath = this.findGitExecutable();
      const normalizedGitPath = this.isWindows
        ? gitPath.replace(/\\/g, '/')
        : gitPath;
      this.outputChannel.appendLine(
        `DevTrack: Using Git executable: ${gitPath}`
      );

      // Initialize Git with safe options
      const options: Partial<SimpleGitOptions> = {
        baseDir: this.repoPath,
        binary: normalizedGitPath,
        maxConcurrentProcesses: 1,
        trimmed: false,
        // Add the unsafe configuration for Windows paths
        unsafe: {
          allowUnsafeCustomBinary: true, // Allow spaces in Windows paths
        },
      };

      if (this.isWindows) {
        options.config = [
          'core.autocrlf=true',
          'core.safecrlf=false',
          'core.longpaths=true',
          'core.quotePath=false',
          'core.preloadIndex=true',
          'core.fscache=true',
          'core.ignorecase=true',
        ];
      }

      this.git = simpleGit(options);

      // Verify the configuration
      await this.verifyGitConfig();
      await this.initGitConfig();
    } catch (error) {
      this.outputChannel.appendLine(
        `DevTrack: Workspace initialization error - ${error}`
      );
      throw error;
    }
  }

  private findGitExecutable(): string {
    try {
      if (this.isWindows) {
        // Try to get Git path from environment variables first
        const pathEnv = process.env.PATH || '';
        const paths = pathEnv.split(path.delimiter);

        // Always use forward slashes for Windows paths
        for (const basePath of paths) {
          const gitExePath = path.join(basePath, 'git.exe').replace(/\\/g, '/');
          if (fs.existsSync(gitExePath)) {
            this.outputChannel.appendLine(
              `DevTrack: Found Git in PATH at ${gitExePath}`
            );
            return gitExePath;
          }
        }

        // Check common installation paths with forward slashes
        const commonPaths = [
          'C:/Program Files/Git/cmd/git.exe',
          'C:/Program Files (x86)/Git/cmd/git.exe',
        ];

        for (const gitPath of commonPaths) {
          if (fs.existsSync(gitPath)) {
            this.outputChannel.appendLine(`DevTrack: Found Git at ${gitPath}`);
            return gitPath;
          }
        }

        // Last resort: try where command
        try {
          const gitPathFromWhere = execSync('where git', { encoding: 'utf8' })
            .split('\n')[0]
            .trim()
            .replace(/\\/g, '/');
          if (gitPathFromWhere && fs.existsSync(gitPathFromWhere)) {
            this.outputChannel.appendLine(
              `DevTrack: Found Git using 'where' command at ${gitPathFromWhere}`
            );
            return gitPathFromWhere;
          }
        } catch (error) {
          this.outputChannel.appendLine('DevTrack: Git not found in PATH');
        }

        // Final fallback
        return 'git';
      } else {
        // Unix-like systems
        try {
          return execSync('which git', { encoding: 'utf8' }).trim();
        } catch {
          return 'git';
        }
      }
    } catch (error) {
      this.outputChannel.appendLine(
        `DevTrack: Error finding Git executable - ${error}`
      );
      return 'git';
    }
  }

  private async cleanupGitLocks(): Promise<void> {
    try {
      const gitDir = path.join(this.repoPath, '.git');
      const lockFiles = ['index.lock', 'HEAD.lock'];

      for (const lockFile of lockFiles) {
        const lockPath = path.join(gitDir, lockFile);
        if (fs.existsSync(lockPath)) {
          try {
            fs.unlinkSync(lockPath);
          } catch (error) {
            this.outputChannel.appendLine(
              `DevTrack: Could not remove lock file ${lockPath}: ${error}`
            );
          }
        }
      }
    } catch (error) {
      this.outputChannel.appendLine(
        `DevTrack: Error cleaning up Git locks: ${error}`
      );
    }
  }

  private async initGitConfig() {
    try {
      if (!this.git) {
        throw new Error('Git not initialized');
      }

      await this.git.addConfig('core.autocrlf', 'true');
      await this.git.addConfig('core.safecrlf', 'false');
      await this.git.addConfig('core.longpaths', 'true');

      if (this.isWindows) {
        await this.git.addConfig('core.quotepath', 'false');
        await this.git.addConfig('core.ignorecase', 'true');
      }
    } catch (error) {
      this.outputChannel.appendLine(
        `DevTrack: Error initializing Git config: ${error}`
      );
      throw error;
    }
  }

  private async verifyGitConfig(): Promise<void> {
    try {
      // Get Git executable path with proper escaping for Windows
      const gitPath = this.findGitExecutable();
      const normalizedGitPath = this.isWindows
        ? gitPath.replace(/\\/g, '/')
        : gitPath;

      // Basic Git version check
      try {
        const versionCmd = this.isWindows
          ? `"${normalizedGitPath}"`
          : normalizedGitPath;
        execSync(`${versionCmd} --version`, { encoding: 'utf8' });
        this.outputChannel.appendLine(
          `DevTrack: Successfully verified Git at: ${normalizedGitPath}`
        );
      } catch (error: any) {
        throw new Error(`Git executable validation failed: ${error.message}`);
      }

      // Test Git configuration with normalized paths
      const testGit = simpleGit({
        baseDir: this.repoPath,
        binary: normalizedGitPath,
        maxConcurrentProcesses: 1,
        unsafe: {
          allowUnsafeCustomBinary: true,
        },
        ...(this.isWindows && {
          config: [
            'core.quotePath=false',
            'core.preloadIndex=true',
            'core.fscache=true',
            'core.ignorecase=true',
          ],
        }),
      });

      // Verify basic Git configuration
      await testGit.raw(['config', '--list']);
      this.outputChannel.appendLine('DevTrack: Git configuration verified');

      // Check repository state
      const isRepo = await testGit.checkIsRepo();
      if (isRepo) {
        const remotes = await testGit.getRemotes(true);
        if (remotes.length === 0) {
          this.outputChannel.appendLine('DevTrack: No remote configured');
        }
      }

      // Windows-specific checks
      if (this.isWindows) {
        try {
          await testGit.raw(['config', '--system', '--list']);
          this.outputChannel.appendLine(
            'DevTrack: Windows Git system configuration verified'
          );
        } catch (error) {
          // Don't throw on system config access issues
          this.outputChannel.appendLine(
            'DevTrack: System Git config check skipped (normal on some Windows setups)'
          );
        }
      }
    } catch (error: any) {
      this.outputChannel.appendLine(
        `DevTrack: Git config verification failed - ${error.message}`
      );
      throw new Error(`Git configuration error: ${error.message}`);
    }
  }
  catch(error: any) {
    this.outputChannel.appendLine(
      `DevTrack: Git config verification failed - ${error.message}`
    );
    throw new Error(`Git configuration error: ${error.message}`);
  }

  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= GitService.MAX_RETRIES; attempt++) {
      try {
        return await operation();
      } catch (error: any) {
        lastError = error;
        this.outputChannel.appendLine(
          `DevTrack: Operation failed (attempt ${attempt}/${GitService.MAX_RETRIES}): ${error.message}`
        );

        if (attempt < GitService.MAX_RETRIES) {
          await new Promise((resolve) =>
            setTimeout(resolve, GitService.RETRY_DELAY * attempt)
          );
          await this.cleanupGitLocks();
        }
      }
    }

    throw lastError;
  }

  public async initializeRepo(remoteUrl: string): Promise<void> {
    return this.enqueueOperation(async () => {
      try {
        // Verify Git installation and configuration first
        await this.verifyGitConfig();

        if (!this.git) {
          throw new Error('Git not initialized');
        }

        // Clean up any existing Git state safely
        await this.cleanupGitLocks();

        await this.withRetry(async () => {
          const isRepo = await this.git.checkIsRepo();

          if (!isRepo) {
            await this.git.init();
            this.outputChannel.appendLine(
              'DevTrack: Initialized new Git repository.'
            );
          }

          // Ensure we're on main branch
          try {
            const branches = await this.git.branchLocal();

            if (!branches.all.includes('main')) {
              // Create and checkout main if it doesn't exist
              await this.git.checkoutLocalBranch('main');
            } else if (branches.current !== 'main') {
              // Switch to main if we're on a different branch
              await this.git.checkout('main');
            }
          } catch (error) {
            // If branch operations fail, create main branch fresh
            await this.git.checkout(['-B', 'main']);
          }

          // Stage and commit any existing files
          const status = await this.git.status();

          if (
            status.files.length > 0 ||
            !status.staged.length ||
            status.not_added.length > 0
          ) {
            await this.git.add('.');
            const hasChanges = (await this.git.status()).files.length > 0;

            if (hasChanges) {
              await this.git.commit(
                'DevTrack: Initial commit with existing project files'
              );
            }
          }
        });

        // Configure remotes with force
        await this.withRetry(async () => {
          const remotes = await this.git.getRemotes(true);
          if (remotes.find((remote) => remote.name === 'origin')) {
            await this.git.removeRemote('origin');
          }
          await this.git.addRemote('origin', remoteUrl);
        });

        // Ensure main branch exists
        await this.withRetry(async () => {
          const branches = await this.git.branchLocal();
          if (!branches.current || branches.current !== 'main') {
            try {
              await this.git.checkoutLocalBranch('main');
            } catch (error) {
              await this.git.checkout(['-b', 'main']);
            }
          }
        });

        // Push to remote with proper error handling
        await this.withRetry(async () => {
          const remotes = await this.git.getRemotes(true);
          if (remotes.find((remote) => remote.name === 'origin')) {
            await this.git.removeRemote('origin');
          }
          await this.git.addRemote('origin', remoteUrl);
        });

        // Push to remote with proper error handling
        await this.withRetry(async () => {
          try {
            // Ensure we have commits before pushing
            const commits = await this.git.log(['--oneline']);
            if (!commits.total) {
              // Create an empty commit if no commits exist
              await this.git.commit('DevTrack: Initial commit', {
                '--allow-empty': null,
              });
            }

            // Now push with upstream tracking
            await this.git.push(['-u', 'origin', 'main']);
          } catch (error: any) {
            if (error.message.includes('rejected')) {
              // Handle case where remote exists but we can't push
              await this.git.fetch('origin');
              await this.git.pull(['--rebase=true', 'origin', 'main']);
              await this.git.push(['--force-with-lease', 'origin', 'main']);
            } else if (
              error.message.includes('src refspec main does not match any')
            ) {
              // Handle case where main branch isn't properly initialized
              await this.git.checkout(['-B', 'main']);
              await this.git.commit('DevTrack: Initialize main branch', {
                '--allow-empty': null,
              });
              await this.git.push(['-u', 'origin', 'main']);
            } else {
              throw error;
            }
          }
        });
      } catch (error: any) {
        this.handleGitError(error);
        throw error;
      }
    });
  }

  private handleGitError(error: any): void {
    let errorMessage = 'Git operation failed';

    if (error.message?.includes('ENOENT')) {
      errorMessage =
        process.platform === 'win32'
          ? 'Git not found. Please install Git for Windows from https://git-scm.com/download/win'
          : 'Git is not accessible. Please ensure Git is installed.';
    } else if (error.message?.includes('spawn git ENOENT')) {
      errorMessage =
        process.platform === 'win32'
          ? 'Git not found in PATH. Please restart VS Code after installing Git.'
          : 'Failed to spawn Git process. Please verify your Git installation.';
    } else if (error.message?.includes('not a git repository')) {
      errorMessage =
        'Not a Git repository. Please initialize the repository first.';
    }

    this.outputChannel.appendLine(
      `DevTrack: ${errorMessage} - ${error.message}`
    );
    vscode.window.showErrorMessage(`DevTrack: ${errorMessage}`);
  }

  private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    this.operationQueue = this.operationQueue
      .then(() => operation())
      .catch((error) => {
        this.outputChannel.appendLine(`DevTrack: Operation failed: ${error}`);
        throw error;
      });
    return this.operationQueue;
  }

  public async commitAndPush(message: string): Promise<void> {
    return this.enqueueOperation(async () => {
      try {
        if (!this.git) {
          throw new Error('Git not initialized');
        }

        this.emitSafe('operation:start', 'commitAndPush');

        await this.withRetry(async () => {
          await this.git.add('.');
          await this.git.commit(message);
          this.emitSafe('commit', message);

          await this.git.push();
          this.emitSafe('push', 'main'); // Assuming main branch for now
        });

        this.emitSafe('operation:end', 'commitAndPush');
      } catch (error: any) {
        this.outputChannel.appendLine(
          `DevTrack: Git commit failed - ${error.message}`
        );
        this.emitSafe('error', error);
        throw error;
      }
    });
  }

  // Helper method to check if we have any listeners for an event
  public hasListeners(event: keyof GitServiceEvents): boolean {
    return this.listenerCount(event) > 0;
  }

  // Add cleanup method
  public dispose(): void {
    this.removeAllListeners();
    if (this.git) {
      // Cleanup any ongoing git operations
      this.operationQueue = Promise.resolve();
    }
    this.outputChannel.appendLine('DevTrack: GitService disposed');
  }
}
