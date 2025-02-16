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
}

export class Tracker extends EventEmitter {
  private changes: Map<string, Change> = new Map();
  private watcher!: vscode.FileSystemWatcher;
  private excludePatterns: string[] = [];
  private outputChannel: OutputChannel;
  private trackingDir: string;
  private isInitialized: boolean = false;

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
        this.outputChannel.appendLine(
          'DevTrack: Waiting for workspace to load...'
        );
        const disposable = vscode.workspace.onDidChangeWorkspaceFolders(() => {
          if (vscode.workspace.workspaceFolders?.length) {
            this.initializeWatcher();
            disposable.dispose();
          }
        });
      } else {
        await this.initializeWatcher();
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
        this.outputChannel.appendLine('DevTrack: No workspace folder found');
        return;
      }

      const workspaceFolder = workspaceFolders[0];
      this.outputChannel.appendLine(
        `DevTrack: Initializing watcher for workspace: ${workspaceFolder.uri.fsPath}`
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

      // Set up event handlers with logging
      this.watcher.onDidChange((uri) => {
        this.outputChannel.appendLine(
          `DevTrack: Change detected in file: ${uri.fsPath}`
        );
        this.handleChange(uri, 'changed');
      });

      this.watcher.onDidCreate((uri) => {
        this.outputChannel.appendLine(
          `DevTrack: New file created: ${uri.fsPath}`
        );
        this.handleChange(uri, 'added');
      });

      this.watcher.onDidDelete((uri) => {
        this.outputChannel.appendLine(`DevTrack: File deleted: ${uri.fsPath}`);
        this.handleChange(uri, 'deleted');
      });

      // Verify the watcher is active
      this.isInitialized = true;
      this.outputChannel.appendLine(
        'DevTrack: File system watcher successfully initialized'
      );

      // Log initial workspace scan
      const files = await vscode.workspace.findFiles(
        '**/*',
        '**/node_modules/**'
      );
      this.outputChannel.appendLine(
        `DevTrack: Found ${files.length} files in workspace`
      );
    } catch (error) {
      this.outputChannel.appendLine(
        `DevTrack: Failed to initialize watcher - ${error}`
      );
      this.isInitialized = false;
    }
  }

  private shouldTrackFile(filePath: string): boolean {
    // Log the file being checked
    this.outputChannel.appendLine(`DevTrack: Checking file: ${filePath}`);

    // Skip files in tracking directory
    if (filePath.includes(this.trackingDir)) {
      this.outputChannel.appendLine(
        `DevTrack: Skipping file in tracking directory: ${filePath}`
      );
      return false;
    }

    // Check exclusions
    const relativePath = vscode.workspace.asRelativePath(filePath);
    const isExcluded = this.excludePatterns.some((pattern) =>
      minimatch(relativePath, pattern)
    );
    if (isExcluded) {
      this.outputChannel.appendLine(
        `DevTrack: File excluded by pattern: ${filePath}`
      );
      return false;
    }

    // Check file extension
    const fileExt = path.extname(filePath).toLowerCase().slice(1);
    const trackedExtensions = [
      'ts',
      'js',
      'py',
      'java',
      'c',
      'cpp',
      'h',
      'hpp',
      'css',
      'scss',
      'html',
      'jsx',
      'tsx',
      'vue',
      'php',
      'rb',
      'go',
      'rs',
      'swift',
      'md',
      'json',
      'yml',
      'yaml',
    ];

    const shouldTrack = Boolean(fileExt) && trackedExtensions.includes(fileExt);
    this.outputChannel.appendLine(
      `DevTrack: File ${shouldTrack ? 'will' : 'will not'} be tracked: ${filePath}`
    );
    return shouldTrack;
  }

  private handleChange(uri: vscode.Uri, type: 'added' | 'changed' | 'deleted') {
    try {
      if (!this.isInitialized) {
        this.outputChannel.appendLine(
          'DevTrack: Watcher not initialized, reinitializing...'
        );
        this.initialize();
        return;
      }

      if (!this.shouldTrackFile(uri.fsPath)) {
        return;
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
      };

      this.changes.set(uri.fsPath, change);
      this.emit('change', change);

      // Log the tracked change
      this.outputChannel.appendLine(
        `DevTrack: Successfully tracked ${type} in ${vscode.workspace.asRelativePath(uri)}`
      );
      this.outputChannel.appendLine(
        `DevTrack: Current number of tracked changes: ${this.changes.size}`
      );
    } catch (error) {
      this.outputChannel.appendLine(
        `DevTrack: Error handling file change: ${error}`
      );
    }
  }

  getChangedFiles(): Change[] {
    const changes = Array.from(this.changes.values());
    this.outputChannel.appendLine(
      `DevTrack: Returning ${changes.length} tracked changes`
    );
    return changes;
  }

  clearChanges(): void {
    const previousCount = this.changes.size;
    this.changes.clear();
    this.outputChannel.appendLine(
      `DevTrack: Cleared ${previousCount} tracked changes`
    );
  }

  updateExcludePatterns(newPatterns: string[]) {
    this.excludePatterns = newPatterns;
    this.outputChannel.appendLine(
      `DevTrack: Updated exclude patterns to: ${newPatterns.join(', ')}`
    );
  }

  async reinitialize() {
    this.outputChannel.appendLine('DevTrack: Reinitializing tracker...');
    await this.initialize();
  }

  dispose() {
    if (this.watcher) {
      this.watcher.dispose();
      this.isInitialized = false;
      this.outputChannel.appendLine('DevTrack: Disposed file system watcher');
    }
  }
}
