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
    const config = vscode.workspace.getConfiguration('devtrackr');
    this.excludePatterns = config.get<string[]>('exclude') || [];

    this.watcher = vscode.workspace.createFileSystemWatcher('**/*', false, false, false);

    this.watcher.onDidChange(uri => this.handleChange(uri, 'changed'));
    this.watcher.onDidCreate(uri => this.handleChange(uri, 'added'));
    this.watcher.onDidDelete(uri => this.handleChange(uri, 'deleted'));
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
    }
  }

  getChangesAndClear(): Change[] {
    const currentChanges = [...this.changes];
    this.changes = [];
    return currentChanges;
  }

  /**
   * Updates the exclude patterns used to filter out files from tracking.
   * @param newPatterns Array of glob patterns to exclude.
   */
  updateExcludePatterns(newPatterns: string[]) {
    this.excludePatterns = newPatterns;
    console.log('DevTrackr: Updated exclude patterns.');
  }
}
