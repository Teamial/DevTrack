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
    const changes: string[] = [];
    let currentFunction = '';

    for (const line of lines) {
      // Skip empty lines and comment-only changes
      if (!line.trim() || line.match(/^[\+\-]\s*\/\//)) {
        continue;
      }

      // Look for function/method changes
      const functionMatch = line.match(
        /^[\+\-]([\s]*(function|class|const|let|var|async)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)|[a-zA-Z_$][a-zA-Z0-9_$]*\s*=\s*(function|\(.*\)\s*=>))/
      );

      if (functionMatch) {
        currentFunction = functionMatch[0].replace(/^[\+\-]/, '').trim();

        // Extract just the function name
        const nameMatch = currentFunction.match(/([a-zA-Z_$][a-zA-Z0-9_$]*)/);
        if (nameMatch) {
          changes.push(`modified ${nameMatch[0]}`);
        }
        continue;
      }

      // Look for significant code changes (non-whitespace)
      if (
        (line.startsWith('+') || line.startsWith('-')) &&
        line.trim().length > 5 &&
        !currentFunction
      ) {
        const cleanLine = line.replace(/^[\+\-]/, '').trim();

        // Add meaningful changes, avoiding duplicates
        if (!changes.includes(cleanLine)) {
          changes.push(cleanLine);
        }
      }
    }

    // Return a meaningful summary
    if (changes.length === 0) {
      return filename;
    }

    // Limit the summary length but indicate if there are more changes
    const summary = changes.slice(0, 2).join(', ');
    return `${filename} (${summary}${changes.length > 2 ? '...' : ''})`;
  }

  async generateSummary(changedFiles: Change[]): Promise<string> {
    try {
      const stats = this.calculateChangeStats(changedFiles);

      // Get detailed file changes
      const fileChanges = await Promise.all(
        changedFiles.map((change) => this.getFileChanges(change))
      );

      const significantChanges = fileChanges.filter(Boolean);
      const context = this.projectContext.getContextForSummary(changedFiles);

      // Build the summary
      let summary = 'DevTrack: ';

      // Add branch and file context if available
      if (context) {
        summary += context;
      }

      // Add detailed changes if available, otherwise fall back to basic stats
      if (significantChanges.length > 0) {
        if (context) {
          summary += '| ';
        }
        summary += `Changes in: ${significantChanges.join('; ')}`;
      } else {
        const changeDetails = [];
        if (stats.added > 0) {
          changeDetails.push(`${stats.added} added`);
        }
        if (stats.modified > 0) {
          changeDetails.push(`${stats.modified} modified`);
        }
        if (stats.deleted > 0) {
          changeDetails.push(`${stats.deleted} deleted`);
        }

        if (context) {
          summary += '| ';
        }
        summary += changeDetails.join(', ');
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
