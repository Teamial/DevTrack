/* eslint-disable no-unused-vars */
/* eslint-disable no-undef */
import * as vscode from 'vscode';
import { GitHubService } from './services/githubService';
import { GitService } from './services/gitService';
import { Tracker } from './services/tracker';
import { SummaryGenerator } from './services/summaryGenerator';
import { Scheduler } from './services/scheduler';
import { execSync } from 'child_process';

// Interface for services
interface DevTrackServices {
  outputChannel: vscode.OutputChannel;
  githubService: GitHubService;
  gitService: GitService;
  tracker: Tracker;
  summaryGenerator: SummaryGenerator;
  scheduler: Scheduler | null;
  trackingStatusBar: vscode.StatusBarItem;
  authStatusBar: vscode.StatusBarItem;
}

// Git installation handling
class GitInstallationHandler {
  private static readonly DOWNLOAD_URLS = {
    win32: 'https://git-scm.com/download/win',
    darwin: 'https://git-scm.com/download/mac',
    linux: 'https://git-scm.com/download/linux',
  };

  static async checkGitInstallation(
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
        this.showInstallationGuide();
      }
      return false;
    }
  }

  static showInstallationGuide() {
    const platform = process.platform;
    const downloadUrl =
      this.DOWNLOAD_URLS[platform as keyof typeof this.DOWNLOAD_URLS];
    const instructions = this.getInstructions(platform);

    const panel = vscode.window.createWebviewPanel(
      'gitInstallGuide',
      'Git Installation Guide',
      vscode.ViewColumn.One,
      { enableScripts: true }
    );

    panel.webview.html = this.getWebviewContent(instructions, downloadUrl);
  }

  private static getInstructions(platform: string): string {
    // Platform-specific installation instructions
    const instructions = {
      win32: `Windows Git Installation Guide:
1. Download Git from ${this.DOWNLOAD_URLS.win32}
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
10. Restart VS Code`,
      darwin: `Mac Git Installation Guide:
Option 1 - Using Homebrew (Recommended):
1. Open Terminal
2. Install Homebrew if not installed:
   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
3. Install Git:
   brew install git

Option 2 - Direct Download:
1. Download Git from ${this.DOWNLOAD_URLS.darwin}
2. Open the downloaded .dmg file
3. Run the installer package

After installation:
- Open Terminal
- Type 'git --version' to verify installation`,
      linux: `Linux Git Installation Guide:
Debian/Ubuntu:
1. Open Terminal
2. Run: sudo apt-get update
3. Run: sudo apt-get install git

Fedora:
1. Open Terminal
2. Run: sudo dnf install git

After installation:
- Type 'git --version' to verify installation`,
    };

    return (
      instructions[platform as keyof typeof instructions] || instructions.linux
    );
  }

  private static getWebviewContent(
    instructions: string,
    downloadUrl: string
  ): string {
    return `
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    body { padding: 20px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
                    pre { white-space: pre-wrap; background-color: #f3f3f3; padding: 15px; border-radius: 5px; }
                    .download-btn { 
                        padding: 10px 20px; 
                        background-color: #007acc; 
                        color: white; 
                        border: none; 
                        border-radius: 5px;
                        cursor: pointer;
                        margin-top: 20px;
                    }
                    .download-btn:hover { background-color: #005999; }
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

  GitInstallationHandler.checkGitInstallation(outputChannel).then(
    (gitInstalled) => {
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
    }
  );
}

// Extension activation handler
export async function activate(context: vscode.ExtensionContext) {
  const services = await initializeServices(context);
  if (!services) {
    return;
  }

  registerCommands(context, services);
  setupConfigurationHandling(services);
  showWelcomeMessage(context, services);
}

async function initializeServices(
  context: vscode.ExtensionContext
): Promise<DevTrackServices | null> {
  const outputChannel = vscode.window.createOutputChannel('DevTrack');
  context.subscriptions.push(outputChannel);
  outputChannel.appendLine('DevTrack: Extension activated.');

  // Initialize basic services
  const services: DevTrackServices = {
    outputChannel,
    githubService: new GitHubService(outputChannel),
    gitService: new GitService(outputChannel),
    tracker: new Tracker(outputChannel),
    summaryGenerator: new SummaryGenerator(outputChannel, context),
    scheduler: null,
    trackingStatusBar: createStatusBarItem('tracking'),
    authStatusBar: createStatusBarItem('auth'),
  };

  // Add status bars to subscriptions
  context.subscriptions.push(
    services.trackingStatusBar,
    services.authStatusBar
  );

  // Load and validate configuration
  if (!(await loadConfiguration(services))) {
    return null;
  }

  return services;
}

function createStatusBarItem(type: 'tracking' | 'auth'): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    type === 'tracking' ? 100 : 101
  );

  if (type === 'tracking') {
    item.text = '$(circle-slash) DevTrack: Stopped';
    item.tooltip = 'DevTrack: Tracking is stopped';
  } else {
    item.text = '$(mark-github) DevTrack: Not Connected';
    item.tooltip = 'DevTrack Status';
  }

  item.show();
  return item;
}

async function loadConfiguration(services: DevTrackServices): Promise<boolean> {
  const config = vscode.workspace.getConfiguration('devtrack');
  const repoName = config.get<string>('repoName') || 'code-tracking';

  if (!repoName || repoName.trim() === '') {
    vscode.window.showErrorMessage(
      'DevTrack: Repository name is not set correctly in the configuration.'
    );
    services.outputChannel.appendLine(
      'DevTrack: Repository name is missing or invalid.'
    );
    return false;
  }

  return true;
}
// ... [Previous code remains the same] ...

async function registerCommands(
  context: vscode.ExtensionContext,
  services: DevTrackServices
) {
  // Start Tracking Command
  const startTracking = vscode.commands.registerCommand(
    'devtrack.startTracking',
    async () => {
      try {
        // Check for workspace
        if (!vscode.workspace.workspaceFolders?.length) {
          throw new Error(
            'Please open a folder or workspace before starting tracking.'
          );
        }

        // Check Git installation
        if (
          !(await GitInstallationHandler.checkGitInstallation(
            services.outputChannel
          ))
        ) {
          return;
        }

        // Check GitHub authentication
        if (!(await ensureGitHubAuth(services))) {
          return;
        }

        if (services.scheduler) {
          services.scheduler.start();
          updateStatusBar(services, 'tracking', true);
          vscode.window.showInformationMessage('DevTrack: Tracking started.');
          services.outputChannel.appendLine(
            'DevTrack: Tracking started manually.'
          );
        } else {
          const response = await vscode.window.showInformationMessage(
            'DevTrack needs to be set up before starting. Would you like to set it up now?',
            'Set Up DevTrack',
            'Cancel'
          );

          if (response === 'Set Up DevTrack') {
            await initializeDevTrack(services);
          }
        }
      } catch (error: any) {
        handleError(services, 'Error starting tracking', error);
      }
    }
  );

  // Stop Tracking Command
  const stopTracking = vscode.commands.registerCommand(
    'devtrack.stopTracking',
    () => {
      if (services.scheduler) {
        services.scheduler.stop();
        updateStatusBar(services, 'tracking', false);
        vscode.window.showInformationMessage('DevTrack: Tracking stopped.');
        services.outputChannel.appendLine(
          'DevTrack: Tracking stopped manually.'
        );
      } else {
        vscode.window.showErrorMessage(
          'DevTrack: Please connect to GitHub first.'
        );
        services.outputChannel.appendLine(
          'DevTrack: Scheduler is not initialized.'
        );
      }
    }
  );

  // Login Command
  const loginCommand = vscode.commands.registerCommand(
    'devtrack.login',
    async () => {
      try {
        services.githubService.setToken('');
        const session = await vscode.authentication.getSession(
          'github',
          ['repo', 'read:user', 'user:email'],
          { forceNewSession: true }
        );

        if (session) {
          await initializeDevTrack(services);
        } else {
          services.outputChannel.appendLine(
            'DevTrack: GitHub connection canceled.'
          );
          vscode.window.showInformationMessage(
            'DevTrack: GitHub connection was canceled.'
          );
        }
      } catch (error: any) {
        handleError(services, 'GitHub connection failed', error);
      }
    }
  );

  // Logout Command
  const logoutCommand = vscode.commands.registerCommand('devtrack.logout', () =>
    handleLogout(services)
  );

  // Add to subscriptions
  context.subscriptions.push(
    startTracking,
    stopTracking,
    loginCommand,
    logoutCommand
  );
}

async function initializeDevTrack(services: DevTrackServices) {
  try {
    services.outputChannel.appendLine('DevTrack: Starting initialization...');

    // Verify Git installation
    if (
      !(await GitInstallationHandler.checkGitInstallation(
        services.outputChannel
      ))
    ) {
      throw new Error(
        'Git must be installed before DevTrack can be initialized.'
      );
    }

    // Get GitHub authentication
    const session = await vscode.authentication.getSession(
      'github',
      ['repo', 'read:user', 'user:email'],
      { forceNewSession: true }
    );

    if (!session) {
      throw new Error('GitHub authentication is required to use DevTrack.');
    }

    // Initialize GitHub service
    services.githubService.setToken(session.accessToken);
    const username = await services.githubService.getUsername();

    if (!username) {
      throw new Error(
        'Unable to retrieve GitHub username. Please try logging in again.'
      );
    }

    // Setup repository
    const config = vscode.workspace.getConfiguration('devtrack');
    const repoName = config.get<string>('repoName') || 'code-tracking';
    const remoteUrl = `https://github.com/${username}/${repoName}.git`;

    await setupRepository(services, repoName, remoteUrl);
    await initializeTracker(services);

    updateStatusBar(services, 'auth', true);
    updateStatusBar(services, 'tracking', true);

    services.outputChannel.appendLine(
      'DevTrack: Initialization completed successfully.'
    );
    vscode.window.showInformationMessage(
      'DevTrack has been set up successfully and tracking has started.'
    );
  } catch (error: any) {
    handleError(services, 'Initialization failed', error);
    throw error;
  }
}

