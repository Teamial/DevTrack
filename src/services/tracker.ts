// src/services/tracker.ts
import * as vscode from 'vscode';
import { EventEmitter } from 'events';
import { minimatch } from 'minimatch';
import { OutputChannel } from 'vscode';

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

  constructor(outputChannel: OutputChannel, trackingDir: string) {
    super();
    this.outputChannel = outputChannel;
    this.trackingDir = trackingDir;
    this.initializeWatcher();
  }

  private initializeWatcher() {
    const config = vscode.workspace.getConfiguration('devtrack');
    this.excludePatterns = config.get<string[]>('exclude') || [];

    // Create a workspace folder from the tracking directory
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      this.outputChannel.appendLine('DevTrack: No workspace folders found.');
      return;
    }

    // Use the workspace folder with RelativePattern
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(workspaceFolders[0], '**/*'),
      false, // Don't ignore creates
      false, // Don't ignore changes
      false // Don't ignore deletes
    );

    // Set up event handlers
    this.watcher.onDidChange((uri) => this.handleChange(uri, 'changed'));
    this.watcher.onDidCreate((uri) => this.handleChange(uri, 'added'));
    this.watcher.onDidDelete((uri) => this.handleChange(uri, 'deleted'));

    this.outputChannel.appendLine(
      'DevTrack: File system watcher initialized for tracking directory.'
    );
  }

  private handleChange(uri: vscode.Uri, type: 'added' | 'changed' | 'deleted') {
    try {
      // Only process files within the tracking directory
      if (!uri.fsPath.startsWith(this.trackingDir)) {
        return;
      }

      const relativePath = vscode.workspace.asRelativePath(uri);

      // Check exclusions
      const isExcluded = this.excludePatterns.some((pattern) =>
        minimatch(relativePath, pattern)
      );

      if (!isExcluded) {
        const fileExt = uri.fsPath.split('.').pop()?.toLowerCase();
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
        // Check if this is a meaningful change
        const existingChange = this.changes.get(uri.fsPath);
        if (existingChange) {
          // If the file was previously deleted and now added, keep as added
          if (existingChange.type === 'deleted' && type === 'added') {
            type = 'added';
          }
          // If the file was previously added and modified, keep as added
          else if (existingChange.type === 'added' && type === 'changed') {
            type = 'added';
          }
        }

        // Update or add the change
        if (fileExt && trackedExtensions.includes(fileExt)) {
          const change: Change = {
            uri,
            timestamp: new Date(),
            type,
          };

          this.changes.set(uri.fsPath, change);
          this.emit('change', change);

          this.outputChannel.appendLine(
            `DevTrack: Detected ${type} in ${relativePath}`
          );
        }
      }
    } catch (error) {
      this.outputChannel.appendLine(
        `DevTrack: Error handling file change: ${error}`
      );
    }
  }

  /**
   * Returns the list of changed files.
   */
  getChangedFiles(): Change[] {
    return Array.from(this.changes.values());
  }

  /**
   * Clears the tracked changes.
   */
  clearChanges(): void {
    this.changes.clear();
    this.outputChannel.appendLine('DevTrack: Cleared tracked changes.');
  }

  /**
   * Updates the exclude patterns used to filter out files from tracking.
   * @param newPatterns Array of glob patterns to exclude.
   */
  updateExcludePatterns(newPatterns: string[]) {
    this.excludePatterns = newPatterns;
    this.outputChannel.appendLine('DevTrack: Updated exclude patterns.');
  }

  /**
   * Dispose method to clean up resources.
   */
  dispose() {
    this.watcher.dispose();
    this.outputChannel.appendLine('DevTrack: Disposed file system watcher.');
  }
}
