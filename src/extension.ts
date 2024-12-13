/* eslint-disable no-unused-vars */
import * as vscode from 'vscode';
import { GitHubService } from './services/githubService';
import { GitService } from './services/gitService';
import { Tracker } from './services/tracker';
import { SummaryGenerator } from './services/summaryGenerator';
import { Scheduler } from './services/scheduler';

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

  // After retrieving configuration settings
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

  // **Initialize Status Bar Items**

  // 1. **Tracking Status Bar Item**
  const trackingStatusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  trackingStatusBar.text = '$(circle-slash) DevTrack: Stopped';
  trackingStatusBar.tooltip = 'DevTrack: Tracking is stopped';
  trackingStatusBar.show();
  context.subscriptions.push(trackingStatusBar);

  // 2. **Authentication Status Bar Item**
  const authStatusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    101
  );
  authStatusBar.text = '$(mark-github) DevTrack: Not Connected';
  authStatusBar.tooltip = 'DevTrack Status';
  // Removed the command from status bar
  authStatusBar.show();
  context.subscriptions.push(authStatusBar);

  // Declare scheduler outside to make it accessible in commands
  let scheduler: Scheduler | null = null;

  // Define the simplified logout handler
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

    // Reset GitHubService's token
    githubService.setToken('');

    // Update UI state
    authStatusBar.text = '$(mark-github) DevTrack: Not Connected';
    authStatusBar.tooltip = 'DevTrack Status';
    trackingStatusBar.text = '$(circle-slash) DevTrack: Stopped';
    trackingStatusBar.tooltip = 'DevTrack: Tracking is stopped';

    // Stop the Scheduler if it's running
    if (scheduler) {
      scheduler.stop();
      scheduler = null;
      outputChannel.appendLine('DevTrack: Scheduler stopped due to logout.');
    }

    // Now prompt for new login
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

  try {
    // Check for existing sessions silently
    session = await auth.getSession('github', ['repo', 'read:user'], {
      createIfNone: false,
    });
    if (session) {
      outputChannel.appendLine('DevTrack: Using existing GitHub session.');
      authStatusBar.text = '$(check) DevTrack: Connected';
      authStatusBar.tooltip = 'DevTrack is connected to GitHub';

      // Initialize GitHub service with the session token
      githubService.setToken(session.accessToken);

      // Retrieve GitHub username
      const username = await githubService.getUsername();
      if (!username) {
        vscode.window.showErrorMessage(
          'DevTrack: Unable to retrieve GitHub username. Please ensure your token is valid.'
        );
        outputChannel.appendLine(
          'DevTrack: Unable to retrieve GitHub username.'
        );
        return;
      }

      outputChannel.appendLine(`Authenticated GitHub Username: ${username}`);

      // Check if repository exists, if not create it
      const repoExists = await githubService.repoExists(repoName);
      let remoteUrl = `https://github.com/${username}/${repoName}.git`;
      if (!repoExists) {
        const createdRepoUrl = await githubService.createRepo(repoName);
        if (createdRepoUrl) {
          remoteUrl = createdRepoUrl;
          outputChannel.appendLine(
            `DevTrack: Created new repository at ${remoteUrl}`
          );
        } else {
          vscode.window.showErrorMessage(
            'DevTrack: Failed to create GitHub repository.'
          );
          outputChannel.appendLine(
            'DevTrack: Failed to create GitHub repository.'
          );
          return;
        }
      } else {
        outputChannel.appendLine(
          `DevTrack: Repository "${repoName}" already exists.`
        );
      }

      // Initialize local Git repository
      try {
        await gitService.initializeRepo(remoteUrl);
      } catch (error) {
        outputChannel.appendLine(
          'DevTrack: Failed to initialize Git repository.'
        );
        return;
      }

      // Initialize Scheduler
      scheduler = new Scheduler(
        commitFrequency,
        tracker,
        summaryGenerator,
        gitService,
        outputChannel
      );
      scheduler.start();
      outputChannel.appendLine('DevTrack: Scheduler started.');

      // Update Tracking Status Bar to indicate tracking is active
      trackingStatusBar.text = '$(clock) DevTrack: Tracking';
      trackingStatusBar.tooltip =
        'DevTrack: Tracking your coding activity is active';

      // Update Tracking Status Bar on each commit
      gitService.on('commit', (message: string) => {
        const now = new Date();
        trackingStatusBar.text = `$(check) Last Commit: ${now.toLocaleTimeString()}`;
        outputChannel.appendLine(
          `DevTrack: Last commit at ${now.toLocaleTimeString()} with message: "${message}"`
        );
      });
    } else {
      // User is not authenticated
      authStatusBar.text = '$(mark-github) DevTrack: Not Connected';
      authStatusBar.tooltip = 'DevTrack Status';

      // Show initial setup message
      const setupChoice = await vscode.window.showInformationMessage(
        'DevTrack needs to be connected to GitHub to start tracking. Would you like to connect now?',
        'Yes',
        'No'
      );

      if (setupChoice === 'Yes') {
        vscode.commands.executeCommand('devtrack.login');
      }
    }

    // **Register Commands**

    // Register Start Tracking Command
    const startTracking = vscode.commands.registerCommand(
      'devtrack.startTracking',
      () => {
        if (scheduler) {
          scheduler.start();
          trackingStatusBar.text = '$(clock) DevTrack: Tracking';
          trackingStatusBar.tooltip =
            'DevTrack: Tracking your coding activity is active';
          vscode.window.showInformationMessage('DevTrack: Tracking started.');
          outputChannel.appendLine('DevTrack: Tracking started manually.');
        } else {
          vscode.window.showErrorMessage(
            'DevTrack: Please connect to GitHub first.'
          );
          outputChannel.appendLine('DevTrack: Scheduler is not initialized.');
        }
      }
    );

    // Register Stop Tracking Command
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

    // Register Login Command
    const loginCommand = vscode.commands.registerCommand(
      'devtrack.login',
      async () => {
        try {
          // First clear any existing session by setting token to empty
          githubService.setToken('');

          // Force a new authentication session
          session = await auth.getSession('github', ['repo', 'read:user'], {
            forceNewSession: true,
          });

          if (session) {
            githubService.setToken(session.accessToken);
            const newUsername = await githubService.getUsername();
            if (newUsername) {
              vscode.window.showInformationMessage(
                `DevTrack: Connected as ${newUsername}`
              );
              outputChannel.appendLine(`DevTrack: Connected as ${newUsername}`);
              authStatusBar.text = '$(check) DevTrack: Connected';
              authStatusBar.tooltip = 'DevTrack is connected to GitHub';

              // Check if repository exists, if not create it
              const repoExists = await githubService.repoExists(repoName);
              let remoteUrl = `https://github.com/${newUsername}/${repoName}.git`;
              if (!repoExists) {
                const createdRepoUrl = await githubService.createRepo(repoName);
                if (createdRepoUrl) {
                  remoteUrl = createdRepoUrl;
                  outputChannel.appendLine(
                    `DevTrack: Created new repository at ${remoteUrl}`
                  );
                } else {
                  vscode.window.showErrorMessage(
                    'DevTrack: Failed to create GitHub repository.'
                  );
                  outputChannel.appendLine(
                    'DevTrack: Failed to create GitHub repository.'
                  );
                  return;
                }
              } else {
                outputChannel.appendLine(
                  `DevTrack: Repository "${repoName}" already exists.`
                );
              }

              // Initialize local Git repository
              try {
                await gitService.initializeRepo(remoteUrl);
              } catch (error) {
                outputChannel.appendLine(
                  'DevTrack: Failed to initialize Git repository.'
                );
                return;
              }

              // Initialize Scheduler
              scheduler = new Scheduler(
                commitFrequency,
                tracker,
                summaryGenerator,
                gitService,
                outputChannel
              );
              scheduler.start();
              outputChannel.appendLine('DevTrack: Scheduler started.');

              // Update Tracking Status Bar to indicate tracking is active
              trackingStatusBar.text = '$(clock) DevTrack: Tracking';
              trackingStatusBar.tooltip =
                'DevTrack: Tracking your coding activity is active';
            } else {
              vscode.window.showErrorMessage(
                'DevTrack: Unable to retrieve GitHub username.'
              );
              outputChannel.appendLine(
                'DevTrack: Unable to retrieve GitHub username.'
              );
            }
          } else {
            outputChannel.appendLine('DevTrack: GitHub connection canceled.');
          }
        } catch (error) {
          outputChannel.appendLine(
            `DevTrack: GitHub connection failed. ${error}`
          );
          vscode.window.showErrorMessage('DevTrack: GitHub connection failed.');
        }
      }
    );

    // Register Logout Command
    const logoutCommand = vscode.commands.registerCommand(
      'devtrack.logout',
      async () => {
        await handleLogout();
      }
    );

    // Add all commands to context subscriptions
    context.subscriptions.push(
      stopTracking,
      startTracking,
      loginCommand,
      logoutCommand
    );

    // **Handle Configuration Changes**
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (event.affectsConfiguration('devtrack')) {
        // Reload configuration settings
        const newConfig = vscode.workspace.getConfiguration('devtrack');
        const newRepoName =
          newConfig.get<string>('repoName') || 'code-tracking';
        const newCommitFrequency =
          newConfig.get<number>('commitFrequency') || 30;
        const newExcludePatterns = newConfig.get<string[]>('exclude') || [];
        const newConfirmBeforeCommit =
          newConfig.get<boolean>('confirmBeforeCommit') || true;

        outputChannel.appendLine('DevTrack: Configuration updated.');

        // Update scheduler if commit frequency has changed
        if (scheduler && newCommitFrequency !== commitFrequency) {
          scheduler.updateFrequency(newCommitFrequency);
          outputChannel.appendLine(
            `DevTrack: Commit frequency updated to ${newCommitFrequency} minutes.`
          );
        }

        // Update Tracker's exclude patterns
        if (
          tracker &&
          JSON.stringify(newExcludePatterns) !== JSON.stringify(excludePatterns)
        ) {
          tracker.updateExcludePatterns(newExcludePatterns);
          outputChannel.appendLine('DevTrack: Exclude patterns updated.');
        }

        // Handle repository name changes if necessary
        if (newRepoName !== repoName) {
          vscode.window.showWarningMessage(
            'DevTrack: Repository name changed. Please restart the extension to apply changes.'
          );
          outputChannel.appendLine('DevTrack: Repository name changed.');
        }
      }
    });
  } catch (error) {
    outputChannel.appendLine(
      `DevTrack: GitHub authentication failed. ${error}`
    );
    vscode.window.showErrorMessage('DevTrack: GitHub authentication failed.');
  }
}

/**
 * This method is called when the extension is deactivated.
 */
export function deactivate() {}
