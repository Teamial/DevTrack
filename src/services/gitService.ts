/* eslint-disable no-unused-vars */
/* eslint-disable no-undef */
import * as vscode from 'vscode';
import simpleGit, { SimpleGit } from 'simple-git';
import * as path from 'path';
import { EventEmitter } from 'events';
import { OutputChannel } from 'vscode';
import { promisify } from 'util';
import { exec } from 'child_process';
import { execSync, spawn } from 'child_process';

const execAsync = promisify(exec);

export class GitService extends EventEmitter {
  private git: SimpleGit;
  private repoPath: string;
  private outputChannel: OutputChannel;
  private operationQueue: Promise<any> = Promise.resolve();
  private static MAX_RETRIES = 3;
  private static RETRY_DELAY = 1000;

  constructor(outputChannel: OutputChannel) {
    super();
    this.outputChannel = outputChannel;

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      vscode.window.showErrorMessage(
        'DevTrack: No workspace folder is open. Please open a folder to start tracking.'
      );
      throw new Error('No workspace folder open.');
    }

    const workspaceFolder = workspaceFolders[0].uri.fsPath;
    this.repoPath = workspaceFolder;

    if (!path.isAbsolute(this.repoPath)) {
      vscode.window.showErrorMessage(
        'DevTrack: The repository path is not absolute.'
      );
      throw new Error('Invalid repository path.');
    }

    // Initialize Git with custom configuration
    this.git = simpleGit(this.repoPath, {
      binary: this.findGitExecutable(),
      maxConcurrentProcesses: 1,
      timeout: {
        block: 10000,
      },
    });

