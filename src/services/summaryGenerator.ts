// src/services/summaryGenerator.ts
import * as vscode from 'vscode';
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

  async generateSummary(changedFiles: Change[]): Promise<string> {
    try {
      // Get change statistics
      const stats = this.calculateChangeStats(changedFiles);

      // Get project context - now passing changedFiles
      const context = this.projectContext.getContextForSummary(changedFiles);

      // Build the summary
      let summary = this.buildSummaryString(context, stats);

      // Save to project context
      await this.projectContext.addCommit(summary, changedFiles);

      this.outputChannel.appendLine(
        `DevTrack: Generated commit summary: "${summary}"`
      );

      return summary;
    } catch (error) {
      this.outputChannel.appendLine(
        `DevTrack: Error generating summary: ${error}`
      );
      // Return a basic summary in case of error
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

  private buildSummaryString(
    context: string,
    stats: { added: number; modified: number; deleted: number }
  ): string {
    let summary = 'DevTrack: ';

    // Add context if available
    if (context) {
      summary += context;
    }

    // Add change statistics
    let changeDetails = [];
    if (stats.added > 0) {
      changeDetails.push(`${stats.added} added`);
    }
    if (stats.modified > 0) {
      changeDetails.push(`${stats.modified} modified`);
    }
    if (stats.deleted > 0) {
      changeDetails.push(`${stats.deleted} deleted`);
    }

    // Add change details if there are any
    if (changeDetails.length > 0) {
      if (context) {
        summary += '| '; // Add separator if we have context
      }
      summary += changeDetails.join(', ');
    }

    return summary;
  }
}
