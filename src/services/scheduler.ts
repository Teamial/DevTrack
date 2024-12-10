// services/scheduler.ts
import { Tracker } from './tracker';
import { SummaryGenerator } from './summaryGenerator';
import { GitService } from './gitService';

export class Scheduler {
  private commitFrequency: number; // in minutes
  private timer: NodeJS.Timeout | null = null;
  private tracker: Tracker;
  private summaryGenerator: SummaryGenerator;
  private gitService: GitService;

  constructor(
    commitFrequency: number,
    tracker: Tracker,
    summaryGenerator: SummaryGenerator,
    gitService: GitService
  ) {
    this.commitFrequency = commitFrequency;
    this.tracker = tracker;
    this.summaryGenerator = summaryGenerator;
    this.gitService = gitService;
  }

  start() {
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.timer = setInterval(() => this.commitChanges(), this.commitFrequency * 60 * 1000);
    console.log(`Scheduler: Started with a frequency of ${this.commitFrequency} minutes.`);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('Scheduler: Stopped.');
    }
  }

  async commitChanges() {
    const changedFiles = this.tracker.getChangedFiles();
    if (changedFiles.length === 0) {
      console.log('Scheduler: No changes detected.');
      return;
    }

    const commitMessage = await this.summaryGenerator.generateSummary(changedFiles);
    try {
      await this.gitService.addAndCommit(commitMessage);
      this.tracker.clearChanges();
      console.log(`Scheduler: Committed changes with message "${commitMessage}".`);
    } catch (error) {
      console.error('Scheduler: Failed to commit changes:', error);
    }
  }

  updateFrequency(newFrequency: number) {
    this.commitFrequency = newFrequency;
    this.start();
    console.log(`Scheduler: Updated commit frequency to ${newFrequency} minutes.`);
  }
}
