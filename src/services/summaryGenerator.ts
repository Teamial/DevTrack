/* eslint-disable no-unused-vars */
/* eslint-disable no-useless-escape */
// src/services/summaryGenerator.ts
import * as vscode from 'vscode';
import * as path from 'path';
import { Change } from './tracker';
import { ProjectContext } from './projectContext';
import { ActivityMetrics } from './tracker';
import { ChangeAnalyzer, ChangeType, ChangeAnalysis } from './changeAnalyzer';

export class SummaryGenerator {
  private outputChannel: vscode.OutputChannel;
  private projectContext: ProjectContext;
  private changeAnalyzer: ChangeAnalyzer;

  constructor(
    outputChannel: vscode.OutputChannel,
    extensionContext: vscode.ExtensionContext
  ) {
    this.outputChannel = outputChannel;
    this.projectContext = new ProjectContext(outputChannel, extensionContext);
    this.changeAnalyzer = new ChangeAnalyzer(outputChannel);
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

  private formatDuration(seconds: number): string {
    if (seconds < 60) {
      return `${seconds} seconds`;
    }
    
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
      return `${minutes} minute${minutes !== 1 ? 's' : ''}`;
    }
    
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    
    if (remainingMinutes === 0) {
      return `${hours} hour${hours !== 1 ? 's' : ''}`;
    } else {
      return `${hours} hour${hours !== 1 ? 's' : ''} ${remainingMinutes} minute${remainingMinutes !== 1 ? 's' : ''}`;
    }
  }
  
  private formatActivitySummary(metrics: ActivityMetrics, changeType: ChangeType): string {
    const formattedDuration = this.formatDuration(metrics.activeTime);
    
    let activitySummary = `Active coding time: ${formattedDuration}`;
    
    if (metrics.keystrokes > 0) {
      activitySummary += `, ${metrics.keystrokes} keystrokes`;
    }
    
    if (metrics.fileChanges > 0) {
      activitySummary += `, ${metrics.fileChanges} file change events`;
    }
    
    // Add change type description
    let changeDescription = "";
    switch (changeType) {
      case 'feature':
        changeDescription = "✨ Feature development";
        break;
      case 'bugfix':
        changeDescription = "🐛 Bug fixing";
        break;
      case 'refactor':
        changeDescription = "♻️ Code refactoring";
        break;
      case 'docs':
        changeDescription = "📝 Documentation";
        break;
      case 'style':
        changeDescription = "💄 Styling/formatting";
        break;
      default:
        changeDescription = "👨‍💻 Coding session";
    }
    
    return `${changeDescription} (${activitySummary})`;
  }

  async generateSummary(
    changedFiles: Change[],
    activityMetrics?: ActivityMetrics
  ): Promise<string> {
    try {
      const timestamp = new Date().toISOString();
      const localTime = new Date().toLocaleString();
      let summary = `DevTrack Update - ${localTime}\n\n`;
      
      // Analyze the type of changes
      const changeAnalysis = await this.changeAnalyzer.analyzeChanges(changedFiles);
      
      // Add activity metrics if available
      if (activityMetrics) {
        summary += this.formatActivitySummary(activityMetrics, changeAnalysis.type) + '\n\n';
      }

      // Get project context
      const projectContext = this.projectContext.getContextForSummary(changedFiles);
      if (projectContext) {
        summary += projectContext + '\n';
      }

      // Get detailed file changes and snippets
      const changePromises = changedFiles.map(async (change) => {
        const { details, snippet } = await this.getFileChanges(change);
        return {
          details,
          snippet,
          type: change.type,
          lineCount: change.lineCount || 0,
          charCount: change.charCount || 0
        };
      });

      const changes = await Promise.all(changePromises);

      // Add change details
      summary += 'Changes:\n';
      changes.forEach((change) => {
        if (change.details) {
          const metrics = change.lineCount ? ` (${change.lineCount} lines)` : '';
          summary += `- ${change.type}: ${change.details}${metrics}\n`;
        }
      });

      // Add code snippets
      summary += '\nCode Snippets:\n';
      changes.forEach((change) => {
        if (change.snippet) {
          summary += `\n${change.snippet}\n`;
        }
      });

      // Add analysis details if confidence is high enough
      if (changeAnalysis.confidence > 0.6 && changeAnalysis.details.length > 0) {
        summary += '\nAnalysis:\n';
        changeAnalysis.details.forEach(detail => {
          summary += `- ${detail}\n`;
        });
      }

      // Save commit info
      await this.projectContext.addCommit(summary, changedFiles);
      this.outputChannel.appendLine(
        `DevTrack: Generated commit summary with code snippets and activity metrics`
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