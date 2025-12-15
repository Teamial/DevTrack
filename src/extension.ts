/* eslint-disable no-unused-vars */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { Buffer } from 'node:buffer';
import { GitHubService } from './services/githubService';
import { GitService } from './services/gitService';
import { Tracker } from './services/tracker';
import { SummaryGenerator } from './services/summaryGenerator';
import { Scheduler } from './services/scheduler';
import { ChangeAnalyzer } from './services/changeAnalyzer';
import { platform, homedir } from 'os';
import { StatisticsProvider } from './services/statisticsProvider';
import { StatisticsView } from './services/statisticsView';

// Interfaces
interface PersistedAuthState {
  username?: string;
  repoName?: string;
  lastWorkspace?: string;
}

interface DevTrackServices {
  outputChannel: vscode.OutputChannel;
  githubService: GitHubService;
  gitService: GitService;
  tracker: Tracker;
  summaryGenerator: SummaryGenerator;
  scheduler: Scheduler | null;
  trackingStatusBar: vscode.StatusBarItem;
  authStatusBar: vscode.StatusBarItem;
  countdownStatusBar: vscode.StatusBarItem;
  extensionContext: vscode.ExtensionContext;
  changeAnalyzer: ChangeAnalyzer;
  statisticsProvider?: StatisticsProvider;
  statisticsView?: StatisticsView;
}

// Extension Activation
export async function activate(
  context: vscode.ExtensionContext
): Promise<void> {
  // Create output channel first to be used throughout
  const channel = vscode.window.createOutputChannel('DevTrack');
  context.subscriptions.push(channel);
  channel.appendLine('DevTrack: Extension activating...');

  try {
    // Register test command
    const testCommand = vscode.commands.registerCommand('devtrack.test', () => {
      vscode.window.showInformationMessage(
        'DevTrack Debug Version: Test Command Executed'
      );
    });
    context.subscriptions.push(testCommand);

    // Initialize services with the created output channel
    const services = await initializeServices(context, channel);
    if (!services) {
      return;
    }

    // Register commands and setup handlers
    await registerCommands(context, services);
    // Also register website commands
    await registerWebsiteCommands(context, services);
    // Register dashboard and statistics commands
    await registerDashboardCommands(context, services);
    setupConfigurationHandling(services);
    // Workspace UI mediation (no folder open => show Open Folder; stop countdown)
    const workspaceWatcher = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      updateWorkspaceUI(services);
      attemptAutoStart(services);
    });
    context.subscriptions.push(workspaceWatcher);

    updateWorkspaceUI(services);
    attemptAutoStart(services);

    // If autoStart is enabled, skip welcome prompt to avoid double prompting.
    const config = vscode.workspace.getConfiguration('devtrack');
    const autoStart = config.get<boolean>('autoStart', true);
    if (!autoStart) {
      showWelcomeMessage(context, services);
    }

    channel.appendLine('DevTrack: Extension activated successfully');
  } catch (error) {
    channel.appendLine(`DevTrack: Activation error - ${error}`);
    vscode.window.showErrorMessage('DevTrack: Failed to activate extension');
  }
}

function hasWorkspaceOpen(): boolean {
  return (vscode.workspace.workspaceFolders ?? []).length > 0;
}

function updateWorkspaceUI(services: DevTrackServices): void {
  if (!hasWorkspaceOpen()) {
    // Stop any running tracking loop
    try {
      services.tracker.stopTracking();
      if (services.scheduler) {
        services.scheduler.stop();
        services.scheduler = null;
      }
    } catch {
      // ignore
    }

    // Show affordance to open a folder
    services.trackingStatusBar.text = '$(folder) DevTrack: Open Folder';
    services.trackingStatusBar.tooltip = 'Open a folder to start DevTrack tracking';
    services.trackingStatusBar.command = 'devtrack.openFolder';
    services.trackingStatusBar.show();

    services.authStatusBar.hide();
    services.countdownStatusBar.hide();

    vscode.commands.executeCommand('setContext', 'devtrack:isInitialized', false);
    vscode.commands.executeCommand('setContext', 'devtrack:isTracking', false);
    return;
  }

  // Workspace is open: restore normal status bar visibility; state will be updated by login/restore
  services.trackingStatusBar.show();
  services.authStatusBar.show();
  // Countdown is controlled by Scheduler; keep it hidden unless tracking is active.
  if (!services.scheduler) {
    services.countdownStatusBar.hide();
  }
}

