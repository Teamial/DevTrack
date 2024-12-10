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

  constructor() {
    super();
    this.initializeWatcher();
  }

  private initializeWatcher() {
    const config = vscode.workspace.getConfiguration('devtrackr');
    const excludePatterns: string[] = config.get<string[]>('exclude') || [];

    this.watcher = vscode.workspace.createFileSystemWatcher('**/*', false, false, false);

    this.watcher.onDidChange(uri => this.handleChange(uri, 'changed', excludePatterns));
    this.watcher.onDidCreate(uri => this.handleChange(uri, 'added', excludePatterns));
    this.watcher.onDidDelete(uri => this.handleChange(uri, 'deleted', excludePatterns));
  }

  private handleChange(uri: vscode.Uri, type: 'added' | 'changed' | 'deleted', excludePatterns: string[]) {
    const relativePath = vscode.workspace.asRelativePath(uri);
    const isExcluded = excludePatterns.some(pattern => minimatch(relativePath, pattern));
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
}
