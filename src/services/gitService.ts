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

  private initializeWorkspace(): void {
    try {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        this.outputChannel.appendLine('DevTrack: No workspace folder is open.');
        return;
      }

      this.repoPath = workspaceFolders[0].uri.fsPath;

      // Initialize Git with safe options
      const options: Partial<SimpleGitOptions> = {
        baseDir: this.repoPath,
        maxConcurrentProcesses: 1,
        trimmed: false,
      };

      if (this.isWindows) {
        // Add Windows-specific options if needed
        options.config = [
          'core.autocrlf=true',
          'core.safecrlf=false',
          'core.longpaths=true',
        ];
      }

      this.git = simpleGit(options);

      this.initGitConfig().catch((error) => {
        this.outputChannel.appendLine(
          `DevTrack: Git config initialization error - ${error}`
        );
      });
    } catch (error) {
      this.outputChannel.appendLine(
        `DevTrack: Workspace initialization error - ${error}`
      );
    }
  }

  private findGitExecutable(): string {
    try {
      if (this.isWindows) {
        const commonPaths = [
          'C:\\Program Files\\Git\\cmd\\git.exe',
          'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
        ];

        for (const gitPath of commonPaths) {
          if (fs.existsSync(gitPath)) {
            return gitPath;
          }
        }

        // Fallback to using PATH
        try {
          const gitPathFromEnv = execSync('where git', { encoding: 'utf8' })
            .split('\n')[0]
            .trim();
          if (gitPathFromEnv) {
            return gitPathFromEnv;
          }
        } catch (error) {
          this.outputChannel.appendLine('DevTrack: Git not found in PATH');
        }
        return 'git'; // Last resort fallback
      } else {
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
    } catch (error) {
      this.outputChannel.appendLine(
        `DevTrack: Error initializing Git config: ${error}`
      );
      throw error;
    }
  }

  private async verifyGitConfig(): Promise<void> {
    try {
      const options = {
        baseDir: this.repoPath,
        binary: this.findGitExecutable(),
        maxConcurrentProcesses: 1,
      };

      // Test Git configuration
      const testGit = simpleGit(options);
      await testGit.raw(['config', '--list']);

      // Verify repository state
      const isRepo = await testGit.checkIsRepo();
      if (isRepo) {
        // Verify remote configuration
        const remotes = await testGit.getRemotes(true);
        if (remotes.length === 0) {
          throw new Error('No remote configured');
        }
      }
    } catch (error: any) {
      this.outputChannel.appendLine(
        `DevTrack: Git config verification failed - ${error.message}`
      );
      throw new Error(`Git configuration error: ${error.message}`);
    }
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

        // Clean up any existing Git state
        await this.cleanupGitLocks();

        await this.withRetry(async () => {
          const isRepo = await this.git.checkIsRepo();

          if (!isRepo) {
            await this.git.init();
            this.outputChannel.appendLine(
              'DevTrack: Initialized new Git repository.'
            );
          }
        });

        // Force clean working directory
        await this.withRetry(() => this.git.clean('f', ['-d']));

        // Reset any existing state
        try {
          await this.withRetry(() => this.git.raw(['reset', '--hard']));
        } catch (error) {
          // Ignore reset errors on fresh repos
        }

        // Configure remotes with force
        await this.withRetry(async () => {
          const remotes = await this.git.getRemotes(true);
          if (remotes.find((remote) => remote.name === 'origin')) {
            await this.git.removeRemote('origin');
          }
          await this.git.addRemote('origin', remoteUrl);
        });

        // Ensure main branch exists and is clean
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

        // Initial commit with proper error handling
        await this.withRetry(async () => {
          try {
            await this.git.add('.');
            await this.git.commit('DevTrack: Initial commit', [
              '--allow-empty',
            ]);
            await this.git.push(['-u', 'origin', 'main']);
          } catch (error: any) {
            if (error.message.includes('rejected')) {
              // Handle case where remote exists but we can't push
              await this.git.fetch('origin');
              await this.git.reset(['--hard', 'origin/main']);
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
