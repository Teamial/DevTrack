// src/services/tracker.ts
import { setTimeout, clearTimeout } from 'node:timers';
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
  private workspaceFolder?: vscode.WorkspaceFolder;
  private isInitialized: boolean = false;
  private isTracking: boolean = false;

  // Noise reduction settings
  private trackedExtensionsMode: 'all' | 'list' = 'all';
  private trackedExtensionsSet: Set<string> = new Set();
  private defaultIgnoredFoldersEnabled: boolean = true;
  private defaultIgnoredFolders: Set<string> = new Set([
    'node_modules',
    'dist',
    'out',
    'build',
    '.next',
    '.nuxt',
    'coverage',
    '.turbo',
    '.cache',
    'target',
    'vendor',
  ]);
  private changeDebounceMs: number = 750;
  private readonly debounceTimers: Map<string, ReturnType<typeof setTimeout>> =
    new Map();
  private readonly pendingChangeTypes: Map<
    string,
    'added' | 'changed' | 'deleted'
  > = new Map();

  // New activity tracking
  private activityTimeout: ReturnType<typeof setTimeout> | null = null;
  private keystrokeCount: number = 0;
  private activeStartTime: Date | null = null;
  private totalActiveTime: number = 0; // in seconds
  private activityMetrics: ActivityMetrics = {
    activeTime: 0,
    fileChanges: 0,
    keystrokes: 0,
    lastActiveTimestamp: new Date(),
  };

  // Track idle time (default 15 minutes; configurable via devtrack.maxIdleTimeBeforePause)
  private idleTimeoutMs: number = 15 * 60 * 1000;
  private trackKeystrokesEnabled: boolean = true;
  // Emit metrics while active (throttled) so adaptive scheduling can react
  private lastMetricsEmitTs: number = 0;
  private readonly METRICS_EMIT_THROTTLE_MS = 30 * 1000; // 30 seconds
  // Suppress frequent logging
  private lastLogTimestamp: number = 0;
  private readonly LOG_THROTTLE_MS = 5000; // 5 seconds

  constructor(
    outputChannel: OutputChannel,
    trackingDir: string,
    workspaceFolder?: vscode.WorkspaceFolder
  ) {
    super();
    this.outputChannel = outputChannel;
    this.trackingDir = trackingDir;
    this.workspaceFolder = workspaceFolder;
    this.initialize();
  }

  private async initialize() {
    try {
      await this.initializeWatcher();
      this.setupActivityTracking();
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
      this.trackKeystrokesEnabled = config.get<boolean>(
        'trackKeystrokes',
        true
      );
      this.trackedExtensionsMode =
        (config.get<'all' | 'list'>('trackedExtensionsMode') || 'all') ===
        'list'
          ? 'list'
          : 'all';
      this.setTrackedExtensions(
        config.get<string[]>('trackedExtensions') || []
      );
      this.defaultIgnoredFoldersEnabled = config.get<boolean>(
        'defaultIgnoredFoldersEnabled',
        true
      );
      this.setDefaultIgnoredFolders(
        config.get<string[]>('defaultIgnoredFolders') || []
      );
      const debounceMs = config.get<number>('changeDebounceMs', 750);
      this.changeDebounceMs = Math.max(0, Math.min(10000, debounceMs));
      // maxIdleTimeBeforePause is seconds in settings
      const maxIdleSeconds = config.get<number>('maxIdleTimeBeforePause', 900);
      // Clamp to a reasonable range
      const clamped = Math.max(60, Math.min(24 * 60 * 60, maxIdleSeconds));
      this.idleTimeoutMs = clamped * 1000;

      // Log current workspace state
      const workspaceFolder =
        this.workspaceFolder ?? vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        this.log('No workspace folder found');
        return;
      }
      this.log(
        `Initializing watcher for workspace: ${workspaceFolder.uri.fsPath}`
      );

      // Create watcher for all files, then filter in code (noise reduction settings)
      const filePattern = new vscode.RelativePattern(workspaceFolder, '**/*');

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
        this.queueChange(uri, 'changed');
        this.recordActivity();
      });

      this.watcher.onDidCreate((uri) => {
        this.logThrottled(`New file created: ${uri.fsPath}`);
        this.queueChange(uri, 'added');
        this.recordActivity();
      });

      this.watcher.onDidDelete((uri) => {
        this.logThrottled(`File deleted: ${uri.fsPath}`);
        this.queueChange(uri, 'deleted');
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
        if (this.trackKeystrokesEnabled) {
          this.keystrokeCount += event.contentChanges.reduce(
            (total, change) => total + (change.text?.length || 0),
            0
          );
        }
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
    if (!this.isTracking) {
      return;
    }

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
    }, this.idleTimeoutMs);
  }

  private pauseActivityTracking() {
    if (this.activeStartTime) {
      // Calculate active time
      const now = new Date();
      const activeTime =
        (now.getTime() - this.activeStartTime.getTime()) / 1000;
      this.totalActiveTime += activeTime;
      this.activeStartTime = null;

      this.activityMetrics.activeTime = this.totalActiveTime;
      this.activityMetrics.keystrokes = this.keystrokeCount;

      this.log(
        `Activity paused. Active time: ${Math.round(this.totalActiveTime / 60)} minutes`
      );

      // Emit metrics event so other services can use it
      this.emit('activityMetrics', this.activityMetrics);
    }

    if (this.activityTimeout) {
      clearTimeout(this.activityTimeout);
      this.activityTimeout = null;
    }
  }

  private recordActivity() {
    if (!this.isTracking) {
      return;
    }

    this.activityMetrics.lastActiveTimestamp = new Date();
    this.startActivityTracking(); // Restart the idle timer

    // Emit metrics periodically while active (throttled) so adaptive scheduling can trigger
    this.emitMetricsThrottled();
  }

  private emitMetricsThrottled() {
    const now = Date.now();
    if (now - this.lastMetricsEmitTs < this.METRICS_EMIT_THROTTLE_MS) {
      return;
    }
    this.lastMetricsEmitTs = now;
    this.emit('activityMetrics', this.getActivityMetrics());
  }

  private async analyzeFileContent(
    uri: vscode.Uri
  ): Promise<{ lineCount: number; charCount: number }> {
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      return {
        lineCount: document.lineCount,
        charCount: document.getText().length,
      };
    } catch {
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

    const relativePathNormalized = relativePath.replace(/\\/g, '/');

    // Default ignored folders (segment match)
    if (this.defaultIgnoredFoldersEnabled) {
      const segments = relativePathNormalized.split('/');
      if (segments.some((s) => this.defaultIgnoredFolders.has(s))) {
        return false;
      }
    }

    // Extension filtering (optional)
    if (this.trackedExtensionsMode === 'list') {
      const ext = path.extname(filePath).toLowerCase().replace(/^\./, '');
      if (!ext) {
        return false;
      }
      return this.trackedExtensionsSet.has(ext);
    }

    // all => allow any file that passes ignores
    return true;
  }

  private queueChange(uri: vscode.Uri, type: 'added' | 'changed' | 'deleted') {
    const key = uri.fsPath;
    if (!this.isInitialized) {
      this.log('Watcher not initialized, reinitializing...');
      this.initialize();
      return;
    }
    if (!this.shouldTrackFile(uri.fsPath)) {
      return;
    }

    // Merge types within the debounce window
    const prevType = this.pendingChangeTypes.get(key);
    let nextType = type;
    if (prevType) {
      // Prefer 'added' over 'changed', and allow deleted->added to become added.
      if (prevType === 'added' || type === 'added') {
        nextType = 'added';
      } else if (prevType === 'deleted' && type === 'changed') {
        nextType = 'changed';
      } else if (type === 'deleted') {
        nextType = 'deleted';
      } else {
        nextType = 'changed';
      }
    }
    this.pendingChangeTypes.set(key, nextType);

    const existingTimer = this.debounceTimers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const delay = this.changeDebounceMs;
    const timer = setTimeout(() => {
      this.debounceTimers.delete(key);
      const finalType = this.pendingChangeTypes.get(key) || nextType;
      this.pendingChangeTypes.delete(key);
      this.handleChange(uri, finalType);
    }, delay);
    this.debounceTimers.set(key, timer);
  }

  private async handleChange(
    uri: vscode.Uri,
    type: 'added' | 'changed' | 'deleted'
  ) {
    try {
      if (!this.isInitialized) {
        this.log('Watcher not initialized, reinitializing...');
        this.initialize();
        return;
      }

      // shouldTrackFile already checked in queueChange; keep a defensive check
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
        charCount: metrics.charCount,
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

  updateTrackingSettings(options: {
    maxIdleTimeBeforePauseSeconds?: number;
    trackKeystrokes?: boolean;
    trackedExtensionsMode?: 'all' | 'list';
    trackedExtensions?: string[];
    defaultIgnoredFoldersEnabled?: boolean;
    defaultIgnoredFolders?: string[];
    changeDebounceMs?: number;
  }) {
    if (typeof options.trackKeystrokes === 'boolean') {
      this.trackKeystrokesEnabled = options.trackKeystrokes;
    }
    if (typeof options.maxIdleTimeBeforePauseSeconds === 'number') {
      const clamped = Math.max(
        60,
        Math.min(24 * 60 * 60, options.maxIdleTimeBeforePauseSeconds)
      );
      this.idleTimeoutMs = clamped * 1000;
    }
    if (options.trackedExtensionsMode) {
      this.trackedExtensionsMode =
        options.trackedExtensionsMode === 'list' ? 'list' : 'all';
    }
    if (Array.isArray(options.trackedExtensions)) {
      this.setTrackedExtensions(options.trackedExtensions);
    }
    if (typeof options.defaultIgnoredFoldersEnabled === 'boolean') {
      this.defaultIgnoredFoldersEnabled = options.defaultIgnoredFoldersEnabled;
    }
    if (Array.isArray(options.defaultIgnoredFolders)) {
      this.setDefaultIgnoredFolders(options.defaultIgnoredFolders);
    }
    if (typeof options.changeDebounceMs === 'number') {
      this.changeDebounceMs = Math.max(
        0,
        Math.min(10000, options.changeDebounceMs)
      );
    }
  }

  private setTrackedExtensions(exts: string[]) {
    const normalized = exts
      .map((e) =>
        String(e || '')
          .trim()
          .toLowerCase()
          .replace(/^\./, '')
      )
      .filter(Boolean);
    this.trackedExtensionsSet = new Set(normalized);
  }

  private setDefaultIgnoredFolders(folders: string[]) {
    const normalized = folders
      .map((f) => String(f || '').trim())
      .filter(Boolean);
    if (normalized.length > 0) {
      this.defaultIgnoredFolders = new Set(normalized);
    }
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
      const currentActiveTime =
        (now.getTime() - this.activeStartTime.getTime()) / 1000;
      this.activityMetrics.activeTime =
        this.totalActiveTime + currentActiveTime;
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
      lastActiveTimestamp: new Date(),
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

    for (const t of this.debounceTimers.values()) {
      clearTimeout(t);
    }
    this.debounceTimers.clear();
    this.pendingChangeTypes.clear();
  }
}