async function attemptAutoStart(services: DevTrackServices): Promise<void> {
  const config = vscode.workspace.getConfiguration('devtrack');
  const autoStart = config.get<boolean>('autoStart', true);
  if (!autoStart || !hasWorkspaceOpen()) {
    return;
  }

  // If already initialized, nothing to do.
  if (services.scheduler) {
    return;
  }

  // Prompt login/setup (this will be silent if an existing session exists).
  try {
    await vscode.commands.executeCommand('devtrack.login');
  } catch (e) {
    // ignore; user may cancel auth prompt
  }
}

// Services Initialization
async function initializeServices(
  context: vscode.ExtensionContext,
  channel: vscode.OutputChannel
): Promise<DevTrackServices | null> {
  try {
    // Use os.homedir() instead of process.env
    const homeDir = homedir();
    if (!homeDir) {
      throw new Error('Unable to determine home directory');
    }

    // Create tracking directory structure
    const trackingBase = path.join(homeDir, '.devtrack', 'tracking');
    await fs.promises.mkdir(trackingBase, { recursive: true });

    // Create workspace-specific tracking directory
    const workspaceId = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
      ? Buffer.from(vscode.workspace.workspaceFolders[0].uri.fsPath)
          .toString('base64')
          .replace(/[/+=]/g, '_')
      : 'default';
    const trackingDir = path.join(trackingBase, workspaceId);
    await fs.promises.mkdir(trackingDir, { recursive: true });

    // Initialize services
    const services: DevTrackServices = {
      outputChannel: channel,
      githubService: new GitHubService(channel),
      gitService: new GitService(channel),
      tracker: new Tracker(channel, trackingDir),
      summaryGenerator: new SummaryGenerator(channel, context),
      scheduler: null,
      trackingStatusBar: createStatusBarItem('tracking'),
      authStatusBar: createStatusBarItem('auth'),
      countdownStatusBar: createStatusBarItem('countdown'),
      extensionContext: context,
      changeAnalyzer: new ChangeAnalyzer(channel),
    };

    // Initialize statistics provider if available
    try {
      services.statisticsProvider = new StatisticsProvider(
        channel,
        trackingDir
      );
      services.statisticsView = new StatisticsView(
        context,
        services.statisticsProvider,
        channel,
        trackingDir
      );
      channel.appendLine('DevTrack: Statistics services initialized');
    } catch (error) {
      channel.appendLine(
        `DevTrack: Statistics initialization error - ${error}`
      );
      // Continue without statistics (non-fatal)
    }

    // Add status bars to subscriptions and show them
    context.subscriptions.push(
      services.trackingStatusBar,
      services.authStatusBar,
      services.countdownStatusBar
    );
    services.trackingStatusBar.show();
    services.authStatusBar.show();
    // Countdown bar shows only when tracking is active

    // Initialize command palette contexts
    vscode.commands.executeCommand('setContext', 'devtrack:isInitialized', false);
    vscode.commands.executeCommand('setContext', 'devtrack:isTracking', false);

    // Try to restore authentication state
    const restored = await restoreAuthenticationState(context, services);
    if (restored) {
      vscode.commands.executeCommand('setContext', 'devtrack:isInitialized', true);
      vscode.commands.executeCommand('setContext', 'devtrack:isTracking', true);
    }

    return services;
  } catch (error) {
    channel.appendLine(`DevTrack: Service initialization error - ${error}`);
    return null;
  }
}

