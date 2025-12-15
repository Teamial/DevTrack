// services/scheduler.ts
import * as vscode from 'vscode';
import {
  setTimeout,
  clearInterval,
  setInterval,
  clearTimeout,
} from 'node:timers';
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
  adaptiveEarlyCommitAfterFraction: number; // 0-1
  adaptiveMinDistinctFiles: number;
  adaptiveMinKeystrokes: number;
}

export class Scheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private isCommitting = false;
  private pendingChanges = false;
  private lastCommitTime: Date = new Date();
  private statusBarItem: vscode.StatusBarItem;
  private countdownTimer: ReturnType<typeof setInterval> | null = null;
  private inactivityPauseTimer: ReturnType<typeof setTimeout> | null = null;
  private isPausedForInactivity: boolean = false;
  private options: SchedulerOptions;
  private isRunning: boolean = false;

  constructor(
    private commitFrequency: number,
    private tracker: Tracker,
    private summaryGenerator: SummaryGenerator,
    private gitService: GitService,
    private outputChannel: OutputChannel,
    countdownStatusBarItem?: vscode.StatusBarItem
  ) {
    // Default options
    this.options = {
      commitFrequency: commitFrequency,
      minChangesForCommit: 1,
      minActiveTimeForCommit: 60, // 1 minute of active time
      maxIdleTimeBeforePause: 15 * 60, // 15 minutes
      enableAdaptiveScheduling: true,
      adaptiveEarlyCommitAfterFraction: 0.5,
      adaptiveMinDistinctFiles: 3,
      adaptiveMinKeystrokes: 120,
    };

    // Use provided countdown status bar item to avoid duplicates; otherwise create one.
    this.statusBarItem =
      countdownStatusBarItem ??
      vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
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
    this.isPausedForInactivity = false;
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
    this.isPausedForInactivity = false;
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
    if (this.isPausedForInactivity) {
      this.statusBarItem.text = `$(debug-pause) Paused`;
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

      // If we've been active for a fraction of the commit frequency
      // and have meaningful activity, commit early.
      const distinctFiles = this.tracker.getChangedFiles().length;
      if (
        timeSinceLastCommit >
          this.commitFrequency *
            60 *
            this.options.adaptiveEarlyCommitAfterFraction &&
        distinctFiles >= this.options.adaptiveMinDistinctFiles &&
        metrics.activeTime > this.options.minActiveTimeForCommit
      ) {
        // If keystrokes are tracked, require some minimal keystrokes to avoid
        // formatters/file-watcher noise. If keystrokes are 0, we allow distinct-files gating.
        if (
          metrics.keystrokes > 0 &&
          metrics.keystrokes < this.options.adaptiveMinKeystrokes
        ) {
          // Not enough typing yet; skip early commit.
        } else {
          this.outputChannel.appendLine(
            'Scheduler: Adaptive commit triggered due to high activity'
          );
          this.commitChanges();
          return;
        }
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
            // Don't actually stop, just pause the timer and countdown UI
            this.isPausedForInactivity = true;
            if (this.timer) {
              clearTimeout(this.timer);
              this.timer = null;
            }
            if (this.countdownTimer) {
              clearInterval(this.countdownTimer);
              this.countdownTimer = null;
            }
            this.updateCountdown();
          }
        }, 60000); // Wait a minute before actually pausing
      } else if (timeSinceLastActivity < 60 && this.inactivityPauseTimer) {
        // Activity detected, clear inactivity timer
        clearTimeout(this.inactivityPauseTimer);
        this.inactivityPauseTimer = null;
        this.isPausedForInactivity = false;

        // Resume timer if it was paused
        if (this.isRunning && !this.timer) {
          this.resetTimer();
          this.startCountdown();
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

      // Build metadata-only summary + append-only JSON log entry
      const { summary: enrichedSummary, logEntry } =
        await this.summaryGenerator.generateSummaryAndLogEntry(
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

      // Commit JSON log entry (and any other staged tracking artifacts)
      await this.gitService.commitAndPush(enrichedSummary, logEntry);
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
    // Metadata-only summaries are already safe; just shorten for the modal.
    const condensed = fullMessage.trim().replace(/\s+/g, ' ');
    if (condensed.length > 300) {
      return condensed.substring(0, 297) + '...';
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
    // Only dispose if Scheduler created its own (not passed in)
    // We detect this by checking whether the item is already in VS Code subscriptions externally.
    // Since we can't reliably detect ownership, we avoid disposing here to prevent disposing a shared item.
  }
}
