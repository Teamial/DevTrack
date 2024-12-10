import { Octokit } from "@octokit/rest";
import * as vscode from "vscode";

export class GitHubService {
  private octokit!: Octokit;
  private token: string = '';

  constructor() {
    // Token will be set via setToken method
  }

  setToken(token: string) {
    this.token = vscode.workspace.getConfiguration('devtrackr').get<string>('githubToken') || '';
    this.octokit = new Octokit({ auth: this.token });
  }

  async createRepo(repoName: string, description: string = "DevTrackr Repository"): Promise<string | null> {
    try {
      const response = await this.octokit.repos.createForAuthenticatedUser({
        name: repoName,
        description,
        private: false,
      });
      return response.data.clone_url;
    } catch (error: any) {
      console.error("Error creating repository:", error.message);
      vscode.window.showErrorMessage(`DevTrackr: Failed to create repository "${repoName}".`);
      return null;
    }
  }

  async repoExists(repoName: string): Promise<boolean> {
    try {
      await this.octokit.repos.createForAuthenticatedUser({
        repo: repoName,
        name: ""
      });
      return true;
    } catch (error: any) {
      if (error.status === 404) {
        return false;
      }
      console.error("Error checking repository existence:", error.message);
      vscode.window.showErrorMessage(`DevTrackr: Error checking repository "${repoName}".`);
      return false;
    }
  }
  async getUsername(): Promise<string | null> {
    try {
      const { data } = await this.octokit.users.getAuthenticated();
      return data.login;
    } catch (error: any) {
      console.error("Error fetching username:", error.message);
      vscode.window.showErrorMessage('DevTrackr: Unable to fetch GitHub username.');
      return null;
    }
  }
}
