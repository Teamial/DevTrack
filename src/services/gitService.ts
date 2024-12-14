/* eslint-disable no-unused-vars */
import simpleGit, { SimpleGit } from 'simple-git';
import * as vscode from 'vscode';
import * as path from 'path';
import { EventEmitter } from 'events';
import { OutputChannel } from 'vscode';

export class GitService extends EventEmitter {
  private git: SimpleGit;
  private repoPath: string;
  private outputChannel: OutputChannel;

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
    await this.git.add('.');
    this.outputChannel.appendLine('DevTrack: Staged all changes.');

    const commitMessage = 'DevTrack: Initial commit';
    const commitSummary = await this.git.commit(commitMessage, [
      '--allow-empty',
    ]);
    if (commitSummary.commit) {
      this.outputChannel.appendLine(
        `DevTrack: Made initial commit with message "${commitMessage}".`
      );
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
      await this.git.add('.');
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

  async commitAndPush(message: string): Promise<void> {
    try {
      await this.git.add('.');
      await this.git.commit(message);
      await this.git.pull('origin', 'main', { '--rebase': 'true' });
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
    }
  }
}
