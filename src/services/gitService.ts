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
import * as fs from 'fs';

const execAsync = promisify(exec);

export class GitService extends EventEmitter {
  private git!: SimpleGit;
  private repoPath!: string;
  private outputChannel: OutputChannel;
  private operationQueue: Promise<any> = Promise.resolve();
  private static MAX_RETRIES = 3;
  private static RETRY_DELAY = 1000;
  private readonly isWindows: boolean = process.platform === 'win32';

  constructor(outputChannel: OutputChannel) {
    super();
    this.outputChannel = outputChannel;
    this.initializeWorkspace();
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

  private async verifyGit(): Promise<boolean> {
    try {
      const gitPath = this.findGitExecutable();
      return new Promise((resolve) => {
        const gitProcess = require('child_process').spawn(gitPath, [
          '--version',
        ]);

        gitProcess.on('error', () => {
          resolve(false);
        });

        gitProcess.on('close', (code: number) => {
          resolve(code === 0);
        });
      });
    } catch (error) {
      return false;
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

  async initializeRepo(remoteUrl: string): Promise<void> {
    return this.enqueueOperation(async () => {
      try {
        if (!this.git) {
          throw new Error('Git not initialized');
        }

        const isRepo = await this.git.checkIsRepo();

        if (!isRepo) {
          await this.git.init();
          this.outputChannel.appendLine(
            'DevTrack: Initialized new Git repository.'
          );
        }

        // Check for existing remotes
        const remotes = await this.git.getRemotes(true);
        const originRemote = remotes.find((remote) => remote.name === 'origin');

        if (originRemote) {
          if (originRemote.refs.fetch !== remoteUrl) {
            await this.git.removeRemote('origin');
            await this.git.addRemote('origin', remoteUrl);
          }
        } else {
          await this.git.addRemote('origin', remoteUrl);
        }

        // Ensure main branch exists
        const branches = await this.git.branchLocal();
        if (!branches.current || branches.current !== 'main') {
          await this.git.checkoutLocalBranch('main');
        }

        // Initial commit
        await this.git.add('.');
        await this.git.commit('DevTrack: Initial commit', ['--allow-empty']);
        await this.git.push(['-u', 'origin', 'main']);
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

  async commitAndPush(message: string): Promise<void> {
    return this.enqueueOperation(async () => {
      try {
        if (!this.git) {
          throw new Error('Git not initialized');
        }

        await this.git.add('.');
        await this.git.commit(message);
        await this.git.push();
        this.emit('commit', message);
      } catch (error: any) {
        this.outputChannel.appendLine(
          `DevTrack: Git commit failed - ${error.message}`
        );
        throw error;
      }
    });
  }
}
