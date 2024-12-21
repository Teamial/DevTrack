/* eslint-disable no-unused-vars */
/* eslint-disable no-undef */
import * as vscode from 'vscode';
import { GitHubService } from './services/githubService';
import { GitService } from './services/gitService';
import { Tracker } from './services/tracker';
import { SummaryGenerator } from './services/summaryGenerator';
import { Scheduler } from './services/scheduler';
import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

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
      const platform = process.platform;
      const response = await vscode.window.showErrorMessage(
        'Git is required but not found on your system. This might be because Git is not installed or not in your system PATH.',
        {
          modal: true,
          detail:
            'Would you like to view the installation guide or fix PATH issues?',
        },
        ...(platform === 'win32'
          ? ['Show Installation Guide', 'Fix PATH Issue', 'Cancel']
          : ['Show Installation Guide', 'Cancel'])
      );

      if (response === 'Show Installation Guide') {
        this.showInstallationGuide();
      } else if (response === 'Fix PATH Issue') {
        this.showPathFixGuide();
      }
      return false;
    }
  }

  private static showPathFixGuide() {
    const panel = vscode.window.createWebviewPanel(
      'gitPathGuide',
      'Fix Git PATH Issue',
      vscode.ViewColumn.One,
      { enableScripts: true }
    );

    const content = `<!DOCTYPE html>
    <html>
    <head>
        <style>
            body { 
                padding: 20px; 
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                line-height: 1.6;
            }
            .step {
                margin-bottom: 20px;
                padding: 15px;
                background-color: #f3f3f3;
                border-radius: 5px;
            }
            .warning {
                color: #856404;
                background-color: #fff3cd;
                border: 1px solid #ffeeba;
                padding: 10px;
                border-radius: 5px;
                margin: 10px 0;
            }
            .tip {
                color: #004085;
                background-color: #cce5ff;
                border: 1px solid #b8daff;
                padding: 10px;
                border-radius: 5px;
                margin: 10px 0;
            }
            img {
                max-width: 100%;
                margin: 10px 0;
                border: 1px solid #ddd;
                border-radius: 4px;
                padding: 5px;
            }
        </style>
    </head>
    <body>
        <h1>Adding Git to System PATH</h1>
        
        <div class="warning">
            ⚠️ Before proceeding, make sure Git is installed on your system. If not, please install it first.
        </div>

        <div class="step">
            <h3>Step 1: Open System Properties</h3>
            <ul>
                <li>Press <strong>Windows + R</strong> to open Run dialog</li>
                <li>Type <strong>sysdm.cpl</strong> and press Enter</li>
                <li>Go to the <strong>Advanced</strong> tab</li>
                <li>Click <strong>Environment Variables</strong> at the bottom</li>
            </ul>
        </div>

        <div class="step">
            <h3>Step 2: Edit PATH Variable</h3>
            <ul>
                <li>Under <strong>System Variables</strong>, find and select <strong>Path</strong></li>
                <li>Click <strong>Edit</strong></li>
                <li>Click <strong>New</strong></li>
                <li>Add the following paths (if they don't already exist):
                    <ul>
                        <li>C:\\Program Files\\Git\\cmd</li>
                        <li>C:\\Program Files\\Git\\bin</li>
                        <li>C:\\Program Files (x86)\\Git\\cmd</li>
                    </ul>
                </li>
                <li>Click <strong>OK</strong> on all windows</li>
            </ul>
        </div>

        <div class="step">
            <h3>Step 3: Verify Installation</h3>
            <ul>
                <li>Open a <strong>new</strong> Command Prompt or PowerShell window</li>
                <li>Type <strong>git --version</strong> and press Enter</li>
                <li>If you see a version number, Git is successfully added to PATH</li>
            </ul>
        </div>

        <div class="tip">
            💡 Tip: If Git is installed in a different location, you'll need to add that path instead. 
            Common alternative locations:
            <ul>
                <li>C:\\Program Files\\Git\\cmd</li>
                <li>C:\\Users\\[YourUsername]\\AppData\\Local\\Programs\\Git\\cmd</li>
            </ul>
        </div>

        <div class="warning">
            Important: After updating the PATH, you need to:
            <ol>
                <li>Close and reopen VS Code</li>
                <li>Close and reopen any open terminal windows</li>
            </ol>
        </div>
    </body>
    </html>`;

    panel.webview.html = content;
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
    const instructions = {
      win32: `Windows Git Installation Guide:
1. Download Git from ${this.DOWNLOAD_URLS.win32}
2. Run the installer
3. During installation:
   - Choose "Git from the command line and also from 3rd-party software"
   - Choose "Use Windows' default console window"
   - Choose "Enable Git Credential Manager"
4. Important: On the "Adjusting your PATH environment" step:
   - Select "Git from the command line and also from 3rd-party software"
5. Complete the installation
6. Verify installation:
   - Open a new Command Prompt or PowerShell
   - Type 'git --version'`,
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
3. Run the installer package`,
      linux: `Linux Git Installation Guide:
Debian/Ubuntu:
1. Open Terminal
2. Run: sudo apt-get update
3. Run: sudo apt-get install git

Fedora:
1. Open Terminal
2. Run: sudo dnf install git`,
    };

    return (
      instructions[platform as keyof typeof instructions] || instructions.linux
    );
  }

  private static getWebviewContent(
    instructions: string,
    downloadUrl: string
  ): string {
    return `<!DOCTYPE html>
    <html>
    <head>
        <style>
            body { 
                padding: 20px; 
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; 
                line-height: 1.6;
            }
            pre { 
                white-space: pre-wrap; 
                background-color: #f3f3f3; 
                padding: 15px; 
                border-radius: 5px; 
            }
            .download-btn { 
                padding: 10px 20px; 
                background-color: #007acc; 
                color: white; 
                border: none; 
                border-radius: 5px;
                cursor: pointer;
                margin-top: 20px;
                text-decoration: none;
                display: inline-block;
            }
            .download-btn:hover { 
                background-color: #005999; 
            }
            .tip {
                background-color: #e8f5e9;
                padding: 10px;
                border-radius: 5px;
                margin: 10px 0;
            }
        </style>
    </head>
    <body>
        <h1>Git Installation Guide</h1>
        <pre>${instructions}</pre>
        <div class="tip">
            <strong>Tip:</strong> After installation, if Git is not recognized:
            <ul>
                <li>Make sure to restart VS Code</li>
                <li>Open a new terminal window</li>
                <li>If still not working, you might need to add Git to your PATH</li>
            </ul>
        </div>
        <a href="${downloadUrl}" class="download-btn" target="_blank">Download Git</a>
    </body>
    </html>`;
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

async function recoverFromGitIssues(services: DevTrackServices): Promise<void> {
  try {
    // Clear existing Git state
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
    if (!workspaceRoot) {
      throw new Error('No workspace folder found');
    }

    const gitPath = path.join(workspaceRoot, '.git');
    if (fs.existsSync(gitPath)) {
      await vscode.workspace.fs.delete(vscode.Uri.file(gitPath), {
        recursive: true,
      });
    }

    // Clear the existing session by requesting with createIfNone: false
    try {
      await vscode.authentication.getSession('github', ['repo', 'read:user'], {
        createIfNone: false,
        clearSessionPreference: true,
      });
    } catch (error) {
      // Ignore errors here, just trying to clear the session
    }

    // Reinitialize services
    services.githubService = new GitHubService(services.outputChannel);
    services.gitService = new GitService(services.outputChannel);

    // Get fresh GitHub token
    const session = await vscode.authentication.getSession(
      'github',
      ['repo', 'read:user'],
      {
        createIfNone: true,
        clearSessionPreference: true,
      }
    );

    if (!session) {
      throw new Error('Failed to authenticate with GitHub');
    }

    services.githubService.setToken(session.accessToken);

    // Setup repository from scratch
    const username = await services.githubService.getUsername();
    if (!username) {
      throw new Error('Failed to get GitHub username');
    }

    const config = vscode.workspace.getConfiguration('devtrack');
    const repoName = config.get<string>('repoName') || 'code-tracking';
    const remoteUrl = `https://github.com/${username}/${repoName}.git`;

    await services.gitService.initializeRepo(remoteUrl);
  } catch (error: any) {
    throw new Error(`Recovery failed: ${error.message}`);
  }
}

