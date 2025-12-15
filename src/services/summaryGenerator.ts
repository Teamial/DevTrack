// src/services/summaryGenerator.ts
import * as vscode from 'vscode';
import * as path from 'path';
import { Change } from './tracker';
import { ProjectContext } from './projectContext';
import { ActivityMetrics } from './tracker';
import { ChangeAnalyzer, ChangeType } from './changeAnalyzer';
import {
  buildTrackingLogEntryV1,
  PrivacyLevel,
  TrackingLogEntryV1,
} from './trackingLog';

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

  private formatActivitySummary(
    metrics: ActivityMetrics,
    changeType: ChangeType
  ): string {
    const formattedDuration = this.formatDuration(metrics.activeTime);

    let activitySummary = `Active coding time: ${formattedDuration}`;

    if (metrics.keystrokes > 0) {
      activitySummary += `, ${metrics.keystrokes} keystrokes`;
    }

    if (metrics.fileChanges > 0) {
      activitySummary += `, ${metrics.fileChanges} file change events`;
    }

    // Add change type description
    let changeDescription = '';
    switch (changeType) {
      case 'feature':
        changeDescription = '✨ Feature development';
        break;
      case 'bugfix':
        changeDescription = '🐛 Bug fixing';
        break;
      case 'refactor':
        changeDescription = '♻️ Code refactoring';
        break;
      case 'docs':
        changeDescription = '📝 Documentation';
        break;
      case 'style':
        changeDescription = '💄 Styling/formatting';
        break;
      default:
        changeDescription = '👨‍💻 Coding session';
    }

    return `${changeDescription} (${activitySummary})`;
  }

  public async generateSummaryAndLogEntry(
    changedFiles: Change[],
    activityMetrics: ActivityMetrics
  ): Promise<{ summary: string; logEntry: TrackingLogEntryV1 }> {
    const localTime = new Date().toLocaleString();
    let summary = `DevTrack Update - ${localTime}\n\n`;

    const config = vscode.workspace.getConfiguration('devtrack');
    const privacyLevel =
      (config.get<string>('privacyLevel') as PrivacyLevel) || 'extensions';
    const trackKeystrokes = config.get<boolean>('trackKeystrokes', true);

    // Analyze the type of changes (local only; no content is persisted)
    const changeAnalysis =
      await this.changeAnalyzer.analyzeChanges(changedFiles);

    summary +=
      this.formatActivitySummary(activityMetrics, changeAnalysis.type) + '\n\n';

    // Add project context (branch + file basenames)
    const projectContext =
      this.projectContext.getContextForSummary(changedFiles);
    if (projectContext) {
      summary += projectContext + '\n';
    }

    // Minimal, non-sensitive change list
    const relPaths = changedFiles.map((c) =>
      vscode.workspace.asRelativePath(c.uri)
    );
    summary += `Changed files: ${relPaths.length}\n`;
    if (privacyLevel === 'relativePaths') {
      // Still no code contents; only paths inside the workspace
      for (const p of relPaths) {
        summary += `- ${p}\n`;
      }
    } else {
      // Avoid listing paths by default
      const names = changedFiles
        .map((c) => path.basename(c.uri.fsPath))
        .filter((v, i, a) => a.indexOf(v) === i)
        .slice(0, 10);
      if (names.length > 0) {
        summary += `Files: ${names.join(', ')}${relPaths.length > names.length ? '…' : ''}\n`;
      }
    }

    // Build JSON log entry (append-only)
    const logEntry = buildTrackingLogEntryV1({
      changeType: changeAnalysis.type,
      activityMetrics,
      relativePaths: relPaths,
      privacyLevel,
      trackKeystrokes,
    });

    // Save commit info (in-memory context refresh)
    await this.projectContext.addCommit(summary, changedFiles);
    this.outputChannel.appendLine(
      'DevTrack: Generated metadata-only summary + log entry'
    );

    return { summary, logEntry };
  }

  async generateSummary(
    changedFiles: Change[],
    activityMetrics?: ActivityMetrics
  ): Promise<string> {
    try {
      if (!activityMetrics) {
        // Backwards fallback; if no metrics provided, use zeros.
        activityMetrics = {
          activeTime: 0,
          fileChanges: changedFiles.length,
          keystrokes: 0,
          lastActiveTimestamp: new Date(),
        };
      }

      const { summary } = await this.generateSummaryAndLogEntry(
        changedFiles,
        activityMetrics
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