async function setupRepository(
  services: DevTrackServices,
  repoName: string,
  remoteUrl: string
) {
  const repoExists = await services.githubService.repoExists(repoName);

  if (!repoExists) {
    const createdRepoUrl = await services.githubService.createRepo(repoName);
    if (!createdRepoUrl) {
      throw new Error(
        'Failed to create GitHub repository. Please check your permissions.'
      );
    }
    services.outputChannel.appendLine(
      `DevTrack: Created new repository at ${remoteUrl}`
    );
  }

  await services.gitService.initializeRepo(remoteUrl);
}

async function initializeTracker(services: DevTrackServices) {
  const config = vscode.workspace.getConfiguration('devtrack');
  const commitFrequency = config.get<number>('commitFrequency') || 30;

  services.scheduler = new Scheduler(
    commitFrequency,
    services.tracker,
    services.summaryGenerator,
    services.gitService,
    services.outputChannel
  );
  services.scheduler.start();
}

async function handleLogout(services: DevTrackServices) {
  const confirm = await vscode.window.showWarningMessage(
    'Are you sure you want to logout from DevTrack?',
    { modal: true },
    'Yes',
    'No'
  );

  if (confirm !== 'Yes') {
    services.outputChannel.appendLine('DevTrack: Logout canceled by user.');
    return;
  }

  cleanup(services);

  const loginChoice = await vscode.window.showInformationMessage(
    'DevTrack: Successfully logged out. Would you like to log in with a different account?',
    'Yes',
    'No'
  );

  if (loginChoice === 'Yes') {
    vscode.commands.executeCommand('devtrack.login');
  }
}

