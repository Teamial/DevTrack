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

  constructor(outputChannel: OutputChannel) {
    super();
    this.outputChannel = outputChannel;
    this.initializeWatcher();
  }

  private initializeWatcher() {
    const config = vscode.workspace.getConfiguration('devtrack');
    this.excludePatterns = config.get<string[]>('exclude') || [];

    // Create file system watcher
    this.watcher = vscode.workspace.createFileSystemWatcher(
      '**/*',
      false, // Don't ignore creates
      false, // Don't ignore changes
      false // Don't ignore deletes
    );

    // Set up event handlers
    this.watcher.onDidChange((uri) => this.handleChange(uri, 'changed'));
    this.watcher.onDidCreate((uri) => this.handleChange(uri, 'added'));
    this.watcher.onDidDelete((uri) => this.handleChange(uri, 'deleted'));

    this.outputChannel.appendLine('DevTrack: File system watcher initialized.');
  }

  private handleChange(uri: vscode.Uri, type: 'added' | 'changed' | 'deleted') {
    try {
      const relativePath = vscode.workspace.asRelativePath(uri);

      // Check if file should be excluded
      const isExcluded = this.excludePatterns.some((pattern) =>
        minimatch(relativePath, pattern)
      );

      if (!isExcluded) {
        // Get file extension
        const fileExt = uri.fsPath.split('.').pop()?.toLowerCase();

        // Only track source code files and specific file types
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

        if (fileExt && trackedExtensions.includes(fileExt)) {
          const key = uri.fsPath;

          // Check if this is a meaningful change
          const existingChange = this.changes.get(key);
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
          const change: Change = {
            uri,
            timestamp: new Date(),
            type,
          };

          this.changes.set(key, change);
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
