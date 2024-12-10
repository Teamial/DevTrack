// src/services/tracker.ts
import * as vscode from 'vscode';
import { EventEmitter } from 'events';
import minimatch from 'minimatch';

export interface Change {
  uri: vscode.Uri;
  timestamp: Date;
  type: 'added' | 'changed' | 'deleted';
}

export class Tracker extends EventEmitter {
  private changes: Change[] = [];
  private watcher!: vscode.FileSystemWatcher;
  private excludePatterns: string[] = [];

  constructor() {
    super();
    this.initializeWatcher();
  }

  private initializeWatcher() {
    const config = vscode.workspace.getConfiguration('devtrack'); // Changed 'devtrackr' to 'devtrack' for consistency
    this.excludePatterns = config.get<string[]>('exclude') || [];

    this.watcher = vscode.workspace.createFileSystemWatcher('**/*', false, false, false);

    this.watcher.onDidChange(uri => this.handleChange(uri, 'changed'));
    this.watcher.onDidCreate(uri => this.handleChange(uri, 'added'));
    this.watcher.onDidDelete(uri => this.handleChange(uri, 'deleted'));

    console.log('DevTrack: File system watcher initialized.');
  }

  private handleChange(uri: vscode.Uri, type: 'added' | 'changed' | 'deleted') {
    const relativePath = vscode.workspace.asRelativePath(uri);
    const isExcluded = this.excludePatterns.some(pattern => minimatch(relativePath, pattern));
    if (!isExcluded) {
      const change: Change = {
        uri,
        timestamp: new Date(),
        type,
      };
      this.changes.push(change);
      this.emit('change', change);
      console.log(`DevTrack: Detected ${type} in ${relativePath}.`);
    }
  }

  /**
   * Returns the list of changed files.
   */
  getChangedFiles(): Change[] {
    return [...this.changes];
  }

  /**
   * Clears the tracked changes.
   */
  clearChanges(): void {
    this.changes = [];
    console.log('DevTrack: Cleared tracked changes.');
  }

  /**
   * Updates the exclude patterns used to filter out files from tracking.
   * @param newPatterns Array of glob patterns to exclude.
   */
  updateExcludePatterns(newPatterns: string[]) {
    this.excludePatterns = newPatterns;
    console.log('DevTrack: Updated exclude patterns.');
  }

  /**
   * Dispose method to clean up resources.
   */
  dispose() {
    this.watcher.dispose();
    console.log('DevTrack: Disposed file system watcher.');
  }
}
