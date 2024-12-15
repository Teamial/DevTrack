import * as vscode from 'vscode';
import { GitHubService } from './services/githubService';
import { GitService } from './services/gitService';
import { Tracker } from './services/tracker';
import { SummaryGenerator } from './services/summaryGenerator';
import { Scheduler } from './services/scheduler';

function showWelcomeInfo() {
  const message =
    'Welcome to DevTrack! Would you like to set up automatic code tracking?';
  const welcomeMessage = `
To get started with DevTrack, you'll need:
1. A GitHub account
2. An open workspace/folder
3. Git installed on your system

DevTrack will:
- Create a private GitHub repository to store your coding activity
- Automatically track and commit your changes
- Generate detailed summaries of your work
    `;

  vscode.window
    .showInformationMessage(message, 'Get Started', 'Learn More', 'Later')
    .then((selection) => {
      if (selection === 'Get Started') {
        vscode.commands.executeCommand('devtrack.login');
      } else if (selection === 'Learn More') {
        vscode.window
          .showInformationMessage(welcomeMessage, 'Set Up Now', 'Later')
          .then((choice) => {
            if (choice === 'Set Up Now') {
              vscode.commands.executeCommand('devtrack.login');
            }
          });
      }
    });
}

/**
 * This method is called when the extension is activated.
 */
