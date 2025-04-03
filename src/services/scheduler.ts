// services/scheduler.ts
import * as vscode from 'vscode';
import { setTimeout, clearInterval, setInterval, clearTimeout} from 'node:timers';
import { Tracker, ActivityMetrics } from './tracker';
import { SummaryGenerator } from './summaryGenerator';
import { GitService } from './gitService';
import { OutputChannel } from 'vscode';

interface SchedulerOptions {
  commitFrequency: number;
  minChangesForCommit: number;
  minActiveTimeForCommit: number; // in seconds
  maxIdleTimeBeforePause: number; // in seconds
  enableAdaptiveScheduling: boolean;
}

export class Scheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private isCommitting = false;
  private pendingChanges = false;
  private lastCommitTime: Date = new Date();
  private statusBarItem: vscode.StatusBarItem;
  private countdownTimer: ReturnType<typeof setInterval> | null = null;
  private isAdaptiveMode: boolean = false;
  private inactivityPauseTimer: ReturnType<typeof setTimeout> | null = null;
  private options: SchedulerOptions;
  private isRunning: boolean = false;

  constructor(
    private commitFrequency: number,
    private tracker: Tracker,
    private summaryGenerator: SummaryGenerator,
    private gitService: GitService,
    private outputChannel: OutputChannel
  ) {
    // Default options
    this.options = {
      commitFrequency: commitFrequency,
      minChangesForCommit: 1,
      minActiveTimeForCommit: 60, // 1 minute of active time
      maxIdleTimeBeforePause: 15 * 60, // 15 minutes
      enableAdaptiveScheduling: true,
    };

    // Create status bar item for countdown
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      99
    );
    this.statusBarItem.tooltip = 'Time until next DevTrack commit';
    this.statusBarItem.command = 'devtrack.commitNow';

    // Listen for activity metrics from tracker
    this.tracker.on('activityMetrics', (metrics: ActivityMetrics) => {
      this.handleActivityMetrics(metrics);
    });
  }

  start() {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.lastCommitTime = new Date();
    this.resetTimer();
    this.startCountdown();
    this.statusBarItem.show();
    this.outputChannel.appendLine(
      `Scheduler: Started with a frequency of ${this.commitFrequency} minutes.`
    );
  }

  stop() {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }

    if (this.inactivityPauseTimer) {
      clearTimeout(this.inactivityPauseTimer);
      this.inactivityPauseTimer = null;
    }

    this.statusBarItem.hide();
    this.outputChannel.appendLine('Scheduler: Stopped.');
  }

  private resetTimer() {
    if (this.timer) {
      clearTimeout(this.timer);
    }

    const timeoutMs = this.commitFrequency * 60 * 1000;
    this.timer = setTimeout(() => this.commitChanges(), timeoutMs);
  }

  private startCountdown() {
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
    }

    this.updateCountdown();

    this.countdownTimer = setInterval(() => {
      this.updateCountdown();
    }, 1000);
  }

  private updateCountdown() {
    if (!this.isRunning) {
      return;
    }

    const now = new Date();
    const elapsedMs = now.getTime() - this.lastCommitTime.getTime();
    const remainingMs = Math.max(
      0,
      this.commitFrequency * 60 * 1000 - elapsedMs
    );

    const remainingMinutes = Math.floor(remainingMs / 60000);
    const remainingSeconds = Math.floor((remainingMs % 60000) / 1000);

    this.statusBarItem.text = `$(clock) ${remainingMinutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  }

  private handleActivityMetrics(metrics: ActivityMetrics) {
    // If we're using adaptive scheduling, we might want to commit
    // earlier if there's a lot of activity
    if (
      this.options.enableAdaptiveScheduling &&
      this.isRunning &&
      !this.isCommitting
    ) {
      const now = new Date();
      const timeSinceLastCommit =
        (now.getTime() - this.lastCommitTime.getTime()) / 1000;

      // If we've been active for at least half the commit frequency
      // and have significant changes, commit early
      if (
        timeSinceLastCommit > (this.commitFrequency * 60) / 2 &&
        metrics.fileChanges >= 5 &&
        metrics.activeTime > this.options.minActiveTimeForCommit
      ) {
        this.outputChannel.appendLine(
          'Scheduler: Adaptive commit triggered due to high activity'
        );
        this.commitChanges();
        return;
      }

      // Setup inactivity pause timer if we detect no activity for a while
      const timeSinceLastActivity =
        (now.getTime() - metrics.lastActiveTimestamp.getTime()) / 1000;
      if (
        timeSinceLastActivity > this.options.maxIdleTimeBeforePause &&
        !this.inactivityPauseTimer
      ) {
        this.inactivityPauseTimer = setTimeout(() => {
          if (this.isRunning) {
            this.outputChannel.appendLine(
              'Scheduler: Pausing due to inactivity'
            );
            // Don't actually stop, just pause the timer
            if (this.timer) {
              clearTimeout(this.timer);
              this.timer = null;
            }
          }
        }, 60000); // Wait a minute before actually pausing
      } else if (timeSinceLastActivity < 60 && this.inactivityPauseTimer) {
        // Activity detected, clear inactivity timer
        clearTimeout(this.inactivityPauseTimer);
        this.inactivityPauseTimer = null;

        // Resume timer if it was paused
        if (this.isRunning && !this.timer) {
          this.resetTimer();
          this.outputChannel.appendLine(
            'Scheduler: Resuming from inactivity pause'
          );
        }
      }
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
      this.resetTimer(); // Reset timer anyway
      this.lastCommitTime = new Date();
      return;
    }

    // Get activity metrics
    const activityMetrics = this.tracker.getActivityMetrics();

    // Skip commit if not enough active time (unless it's been a long time)
    const now = new Date();
    const hoursSinceLastCommit =
      (now.getTime() - this.lastCommitTime.getTime()) / (60 * 60 * 1000);

    // If minimal activity and not enough time has passed, skip
    if (
      activityMetrics.activeTime < this.options.minActiveTimeForCommit &&
      hoursSinceLastCommit < 1 &&
      changedFiles.length < 3
    ) {
      this.outputChannel.appendLine(
        `Scheduler: Skipping commit due to minimal activity (${Math.round(activityMetrics.activeTime)} seconds).`
      );
      this.resetTimer();
      return;
    }

    try {
      this.isCommitting = true;
      this.statusBarItem.text = `$(sync~spin) Committing...`;

      // Add activity metrics to the summary
      const enrichedSummary = await this.summaryGenerator.generateSummary(
        changedFiles,
        activityMetrics
      );

      const config = vscode.workspace.getConfiguration('devtrack');
      if (config.get<boolean>('confirmBeforeCommit', true)) {
        // Create a condensed version of the commit message for the dialog
        const condensedMessage =
          this.createCondensedCommitMessage(enrichedSummary);

        const userResponse = await vscode.window.showInformationMessage(
          `DevTrack: A commit will be made with the following changes:\n"${condensedMessage}"`,
          { modal: true },
          'Proceed',
          'Cancel'
        );

        if (userResponse !== 'Proceed') {
          this.outputChannel.appendLine(
            'Scheduler: Commit canceled by the user.'
          );
          this.isCommitting = false;
          this.resetTimer();
          return;
        }
      }

      await this.gitService.commitAndPush(enrichedSummary);
      this.tracker.clearChanges();
      this.tracker.resetMetrics();
      this.lastCommitTime = new Date();
      this.outputChannel.appendLine(
        `Scheduler: Committed changes with metrics: ${Math.round(activityMetrics.activeTime / 60)} minutes active, ${changedFiles.length} files changed`
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
      this.resetTimer();
      this.updateCountdown();

      if (this.pendingChanges) {
        this.pendingChanges = false;
        this.outputChannel.appendLine(
          'Scheduler: Processing pending changes...'
        );
        setTimeout(() => this.commitChanges(), 5000); // Wait 5 seconds before processing pending changes
      }
    }
  }

  // Manually trigger a commit now
  async commitNow() {
    if (this.isCommitting) {
      vscode.window.showInformationMessage(
        'DevTrack: A commit is already in progress.'
      );
      return;
    }

    const changedFiles = this.tracker.getChangedFiles();
    if (changedFiles.length === 0) {
      vscode.window.showInformationMessage('DevTrack: No changes to commit.');
      return;
    }

    // Reset the timer and commit
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    await this.commitChanges();
  }

  private createCondensedCommitMessage(fullMessage: string): string {
    // Extract just the first part of the message (before code snippets)
    const parts = fullMessage.split('Code Snippets:');
    let condensed = parts[0].trim();

    // Add a count of affected files instead of showing all snippets
    const codeBlockCount = (fullMessage.match(/```/g) || []).length / 2;
    condensed += `\n(${codeBlockCount} file${codeBlockCount !== 1 ? 's' : ''} modified)`;

    // Limit to a reasonable length
    if (condensed.length > 500) {
      condensed = condensed.substring(0, 497) + '...';
    }

    return condensed;
  }

  updateFrequency(newFrequency: number) {
    this.commitFrequency = newFrequency;
    this.options.commitFrequency = newFrequency;

    if (this.isRunning) {
      this.resetTimer(); // Restart the scheduler with the new frequency
      this.outputChannel.appendLine(
        `Scheduler: Updated commit frequency to ${newFrequency} minutes.`
      );
    }
  }

  updateOptions(newOptions: Partial<SchedulerOptions>) {
    this.options = { ...this.options, ...newOptions };
    this.outputChannel.appendLine('Scheduler: Updated options');

    if (this.isRunning) {
      this.resetTimer(); // Apply any new settings
    }
  }

  dispose() {
    this.stop();
    this.statusBarItem.dispose();
  }
}
