/* eslint-disable no-unused-vars */
/* eslint-disable no-useless-escape */
// src/services/summaryGenerator.ts
import * as vscode from 'vscode';
import * as path from 'path';
import { Change } from './tracker';
import { ProjectContext } from './projectContext';

export class SummaryGenerator {
  private outputChannel: vscode.OutputChannel;
  private projectContext: ProjectContext;

  constructor(
    outputChannel: vscode.OutputChannel,
    extensionContext: vscode.ExtensionContext
  ) {
    this.outputChannel = outputChannel;
    this.projectContext = new ProjectContext(outputChannel, extensionContext);
  }

  private async getFileChanges(change: Change): Promise<string> {
    try {
      const oldUri = change.type === 'added' ? undefined : change.uri;
      const newUri = change.type === 'deleted' ? undefined : change.uri;

      if (!oldUri && !newUri) {
        return '';
      }

      const gitExt = vscode.extensions.getExtension('vscode.git');
      if (!gitExt) {
        return '';
      }

      const git = gitExt.exports.getAPI(1);
      if (!git.repositories.length) {
        return '';
      }

      const repo = git.repositories[0];

      // Get the diff for the file
      const diff = await repo.diff(oldUri, newUri);
      return this.parseDiff(diff, path.basename(change.uri.fsPath));
    } catch (error) {
      this.outputChannel.appendLine(`Error getting file changes: ${error}`);
      return '';
    }
  }

  private parseDiff(diff: string, filename: string): string {
    if (!diff) {
      return filename;
    }

    const lines = diff.split('\n');
    const changes: {
      modified: Set<string>;
      added: Set<string>;
      removed: Set<string>;
    } = {
      modified: new Set(),
      added: new Set(),
      removed: new Set(),
    };

    let currentFunction = '';

    for (const line of lines) {
      // Skip empty lines and comments
      if (!line.trim() || line.match(/^[\+\-]\s*\/\//)) {
        continue;
      }

      // Function/method/class detection
      const functionMatch = line.match(
        /^([\+\-])\s*(async\s+)?((function|class|const|let|var)\s+)?([a-zA-Z_$][a-zA-Z0-9_$]*)/
      );

      if (functionMatch) {
        const [_, changeType, _async, _keyword, _type, name] = functionMatch;

        if (changeType === '+') {
          changes.added.add(name);
        } else if (changeType === '-') {
          changes.removed.add(name);
        }

        // If both added and removed, it's a modification
        if (changes.added.has(name) && changes.removed.has(name)) {
          changes.modified.add(name);
          changes.added.delete(name);
          changes.removed.delete(name);
        }

        continue;
      }
    }

    // Build change description
    const descriptions: string[] = [];

    if (changes.modified.size > 0) {
      descriptions.push(`modified ${Array.from(changes.modified).join(', ')}`);
    }
    if (changes.added.size > 0) {
      descriptions.push(`added ${Array.from(changes.added).join(', ')}`);
    }
    if (changes.removed.size > 0) {
      descriptions.push(`removed ${Array.from(changes.removed).join(', ')}`);
    }

    return descriptions.length > 0
      ? `${filename} (${descriptions.join('; ')})`
      : filename;
  }

  async generateSummary(changedFiles: Change[]): Promise<string> {
    try {
      // Get detailed file changes
      const fileChanges = await Promise.all(
        changedFiles.map((change) => this.getFileChanges(change))
      );

      const significantChanges = fileChanges.filter(Boolean);
      const context = this.projectContext.getContextForSummary(changedFiles);

      // Build the summary
      let summary = 'DevTrack:';

      // Add branch context
      if (context) {
        summary += ` ${context}`;
      }

      // Add file changes
      if (significantChanges.length > 0) {
        summary += ` | Changes in: ${significantChanges.join('; ')}`;
      } else {
        // Fallback to basic stats
        const stats = this.calculateChangeStats(changedFiles);
        const changeDetails = [];
        if (stats.added > 0) {
          changeDetails.push(`${stats.added} files added`);
        }
        if (stats.modified > 0) {
          changeDetails.push(`${stats.modified} files modified`);
        }
        if (stats.deleted > 0) {
          changeDetails.push(`${stats.deleted} files deleted`);
        }

        summary += ` | ${changeDetails.join(', ')}`;
      }

      // Save commit info and return summary
      await this.projectContext.addCommit(summary, changedFiles);
      this.outputChannel.appendLine(
        `DevTrack: Generated commit summary: "${summary}"`
      );

      return summary;
    } catch (error) {
      this.outputChannel.appendLine(
        `DevTrack: Error generating summary: ${error}`
      );
      return 'DevTrack: Updated files';
    }
  }

  private calculateChangeStats(changes: Change[]) {
    return {
      added: changes.filter((change) => change.type === 'added').length,
      modified: changes.filter((change) => change.type === 'changed').length,
      deleted: changes.filter((change) => change.type === 'deleted').length,
    };
  }
}
