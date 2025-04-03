// src/services/tracker.ts
import * as vscode from 'vscode';
import { EventEmitter } from 'events';
import { minimatch } from 'minimatch';
import { OutputChannel } from 'vscode';
import * as path from 'path';

export interface Change {
  uri: vscode.Uri;
  timestamp: Date;
  type: 'added' | 'changed' | 'deleted';
  // Added metrics to each change
  lineCount?: number;
  charCount?: number;
}

export interface ActivityMetrics {
  activeTime: number; // in seconds
  fileChanges: number;
  keystrokes: number;
  lastActiveTimestamp: Date;
}

export class Tracker extends EventEmitter {
  private changes: Map<string, Change> = new Map();
  private watcher!: vscode.FileSystemWatcher;
  private excludePatterns: string[] = [];
  private outputChannel: OutputChannel;
  private trackingDir: string;
  private isInitialized: boolean = false;
  private isTracking: boolean = false;
  
  // New activity tracking
  private activityTimeout: NodeJS.Timeout | null = null;
  private keystrokeCount: number = 0;
  private activeStartTime: Date | null = null;
  private totalActiveTime: number = 0; // in seconds
  private activityMetrics: ActivityMetrics = {
    activeTime: 0,
    fileChanges: 0,
    keystrokes: 0,
    lastActiveTimestamp: new Date()
  };
  
  // Track idle time (default 5 minutes)
  private readonly IDLE_TIMEOUT_MS = 5 * 60 * 1000;
  // Suppress frequent logging
  private lastLogTimestamp: number = 0;
  private readonly LOG_THROTTLE_MS = 5000; // 5 seconds

  constructor(outputChannel: OutputChannel, trackingDir: string) {
    super();
    this.outputChannel = outputChannel;
    this.trackingDir = trackingDir;
    this.initialize();
  }

  private async initialize() {
    try {
      // Wait for workspace to be fully loaded
      if (!vscode.workspace.workspaceFolders?.length) {
        this.log('Waiting for workspace to load...');
        const disposable = vscode.workspace.onDidChangeWorkspaceFolders(() => {
          if (vscode.workspace.workspaceFolders?.length) {
            this.initializeWatcher();
            disposable.dispose();
          }
        });
      } else {
        await this.initializeWatcher();
        this.setupActivityTracking();
      }
    } catch (error) {
      this.outputChannel.appendLine(
        `DevTrack: Initialization error - ${error}`
      );
    }
  }

