import * as vscode from 'vscode';
import * as path from 'path';
import { Buffer } from 'node:buffer';
import { homedir } from 'os';
import { GitHubService } from './githubService';
import { GitService } from './gitService';
import { Tracker } from './tracker';
import { SummaryGenerator } from './summaryGenerator';
import { Scheduler } from './scheduler';
import { StatisticsProvider } from './statisticsProvider';
import { StatisticsView } from './statisticsView';

export interface WorkspaceRuntime {
  folder: vscode.WorkspaceFolder;
  trackingDir: string;
  gitService: GitService;
  tracker: Tracker;
  scheduler: Scheduler | null;
  statisticsProvider?: StatisticsProvider;
  statisticsView?: StatisticsView;
}

export class WorkspaceCoordinator {
  private runtimes = new Map<string, WorkspaceRuntime>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly outputChannel: vscode.OutputChannel,
    private readonly githubService: GitHubService,
    private readonly summaryGenerator: SummaryGenerator,
    private readonly countdownStatusBar: vscode.StatusBarItem
  ) {}

  getWorkspaceFolders(): vscode.WorkspaceFolder[] {
    return vscode.workspace.workspaceFolders ?? [];
  }

  getActiveFolder(): vscode.WorkspaceFolder | null {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (activeUri) {
      const folder = vscode.workspace.getWorkspaceFolder(activeUri);
      if (folder) {
        return folder;
      }
    }
    const folders = this.getWorkspaceFolders();
    return folders[0] ?? null;
  }

  async pickFolder(): Promise<vscode.WorkspaceFolder | null> {
    const folders = this.getWorkspaceFolders();
    if (folders.length === 0) {
      return null;
    }
    if (folders.length === 1) {
      return folders[0];
    }

    const picked = await vscode.window.showQuickPick(
      folders.map((f) => ({
        label: f.name,
        description: f.uri.fsPath,
        folder: f,
      })),
      { title: 'Select workspace folder for DevTrack' }
    );
    return picked?.folder ?? null;
  }

  getTrackingDir(folder: vscode.WorkspaceFolder): string {
    const workspaceId = Buffer.from(folder.uri.fsPath)
      .toString('base64')
      .replace(/[/+=]/g, '_');
    return path.join(homedir(), '.devtrack', 'tracking', workspaceId);
  }

  getOrCreateRuntime(folder: vscode.WorkspaceFolder): WorkspaceRuntime {
    const key = folder.uri.toString();
    const existing = this.runtimes.get(key);
    if (existing) {
      return existing;
    }

    const trackingDir = this.getTrackingDir(folder);
    const gitService = new GitService(this.outputChannel, trackingDir);
    const tracker = new Tracker(this.outputChannel, trackingDir, folder);

    let statisticsProvider: StatisticsProvider | undefined;
    let statisticsView: StatisticsView | undefined;
    try {
      statisticsProvider = new StatisticsProvider(
        this.outputChannel,
        trackingDir
      );
      statisticsView = new StatisticsView(
        this.context,
        statisticsProvider,
        this.outputChannel,
        trackingDir
      );
    } catch {
      // optional
    }

    const runtime: WorkspaceRuntime = {
      folder,
      trackingDir,
      gitService,
      tracker,
      scheduler: null,
      statisticsProvider,
      statisticsView,
    };
    this.runtimes.set(key, runtime);
    return runtime;
  }

  tryGetRuntime(folder: vscode.WorkspaceFolder): WorkspaceRuntime | null {
    const key = folder.uri.toString();
    return this.runtimes.get(key) ?? null;
  }

  getAllRuntimes(): WorkspaceRuntime[] {
    return Array.from(this.runtimes.values());
  }

  isTracking(runtime: WorkspaceRuntime): boolean {
    return Boolean(runtime.scheduler);
  }

  async selectRuntime(): Promise<WorkspaceRuntime | null> {
    const active = this.getActiveFolder();
    const folders = this.getWorkspaceFolders();
    if (!active) {
      return null;
    }
    if (folders.length === 1) {
      return this.getOrCreateRuntime(active);
    }

    // If we can infer from active editor, use it; otherwise prompt.
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    const inferred = activeUri
      ? vscode.workspace.getWorkspaceFolder(activeUri)
      : null;
    const folder = inferred ?? (await this.pickFolder());
    return folder ? this.getOrCreateRuntime(folder) : null;
  }

  async ensureScheduler(runtime: WorkspaceRuntime): Promise<Scheduler> {
    if (runtime.scheduler) {
      return runtime.scheduler;
    }
    const config = vscode.workspace.getConfiguration('devtrack');
    const commitFrequency = config.get<number>('commitFrequency') || 30;
    runtime.scheduler = new Scheduler(
      commitFrequency,
      runtime.tracker,
      this.summaryGenerator,
      runtime.gitService,
      this.outputChannel,
      this.countdownStatusBar
    );
    return runtime.scheduler;
  }

  async startTracking(
    runtime: WorkspaceRuntime,
    remoteUrl: string
  ): Promise<void> {
    // Shared countdown/status bar: keep only one workspace actively tracking at a time.
    for (const other of this.getAllRuntimes()) {
      if (other.folder.uri.toString() !== runtime.folder.uri.toString()) {
        if (other.scheduler) {
          this.stopTracking(other);
        }
      }
    }

    await runtime.gitService.ensureRepoSetup(remoteUrl);
    const identity = await this.githubService.getAuthenticatedIdentity();
    if (identity) {
      await runtime.gitService.configureCommitAttribution(identity);
    }
    const scheduler = await this.ensureScheduler(runtime);
    runtime.tracker.startTracking();
    scheduler.start();
  }

  stopTracking(runtime: WorkspaceRuntime): void {
    runtime.tracker.stopTracking();
    runtime.scheduler?.stop();
    runtime.scheduler = null;
  }
}
