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

  private async getFileContent(uri: vscode.Uri): Promise<string> {
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      return document.getText();
    } catch (error) {
      this.outputChannel.appendLine(`Error reading file content: ${error}`);
      return '';
    }
  }

  private async getFileChanges(
    change: Change
  ): Promise<{ details: string; snippet: string }> {
    try {
      const oldUri = change.type === 'added' ? undefined : change.uri;
      const newUri = change.type === 'deleted' ? undefined : change.uri;

      if (!oldUri && !newUri) {
        return { details: '', snippet: '' };
      }

      const gitExt = vscode.extensions.getExtension('vscode.git');
      if (!gitExt) {
        return { details: '', snippet: '' };
      }

      const git = gitExt.exports.getAPI(1);
      if (!git.repositories.length) {
        return { details: '', snippet: '' };
      }

      const repo = git.repositories[0];
      const diff = await repo.diff(oldUri, newUri);
      const parsedChanges = await this.parseDiff(diff, change.uri);

      // Get the current content of the file for the snippet
      const currentContent =
        change.type !== 'deleted' ? await this.getFileContent(change.uri) : '';

      return {
        details: parsedChanges,
        snippet: this.formatCodeSnippet(
          currentContent,
          path.basename(change.uri.fsPath)
        ),
      };
    } catch (error) {
      this.outputChannel.appendLine(`Error getting file changes: ${error}`);
      return { details: '', snippet: '' };
    }
  }

  private formatCodeSnippet(content: string, filename: string): string {
    // Only include up to 50 lines of code to keep commits reasonable
    const lines = content.split('\n').slice(0, 50);
    if (content.split('\n').length > 50) {
      lines.push('... (truncated for brevity)');
    }

    return `\`\`\`\n${filename}:\n${lines.join('\n')}\n\`\`\``;
  }

  private parseDiff(diff: string, uri: vscode.Uri): string {
    if (!diff) {
      return path.basename(uri.fsPath);
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
      if (!line.trim() || line.match(/^[\+\-]\s*\/\//)) {
        continue;
      }

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

        if (changes.added.has(name) && changes.removed.has(name)) {
          changes.modified.add(name);
          changes.added.delete(name);
          changes.removed.delete(name);
        }
      }
    }

    const descriptions: string[] = [];
    const filename = path.basename(uri.fsPath);

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
      const timestamp = new Date().toISOString();
      let summary = `DevTrack Update - ${timestamp}\n\n`;

      // Get detailed file changes and snippets
      const changePromises = changedFiles.map(async (change) => {
        const { details, snippet } = await this.getFileChanges(change);
        return {
          details,
          snippet,
          type: change.type,
        };
      });

      const changes = await Promise.all(changePromises);

      // Add change details
      summary += 'Changes:\n';
      changes.forEach((change) => {
        if (change.details) {
          summary += `- ${change.type}: ${change.details}\n`;
        }
      });

      // Add code snippets
      summary += '\nCode Snippets:\n';
      changes.forEach((change) => {
        if (change.snippet) {
          summary += `\n${change.snippet}\n`;
        }
      });

      // Save commit info
      await this.projectContext.addCommit(summary, changedFiles);
      this.outputChannel.appendLine(
        `DevTrack: Generated commit summary with code snippets`
      );

      return summary;
    } catch (error) {
      this.outputChannel.appendLine(
        `DevTrack: Error generating summary: ${error}`
      );
      return `DevTrack Update - ${new Date().toISOString()}\nUpdated files`;
    }
  }
}