function cleanup(services: DevTrackServices) {
  services.githubService.setToken('');
  updateStatusBar(services, 'auth', false);
  updateStatusBar(services, 'tracking', false);

  if (services.scheduler) {
    services.scheduler.stop();
    services.scheduler = null;
  }

  services.outputChannel.appendLine('DevTrack: Cleaned up services.');
}

function updateStatusBar(
  services: DevTrackServices,
  type: 'tracking' | 'auth',
  active: boolean
) {
  const { trackingStatusBar, authStatusBar } = services;

  if (type === 'tracking') {
    trackingStatusBar.text = active
      ? '$(clock) DevTrack: Tracking'
      : '$(circle-slash) DevTrack: Stopped';
    trackingStatusBar.tooltip = active
      ? 'DevTrack: Tracking your coding activity is active'
      : 'DevTrack: Tracking is stopped';
  } else {
    authStatusBar.text = active
      ? '$(check) DevTrack: Connected'
      : '$(mark-github) DevTrack: Not Connected';
    authStatusBar.tooltip = active
      ? 'DevTrack is connected to GitHub'
      : 'DevTrack Status';
  }
}

function handleError(
  services: DevTrackServices,
  context: string,
  error: Error
) {
  const message = error.message || 'An unknown error occurred';
  services.outputChannel.appendLine(`DevTrack: ${context} - ${message}`);
  vscode.window.showErrorMessage(`DevTrack: ${message}`);
}

async function ensureGitHubAuth(services: DevTrackServices): Promise<boolean> {
  try {
    const session = await vscode.authentication.getSession('github', [
      'repo',
      'read:user',
      'user:email',
    ]);
    return !!session;
  } catch {
    const response = await vscode.window.showErrorMessage(
      'DevTrack requires GitHub authentication. Would you like to sign in now?',
      'Sign in to GitHub',
      'Cancel'
    );

    if (response === 'Sign in to GitHub') {
      await vscode.commands.executeCommand('devtrack.login');
    }
    return false;
  }
}

function setupConfigurationHandling(services: DevTrackServices) {
  vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('devtrack')) {
      handleConfigurationChange(services);
    }
  });
}

async function handleConfigurationChange(services: DevTrackServices) {
  const config = vscode.workspace.getConfiguration('devtrack');

  if (services.scheduler) {
    const newFrequency = config.get<number>('commitFrequency') || 30;
    services.scheduler.updateFrequency(newFrequency);
    services.outputChannel.appendLine(
      `DevTrack: Commit frequency updated to ${newFrequency} minutes.`
    );
  }

  const newExcludePatterns = config.get<string[]>('exclude') || [];
  services.tracker.updateExcludePatterns(newExcludePatterns);
  services.outputChannel.appendLine('DevTrack: Configuration updated.');
}

function showWelcomeMessage(
  context: vscode.ExtensionContext,
  services: DevTrackServices
) {
  if (!context.globalState.get('devtrackWelcomeShown')) {
    showWelcomeInfo(services.outputChannel);
    context.globalState.update('devtrackWelcomeShown', true);
  }
}

export function deactivate() {
  // Cleanup will be handled by VS Code's disposal of subscriptions
}
