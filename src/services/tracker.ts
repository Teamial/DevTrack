// src/services/tracker.ts
import * as vscode from 'vscode';
import { EventEmitter } from 'events';
import minimatch from 'minimatch';
import { OutputChannel } from 'vscode';

export interface Change {
  uri: vscode.Uri;
  timestamp: Date;
  type: 'added' | 'changed' | 'deleted';
}

export class Tracker extends EventEmitter {
  private changes: Change[] = [];
  private watcher!: vscode.FileSystemWatcher;
  private excludePatterns: string[] = [];
  private outputChannel: OutputChannel;

  constructor(outputChannel: OutputChannel) {
    super();
    this.outputChannel = outputChannel;
    this.initializeWatcher();
  }

  private initializeWatcher() {
    const config = vscode.workspace.getConfiguration('devtrack'); // Consistent key
    this.excludePatterns = config.get<string[]>('exclude') || [];

    this.watcher = vscode.workspace.createFileSystemWatcher('**/*', false, false, false);

    this.watcher.onDidChange(uri => this.handleChange(uri, 'changed'));
    this.watcher.onDidCreate(uri => this.handleChange(uri, 'added'));
    this.watcher.onDidDelete(uri => this.handleChange(uri, 'deleted'));

    this.outputChannel.appendLine('DevTrack: File system watcher initialized.');
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
      this.outputChannel.appendLine(`DevTrack: Detected ${type} in ${relativePath}.`);
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