// Register dashboard commands
async function registerDashboardCommands(
  context: vscode.ExtensionContext,
  services: DevTrackServices
): Promise<void> {
  // Show dashboard command
  const showDashboardCommand = vscode.commands.registerCommand(
    'devtrack.showDashboard',
    async () => {
      if (services.statisticsView) {
        services.statisticsView.show();
      } else {
        vscode.window.showErrorMessage(
          'DevTrack: Statistics view not available'
        );
      }
    }
  );
  context.subscriptions.push(showDashboardCommand);

  // Generate report command
  const generateReportCommand = vscode.commands.registerCommand(
    'devtrack.generateReport',
    async () => {
      if (!services.statisticsProvider) {
        vscode.window.showErrorMessage(
          'DevTrack: Statistics provider not available'
        );
        return;
      }

      try {
        vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'DevTrack: Generating coding report',
            cancellable: false,
          },
          async (progress) => {
            progress.report({ message: 'Collecting statistics...' });
            const stats = await services.statisticsProvider?.getStatistics();

            if (!stats) {
              throw new Error('Failed to retrieve statistics');
            }

            // Create report markdown
            const reportContent = `# DevTrack Coding Report

## Summary
- **Total Coding Time:** ${Math.round(stats.totalTime)} hours
- **Files Modified:** ${stats.filesModified}
- **Total Commits:** ${stats.totalCommits}
- **Lines Changed:** ${stats.linesChanged.toLocaleString()}

## File Type Distribution
${
  stats.fileTypes && stats.fileTypes.length > 0
    ? stats.fileTypes
        .slice(0, 5)
        .map((ft) => `- **${ft.name || 'Unknown'}:** ${ft.count} files`)
        .join('\n')
    : '- No file type data available'
}

## Most Active Times
${
  stats.timeDistribution && stats.timeDistribution.length > 0
    ? [...stats.timeDistribution]
        .sort((a, b) => b.changes - a.changes)
        .slice(0, 3)
        .map((td) => `- **${td.hour}:** ${td.changes} changes`)
        .join('\n')
    : '- No activity time data available'
}

*Generated by DevTrack on ${new Date().toLocaleDateString()}*
`;

            // Show the report in a new editor
            const doc = await vscode.workspace.openTextDocument({
              content: reportContent,
              language: 'markdown',
            });
            await vscode.window.showTextDocument(doc);

            progress.report({ message: 'Done' });
          }
        );
      } catch (error) {
        services.outputChannel.appendLine(
          `DevTrack: Error generating report - ${error}`
        );
        vscode.window.showErrorMessage('DevTrack: Failed to generate report');
      }
    }
  );
  context.subscriptions.push(generateReportCommand);
}

async function registerWebsiteCommands(
  context: vscode.ExtensionContext,
  services: DevTrackServices
): Promise<void> {
  // Register command to manually generate the website
  const generateWebsiteCommand = vscode.commands.registerCommand(
    'devtrack.generateWebsite',
    async () => {
      try {
        vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'DevTrack: Generating statistics website',
            cancellable: false,
          },
          async (progress) => {
            progress.report({ message: 'Initializing...' });

            // Import WebsiteGenerator dynamically to avoid circular dependencies
            const { WebsiteGenerator } = await import(
              './services/websiteGenerator'
            );

            // Get home directory and tracking path
            const homeDir = homedir();

            // Create workspace-specific tracking directory
            const workspaceId = vscode.workspace.workspaceFolders?.[0]?.uri
              .fsPath
              ? Buffer.from(vscode.workspace.workspaceFolders[0].uri.fsPath)
                  .toString('base64')
                  .replace(/[/+=]/g, '_')
              : 'default';
            const trackingDir = path.join(
              homeDir,
              '.devtrack',
              'tracking',
              workspaceId
            );

            progress.report({ message: 'Generating website files...' });

            // Create website generator
            const websiteGenerator = new WebsiteGenerator(
              services.outputChannel,
              trackingDir
            );
            await websiteGenerator.generateWebsite();

            progress.report({ message: 'Committing changes...' });

            // Instead of directly accessing git, use commitAndPush method
            await services.gitService.commitAndPush(
              'DevTrack: Update statistics website'
            );

            progress.report({ message: 'Done' });

            // Show success message with GitHub Pages URL
            const username = await services.githubService.getUsername();
            const config = vscode.workspace.getConfiguration('devtrack');
            const repoName = config.get<string>('repoName') || 'code-tracking';

            if (username) {
              const pagesUrl = `https://${username}.github.io/${repoName}/`;

              const viewWebsite = 'View Website';
              vscode.window
                .showInformationMessage(
                  `DevTrack: Statistics website generated and pushed to GitHub. It should be available soon at ${pagesUrl}`,
                  viewWebsite
                )
                .then((selection) => {
                  if (selection === viewWebsite) {
                    vscode.env.openExternal(vscode.Uri.parse(pagesUrl));
                  }
                });
            } else {
              vscode.window.showInformationMessage(
                'DevTrack: Statistics website generated and pushed to GitHub. It should be available soon.'
              );
            }
          }
        );
      } catch (error: any) {
        services.outputChannel.appendLine(
          `DevTrack: Failed to generate website - ${error.message}`
        );
        vscode.window.showErrorMessage(
          `DevTrack: Failed to generate website - ${error.message}`
        );
      }
    }
  );

  context.subscriptions.push(generateWebsiteCommand);
}

