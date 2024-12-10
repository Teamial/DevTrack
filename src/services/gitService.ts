import simpleGit, { SimpleGit } from 'simple-git';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { EventEmitter } from 'events';

export class GitService extends EventEmitter {
  private git: SimpleGit;
  private repoPath: string;

  constructor() {
    super();
    const workspaceFolders = vscode.workspace.workspaceFolders;
    
    if (!workspaceFolders || workspaceFolders.length === 0) {
      vscode.window.showErrorMessage('DevTrackr: No workspace folder is open. Please open a folder to start tracking.');
      throw new Error('No workspace folder open.');
    }

    const workspaceFolder = workspaceFolders[0].uri.fsPath;
    this.repoPath = path.join(workspaceFolder, 'code-tracking');

    // Ensure the repository path is absolute
    if (!path.isAbsolute(this.repoPath)) {
      vscode.window.showErrorMessage('DevTrackr: The repository path is not absolute.');
      throw new Error('Invalid repository path.');
    }

    // Ensure the directory exists before creating the git instance
    if (!fs.existsSync(this.repoPath)) {
      fs.mkdirSync(this.repoPath, { recursive: true });
      console.log(`DevTrackr: Created directory at ${this.repoPath}`);
    }

    this.git = simpleGit(this.repoPath);
  }

  async initializeRepo(remoteUrl: string): Promise<void> {
    try {
      const isRepo = await this.git.checkIsRepo();
      if (!isRepo) {
        await this.git.init();
        await this.git.addRemote('origin', remoteUrl);
        await this.git.commit('Initial commit', ['--allow-empty']);
        await this.git.push(['-u', 'origin', 'main']);
        console.log('DevTrackr: Initialized new Git repository and pushed to remote.');
      } else {
        console.log('DevTrackr: Git repository already initialized.');
      }
    } catch (error: any) {
      console.error('DevTrackr: Error initializing Git repository:', error.message);
      vscode.window.showErrorMessage(`DevTrackr: Failed to initialize Git repository. ${error.message}`);
      throw error;
    }
  }

  async addAndCommit(message: string): Promise<void> {
    try {
      await this.git.add('.');
      await this.git.commit(message);
      await this.git.push();
      this.emit('commit', message);
      console.log(`DevTrackr: Committed changes with message: "${message}"`);
    } catch (error: any) {
      console.error("DevTrackr: Git commit failed:", error.message);
      vscode.window.showErrorMessage(`DevTrackr: Git commit failed. ${error.message}`);
    }
  }
}
