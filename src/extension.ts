import * as vscode from 'vscode';
import { GitHubService } from './services/githubService';
import { GitService } from './services/gitService';
import { Tracker } from './services/tracker';
import { SummaryGenerator } from './services/summaryGenerator';
import { Scheduler } from './services/scheduler';

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

  // Use VS Code's Authentication API for GitHub
  const auth = vscode.authentication;
  let session: vscode.AuthenticationSession | undefined;

  try {
    // Check for existing sessions
    let session = await auth.getSession('github', ['repo', 'read:user'], { createIfNone: true });
    // session is already an AuthenticationSession object

    if (!session) {
      // Prompt user to login
      session = await auth.getSession('github', ['repo', 'read:user'], { createIfNone: true });
    }

    if (!session) {
      vscode.window.showErrorMessage('DevTrack: GitHub authentication is required.');
      return;
    }

    console.log('DevTrack: GitHub authentication successful.');

    // Initialize GitHub service with the session token
    githubService.setToken(session.accessToken);

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
        const updatedSession = await auth.getSession('github', ['repo', 'read:user'], { silent: true });
        if (updatedSession && updatedSession.accessToken !== session?.accessToken) {
          session = updatedSession;
          githubService.setToken(session.accessToken);
          console.log('DevTrack: GitHub token updated via authentication.');
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

        // Optionally check if repoName changed and handle it if needed (e.g., re-init repository)
      }
    });
  } catch (error) {
    console.error('DevTrack: GitHub authentication failed:', error);
    vscode.window.showErrorMessage('DevTrack: GitHub authentication failed.');
  }

  // Create Status Bar Item for Login (Optional)
  // This allows users to re-authenticate if needed
  const loginStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
  loginStatusBar.text = '$(mark-github) Login';
  loginStatusBar.tooltip = 'DevTrack: Login to GitHub';
  loginStatusBar.command = 'devtrack.login';
  loginStatusBar.show();
  context.subscriptions.push(loginStatusBar);

  // Register Login Command
  const loginCommand = vscode.commands.registerCommand('devtrack.login', async () => {
    try {
      session = await auth.getSession('github', ['repo', 'read:user'], { createIfNone: true });
      if (session) {
        githubService.setToken(session.accessToken);
        const username = await githubService.getUsername();
        if (username) {
          vscode.window.showInformationMessage(`DevTrack: Logged in as ${username}`);
          loginStatusBar.hide();
          // Optionally re-initialize repository or perform other actions
        } else {
          vscode.window.showErrorMessage('DevTrack: Unable to retrieve GitHub username.');
        }
      }
    } catch (error) {
      console.error('DevTrack: GitHub login failed:', error);
      vscode.window.showErrorMessage('DevTrack: GitHub login failed.');
    }
  });

  context.subscriptions.push(loginCommand);
}

export function deactivate() {}
