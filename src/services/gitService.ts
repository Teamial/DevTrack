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
    const workspaceFolder = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].uri.fsPath : '';
    this.repoPath = path.join(workspaceFolder, 'code-tracking');
    this.git = simpleGit(this.repoPath);
  }

  async initializeRepo(remoteUrl: string): Promise<void> {
    if (!fs.existsSync(this.repoPath)) {
      fs.mkdirSync(this.repoPath);
    }

    const isRepo = await this.git.checkIsRepo();
    if (!isRepo) {
      await this.git.init();
      await this.git.addRemote('origin', remoteUrl);
      await this.git.commit('Initial commit', ['--allow-empty']);
      await this.git.push(['-u', 'origin', 'main']);
    }
  }

  async addAndCommit(message: string): Promise<void> {
    try {
      await this.git.add('.');
      await this.git.commit(message);
      await this.git.push();
      this.emit('commit', message);
    } catch (error: any) {
      console.error("Git commit failed:", error.message);
      vscode.window.showErrorMessage(`DevTrackr: Git commit failed. ${error.message}`);
    }
  }
}
