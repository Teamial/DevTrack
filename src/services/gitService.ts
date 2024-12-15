/* eslint-disable no-unused-vars */
/* eslint-disable no-undef */
// src/services/gitService.ts
import simpleGit, { SimpleGit } from 'simple-git';
import * as vscode from 'vscode';
import * as path from 'path';
import { minimatch } from 'minimatch';
import { EventEmitter } from 'events';
import { OutputChannel } from 'vscode';

export class GitService extends EventEmitter {
  private git: SimpleGit;
  private repoPath: string;
  private outputChannel: OutputChannel;
  private trackingDirectory: string;
  private initialCommitTimestamp: number;

  constructor(outputChannel: OutputChannel) {
    super();
    this.outputChannel = outputChannel;
    const workspaceFolders = vscode.workspace.workspaceFolders;

    if (!workspaceFolders || workspaceFolders.length === 0) {
      throw new Error('No workspace folder open.');
    }

    const workspaceFolder = workspaceFolders[0].uri.fsPath;
    this.repoPath = workspaceFolder;
    this.trackingDirectory = path.join(this.repoPath, '.devtrack');
    this.initialCommitTimestamp = Date.now();

    if (!path.isAbsolute(this.repoPath)) {
      throw new Error('Invalid repository path.');
    }

    this.git = simpleGit(this.repoPath);
  }

  async initializeRepo(remoteUrl: string): Promise<void> {
    try {
      // Check if repo exists
      const isRepo = await this.git.checkIsRepo();

      if (!isRepo) {
        // Initialize new repository
        await this.git.init();
        this.outputChannel.appendLine(
          'DevTrack: Initialized new Git repository.'
        );
      } else {
        // Check if it's already a DevTrack repo
        const isDevTrackRepo = await this.isDevTrackRepo();
        if (isDevTrackRepo) {
          this.outputChannel.appendLine(
            'DevTrack: Repository already initialized.'
          );
          return;
        }
      }

      // Set up initial configuration
      await this.setupInitialConfig(remoteUrl);
    } catch (error: any) {
      this.outputChannel.appendLine(
        `DevTrack: Failed to initialize Git repository. ${error.message}`
      );
      throw error;
    }
  }

  private async isDevTrackRepo(): Promise<boolean> {
    try {
      const devtrackPath = path.join(this.repoPath, '.devtrack');
      await vscode.workspace.fs.stat(vscode.Uri.file(devtrackPath));
      return true;
    } catch {
      return false;
    }
  }
  private async configureRemote(remoteUrl: string): Promise<void> {
    try {
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
    } catch (error: any) {
      throw new Error(`Failed to configure remote: ${error.message}`);
    }
  }

  private async setupMainBranch(): Promise<void> {
    try {
      const branchSummary = await this.git.branchLocal();
      if (!branchSummary.current || branchSummary.current !== 'main') {
        await this.git.checkoutLocalBranch('main');
        this.outputChannel.appendLine(
          'DevTrack: Created and switched to branch "main".'
        );
      } else {
        this.outputChannel.appendLine('DevTrack: Already on main branch.');
      }
    } catch (error: any) {
      throw new Error(`Failed to setup main branch: ${error.message}`);
    }
  }

  private async setupInitialConfig(remoteUrl: string): Promise<void> {
    try {
      // Create .gitignore if it doesn't exist
      await this.setupGitignore();

      // Create DevTrack directory and config
      await this.setupDevTrackDirectory();

      // Configure remote
      await this.configureRemote(remoteUrl);

      // Set up main branch
      await this.setupMainBranch();

      // Create initial commit with only DevTrack files
      await this.createInitialCommit();

      // Push initial setup
      await this.git.push(['-u', 'origin', 'main']);

      this.outputChannel.appendLine(
        'DevTrack: Initial setup completed successfully.'
      );
    } catch (error: any) {
      throw new Error(
        `Failed to set up initial configuration: ${error.message}`
      );
    }
  }

  private async setupGitignore(): Promise<void> {
    const gitignorePath = path.join(this.repoPath, '.gitignore');
    const defaultIgnores = [
      'node_modules/',
      'dist/',
      '.DS_Store',
      'build/',
      'coverage/',
      '.env',
      '*.log',
      '.vscode/',
      'temp/',
      '*.tmp',
    ].join('\n');

    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(gitignorePath),
      Buffer.from(defaultIgnores, 'utf8')
    );
  }

  private async setupDevTrackDirectory(): Promise<void> {
    await vscode.workspace.fs.createDirectory(
      vscode.Uri.file(this.trackingDirectory)
    );

    const readmePath = path.join(this.trackingDirectory, 'README.md');
    const readmeContent = `# DevTrack Activity Log

This directory is managed by DevTrack to track your coding activity.
Only files modified after ${new Date(this.initialCommitTimestamp).toLocaleString()} will be tracked.

## Configuration
- Commit Frequency: ${vscode.workspace.getConfiguration('devtrack').get('commitFrequency')} minutes
- Excluded Patterns: ${JSON.stringify(vscode.workspace.getConfiguration('devtrack').get('exclude'))}
`;

    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(readmePath),
      Buffer.from(readmeContent, 'utf8')
    );
  }

  private async createInitialCommit(): Promise<void> {
    try {
      // Only stage DevTrack-specific files
      await this.git.add(['.gitignore', '.devtrack/README.md']);

      const commitMessage = 'DevTrack: Initialize repository tracking';
      await this.git.commit(commitMessage);

      this.outputChannel.appendLine(
        'DevTrack: Created initial configuration commit.'
      );
    } catch (error: any) {
      throw new Error(`Failed to create initial commit: ${error.message}`);
    }
  }

  async commitAndPush(message: string): Promise<void> {
    try {
      const trackedFiles = await this.getModifiedFiles();

      if (trackedFiles.length === 0) {
        this.outputChannel.appendLine(
          'DevTrack: No tracked changes to commit.'
        );
        return;
      }

      // Ensure we're on main branch
      await this.git.checkout('main');

      // Pull latest changes
      try {
        await this.git.pull('origin', 'main', { '--rebase': 'true' });
      } catch (pullError) {
        this.outputChannel.appendLine('DevTrack: No remote changes to pull.');
      }

      // Stage and commit only tracked files
      for (const file of trackedFiles) {
        await this.git.add(file);
      }

      await this.git.commit(message);
      await this.git.push('origin', 'main');

      this.emit('commit', message);
      this.outputChannel.appendLine(
        `DevTrack: Successfully committed and pushed: "${message}"`
      );
    } catch (error: any) {
      this.outputChannel.appendLine(
        `DevTrack: Git commit failed. ${error.message}`
      );
      vscode.window.showErrorMessage(
        `DevTrack: Git commit failed. ${error.message}`
      );
    }
  }

  private async getModifiedFiles(): Promise<string[]> {
    const status = await this.git.status();
    const config = vscode.workspace.getConfiguration('devtrack');
    const excludePatterns = config.get<string[]>('exclude') || [];

    return status.files
      .filter((file) => {
        // Only include files modified after initialization
        const filePath = path.join(this.repoPath, file.path);
        const stats = vscode.workspace.fs.stat(vscode.Uri.file(filePath));

        // Skip excluded patterns
        const isExcluded = excludePatterns.some((pattern) =>
          minimatch(file.path, pattern, { dot: true })
        );

        // Skip DevTrack's own files
        const isDevTrackFile =
          file.path.startsWith('.devtrack/') || file.path === '.gitignore';

        return !isExcluded && !isDevTrackFile && file.working_dir;
      })
      .map((file) => file.path);
  }
}