export async function activate(context: vscode.ExtensionContext) {
  // Create Output Channel
  const outputChannel = vscode.window.createOutputChannel('DevTrack');
  context.subscriptions.push(outputChannel);
  outputChannel.appendLine('DevTrack: Extension activated.');

  // Initialize services with OutputChannel for logging
  const githubService = new GitHubService(outputChannel);
  const gitService = new GitService(outputChannel);
  const tracker = new Tracker(outputChannel);
  const summaryGenerator = new SummaryGenerator(outputChannel, context);

  // Retrieve configuration settings from 'devtrack'
  const config = vscode.workspace.getConfiguration('devtrack');
  const repoName = config.get<string>('repoName') || 'code-tracking';
  const commitFrequency = config.get<number>('commitFrequency') || 30; // Default to 30 minutes
  const excludePatterns = config.get<string[]>('exclude') || [];
  const confirmBeforeCommit =
    config.get<boolean>('confirmBeforeCommit') || true;

  outputChannel.appendLine(`DevTrack Configuration:
        Repository Name: ${repoName}
        Commit Frequency: ${commitFrequency} minutes
        Exclude Patterns: ${excludePatterns.join(', ') || 'None'}
        Confirm Before Commit: ${confirmBeforeCommit}
    `);

  // Check repository name
  if (!repoName || repoName.trim() === '') {
    vscode.window.showErrorMessage(
      'DevTrack: Repository name is not set correctly in the configuration.'
    );
    outputChannel.appendLine(
      'DevTrack: Repository name is missing or invalid.'
    );
    return;
  }
  outputChannel.appendLine(`DevTrack: Using repository name "${repoName}".`);

  // Use VS Code's Authentication API for GitHub
  const auth = vscode.authentication;
  let session: vscode.AuthenticationSession | undefined;

  // Initialize Status Bar Items
  const trackingStatusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  trackingStatusBar.text = '$(circle-slash) DevTrack: Stopped';
  trackingStatusBar.tooltip = 'DevTrack: Tracking is stopped';
  trackingStatusBar.show();
  context.subscriptions.push(trackingStatusBar);

  const authStatusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    101
  );
  authStatusBar.text = '$(mark-github) DevTrack: Not Connected';
  authStatusBar.tooltip = 'DevTrack Status';
  authStatusBar.show();
  context.subscriptions.push(authStatusBar);

  // Declare scheduler outside to make it accessible in commands
  let scheduler: Scheduler | null = null;

  // Handle Logout Function
  async function handleLogout() {
    const confirm = await vscode.window.showWarningMessage(
      'Are you sure you want to logout from DevTrack?',
      { modal: true },
      'Yes',
      'No'
    );

    if (confirm !== 'Yes') {
      outputChannel.appendLine('DevTrack: Logout canceled by user.');
      return;
    }

    githubService.setToken('');
    authStatusBar.text = '$(mark-github) DevTrack: Not Connected';
    authStatusBar.tooltip = 'DevTrack Status';
    trackingStatusBar.text = '$(circle-slash) DevTrack: Stopped';
    trackingStatusBar.tooltip = 'DevTrack: Tracking is stopped';

    if (scheduler) {
      scheduler.stop();
      scheduler = null;
      outputChannel.appendLine('DevTrack: Scheduler stopped due to logout.');
    }

    const loginChoice = await vscode.window.showInformationMessage(
      'DevTrack: Successfully logged out. Would you like to log in with a different account?',
      'Yes',
      'No'
    );

    if (loginChoice === 'Yes') {
      vscode.commands.executeCommand('devtrack.login');
    }

    outputChannel.appendLine('DevTrack: User logged out.');
  }

  // Initialize DevTrack Function
  async function initializeDevTrack() {
    try {
      outputChannel.appendLine('DevTrack: Starting initialization...');

      // Ensure GitHub authentication
      const session = await auth.getSession('github', ['repo', 'read:user'], {
        createIfNone: true,
      });

      if (!session) {
        throw new Error('GitHub authentication is required to use DevTrack.');
      }

      // Initialize GitHub service
      githubService.setToken(session.accessToken);
      const username = await githubService.getUsername();

      if (!username) {
        throw new Error(
          'Unable to retrieve GitHub username. Please ensure your token is valid.'
        );
      }

      // Check/create repository
      const repoExists = await githubService.repoExists(repoName);
      const remoteUrl = `https://github.com/${username}/${repoName}.git`;

      if (!repoExists) {
        const createdRepoUrl = await githubService.createRepo(repoName);
        if (!createdRepoUrl) {
          throw new Error('Failed to create GitHub repository.');
        }
        outputChannel.appendLine(
          `DevTrack: Created new repository at ${remoteUrl}`
        );
      }

      // Initialize Git repository
      await gitService.initializeRepo(remoteUrl);

      // Initialize scheduler
      scheduler = new Scheduler(
        commitFrequency,
        tracker,
        summaryGenerator,
        gitService,
        outputChannel
      );
      scheduler.start();

      // Update status bars
      authStatusBar.text = '$(check) DevTrack: Connected';
      authStatusBar.tooltip = 'DevTrack is connected to GitHub';
      trackingStatusBar.text = '$(clock) DevTrack: Tracking';
      trackingStatusBar.tooltip =
        'DevTrack: Tracking your coding activity is active';

      outputChannel.appendLine(
        'DevTrack: Initialization completed successfully.'
      );
      vscode.window.showInformationMessage(
        'DevTrack has been set up successfully and tracking has started.'
      );
    } catch (error: any) {
      outputChannel.appendLine(
        `DevTrack: Initialization failed - ${error.message}`
      );
      throw error;
    }
  }

  // Register Commands
  const startTracking = vscode.commands.registerCommand(
    'devtrack.startTracking',
    async () => {
      try {
        if (!vscode.workspace.workspaceFolders?.length) {
          throw new Error(
            'Please open a folder or workspace before starting tracking.'
          );
        }

        const session = await auth.getSession('github', ['repo', 'read:user'], {
          createIfNone: false,
        });

        if (!session) {
          const response = await vscode.window.showErrorMessage(
            'DevTrack requires GitHub authentication to start tracking. Would you like to sign in now?',
            'Sign in to GitHub',
            'Cancel'
          );

          if (response === 'Sign in to GitHub') {
            await vscode.commands.executeCommand('devtrack.login');
          }
          return;
        }

        if (scheduler) {
          scheduler.start();
          trackingStatusBar.text = '$(clock) DevTrack: Tracking';
          trackingStatusBar.tooltip =
            'DevTrack: Tracking your coding activity is active';
          vscode.window.showInformationMessage('DevTrack: Tracking started.');
          outputChannel.appendLine('DevTrack: Tracking started manually.');
        } else {
          const response = await vscode.window.showErrorMessage(
            'DevTrack needs to be set up before starting. Would you like to set it up now?',
            'Set Up DevTrack',
            'Cancel'
          );

          if (response === 'Set Up DevTrack') {
            await initializeDevTrack();
          }
        }
      } catch (error: any) {
        outputChannel.appendLine(
          `DevTrack: Error starting tracking - ${error.message}`
        );
        vscode.window.showErrorMessage(`DevTrack: ${error.message}`);
      }
    }
  );

  const stopTracking = vscode.commands.registerCommand(
    'devtrack.stopTracking',
    () => {
      if (scheduler) {
        scheduler.stop();
        trackingStatusBar.text = '$(circle-slash) DevTrack: Stopped';
        trackingStatusBar.tooltip = 'DevTrack: Tracking is stopped';
        vscode.window.showInformationMessage('DevTrack: Tracking stopped.');
        outputChannel.appendLine('DevTrack: Tracking stopped manually.');
      } else {
        vscode.window.showErrorMessage(
          'DevTrack: Please connect to GitHub first.'
        );
        outputChannel.appendLine('DevTrack: Scheduler is not initialized.');
      }
    }
  );

  const loginCommand = vscode.commands.registerCommand(
    'devtrack.login',
    async () => {
      try {
        githubService.setToken('');
        session = await auth.getSession('github', ['repo', 'read:user'], {
          forceNewSession: true,
        });

        if (session) {
          await initializeDevTrack();
        } else {
          outputChannel.appendLine('DevTrack: GitHub connection canceled.');
        }
      } catch (error: any) {
        outputChannel.appendLine(
          `DevTrack: GitHub connection failed. ${error}`
        );
        vscode.window.showErrorMessage('DevTrack: GitHub connection failed.');
      }
    }
  );

  const logoutCommand = vscode.commands.registerCommand(
    'devtrack.logout',
    handleLogout
  );

  // Add commands to subscriptions
  context.subscriptions.push(
    startTracking,
    stopTracking,
    loginCommand,
    logoutCommand
  );

  // Show welcome message for first-time users
  if (!context.globalState.get('devtrackWelcomeShown')) {
    showWelcomeInfo();
    context.globalState.update('devtrackWelcomeShown', true);
  }

  // Handle Configuration Changes
  vscode.workspace.onDidChangeConfiguration(async (event) => {
    if (event.affectsConfiguration('devtrack')) {
      const newConfig = vscode.workspace.getConfiguration('devtrack');
      const newRepoName = newConfig.get<string>('repoName') || 'code-tracking';
      const newCommitFrequency = newConfig.get<number>('commitFrequency') || 30;
      const newExcludePatterns = newConfig.get<string[]>('exclude') || [];

      outputChannel.appendLine('DevTrack: Configuration updated.');

      if (scheduler && newCommitFrequency !== commitFrequency) {
        scheduler.updateFrequency(newCommitFrequency);
        outputChannel.appendLine(
          `DevTrack: Commit frequency updated to ${newCommitFrequency} minutes.`
        );
      }

      if (
        tracker &&
        JSON.stringify(newExcludePatterns) !== JSON.stringify(excludePatterns)
      ) {
        tracker.updateExcludePatterns(newExcludePatterns);
        outputChannel.appendLine('DevTrack: Exclude patterns updated.');
      }

      if (newRepoName !== repoName) {
        vscode.window.showWarningMessage(
          'DevTrack: Repository name changed. Please restart the extension to apply changes.'
        );
        outputChannel.appendLine('DevTrack: Repository name changed.');
      }
    }
  });
}

/**
 * This method is called when the extension is deactivated.
 */
export function deactivate() {}