// Status Bar Creation
function createStatusBarItem(
  type: 'tracking' | 'auth' | 'countdown'
): vscode.StatusBarItem {
  let priority = 100;
  if (type === 'tracking') {
    priority = 100;
  }
  if (type === 'auth') {
    priority = 101;
  }
  if (type === 'countdown') {
    priority = 99;
  }

  const item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    priority
  );

  if (type === 'tracking') {
    item.text = '$(circle-slash) DevTrack: Stopped';
    item.tooltip = 'Click to start/stop tracking';
    item.command = 'devtrack.startTracking';
  } else if (type === 'auth') {
    item.text = '$(mark-github) DevTrack: Not Connected';
    item.tooltip = 'Click to connect to GitHub';
    item.command = 'devtrack.login';
  } else if (type === 'countdown') {
    item.text = '$(clock)';
    item.tooltip = 'Time until next DevTrack commit';
    item.command = 'devtrack.commitNow';
    // Don't show by default - only when active
    item.hide();
  }

  return item;
}

// Authentication State Management
async function restoreAuthenticationState(
  context: vscode.ExtensionContext,
  services: DevTrackServices
): Promise<boolean> {
  try {
    const persistedState =
      context.globalState.get<PersistedAuthState>('devtrackAuthState');
    if (!persistedState?.username) {
      return false;
    }

    const session = await vscode.authentication.getSession(
      'github',
      ['repo', 'read:user'],
      {
        createIfNone: false,
        silent: true,
      }
    );

    if (session) {
      services.githubService.setToken(session.accessToken);
      const identity = await services.githubService.getAuthenticatedIdentity();
      const username = identity?.login ?? (await services.githubService.getUsername());

      if (username === persistedState.username) {
        const repoName = persistedState.repoName || 'code-tracking';
        const remoteUrl = `https://github.com/${username}/${repoName}.git`;

        await services.gitService.ensureRepoSetup(remoteUrl);
        // Ensure commits are authored as the authenticated GitHub user
        if (identity) {
          await services.gitService.configureCommitAttribution(identity);
        }
        await initializeTracker(services);

        updateStatusBar(services, 'auth', true);
        updateStatusBar(services, 'tracking', true);
        vscode.commands.executeCommand('setContext', 'devtrack:isInitialized', true);
        vscode.commands.executeCommand('setContext', 'devtrack:isTracking', true);

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

// Command Registration
async function registerCommands(
  context: vscode.ExtensionContext,
  services: DevTrackServices
): Promise<void> {
  const commands = [
    {
      command: 'devtrack.startTracking',
      callback: () => handleStartTracking(services),
    },
    {
      command: 'devtrack.stopTracking',
      callback: () => handleStopTracking(services),
    },
    {
      command: 'devtrack.login',
      callback: () => handleLogin(services),
    },
    {
      command: 'devtrack.logout',
      callback: () => handleLogout(services),
    },
    {
      command: 'devtrack.showGitGuide',
      callback: () => GitInstallationHandler.showInstallationGuide(),
    },
    {
      command: 'devtrack.openFolder',
      callback: () => vscode.commands.executeCommand('vscode.openFolder'),
    },
    // New commands
    {
      command: 'devtrack.commitNow',
      callback: () => handleCommitNow(services),
    },
    {
      command: 'devtrack.pauseTracking',
      callback: () => handlePauseTracking(services),
    },
    {
      command: 'devtrack.resumeTracking',
      callback: () => handleResumeTracking(services),
    },
    {
      command: 'devtrack.showSettings',
      callback: () => handleShowSettings(),
    },
  ];

  commands.forEach(({ command, callback }) => {
    context.subscriptions.push(
      vscode.commands.registerCommand(command, callback)
    );
  });
}

// New command handlers
async function handleCommitNow(services: DevTrackServices): Promise<void> {
  if (!services.scheduler) {
    vscode.window.showErrorMessage('DevTrack: Tracking not active');
    return;
  }

  await services.scheduler.commitNow();
}

async function handlePauseTracking(services: DevTrackServices): Promise<void> {
  if (!services.scheduler) {
    vscode.window.showErrorMessage('DevTrack: Tracking not active');
    return;
  }

  services.tracker.stopTracking();
  services.scheduler.stop();
  updateStatusBar(services, 'tracking', false);
  vscode.window.showInformationMessage('DevTrack: Tracking paused');
  vscode.commands.executeCommand('setContext', 'devtrack:isTracking', false);
}

async function handleResumeTracking(services: DevTrackServices): Promise<void> {
  if (!services.scheduler) {
    await handleStartTracking(services);
    return;
  }

  services.tracker.startTracking();
  services.scheduler.start();
  updateStatusBar(services, 'tracking', true);
  vscode.window.showInformationMessage('DevTrack: Tracking resumed');
  vscode.commands.executeCommand('setContext', 'devtrack:isTracking', true);
}

function handleShowSettings(): void {
  vscode.commands.executeCommand('workbench.action.openSettings', 'devtrack');
}

// Command Handlers
async function handleStartTracking(services: DevTrackServices): Promise<void> {
  try {
    if (!vscode.workspace.workspaceFolders?.length) {
      throw new Error(
        'Please open a folder or workspace before starting tracking.'
      );
    }

    const gitInstalled = await GitInstallationHandler.checkGitInstallation(
      services.outputChannel
    );
    if (!gitInstalled) {
      return;
    }

    if (services.scheduler) {
      services.scheduler.start();
      services.tracker.startTracking(); // Make sure tracker is also tracking
      updateStatusBar(services, 'tracking', true);
      vscode.window.showInformationMessage('DevTrack: Tracking started.');
      vscode.commands.executeCommand('setContext', 'devtrack:isTracking', true);
      vscode.commands.executeCommand('setContext', 'devtrack:isInitialized', true);
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
  } catch (error: unknown) {
    handleError(services, 'Error starting tracking', error as Error);
  }
}

async function handleStopTracking(services: DevTrackServices): Promise<void> {
  if (services.scheduler) {
    services.scheduler.stop();
    services.tracker.stopTracking(); // Stop the tracker too
    updateStatusBar(services, 'tracking', false);
    vscode.window.showInformationMessage('DevTrack: Tracking stopped.');
    vscode.commands.executeCommand('setContext', 'devtrack:isTracking', false);
  } else {
    vscode.window.showErrorMessage('DevTrack: Please connect to GitHub first.');
  }
}

async function handleLogin(services: DevTrackServices): Promise<void> {
  try {
    services.outputChannel.appendLine('DevTrack: Starting login process...');

    const session = await vscode.authentication.getSession(
      'github',
      ['repo', 'read:user'],
      { createIfNone: true }
    );

    if (session) {
      services.githubService.setToken(session.accessToken);
      await initializeDevTrack(services);
    } else {
      vscode.window.showInformationMessage(
        'DevTrack: GitHub connection was cancelled.'
      );
    }
  } catch (error: any) {
    handleError(services, 'Login failed', error);
  }
}

async function handleLogout(services: DevTrackServices): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(
    'Are you sure you want to logout from DevTrack?',
    { modal: true },
    'Yes',
    'No'
  );

  if (confirm !== 'Yes') {
    return;
  }

  try {
    cleanup(services);
    await services.extensionContext.globalState.update(
      'devtrackAuthState',
      undefined
    );
    vscode.window.showInformationMessage('DevTrack: Successfully logged out.');

    const loginChoice = await vscode.window.showInformationMessage(
      'Would you like to log in with a different account?',
      'Yes',
      'No'
    );

    if (loginChoice === 'Yes') {
      await vscode.commands.executeCommand('devtrack.login');
    }
  } catch (error: any) {
    handleError(services, 'Logout failed', error);
  }
}

// GitInstallationHandler Class
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
    } catch {
      const currentPlatform = platform();
      const response = await vscode.window.showErrorMessage(
        'Git is required but not found on your system.',
        {
          modal: true,
          detail: 'Would you like to view the installation guide?',
        },
        'Show Installation Guide',
        ...(currentPlatform === 'win32' ? ['Fix PATH Issue'] : []),
        'Cancel'
      );

      if (response === 'Show Installation Guide') {
        this.showInstallationGuide();
      } else if (response === 'Fix PATH Issue') {
        this.showPathFixGuide();
      }
      return false;
    }
  }

  public static showInstallationGuide(): void {
    const panel = vscode.window.createWebviewPanel(
      'gitInstallGuide',
      'Git Installation Guide',
      vscode.ViewColumn.One,
      { enableScripts: true }
    );

    const currentPlatform = platform();
    const downloadUrl =
      this.DOWNLOAD_URLS[currentPlatform as keyof typeof this.DOWNLOAD_URLS];
    const instructions = this.getInstructions(currentPlatform);
    panel.webview.html = this.getWebviewContent(instructions, downloadUrl);
  }

  private static showPathFixGuide(): void {
    const panel = vscode.window.createWebviewPanel(
      'gitPathGuide',
      'Fix Git PATH Issue',
      vscode.ViewColumn.One,
      { enableScripts: true }
    );

    panel.webview.html = `<!DOCTYPE html>
    <html>
      <head>
        <style>
          body { padding: 20px; font-family: system-ui; line-height: 1.6; }
          .step { margin-bottom: 20px; padding: 15px; background-color: #f3f3f3; border-radius: 5px; }
          .warning { color: #856404; background-color: #fff3cd; padding: 10px; border-radius: 5px; }
        </style>
      </head>
      <body>
        <h1>Adding Git to System PATH</h1>
        <div class="warning">⚠️ Ensure Git is installed before proceeding.</div>
        <div class="step">
          <h3>Steps:</h3>
          <ol>
            <li>Open System Properties (Windows + R, type sysdm.cpl)</li>
            <li>Go to Advanced tab</li>
            <li>Click Environment Variables</li>
            <li>Under System Variables, find and select Path</li>
            <li>Click Edit</li>
            <li>Add Git paths:
              <ul>
                <li>C:\\Program Files\\Git\\cmd</li>
                <li>C:\\Program Files\\Git\\bin</li>
              </ul>
            </li>
            <li>Click OK on all windows</li>
            <li>Restart VS Code</li>
          </ol>
        </div>
      </body>
    </html>`;
  }

  private static getInstructions(platform: string): string {
    const instructions: Record<string, string> = {
      win32: `Windows Installation:
1. Download Git from ${this.DOWNLOAD_URLS.win32}
2. Run installer
3. Select "Git from command line and 3rd-party software"
4. Select "Use Windows' default console"
5. Enable Git Credential Manager
6. Complete installation
7. Open new terminal and verify with 'git --version'`,
      darwin: `Mac Installation:
Option 1 (Homebrew):
1. Install Homebrew: /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
2. Run: brew install git

Option 2 (Direct):
1. Download from ${this.DOWNLOAD_URLS.darwin}
2. Install the package`,
      linux: `Linux Installation:
Debian/Ubuntu:
1. sudo apt-get update
2. sudo apt-get install git

Fedora:
1. sudo dnf install git`,
    };

    return instructions[platform] || instructions.linux;
  }

  private static getWebviewContent(
    instructions: string,
    downloadUrl: string
  ): string {
    return `<!DOCTYPE html>
    <html>
      <head>
        <style>
          body { padding: 20px; font-family: system-ui; line-height: 1.6; }
          pre { background-color: #f3f3f3; padding: 15px; border-radius: 5px; }
          .download-btn { 
            padding: 10px 20px;
            background-color: #007acc;
            color: white;
            border-radius: 5px;
            text-decoration: none;
            display: inline-block;
            margin-top: 20px;
          }
        </style>
      </head>
      <body>
        <h1>Git Installation Guide</h1>
        <pre>${instructions}</pre>
        <a href="${downloadUrl}" class="download-btn" target="_blank">Download Git</a>
      </body>
    </html>`;
  }
}

// DevTrack Initialization
async function initializeDevTrack(services: DevTrackServices): Promise<void> {
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

    // Get GitHub session
    const session = await vscode.authentication.getSession(
      'github',
      ['repo', 'read:user'],
      { createIfNone: true }
    );

    if (!session) {
      throw new Error('GitHub authentication is required to use DevTrack.');
    }

    // Initialize GitHub service
    services.githubService.setToken(session.accessToken);
    const identity = await services.githubService.getAuthenticatedIdentity();
    const username = identity?.login ?? (await services.githubService.getUsername());

    if (!username) {
      throw new Error('Unable to retrieve GitHub username.');
    }

    // Setup repository
    const config = vscode.workspace.getConfiguration('devtrack');
    const repoName = config.get<string>('repoName') || 'code-tracking';
    const repoVisibility =
      config.get<string>('repoVisibility') || 'private';
    const isPrivateRepo = repoVisibility !== 'public';
    const remoteUrl = `https://github.com/${username}/${repoName}.git`;

    // Create repository if it doesn't exist
    const repoExists = await services.githubService.repoExists(repoName);
    if (!repoExists) {
      const createdRepoUrl = await services.githubService.createRepo(
        repoName,
        'DevTrack Repository',
        isPrivateRepo
      );
      if (!createdRepoUrl) {
        throw new Error('Failed to create GitHub repository.');
      }
    }

    // Initialize Git repository
    await services.gitService.ensureRepoSetup(remoteUrl);
    // Ensure commits are authored as the authenticated GitHub user
    if (identity) {
      await services.gitService.configureCommitAttribution(identity);
    }

    // Initialize tracker
    await initializeTracker(services);

    // Update UI and persist state
    updateStatusBar(services, 'auth', true);
    updateStatusBar(services, 'tracking', true);
    vscode.commands.executeCommand('setContext', 'devtrack:isInitialized', true);
    vscode.commands.executeCommand('setContext', 'devtrack:isTracking', true);

    await services.extensionContext.globalState.update('devtrackAuthState', {
      username,
      repoName,
      lastWorkspace: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    });

    services.outputChannel.appendLine(
      'DevTrack: Initialization completed successfully'
    );
    vscode.window.showInformationMessage(
      'DevTrack has been set up successfully and tracking has started.'
    );
  } catch (error: any) {
    handleError(services, 'Initialization failed', error);
    throw error;
  }
}

