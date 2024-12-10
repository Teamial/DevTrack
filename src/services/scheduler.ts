import { Tracker, Change } from './tracker';
import { SummaryGenerator } from './summaryGenerator';
import { GitService } from './gitService';
import * as nodeSchedule from 'node-schedule';

export class Scheduler {
  private intervalMinutes: number;
  private tracker: Tracker;
  private summaryGenerator: SummaryGenerator;
  private gitService: GitService;
  private job: nodeSchedule.Job | null = null;

  constructor(intervalMinutes: number, tracker: Tracker, summaryGenerator: SummaryGenerator, gitService: GitService) {
    this.intervalMinutes = intervalMinutes;
    this.tracker = tracker;
    this.summaryGenerator = summaryGenerator;
    this.gitService = gitService;
  }

  start() {
    if (this.job) {
      console.log('DevTrackr: Scheduler is already running.');
      return;
    }

    // Schedule the job to run every 'intervalMinutes' minutes
    const rule = new nodeSchedule.RecurrenceRule();
    rule.minute = new nodeSchedule.Range(0, 59, this.intervalMinutes);

    this.job = nodeSchedule.scheduleJob(rule, async () => {
      const changes: Change[] = this.tracker.getChangesAndClear();
      const summary = this.summaryGenerator.generateSummary(changes);
      await this.gitService.addAndCommit(summary);
      console.log(`DevTrackr: Committed - ${summary}`);
    });

    console.log(`DevTrackr: Scheduler started with interval ${this.intervalMinutes} minutes.`);
  }

  stop() {
    if (this.job) {
      this.job.cancel();
      this.job = null;
      console.log('DevTrackr: Scheduler stopped.');
    } else {
      console.log('DevTrackr: Scheduler is not running.');
    }
  }

  updateFrequency(newInterval: number) {
    if (this.intervalMinutes === newInterval) {
      return;
    }
    this.intervalMinutes = newInterval;
    this.stop();
    this.start();
    console.log(`DevTrackr: Scheduler frequency updated to ${this.intervalMinutes} minutes.`);
  }
}
