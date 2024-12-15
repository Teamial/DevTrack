/* eslint-disable no-unused-vars */
/* eslint-disable no-undef */
import * as vscode from 'vscode';
import { GitHubService } from './services/githubService';
import { GitService } from './services/gitService';
import { Tracker } from './services/tracker';
import { SummaryGenerator } from './services/summaryGenerator';
import { Scheduler } from './services/scheduler';
import { execSync } from 'child_process';

function showGitInstallationGuide() {
  const isWindows = process.platform === 'win32';
  const isMac = process.platform === 'darwin';

  let instructions = '';
  let downloadUrl = '';

  if (isWindows) {
    downloadUrl = 'https://git-scm.com/download/win';
    instructions = `
Windows Git Installation Guide:
1. Download Git from ${downloadUrl}
2. Run the installer
3. During installation:
   - Choose "Git from the command line and also from 3rd-party software"
   - Choose "Use Windows' default console window"
   - Choose "Enable Git Credential Manager"
4. After installation:
   - Open Command Prompt (cmd) or PowerShell
   - Type 'git --version' to verify installation

If Git is not recognized after installation:
1. Open Windows Settings
2. Search for "Environment Variables"
3. Click "Edit the system environment variables"
4. Click "Environment Variables"
5. Under "System Variables", find and select "Path"
6. Click "Edit"
7. Click "New"
8. Add "C:\\Program Files\\Git\\cmd"
9. Click "OK" on all windows
10. Restart VS Code
`;
  } else if (isMac) {
    downloadUrl = 'https://git-scm.com/download/mac';
    instructions = `
Mac Git Installation Guide:
Option 1 - Using Homebrew (Recommended):
1. Open Terminal
2. Install Homebrew if not installed:
   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
3. Install Git:
   brew install git

Option 2 - Direct Download:
1. Download Git from ${downloadUrl}
2. Open the downloaded .dmg file
3. Run the installer package

After installation:
- Open Terminal
- Type 'git --version' to verify installation
`;
  } else {
    // Linux
    downloadUrl = 'https://git-scm.com/download/linux';
    instructions = `
Linux Git Installation Guide:
Debian/Ubuntu:
1. Open Terminal
2. Run: sudo apt-get update
3. Run: sudo apt-get install git

Fedora:
1. Open Terminal
2. Run: sudo dnf install git

After installation:
- Type 'git --version' to verify installation
`;
  }

  const panel = vscode.window.createWebviewPanel(
    'gitInstallGuide',
    'Git Installation Guide',
    vscode.ViewColumn.One,
    {
      enableScripts: true,
    }
  );

  panel.webview.html = `
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                body { padding: 20px; }
                pre { white-space: pre-wrap; background-color: #f0f0f0; padding: 10px; }
                .download-btn { padding: 10px 20px; background-color: #007acc; color: white; border: none; cursor: pointer; }
            </style>
        </head>
        <body>
            <h1>Git Installation Guide</h1>
            <pre>${instructions}</pre>
            <button class="download-btn" onclick="window.open('${downloadUrl}')">Download Git</button>
        </body>
        </html>
    `;
}

async function checkGitInstallation(
  outputChannel: vscode.OutputChannel
): Promise<boolean> {
  try {
    const gitVersion = execSync('git --version', { encoding: 'utf8' });
    outputChannel.appendLine(`DevTrack: Git found - ${gitVersion.trim()}`);
    return true;
  } catch (error) {
    const response = await vscode.window.showErrorMessage(
      'Git is required but not found on your system. Would you like to view the installation guide?',
      'Show Installation Guide',
      'Cancel'
    );

    if (response === 'Show Installation Guide') {
      showGitInstallationGuide();
    }
    return false;
  }
}

function showWelcomeInfo(outputChannel: vscode.OutputChannel) {
  const message =
    'Welcome to DevTrack! Would you like to set up automatic code tracking?';
  const welcomeMessage = `
To get started with DevTrack, you'll need:
1. A GitHub account
2. An open workspace/folder
3. Git installed on your system (Download from https://git-scm.com/downloads)

DevTrack will:
- Create a private GitHub repository to store your coding activity
- Automatically track and commit your changes
- Generate detailed summaries of your work
    `;

  checkGitInstallation(outputChannel).then((gitInstalled) => {
    if (!gitInstalled) {
      return;
    }

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

      // Check Git installation first
      if (!(await checkGitInstallation(outputChannel))) {
        throw new Error(
          'Git must be installed before DevTrack can be initialized.'
        );
      }

      // Rest of your existing initializeDevTrack code...
    } catch (error: any) {
      outputChannel.appendLine(
        `DevTrack: Initialization failed - ${error.message}`
      );

      if (error.message.includes('Git must be installed')) {
        // Already handled by checkGitInstallation
        return;
      }

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
    showWelcomeInfo(outputChannel);
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