// Tracker Initialization
async function initializeTracker(services: DevTrackServices): Promise<void> {
  const config = vscode.workspace.getConfiguration('devtrack');
  const commitFrequency = config.get<number>('commitFrequency') || 30;

  services.scheduler = new Scheduler(
    commitFrequency,
    services.tracker,
    services.summaryGenerator,
    services.gitService,
    services.outputChannel,
    services.countdownStatusBar
  );

  // Start tracker
  services.tracker.startTracking();
  services.scheduler.start();

  services.outputChannel.appendLine(
    `DevTrack: Tracker initialized with ${commitFrequency} minute intervals`
  );
}

// Configuration Handling
function setupConfigurationHandling(services: DevTrackServices): void {
  vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('devtrack')) {
      handleConfigurationChange(services);
    }
  });
}

async function handleConfigurationChange(
  services: DevTrackServices
): Promise<void> {
  try {
    const config = vscode.workspace.getConfiguration('devtrack');

    // Update commit frequency if scheduler exists
    if (services.scheduler) {
      const newFrequency = config.get<number>('commitFrequency') || 30;
      services.scheduler.updateFrequency(newFrequency);
      services.outputChannel.appendLine(
        `DevTrack: Updated commit frequency to ${newFrequency} minutes`
      );

      // Update scheduler options
      const minChangesForCommit =
        config.get<number>('minChangesForCommit') || 1;
      const minActiveTimeForCommit =
        config.get<number>('minActiveTimeForCommit') || 60;
      const enableAdaptiveScheduling =
        config.get<boolean>('enableAdaptiveScheduling') ?? true;

      services.scheduler.updateOptions({
        minChangesForCommit,
        minActiveTimeForCommit,
        enableAdaptiveScheduling,
      });
    }

    // Update exclude patterns
    const newExcludePatterns = config.get<string[]>('exclude') || [];
    services.tracker.updateExcludePatterns(newExcludePatterns);
    services.outputChannel.appendLine('DevTrack: Updated exclude patterns');
  } catch (error: any) {
    handleError(services, 'Configuration update failed', error);
  }
}