    // Configure Git to handle large repositories
    this.initGitConfig();
  }

  private findGitExecutable(): string {
    const platform = process.platform;
    let gitPath: string | null = null;

    try {
      if (platform === 'win32') {
        // Check common Windows Git installation paths
        const possiblePaths = [
          'C:\\Program Files\\Git\\cmd\\git.exe',
          'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
          process.env.PROGRAMFILES + '\\Git\\cmd\\git.exe',
          process.env.LOCALAPPDATA + '\\Programs\\Git\\cmd\\git.exe',
        ];

        for (const path of possiblePaths) {
          try {
            execSync(`"${path}" --version`);
            gitPath = path;
            break;
          } catch (e) {
            // Continue checking other paths
          }
        }
      } else {
        // On Unix-like systems, try to find git in PATH
        gitPath = execSync('which git').toString().trim();
      }

      if (!gitPath) {
        throw new Error('Git executable not found');
      }

      execSync(`"${gitPath}" --version`);
      this.outputChannel.appendLine(`DevTrack: Found Git at ${gitPath}`);
      return gitPath;
    } catch (error) {
      this.outputChannel.appendLine(
        `DevTrack: Error finding Git executable - ${error}`
      );
      throw new Error('Git is not properly installed or not in PATH');
    }
  }

  private async verifyGitAccess(): Promise<void> {
    return new Promise((resolve, reject) => {
      const gitProcess = spawn(this.findGitExecutable(), ['--version']);

      gitProcess.on('error', (error) => {
        this.outputChannel.appendLine(
          `DevTrack: Git access verification failed - ${error.message}`
        );
        reject(
          new Error(
            'Git is not accessible. Please ensure Git is installed and in your PATH.'
          )
        );
      });

      gitProcess.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(
            new Error(
              'Git verification failed. Please check your Git installation.'
            )
          );
        }
      });
    });
  }

  private async initGitConfig() {
    try {
      await this.git.addConfig('core.compression', '0');
      await this.git.addConfig('http.postBuffer', '524288000');
      await this.git.addConfig('http.maxRequestBuffer', '100M');
      await this.git.addConfig('core.longpaths', 'true');
      await this.git.addConfig('gc.auto', '0');
    } catch (error) {
      this.outputChannel.appendLine(
        `DevTrack: Error initializing Git config: ${error}`
      );
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

  private async cleanupGitLocks() {
    try {
      const gitDir = path.join(this.repoPath, '.git');
      const lockFiles = ['index.lock', 'HEAD.lock'];

      for (const lockFile of lockFiles) {
        const lockPath = path.join(gitDir, lockFile);
        await execAsync(`rm -f "${lockPath}"`);
      }
    } catch (error) {
      this.outputChannel.appendLine(
        `DevTrack: Error cleaning up Git locks: ${error}`
      );
    }
  }

  private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    this.operationQueue = this.operationQueue
      .then(() => this.withRetry(operation))
      .catch((error) => {
        this.outputChannel.appendLine(`DevTrack: Operation failed: ${error}`);
        throw error;
      });
    return this.operationQueue;
  }

  async initializeRepo(remoteUrl: string): Promise<void> {
    return this.enqueueOperation(async () => {
      try {
        await this.verifyGitAccess();
        const isRepo = await this.git.checkIsRepo();
        if (!isRepo) {
          await this.git.init();
          this.outputChannel.appendLine(
            'DevTrack: Initialized new Git repository.'
          );
        } else {
          this.outputChannel.appendLine(
            'DevTrack: Git repository already initialized.'
          );
        }

        // Fetch existing remotes
        const remotes = await this.git.getRemotes(true);
        const originRemote = remotes.find((remote) => remote.name === 'origin');

        if (originRemote) {
          if (originRemote.refs.fetch !== remoteUrl) {
            await this.git.removeRemote('origin');
            this.outputChannel.appendLine(
              'DevTrack: Removed existing remote origin.'
            );
            await this.git.addRemote('origin', remoteUrl);
            this.outputChannel.appendLine(
              `DevTrack: Added remote origin ${remoteUrl}.`
            );
          } else {
            this.outputChannel.appendLine(
              'DevTrack: Remote origin is already set correctly.'
            );
          }
        } else {
          await this.git.addRemote('origin', remoteUrl);
          this.outputChannel.appendLine(
            `DevTrack: Added remote origin ${remoteUrl}.`
          );
        }

        // Check if the default branch is 'main'; if not, create and switch to 'main'
        const branchSummary = await this.git.branchLocal();
        if (!branchSummary.current || branchSummary.current !== 'main') {
          await this.git.checkoutLocalBranch('main');
          this.outputChannel.appendLine(
            'DevTrack: Created and switched to branch "main".'
          );
        }

        // Stage all changes
        await this.git.add('.');
        this.outputChannel.appendLine('DevTrack: Staged all changes.');

        // Commit changes
        const commitMessage = 'DevTrack: Initial commit';
        const commitSummary = await this.git.commit(commitMessage, [
          '--allow-empty',
        ]);
        if (commitSummary.commit) {
          this.outputChannel.appendLine(
            `DevTrack: Made initial commit with message "${commitMessage}".`
          );
        }

        // Push to remote
        await this.git.push(['-u', 'origin', 'main']);
        this.outputChannel.appendLine(
          'DevTrack: Pushed initial commit to remote.'
        );
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
        'Git is not accessible. Please ensure Git is installed and in your PATH.';
    } else if (error.message?.includes('spawn git ENOENT')) {
      errorMessage =
        'Failed to spawn Git process. Please verify your Git installation.';
    } else if (error.message?.includes('not a git repository')) {
      errorMessage =
        'Not a Git repository. Please initialize the repository first.';
    }

    this.outputChannel.appendLine(
      `DevTrack: ${errorMessage} - ${error.message}`
    );
    vscode.window.showErrorMessage(`DevTrack: ${errorMessage}`);
  }

  async commitAndPush(message: string): Promise<void> {
    return this.enqueueOperation(async () => {
      try {
        await this.git.add('.');
        await this.git.commit(message);
        await this.git.push();
        this.emit('commit', message);
        this.outputChannel.appendLine(
          `DevTrack: Committed changes with message: "${message}"`
        );
      } catch (error: any) {
        this.outputChannel.appendLine(
          `DevTrack: Git commit failed. ${error.message}`
        );
        vscode.window.showErrorMessage(
          `DevTrack: Git commit failed. ${error.message}`
        );
        throw error;
      }
    });
  }
}
