/* eslint-disable no-undef */

// services/scheduler.ts
import * as vscode from 'vscode';
import { Tracker } from './tracker';
import { SummaryGenerator } from './summaryGenerator';
import { GitService } from './gitService';
import { OutputChannel } from 'vscode';

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private isCommitting = false;
  private pendingChanges = false;

  constructor(
    private commitFrequency: number,
    private tracker: Tracker,
    private summaryGenerator: SummaryGenerator,
    private gitService: GitService,
    private outputChannel: OutputChannel
  ) {}

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
    if (this.isCommitting) {
      this.pendingChanges = true;
      this.outputChannel.appendLine(
        'Scheduler: Commit already in progress, queuing changes.'
      );
      return;
    }

    const changedFiles = this.tracker.getChangedFiles();
    if (changedFiles.length === 0) {
      this.outputChannel.appendLine('Scheduler: No changes detected.');
      return;
    }

    try {
      this.isCommitting = true;
      const commitMessage =
        await this.summaryGenerator.generateSummary(changedFiles);

      const config = vscode.workspace.getConfiguration('devtrack');
      if (config.get<boolean>('confirmBeforeCommit', true)) {
        const userResponse = await vscode.window.showInformationMessage(
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

      await this.gitService.commitAndPush(commitMessage);
      this.tracker.clearChanges();
      this.outputChannel.appendLine(
        `Scheduler: Committed changes with message "${commitMessage}".`
      );
    } catch (error: any) {
      this.outputChannel.appendLine(
        `Scheduler: Failed to commit changes. ${error.message}`
      );
      vscode.window.showErrorMessage(
        `DevTrack: Commit failed. ${error.message}`
      );
    } finally {
      this.isCommitting = false;

      if (this.pendingChanges) {
        this.pendingChanges = false;
        this.outputChannel.appendLine(
          'Scheduler: Processing pending changes...'
        );
        setTimeout(() => this.commitChanges(), 5000); // Wait 5 seconds before processing pending changes
      }
    }
  }

  updateFrequency(newFrequency: number) {
    this.commitFrequency = newFrequency;
    this.start(); // Restart the scheduler with the new frequency
    this.outputChannel.appendLine(
      `Scheduler: Updated commit frequency to ${newFrequency} minutes.`
    );
  }
}
