/* eslint-disable no-unused-vars */
/* eslint-disable no-undef */
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
    this.trackingDirectory = path.join(this.repoPath, '.devtrack');

    if (!path.isAbsolute(this.repoPath)) {
      vscode.window.showErrorMessage(
        'DevTrack: The repository path is not absolute.'
      );
      throw new Error('Invalid repository path.');
    }

    this.git = simpleGit(this.repoPath);
  }

  async initializeRepo(remoteUrl: string): Promise<void> {
    try {
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

      await this.configureRemote(remoteUrl);
      await this.setupTrackingEnvironment();
      await this.synchronizeWithRemote();
      await this.setupMainBranch();
      await this.createInitialCommit();
      await this.pushChanges();
    } catch (error: any) {
      this.outputChannel.appendLine(
        `DevTrack: Failed to initialize Git repository. ${error.message}`
      );
      vscode.window.showErrorMessage(
        `DevTrack: Failed to initialize Git repository. ${error.message}`
      );
      throw error;
    }
  }

  private async setupTrackingEnvironment(): Promise<void> {
    try {
      // Create .gitignore
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

      // Create tracking directory and README
      await vscode.workspace.fs.createDirectory(
        vscode.Uri.file(this.trackingDirectory)
      );
      const readmePath = path.join(this.trackingDirectory, 'README.md');
      const readmeContent = `# DevTrack Activity Log

This repository is managed by DevTrack to track your coding activity.

## Structure
- Daily activity logs are stored in dated directories
- Changes are automatically committed every 30 minutes
- Configuration can be modified through VS Code settings

## Excluded Patterns
The following patterns are excluded by default:
${defaultIgnores
  .split('\n')
  .map((pattern) => `- ${pattern}`)
  .join('\n')}
`;

      await vscode.workspace.fs.writeFile(
        vscode.Uri.file(readmePath),
        Buffer.from(readmeContent, 'utf8')
      );

      this.outputChannel.appendLine('DevTrack: Set up tracking environment.');
    } catch (error: any) {
      throw new Error(
        `Failed to set up tracking environment: ${error.message}`
      );
    }
  }

  private async configureRemote(remoteUrl: string): Promise<void> {
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
  }

  private async synchronizeWithRemote(): Promise<void> {
    try {
      await this.git.fetch('origin');
      try {
        await this.git.pull('origin', 'main', { '--rebase': 'true' });
        this.outputChannel.appendLine(
          'DevTrack: Synchronized with remote repository.'
        );
      } catch (pullError) {
        this.outputChannel.appendLine(
          'DevTrack: No existing remote content to synchronize.'
        );
      }
    } catch (fetchError) {
      this.outputChannel.appendLine('DevTrack: Unable to fetch from remote.');
    }
  }

  private async setupMainBranch(): Promise<void> {
    const branchSummary = await this.git.branchLocal();
    if (!branchSummary.current || branchSummary.current !== 'main') {
      await this.git.checkoutLocalBranch('main');
      this.outputChannel.appendLine(
        'DevTrack: Created and switched to branch "main".'
      );
    }
  }

  private async createInitialCommit(): Promise<void> {
    try {
      // Only stage DevTrack-specific files
      await this.git.add(['.gitignore', '.devtrack/']);

      const commitMessage = 'DevTrack: Initialize activity tracking';
      const commitSummary = await this.git.commit(commitMessage, [
        '--allow-empty',
      ]);

      if (commitSummary.commit) {
        this.outputChannel.appendLine(
          `DevTrack: Made initial commit with message "${commitMessage}".`
        );
      }
    } catch (error: any) {
      throw new Error(`Failed to create initial commit: ${error.message}`);
    }
  }

  private async pushChanges(): Promise<void> {
    try {
      await this.git.push(['--force-with-lease', 'origin', 'main']);
      this.outputChannel.appendLine('DevTrack: Pushed changes to remote.');
    } catch (pushError: any) {
      if (pushError.message.includes('rejected')) {
        await this.handlePushRejection();
      } else {
        throw pushError;
      }
    }
  }

  private async handlePushRejection(): Promise<void> {
    try {
      await this.git.fetch('origin');
      await this.git.reset(['--soft', 'origin/main']);
      await this.git.add(['.gitignore', '.devtrack/']);
      await this.git.commit('DevTrack: Synchronize with remote', [
        '--allow-empty',
      ]);
      await this.git.push(['origin', 'main']);
      this.outputChannel.appendLine(
        'DevTrack: Successfully synchronized with remote repository.'
      );
    } catch (error: any) {
      throw new Error(`Failed to synchronize with remote: ${error.message}`);
    }
  }

  private async getTrackedFiles(): Promise<string[]> {
    const status = await this.git.status();
    const config = vscode.workspace.getConfiguration('devtrack');
    const excludePatterns = config.get<string[]>('exclude') || [];

    // Add common system files to exclude patterns
    const systemExcludes = [
      '.DS_Store',
      'Thumbs.db',
      'desktop.ini',
      '*.swp',
      '.Spotlight-V100',
      '.Trashes',
    ];

    const allExcludes = [...excludePatterns, ...systemExcludes];

    return status.files
      .map((file) => file.path)
      .filter((file) => {
        const isDevTrackFile =
          file.startsWith('.devtrack/') || file === '.gitignore';
        const isExcluded = allExcludes.some((pattern) =>
          minimatch(file, pattern, { dot: true })
        );
        return isDevTrackFile || !isExcluded;
      });
  }
  catch(error: any) {
    this.outputChannel.appendLine(
      `DevTrack: Error getting tracked files: ${error.message}`
    );
    return [];
  }

  async commitAndPush(message: string): Promise<void> {
    try {
      const trackedFiles = await this.getTrackedFiles();

      if (trackedFiles.length === 0) {
        this.outputChannel.appendLine(
          'DevTrack: No tracked changes to commit.'
        );
        return;
      }

      // First, stash any existing changes
      await this.git.stash([
        'push',
        '-u',
        '-m',
        'DevTrack: Temporary stash before pull',
      ]);
      this.outputChannel.appendLine('DevTrack: Stashed current changes.');

      try {
        // Pull latest changes
        await this.git.pull('origin', 'main', { '--rebase': 'true' });
        this.outputChannel.appendLine(
          'DevTrack: Pulled latest changes from remote.'
        );

        // Pop the stash
        await this.git.stash(['pop']);
        this.outputChannel.appendLine('DevTrack: Restored stashed changes.');

        // Stage and commit the files
        await this.git.add(trackedFiles);
        await this.git.commit(message);

        // Push the changes
        await this.git.push();

        this.emit('commit', message);
        this.outputChannel.appendLine(
          `DevTrack: Successfully committed and pushed changes with message: "${message}"`
        );
      } catch (error: any) {
        // If anything fails, ensure we restore the stashed changes
        try {
          await this.git.stash(['pop']);
          this.outputChannel.appendLine(
            'DevTrack: Restored stashed changes after error.'
          );
        } catch (stashError) {
          this.outputChannel.appendLine(
            'DevTrack: Failed to restore stashed changes. Please check git stash list.'
          );
        }
        throw error;
      }
    } catch (error: any) {
      this.outputChannel.appendLine(
        `DevTrack: Git commit failed. ${error.message}`
      );
      vscode.window.showErrorMessage(
        `DevTrack: Git commit failed. ${error.message}`
      );
    }
  }
}