// UI Updates
function updateStatusBar(
  services: DevTrackServices,
  type: 'tracking' | 'auth',
  active: boolean
): void {
  if (type === 'tracking') {
    services.trackingStatusBar.text = active
      ? '$(clock) DevTrack: Tracking'
      : '$(circle-slash) DevTrack: Stopped';
    services.trackingStatusBar.tooltip = active
      ? 'Click to stop tracking'
      : 'Click to start tracking';
    services.trackingStatusBar.command = active
      ? 'devtrack.stopTracking'
      : 'devtrack.startTracking';
  } else {
    services.authStatusBar.text = active
      ? '$(check) DevTrack: Connected'
      : '$(mark-github) DevTrack: Not Connected';
    services.authStatusBar.tooltip = active
      ? 'Click to logout'
      : 'Click to connect to GitHub';
    services.authStatusBar.command = active
      ? 'devtrack.logout'
      : 'devtrack.login';
  }
}

// Error Handling
function handleError(
  services: DevTrackServices,
  context: string,
  error: Error
): void {
  const message = error.message || 'An unknown error occurred';
  services.outputChannel.appendLine(`DevTrack: ${context} - ${message}`);
  vscode.window.showErrorMessage(`DevTrack: ${message}`);
}

// Cleanup
function cleanup(services: DevTrackServices): void {
  try {
    services.githubService.setToken('');
    if (services.scheduler) {
      services.scheduler.stop();
      services.scheduler = null;
    }
    services.tracker.stopTracking();
    updateStatusBar(services, 'auth', false);
    updateStatusBar(services, 'tracking', false);
    services.outputChannel.appendLine('DevTrack: Cleaned up services');
  } catch (error: any) {
    services.outputChannel.appendLine(
      `DevTrack: Cleanup error - ${error.message}`
    );
  }
}

