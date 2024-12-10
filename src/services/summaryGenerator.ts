// src/services/summaryGenerator.ts
import { Change } from './tracker';
import { OutputChannel } from 'vscode';

export class SummaryGenerator {
  private outputChannel: OutputChannel;

  constructor(outputChannel: OutputChannel) {
    this.outputChannel = outputChannel;
  }

  async generateSummary(changedFiles: Change[]): Promise<string> {
    // Example summary: List of changed files
    const added = changedFiles.filter(change => change.type === 'added').length;
    const modified = changedFiles.filter(change => change.type === 'changed').length;
    const deleted = changedFiles.filter(change => change.type === 'deleted').length;

    let summary = 'DevTrack: Commit Summary - ';

    if (added > 0) {
      summary += `${added} added, `;
    }
    if (modified > 0) {
      summary += `${modified} modified, `;
    }
    if (deleted > 0) {
      summary += `${deleted} deleted, `;
    }

    // Remove trailing comma and space
    summary = summary.replace(/, $/, '');

    this.outputChannel.appendLine(`DevTrack: Generated commit summary: "${summary}"`);
    return summary;
  }
}
