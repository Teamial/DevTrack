// The module 'vscode' contains the VS Code extensibility API
import * as vscode from 'vscode';
import { GitHubService } from './services/githubService';
import { GitService } from './services/gitService';
import { Tracker } from './services/tracker';
import { SummaryGenerator } from './services/summaryGenerator';
import { Scheduler } from './services/scheduler';

// This method is called when your extension is activated
export async function activate(context: vscode.ExtensionContext) {
  console.log('DevTrackr is now active!');

  // Initialize services
  const githubService = new GitHubService();
  const gitService = new GitService();
  const tracker = new Tracker();
  const summaryGenerator = new SummaryGenerator();
  
  // Retrieve configuration settings
  const config = vscode.workspace.getConfiguration('devtrackr');
  const repoName = config.get<string>('repoName') || 'code-tracking';
  const commitFrequency = config.get<number>('commitFrequency') || 30;
  const githubToken = config.get<string>('githubToken') || '';
  const excludePatterns = config.get<string[]>('exclude') || [];

  // Ensure GitHub token is provided
  if (!githubToken) {
    vscode.window.showErrorMessage('DevTrackr: GitHub Personal Access Token is not set. Please configure it in settings.');
    return;
  }

  // Initialize GitHub service with token
  githubService.setToken(githubToken);

  // Retrieve GitHub username
  const username = await githubService.getUsername();
  if (!username) {
    vscode.window.showErrorMessage('DevTrackr: Unable to retrieve GitHub username.');
    return;
  }

  // Check if repository exists, if not create it
  const repoExists = await githubService.repoExists(repoName);
  let remoteUrl = `https://github.com/${username}/${repoName}.git`;
  if (!repoExists) {
    const createdRepoUrl = await githubService.createRepo(repoName);
    if (createdRepoUrl) {
      remoteUrl = createdRepoUrl;
    } else {
      vscode.window.showErrorMessage('DevTrackr: Failed to create GitHub repository.');
      return;
    }
  }

  // Initialize local Git repository
  await gitService.initializeRepo(remoteUrl);

  // Initialize Scheduler
  const scheduler = new Scheduler(commitFrequency, tracker, summaryGenerator, gitService);
  scheduler.start();

  // Create Status Bar Item
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.text = '$(clock) DevTrackr';
  statusBar.tooltip = 'DevTrackr: Tracking your coding activity';
  statusBar.show();
  context.subscriptions.push(statusBar);

  // Update Status Bar on each commit
  gitService.on('commit', (message: string) => {
    const now = new Date();
    statusBar.text = `$(check) Last Commit: ${now.toLocaleTimeString()}`;
  });

  // Register Start Tracking Command
  const startTracking = vscode.commands.registerCommand('devtrackr.startTracking', () => {
    scheduler.start();
    vscode.window.showInformationMessage('DevTrackr: Tracking started.');
  });

  // Register Stop Tracking Command
  const stopTracking = vscode.commands.registerCommand('devtrackr.stopTracking', () => {
    scheduler.stop();
    vscode.window.showInformationMessage('DevTrackr: Tracking stopped.');
  });

  context.subscriptions.push(startTracking);
  context.subscriptions.push(stopTracking);

  // Optionally, handle configuration changes
  vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('devtrackr')) {
      // Reload configuration settings
      const newConfig = vscode.workspace.getConfiguration('devtrackr');
      const newRepoName = newConfig.get<string>('repoName') || 'code-tracking';
      const newCommitFrequency = newConfig.get<number>('commitFrequency') || 30;
      const newExcludePatterns = newConfig.get<string[]>('exclude') || [];
      const newGithubToken = newConfig.get<string>('githubToken') || '';

      // Update GitHub token if it has changed
      if (newGithubToken && newGithubToken !== githubToken) {
        githubService.setToken(newGithubToken);
      }

      // Update scheduler if commit frequency has changed
      scheduler.updateFrequency(newCommitFrequency);
    }
  });
}

// This method is called when your extension is deactivated
export function deactivate() {}
