/* eslint-disable no-unused-vars */
/* eslint-disable no-undef */
import * as vscode from 'vscode';
import simpleGit, { SimpleGit } from 'simple-git';
import * as path from 'path';
import { EventEmitter } from 'events';
import { OutputChannel } from 'vscode';
import { promisify } from 'util';
import { exec } from 'child_process';
import { execSync } from 'child_process';

const execAsync = promisify(exec);

export class GitService extends EventEmitter {
  private git!: SimpleGit;
  private repoPath!: string;
  private outputChannel: OutputChannel;
  private operationQueue: Promise<any> = Promise.resolve();
  private static MAX_RETRIES = 3;
  private static RETRY_DELAY = 1000;

  constructor(outputChannel: OutputChannel) {
    super();
    this.outputChannel = outputChannel;

    this.initializeWorkspace();
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      vscode.window.showErrorMessage(
        'DevTrack: No workspace folder is open. Please open a folder to start tracking.'
      );
      return;
    }

    const workspaceFolder = workspaceFolders[0].uri.fsPath;
    this.repoPath = workspaceFolder;

    if (!path.isAbsolute(this.repoPath)) {
      vscode.window.showErrorMessage(
        'DevTrack: The repository path is not absolute.'
      );
      return;
    }

    // Initialize Git with custom configuration
    try {
      const gitPath = this.findGitExecutable();
      this.git = simpleGit(this.repoPath, {
        binary: gitPath,
        maxConcurrentProcesses: 1,
        timeout: {
          block: 10000,
        },
      });

      this.initGitConfig().catch((error) => {
        this.outputChannel.appendLine(
          `DevTrack: Git config initialization error - ${error}`
        );
      });
    } catch (error) {
      // Log error but don't throw - allows extension to still function for auth
      this.outputChannel.appendLine(
        `DevTrack: Git initialization error - ${error}`
      );
    }
  }

  private initializeWorkspace(): void {
    try {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        this.outputChannel.appendLine('DevTrack: No workspace folder is open.');
        return;
      }

      const workspaceFolder = workspaceFolders[0].uri.fsPath;
      this.repoPath = workspaceFolder;

      if (!path.isAbsolute(this.repoPath)) {
        this.outputChannel.appendLine(
          'DevTrack: The repository path is not absolute.'
        );
        return;
      }

      // Initialize Git with modified configuration
      const gitPath = this.findGitExecutable();
      this.git = simpleGit(this.repoPath, {
        binary: gitPath,
        maxConcurrentProcesses: 1,
        timeout: {
          block: 10000,
        },
      });

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
    const platform = process.platform;
    let gitPath: string | null = null;

    try {
      if (platform === 'win32') {
        // Enhanced Windows Git path detection
        const programFiles = process.env.PROGRAMFILES || '';
        const localAppData = process.env.LOCALAPPDATA || '';

        const possiblePaths = [
          'C:\\Program Files\\Git\\cmd\\git.exe',
          'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
          path.join(programFiles, 'Git\\cmd\\git.exe'),
          path.join(localAppData, 'Programs\\Git\\cmd\\git.exe'),
        ];

        // Add PATH entries if they exist
        const pathEntries = process.env.PATH?.split(';') || [];
        const pathGitExecutables = pathEntries
          .map((entry) => path.join(entry, 'git.exe'))
          .filter(Boolean);

        // Combine all possible paths
        const allPaths = [...possiblePaths, ...pathGitExecutables];

        // Try each path
        for (const testPath of allPaths) {
          try {
            execSync(`"${testPath}" --version`, { stdio: 'ignore' });
            gitPath = testPath;
            break;
          } catch {
            continue;
          }
        }
      } else {
        // Unix-like systems
        try {
          gitPath = execSync('which git', { stdio: 'pipe' }).toString().trim();
        } catch {
          // Fallback to common Unix paths
          const unixPaths = ['/usr/bin/git', '/usr/local/bin/git'];
          for (const testPath of unixPaths) {
            try {
              execSync(`"${testPath}" --version`, { stdio: 'ignore' });
              gitPath = testPath;
              break;
            } catch {
              continue;
            }
          }
        }
      }

      if (!gitPath) {
        this.outputChannel.appendLine(
          'DevTrack: Git executable not found in common locations'
        );
        // Return 'git' as fallback - let simple-git handle it
        return 'git';
      }

      return gitPath;
    } catch (error) {
      this.outputChannel.appendLine(
        `DevTrack: Error finding Git executable - ${error}`
      );
      // Return 'git' as fallback - let simple-git handle it
      return 'git';
    }
  }

  private async initGitConfig() {
    if (!this.git) {
      return;
    }
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
        await this.verifyGit();
        const isRepo = await this.git.checkIsRepo();
        if (!(await this.verifyGit())) {
          this.outputChannel.appendLine(
            'DevTrack: Git is not properly installed or accessible'
          );
        }
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