// Extension activation handler
export async function activate(context: vscode.ExtensionContext) {
  let testCommand = vscode.commands.registerCommand('devtrack.test', () => {
    vscode.window.showInformationMessage(
      'DevTrack Debug Version: Test Command Executed'
    );
  });
  context.subscriptions.push(testCommand);

  const services = await initializeServices(context);
  if (!services) {
    return;
  }

  registerCommands(context, services);
  setupConfigurationHandling(services);
  showWelcomeMessage(context, services);
}
interface PersistedAuthState {
  username?: string;
  repoName?: string;
  lastWorkspace?: string;
}
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
  extensionContext: vscode.ExtensionContext;
}

async function restoreAuthenticationState(
  context: vscode.ExtensionContext,
  services: DevTrackServices
): Promise<boolean> {
  try {
    // Use getSession instead of getSessions
    const session = await vscode.authentication.getSession(
      'github',
      ['repo', 'read:user'],
      {
        createIfNone: false,
        silent: true, // Try to get session without prompting user
      }
    );

    if (session) {
      services.githubService.setToken(session.accessToken);
      const username = await services.githubService.getUsername();

      if (username) {
        // Get persisted state
        const persistedState =
          context.globalState.get<PersistedAuthState>('devtrackAuthState');
        const currentWorkspace =
          vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

        // Initialize with persisted or default settings
        const config = vscode.workspace.getConfiguration('devtrack');
        const repoName =
          config.get<string>('repoName') ||
          persistedState?.repoName ||
          'code-tracking';
        const remoteUrl = `https://github.com/${username}/${repoName}.git`;

        await setupRepository(services, repoName, remoteUrl);
        await initializeTracker(services);

        // Update UI
        updateStatusBar(services, 'auth', true);
        updateStatusBar(services, 'tracking', true);

        // Update persisted state
        await context.globalState.update('devtrackAuthState', {
          username,
          repoName,
          lastWorkspace: currentWorkspace,
        });

        services.outputChannel.appendLine(
          'DevTrack: Successfully restored authentication state'
        );
        return true;
      }
    }
  } catch (error) {
    services.outputChannel.appendLine(
      `DevTrack: Error restoring auth state - ${error}`
    );
  }
  return false;
}

