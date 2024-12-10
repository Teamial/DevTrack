// The module 'vscode' contains the VS Code extensibility API
import * as vscode from 'vscode';
import { GitHubService } from './services/githubService';
import { GitService } from './services/gitService';
import { Tracker } from './services/tracker';
import { SummaryGenerator } from './services/summaryGenerator';
import { Scheduler } from './services/scheduler';

// This method is called when your extension is activated
export async function activate(context: vscode.ExtensionContext) {
  console.log('DevTrack is now active!');

  // Initialize services
  const githubService = new GitHubService();
  const gitService = new GitService();
  const tracker = new Tracker();
  const summaryGenerator = new SummaryGenerator();

  // Retrieve configuration settings from 'devtrack'
  const config = vscode.workspace.getConfiguration('devtrack');
  const repoName = config.get<string>('repoName') || 'code-tracking';
  const commitFrequency = config.get<number>('commitFrequency') || 30;
  const excludePatterns = config.get<string[]>('exclude') || [];

  console.log(`DevTrack Configuration:
    Repository Name: ${repoName}
    Commit Frequency: ${commitFrequency} minutes
    Exclude Patterns: ${excludePatterns.join(', ') || 'None'}
  `);

  // Use secret storage for GitHub Token
  const secretStorage = context.secrets;
  let githubToken = await secretStorage.get('devtrack.githubToken');

  if (!githubToken) {
    // Prompt user for GitHub token if not set
    githubToken = await vscode.window.showInputBox({
      prompt: 'Enter your GitHub Personal Access Token for DevTrack',
      password: true
    });

    if (githubToken) {
      await secretStorage.store('devtrack.githubToken', githubToken);
      console.log('DevTrack: GitHub token stored securely.');
    } else {
      vscode.window.showErrorMessage('DevTrack: GitHub Personal Access Token is required.');
      return;
    }
  } else {
    console.log('DevTrack: Using previously stored GitHub token from secret storage.');
  }

  // Initialize GitHub service with token
  githubService.setToken(githubToken);

  // Retrieve GitHub username
  const username = await githubService.getUsername();
  if (!username) {
    vscode.window.showErrorMessage('DevTrack: Unable to retrieve GitHub username. Please ensure your token is valid.');
    return;
  }

  console.log(`Authenticated GitHub Username: ${username}`);

  // Check if repository exists, if not create it
  const repoExists = await githubService.repoExists(repoName);
  let remoteUrl = `https://github.com/${username}/${repoName}.git`;
  if (!repoExists) {
    const createdRepoUrl = await githubService.createRepo(repoName);
    if (createdRepoUrl) {
      remoteUrl = createdRepoUrl;
      console.log(`DevTrack: Created new repository at ${remoteUrl}`);
    } else {
      vscode.window.showErrorMessage('DevTrack: Failed to create GitHub repository.');
      return;
    }
  } else {
    console.log(`DevTrack: Repository "${repoName}" already exists.`);
  }

  // Initialize local Git repository
  try {
    await gitService.initializeRepo(remoteUrl);
  } catch (error) {
    console.error('DevTrack: Failed to initialize Git repository.');
    return;
  }

  // Initialize Scheduler
  const scheduler = new Scheduler(commitFrequency, tracker, summaryGenerator, gitService);
  scheduler.start();
  console.log('DevTrack: Scheduler started.');

  // Create Status Bar Item
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.text = '$(clock) DevTrack';
  statusBar.tooltip = 'DevTrack: Tracking your coding activity';
  statusBar.show();
  context.subscriptions.push(statusBar);

  // Update Status Bar on each commit
  gitService.on('commit', (message: string) => {
    const now = new Date();
    statusBar.text = `$(check) Last Commit: ${now.toLocaleTimeString()}`;
    console.log(`DevTrack: Last commit at ${now.toLocaleTimeString()} with message: "${message}"`);
  });

  // Register Start Tracking Command
  const startTracking = vscode.commands.registerCommand('devtrack.startTracking', () => {
    scheduler.start();
    vscode.window.showInformationMessage('DevTrack: Tracking started.');
    console.log('DevTrack: Tracking started manually.');
  });

  // Register Stop Tracking Command
  const stopTracking = vscode.commands.registerCommand('devtrack.stopTracking', () => {
    scheduler.stop();
    vscode.window.showInformationMessage('DevTrack: Tracking stopped.');
    console.log('DevTrack: Tracking stopped manually.');
  });

  context.subscriptions.push(startTracking);
  context.subscriptions.push(stopTracking);

  // Handle configuration changes
  vscode.workspace.onDidChangeConfiguration(async event => {
    if (event.affectsConfiguration('devtrack')) {
      // Reload configuration settings
      const newConfig = vscode.workspace.getConfiguration('devtrack');
      const newRepoName = newConfig.get<string>('repoName') || 'code-tracking';
      const newCommitFrequency = newConfig.get<number>('commitFrequency') || 30;
      const newExcludePatterns = newConfig.get<string[]>('exclude') || [];

      console.log('DevTrack: Configuration updated.');

      // Update GitHub token if re-entered
      const updatedGithubToken = await secretStorage.get('devtrack.githubToken');
      if (updatedGithubToken && updatedGithubToken !== githubToken) {
        githubService.setToken(updatedGithubToken);
        githubToken = updatedGithubToken;
        console.log('DevTrack: GitHub token updated via secret storage.');
      }

      // Update scheduler if commit frequency has changed
      if (newCommitFrequency !== commitFrequency) {
        scheduler.updateFrequency(newCommitFrequency);
        console.log(`DevTrack: Commit frequency updated to ${newCommitFrequency} minutes.`);
      }

      // Handle exclude patterns if necessary
      if (JSON.stringify(newExcludePatterns) !== JSON.stringify(excludePatterns)) {
        tracker.updateExcludePatterns(newExcludePatterns);
        console.log('DevTrack: Exclude patterns updated.');
      }

      // If repoName changed and you want to handle that scenario, add code here to re-init repo if needed
    }
  });
}

// This method is called when your extension is deactivated
export function deactivate() {}
