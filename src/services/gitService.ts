// services/gitService.ts
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
      vscode.window.showErrorMessage('DevTrack: No workspace folder is open. Please open a folder to start tracking.');
      throw new Error('No workspace folder open.');
    }

    const workspaceFolder = workspaceFolders[0].uri.fsPath;
    this.repoPath = workspaceFolder; // Initialize at workspace root

    // Ensure the repository path is absolute
    if (!path.isAbsolute(this.repoPath)) {
      vscode.window.showErrorMessage('DevTrack: The repository path is not absolute.');
      throw new Error('Invalid repository path.');
    }

    // Initialize Git instance at workspace root
    this.git = simpleGit(this.repoPath);
  }

  async initializeRepo(remoteUrl: string): Promise<void> {
    try {
      const isRepo = await this.git.checkIsRepo();
      if (!isRepo) {
        await this.git.init();
        this.outputChannel.appendLine('DevTrack: Initialized new Git repository.');
        await this.git.addRemote('origin', remoteUrl);
        this.outputChannel.appendLine(`DevTrack: Added remote origin ${remoteUrl}.`);
        await this.git.add('.');
        await this.git.commit('DevTrack: Initial commit', ['--allow-empty']);
        this.outputChannel.appendLine('DevTrack: Made initial commit.');
        await this.git.push(['-u', 'origin', 'main']);
        this.outputChannel.appendLine('DevTrack: Pushed initial commit to remote.');
      } else {
        this.outputChannel.appendLine('DevTrack: Git repository already initialized.');
      }
    } catch (error: any) {
      this.outputChannel.appendLine(`DevTrack: Failed to initialize Git repository. ${error.message}`);
      vscode.window.showErrorMessage(`DevTrack: Failed to initialize Git repository. ${error.message}`);
      throw error;
    }
  }

  /**
   * Commits and pushes changes with the provided message.
   * @param message Commit message.
   */
  async commitAndPush(message: string): Promise<void> {
    try {
      await this.git.add('.');
      await this.git.commit(message);
      await this.git.push();
      this.emit('commit', message);
      this.outputChannel.appendLine(`DevTrack: Committed changes with message: "${message}"`);
    } catch (error: any) {
      this.outputChannel.appendLine(`DevTrack: Git commit failed. ${error.message}`);
      vscode.window.showErrorMessage(`DevTrack: Git commit failed. ${error.message}`);
    }
  }
}