// Welcome Message
function showWelcomeMessage(
  context: vscode.ExtensionContext,
  services: DevTrackServices
): void {
  if (!context.globalState.get('devtrackWelcomeShown')) {
    const message =
      'Welcome to DevTrack! Would you like to set up automatic code tracking?';

    vscode.window
      .showInformationMessage(message, 'Get Started', 'Learn More', 'Later')
      .then((selection) => {
        if (selection === 'Get Started') {
          vscode.commands.executeCommand('devtrack.login');
        } else if (selection === 'Learn More') {
          showWelcomeInfo(services.outputChannel);
        }
      });

    context.globalState.update('devtrackWelcomeShown', true);
  }
}

function showWelcomeInfo(outputChannel: vscode.OutputChannel): void {
  const welcomeMessage = `
DevTrack helps you monitor your coding activity by:
- Tracking actual time spent coding (not just when you make commits)
- Creating a private repository with detailed logs of your work
- Generating visual reports of your coding patterns
- Helping you understand your most productive times

To get started, you'll need:
1. A GitHub account
2. An open workspace/folder
3. Git installed on your system
`;

  vscode.window
    .showInformationMessage(welcomeMessage, 'Set Up Now', 'Later')
    .then((choice) => {
      if (choice === 'Set Up Now') {
        vscode.commands.executeCommand('devtrack.login');
      }
    });
}

// Deactivation
export function deactivate(): void {
  // VSCode will handle disposal of subscriptions
}
