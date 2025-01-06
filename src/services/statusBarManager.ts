// src/services/statusBarManager.ts
import * as vscode from 'vscode';

export class StatusBarManager {
  private workspaceStatusBar: vscode.StatusBarItem;
  private trackingStatusBar: vscode.StatusBarItem;
  private authStatusBar: vscode.StatusBarItem;

  constructor() {
    // Create workspace status item
    this.workspaceStatusBar = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      102
    );
    this.workspaceStatusBar.text = '$(folder) Open Folder to Start';
    this.workspaceStatusBar.command = 'vscode.openFolder';

    // Create tracking status item
    this.trackingStatusBar = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      101
    );
    this.trackingStatusBar.text = '$(circle-slash) DevTrack: Stopped';
    this.trackingStatusBar.command = 'devtrack.startTracking';

    // Create auth status item
    this.authStatusBar = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.authStatusBar.text = '$(mark-github) DevTrack: Not Connected';
    this.authStatusBar.command = 'devtrack.login';

    // Initial update
    this.updateVisibility();

    // Listen for workspace folder changes
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      this.updateVisibility();
    });
  }

  private hasWorkspace(): boolean {
    return (vscode.workspace.workspaceFolders ?? []).length > 0;
  }

  private updateVisibility() {
    if (this.hasWorkspace()) {
      this.workspaceStatusBar.hide();
      this.trackingStatusBar.show();
      this.authStatusBar.show();
    } else {
      this.workspaceStatusBar.show();
      this.trackingStatusBar.hide();
      this.authStatusBar.hide();
    }
  }

  public updateTrackingStatus(isTracking: boolean) {
    this.trackingStatusBar.text = isTracking
      ? '$(clock) DevTrack: Tracking'
      : '$(circle-slash) DevTrack: Stopped';
    this.trackingStatusBar.tooltip = isTracking
      ? 'Click to stop tracking'
      : 'Click to start tracking';
    this.trackingStatusBar.command = isTracking
      ? 'devtrack.stopTracking'
      : 'devtrack.startTracking';
  }

  public updateAuthStatus(isConnected: boolean) {
    this.authStatusBar.text = isConnected
      ? '$(check) DevTrack: Connected'
      : '$(mark-github) DevTrack: Not Connected';
    this.authStatusBar.tooltip = isConnected
      ? 'Connected to GitHub'
      : 'Click to connect to GitHub';
    this.authStatusBar.command = isConnected
      ? 'devtrack.logout'
      : 'devtrack.login';
  }

  public dispose() {
    this.workspaceStatusBar.dispose();
    this.trackingStatusBar.dispose();
    this.authStatusBar.dispose();
  }
}