  private async initializeWatcher() {
    try {
      const config = vscode.workspace.getConfiguration('devtrack');
      this.excludePatterns = config.get<string[]>('exclude') || [];

      // Log current workspace state
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        this.log('No workspace folder found');
        return;
      }

      const workspaceFolder = workspaceFolders[0];
      this.log(
        `Initializing watcher for workspace: ${workspaceFolder.uri.fsPath}`
      );

      // Create watcher with specific glob pattern for code files
      const filePattern = new vscode.RelativePattern(
        workspaceFolder,
        '**/*.{ts,js,py,java,c,cpp,h,hpp,css,scss,html,jsx,tsx,vue,php,rb,go,rs,swift,md,json,yml,yaml}'
      );

      // Dispose existing watcher if it exists
      if (this.watcher) {
        this.watcher.dispose();
      }

      this.watcher = vscode.workspace.createFileSystemWatcher(
        filePattern,
        false, // Don't ignore creates
        false, // Don't ignore changes
        false // Don't ignore deletes
      );

      // Set up event handlers with logging (but throttled)
      this.watcher.onDidChange((uri) => {
        this.logThrottled(`Change detected in file: ${uri.fsPath}`);
        this.handleChange(uri, 'changed');
        this.recordActivity();
      });

      this.watcher.onDidCreate((uri) => {
        this.logThrottled(`New file created: ${uri.fsPath}`);
        this.handleChange(uri, 'added');
        this.recordActivity();
      });

      this.watcher.onDidDelete((uri) => {
        this.logThrottled(`File deleted: ${uri.fsPath}`);
        this.handleChange(uri, 'deleted');
        this.recordActivity();
      });

      // Verify the watcher is active
      this.isInitialized = true;
      this.log('File system watcher successfully initialized');
    } catch (error) {
      this.outputChannel.appendLine(
        `DevTrack: Failed to initialize watcher - ${error}`
      );
      this.isInitialized = false;
    }
  }

  private setupActivityTracking() {
    // Track text document changes
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.contentChanges.length > 0) {
        this.keystrokeCount += event.contentChanges.reduce(
          (total, change) => total + (change.text?.length || 0), 
          0
        );
        this.recordActivity();
      }
    });

    // Track when editor becomes active
    vscode.window.onDidChangeActiveTextEditor(() => {
      this.recordActivity();
    });

    // Track cursor movements & selection changes
    vscode.window.onDidChangeTextEditorSelection(() => {
      this.recordActivity();
    });
    
    // Start active time tracking
    this.startActivityTracking();
  }

  public startTracking() {
    this.isTracking = true;
    this.startActivityTracking();
    this.log('Tracking started');
  }

  public stopTracking() {
    this.isTracking = false;
    this.pauseActivityTracking();
    this.log('Tracking stopped');
  }

  private startActivityTracking() {
    if (!this.isTracking) return;
    
    if (!this.activeStartTime) {
      this.activeStartTime = new Date();
      this.logThrottled('Starting activity tracking');
    }
    
    // Clear any existing timeout
    if (this.activityTimeout) {
      clearTimeout(this.activityTimeout);
    }
    
    // Set a new timeout to detect inactivity
    this.activityTimeout = setTimeout(() => {
      this.pauseActivityTracking();
    }, this.IDLE_TIMEOUT_MS);
  }
  
  private pauseActivityTracking() {
    if (this.activeStartTime) {
      // Calculate active time
      const now = new Date();
      const activeTime = (now.getTime() - this.activeStartTime.getTime()) / 1000;
      this.totalActiveTime += activeTime;
      this.activeStartTime = null;
      
      this.activityMetrics.activeTime = this.totalActiveTime;
      this.activityMetrics.keystrokes = this.keystrokeCount;
      
      this.log(`Activity paused. Active time: ${Math.round(this.totalActiveTime / 60)} minutes`);
      
      // Emit metrics event so other services can use it
      this.emit('activityMetrics', this.activityMetrics);
    }
    
    if (this.activityTimeout) {
      clearTimeout(this.activityTimeout);
      this.activityTimeout = null;
    }
  }
  
  private recordActivity() {
    if (!this.isTracking) return;
    
    this.activityMetrics.lastActiveTimestamp = new Date();
    this.startActivityTracking(); // Restart the idle timer
  }

  private async analyzeFileContent(uri: vscode.Uri): Promise<{lineCount: number, charCount: number}> {
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      return {
        lineCount: document.lineCount,
        charCount: document.getText().length
      };
    } catch (error) {
      return { lineCount: 0, charCount: 0 };
    }
  }

  private shouldTrackFile(filePath: string): boolean {
    // Skip files in tracking directory
    if (filePath.includes(this.trackingDir)) {
      return false;
    }

    // Check exclusions
    const relativePath = vscode.workspace.asRelativePath(filePath);
    const isExcluded = this.excludePatterns.some((pattern) =>
      minimatch(relativePath, pattern)
    );
    if (isExcluded) {
      return false;
    }

    // Check file extension
    const fileExt = path.extname(filePath).toLowerCase().slice(1);
    const trackedExtensions = [
      'ts', 'js', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'css',
      'scss', 'html', 'jsx', 'tsx', 'vue', 'php', 'rb', 'go',
      'rs', 'swift', 'md', 'json', 'yml', 'yaml'
    ];

    return Boolean(fileExt) && trackedExtensions.includes(fileExt);
  }

  private async handleChange(uri: vscode.Uri, type: 'added' | 'changed' | 'deleted') {
    try {
      if (!this.isInitialized) {
        this.log('Watcher not initialized, reinitializing...');
        this.initialize();
        return;
      }

      if (!this.shouldTrackFile(uri.fsPath)) {
        return;
      }

      // Analyze file for metrics
      let metrics = { lineCount: 0, charCount: 0 };
      if (type !== 'deleted') {
        metrics = await this.analyzeFileContent(uri);
      }

      // Check if this is a meaningful change
      const existingChange = this.changes.get(uri.fsPath);
      if (existingChange) {
        if (existingChange.type === 'deleted' && type === 'added') {
          type = 'added';
        } else if (existingChange.type === 'added' && type === 'changed') {
          type = 'added';
        }
      }

      // Update or add the change
      const change: Change = {
        uri,
        timestamp: new Date(),
        type,
        lineCount: metrics.lineCount,
        charCount: metrics.charCount
      };

      this.changes.set(uri.fsPath, change);
      this.activityMetrics.fileChanges++;
      this.emit('change', change);
    } catch (error) {
      this.outputChannel.appendLine(
        `DevTrack: Error handling file change: ${error}`
      );
    }
  }

  getChangedFiles(): Change[] {
    const changes = Array.from(this.changes.values());
    return changes;
  }

  clearChanges(): void {
    const previousCount = this.changes.size;
    this.changes.clear();
    this.log(`Cleared ${previousCount} tracked changes`);
  }

  updateExcludePatterns(newPatterns: string[]) {
    this.excludePatterns = newPatterns;
    this.log(`Updated exclude patterns to: ${newPatterns.join(', ')}`);
  }

  async reinitialize() {
    this.log('Reinitializing tracker...');
    await this.initialize();
  }
  
  // Returns activity metrics for the current session
  getActivityMetrics(): ActivityMetrics {
    // If currently active, update the active time
    if (this.activeStartTime) {
      const now = new Date();
      const currentActiveTime = (now.getTime() - this.activeStartTime.getTime()) / 1000;
      this.activityMetrics.activeTime = this.totalActiveTime + currentActiveTime;
    } else {
      this.activityMetrics.activeTime = this.totalActiveTime;
    }
    
    return this.activityMetrics;
  }
  
  // Reset metrics after they've been committed
  resetMetrics() {
    this.totalActiveTime = 0;
    this.keystrokeCount = 0;
    this.activityMetrics = {
      activeTime: 0,
      fileChanges: 0,
      keystrokes: 0,
      lastActiveTimestamp: new Date()
    };
  }

  private log(message: string) {
    this.outputChannel.appendLine(`DevTrack: ${message}`);
  }
  
  private logThrottled(message: string) {
    const now = Date.now();
    if (now - this.lastLogTimestamp > this.LOG_THROTTLE_MS) {
      this.log(message);
      this.lastLogTimestamp = now;
    }
  }

  dispose() {
    if (this.watcher) {
      this.watcher.dispose();
      this.isInitialized = false;
      this.log('Disposed file system watcher');
    }
    
    if (this.activityTimeout) {
      clearTimeout(this.activityTimeout);
      this.activityTimeout = null;
    }
  }
}