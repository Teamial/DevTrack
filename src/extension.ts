// extension.ts
import * as vscode from 'vscode';
import { GitHubService } from './services/githubService';
import { GitService } from './services/gitService';
import { Tracker } from './services/tracker';
import { SummaryGenerator } from './services/summaryGenerator';
import { Scheduler } from './services/scheduler';

/**
 * This method is called when your extension is activated.
 */
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

  // **Initialize Status Bar Items**

  // 1. **Tracking Status Bar Item**
  const trackingStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  trackingStatusBar.text = '$(clock) DevTrack';
  trackingStatusBar.tooltip = 'DevTrack: Tracking your coding activity';
  trackingStatusBar.show();
  context.subscriptions.push(trackingStatusBar);

  // 2. **Authentication Status Bar Item**
  const authStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
  authStatusBar.tooltip = 'DevTrack: Authenticate with GitHub';
  authStatusBar.command = 'devtrack.login'; // Clicking this will trigger the login command
  authStatusBar.show();
  context.subscriptions.push(authStatusBar);

  try {
    // Check for existing sessions silently
    session = await auth.getSession('github', [], { createIfNone: false });

    if (session) {
      console.log('DevTrack: Using existing GitHub session.');
      authStatusBar.text = '$(check) DevTrack: Authenticated';
      authStatusBar.tooltip = 'DevTrack: GitHub authenticated';
    } else {
      // User is not authenticated
      authStatusBar.text = '$(mark-github) DevTrack: Login';
      authStatusBar.tooltip = 'DevTrack: Click to authenticate with GitHub';
    }

    if (session) {
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

      // **Update Tracking Status Bar on Commit**
      gitService.on('commit', (message: string) => {
        const now = new Date();
        trackingStatusBar.text = `$(check) Last Commit: ${now.toLocaleTimeString()}`;
        console.log(`DevTrack: Last commit at ${now.toLocaleTimeString()} with message: "${message}"`);
      });
    }

    // **Register Commands**

    // Initialize Scheduler
    const scheduler = new Scheduler(commitFrequency, tracker, summaryGenerator, gitService);
    scheduler.start();
    console.log('DevTrack: Scheduler started.');

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

    // Register Login Command
    const loginCommand = vscode.commands.registerCommand('devtrack.login', async () => {
      try {
        // Authenticate with GitHub (prompt user)
        session = await auth.getSession('github', ['repo', 'read:user'], { createIfNone: true });

        if (session) {
          githubService.setToken(session.accessToken);
          const newUsername = await githubService.getUsername();
          if (newUsername) {
            vscode.window.showInformationMessage(`DevTrack: Logged in as ${newUsername}`);
            console.log(`DevTrack: Logged in as ${newUsername}`);
            authStatusBar.text = '$(check) DevTrack: Authenticated';
            authStatusBar.tooltip = 'DevTrack: GitHub authenticated';
          } else {
            vscode.window.showErrorMessage('DevTrack: Unable to retrieve GitHub username.');
          }
        } else {
          vscode.window.showErrorMessage('DevTrack: GitHub authentication failed.');
        }
      } catch (error) {
        console.error('DevTrack: GitHub login failed:', error);
        vscode.window.showErrorMessage('DevTrack: GitHub login failed.');
      }
    });

    context.subscriptions.push(startTracking);
    context.subscriptions.push(stopTracking);
    context.subscriptions.push(loginCommand);

    // **Handle Configuration Changes**
    vscode.workspace.onDidChangeConfiguration(async event => {
      if (event.affectsConfiguration('devtrack')) {
        // Reload configuration settings
        const newConfig = vscode.workspace.getConfiguration('devtrack');
        const newRepoName = newConfig.get<string>('repoName') || 'code-tracking';
        const newCommitFrequency = newConfig.get<number>('commitFrequency') || 30;
        const newExcludePatterns = newConfig.get<string[]>('exclude') || [];

        console.log('DevTrack: Configuration updated.');

        // Update GitHub token if re-authenticated
        if (session) {
          githubService.setToken(session.accessToken);
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
}

/**
 * This method is called when your extension is deactivated.
 */
export function deactivate() {}
