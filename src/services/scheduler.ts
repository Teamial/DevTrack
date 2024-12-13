/* eslint-disable no-undef */
/* eslint-disable no-unused-vars */
// services/scheduler.ts
import { Tracker, Change } from './tracker';
import { SummaryGenerator } from './summaryGenerator';
import { GitService } from './gitService';
import { OutputChannel, window, workspace } from 'vscode';

export class Scheduler {
  private commitFrequency: number; // in minutes
  private timer: NodeJS.Timeout | null = null;
  private tracker: Tracker;
  private summaryGenerator: SummaryGenerator;
  private gitService: GitService;
  private outputChannel: OutputChannel;

  constructor(
    commitFrequency: number,
    tracker: Tracker,
    summaryGenerator: SummaryGenerator,
    gitService: GitService,
    outputChannel: OutputChannel
  ) {
    this.commitFrequency = commitFrequency;
    this.tracker = tracker;
    this.summaryGenerator = summaryGenerator;
    this.gitService = gitService;
    this.outputChannel = outputChannel;
  }

  start() {
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.timer = setInterval(
      () => this.commitChanges(),
      this.commitFrequency * 60 * 1000
    );
    this.outputChannel.appendLine(
      `Scheduler: Started with a frequency of ${this.commitFrequency} minutes.`
    );
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.outputChannel.appendLine('Scheduler: Stopped.');
    }
  }

  async commitChanges() {
    const changedFiles = this.tracker.getChangedFiles();
    if (changedFiles.length === 0) {
      this.outputChannel.appendLine('Scheduler: No changes detected.');
      return;
    }

    const commitMessage =
      await this.summaryGenerator.generateSummary(changedFiles);

    const config = workspace.getConfiguration('devtrack');
    const confirmBeforeCommit = config.get<boolean>(
      'confirmBeforeCommit',
      true
    );

    if (confirmBeforeCommit) {
      // Notify the user about the upcoming commit
      const userResponse = await window.showInformationMessage(
        `DevTrack: A commit will be made with the following message:\n"${commitMessage}"`,
        { modal: true },
        'Proceed',
        'Cancel'
      );

      if (userResponse !== 'Proceed') {
        this.outputChannel.appendLine(
          'Scheduler: Commit canceled by the user.'
        );
        return;
      }
    }

    try {
      await this.gitService.commitAndPush(commitMessage);
      this.tracker.clearChanges();
      this.outputChannel.appendLine(
        `Scheduler: Committed changes with message "${commitMessage}".`
      );
    } catch (error) {
      this.outputChannel.appendLine('Scheduler: Failed to commit changes.');
    }
  }

  updateFrequency(newFrequency: number) {
    this.commitFrequency = newFrequency;
    this.start();
    this.outputChannel.appendLine(
      `Scheduler: Updated commit frequency to ${newFrequency} minutes.`
    );
  }
}