async function initializeServices(
  context: vscode.ExtensionContext
): Promise<DevTrackServices | null> {
  const outputChannel = vscode.window.createOutputChannel('DevTrack');
  context.subscriptions.push(outputChannel);
  outputChannel.appendLine('DevTrack: Extension activated.');

  const services: DevTrackServices = {
    outputChannel,
    githubService: new GitHubService(outputChannel),
    gitService: new GitService(outputChannel),
    tracker: new Tracker(outputChannel),
    summaryGenerator: new SummaryGenerator(outputChannel, context),
    scheduler: null,
    trackingStatusBar: createStatusBarItem('tracking'),
    authStatusBar: createStatusBarItem('auth'),
    extensionContext: context,
  };

  // Add status bars to subscriptions
  context.subscriptions.push(
    services.trackingStatusBar,
    services.authStatusBar
  );

  // Try to restore authentication state
  const authRestored = await restoreAuthenticationState(context, services);

  if (!authRestored) {
    // If restoration failed, check if we should show the initial setup prompt
    const shouldPrompt = context.globalState.get(
      'devtrackShouldPromptAuth',
      true
    );
    if (shouldPrompt) {
      const response = await vscode.window.showInformationMessage(
        'DevTrack needs to connect to GitHub. Would you like to connect now?',
        'Yes',
        'No',
        "Don't Ask Again"
      );

      if (response === 'Yes') {
        vscode.commands.executeCommand('devtrack.login');
      } else if (response === "Don't Ask Again") {
        await context.globalState.update('devtrackShouldPromptAuth', false);
      }
    }
  }

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

// Update the interface to include extensionContext
interface DevTrackServices {
  outputChannel: vscode.OutputChannel;
  githubService: GitHubService;
  gitService: GitService;
  tracker: Tracker;
  summaryGenerator: SummaryGenerator;
  scheduler: Scheduler | null;
  trackingStatusBar: vscode.StatusBarItem;
  authStatusBar: vscode.StatusBarItem;
  extensionContext: vscode.ExtensionContext;
}

async function initializeDevTrack(services: DevTrackServices) {
  try {
    services.outputChannel.appendLine('DevTrack: Starting initialization...');

    // Verify Git installation with improved error handling
    if (
      !(await GitInstallationHandler.checkGitInstallation(
        services.outputChannel
      ))
    ) {
      const response = await vscode.window.showErrorMessage(
        'DevTrack requires Git to be installed and properly configured. Would you like to see the installation guide?',
        'Show Guide',
        'Cancel'
      );

      if (response === 'Show Guide') {
        await vscode.commands.executeCommand('devtrack.showGitGuide');
      }
      throw new Error(
        'Git must be installed before DevTrack can be initialized.'
      );
    }

    // Get GitHub authentication
    const session = await vscode.authentication.getSession(
      'github',
      ['repo', 'read:user', 'user:email'],
      { createIfNone: true, clearSessionPreference: true }
    );

    if (!session) {
      throw new Error('GitHub authentication is required to use DevTrack.');
    }

    // Initialize GitHub service
    try {
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

      // Persist authentication state using the context from services
      await services.extensionContext.globalState.update('devtrackAuthState', {
        username,
        repoName,
        lastWorkspace: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      });

      updateStatusBar(services, 'auth', true);
      updateStatusBar(services, 'tracking', true);

      services.outputChannel.appendLine(
        'DevTrack: Initialization completed successfully.'
      );
      vscode.window.showInformationMessage(
        'DevTrack has been set up successfully and tracking has started.'
      );
    } catch (error: any) {
      if (error.message.includes('git')) {
        // Show more helpful error message for Git-related issues
        throw new Error(
          'There was an issue with Git configuration. Please ensure Git is properly installed and try again.'
        );
      }
      throw error;
    }
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

export function deactivate() {}
