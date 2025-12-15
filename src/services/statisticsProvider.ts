// src/services/statisticsProvider.ts
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

interface CodingStatistics {
  totalTime: number;
  filesModified: number;
  totalCommits: number;
  linesChanged: number;
  activityTimeline: ActivityData[];
  timeDistribution: TimeDistribution[];
  fileTypes: FileTypeStats[];
}

interface ActivityData {
  date: string;
  commits: number;
  filesChanged: number;
  linesChanged: number;
}

interface TimeDistribution {
  hour: string;
  changes: number;
}

interface FileTypeStats {
  name: string;
  count: number;
  percentage: number;
}

export class StatisticsProvider {
  private outputChannel: vscode.OutputChannel;
  private trackingDir: string;

  constructor(outputChannel: vscode.OutputChannel, trackingDir: string) {
    this.outputChannel = outputChannel;
    this.trackingDir = trackingDir;
  }

  async getStatistics(): Promise<CodingStatistics> {
    try {
      const changesDir = path.join(this.trackingDir, 'changes');
      let files: string[] = [];
      try {
        files = await fs.promises.readdir(changesDir);
      } catch (e) {
        // No changes yet
        return {
          totalTime: 0,
          filesModified: 0,
          totalCommits: 0,
          linesChanged: 0,
          activityTimeline: [],
          timeDistribution: [],
          fileTypes: [],
        };
      }

      // Process all change files
      const stats = await this.processChangeFiles(files, changesDir);

      return {
        totalTime: this.calculateTotalTime(stats.activityTimeline),
        filesModified: stats.filesModified,
        totalCommits: stats.totalCommits,
        linesChanged: stats.linesChanged,
        activityTimeline: stats.activityTimeline,
        timeDistribution: this.calculateTimeDistribution(stats.timeData),
        fileTypes: this.calculateFileTypeStats(stats.fileTypes),
      };
    } catch (error) {
      this.outputChannel.appendLine(`Error getting statistics: ${error}`);
      throw error;
    }
  }

  private async processChangeFiles(files: string[], changesDir: string) {
    const stats = {
      filesModified: 0,
      totalCommits: 0,
      linesChanged: 0,
      activityTimeline: new Map<string, ActivityData>(),
      timeData: new Map<number, number>(),
      fileTypes: new Map<string, number>(),
    };

    for (const file of files) {
      if (!file.endsWith('.json')) {
        continue;
      }

      const filePath = path.join(changesDir, file);
      try {
        const content = await fs.promises.readFile(filePath, 'utf8');
        const changeData = JSON.parse(content);
        this.processChangeData(changeData, stats);
      } catch (e) {
        // Skip invalid files
        continue;
      }
    }

    return {
      ...stats,
      activityTimeline: Array.from(stats.activityTimeline.values()),
    };
  }

  private processChangeData(changeData: any, stats: any) {
    // Expect TrackingLogEntryV1 shape
    const date = new Date(changeData.timestamp);
    const dateKey = date.toISOString().split('T')[0];
    const hour = date.getHours();
    const totalChangedFiles =
      changeData?.files?.totalChangedFiles ?? changeData?.files?.length ?? 0;
    const activeTimeSeconds = changeData?.activity?.activeTimeSeconds ?? 0;

    // Update timeline data
    if (!stats.activityTimeline.has(dateKey)) {
      stats.activityTimeline.set(dateKey, {
        date: dateKey,
        commits: 0,
        filesChanged: 0,
        linesChanged: 0,
      });
    }
    const timelineData = stats.activityTimeline.get(dateKey);
    timelineData.commits++;
    timelineData.filesChanged += totalChangedFiles;
    // Lines changed is not stored (privacy); keep a simple estimate
    timelineData.linesChanged += this.estimateLineChanges(totalChangedFiles);

    // Update hourly distribution
    stats.timeData.set(hour, (stats.timeData.get(hour) || 0) + 1);

    // Update file type statistics
    const extensions: Record<string, number> | undefined =
      changeData?.files?.extensions;
    if (extensions && typeof extensions === 'object') {
      for (const [ext, count] of Object.entries(extensions)) {
        const key = (ext || 'unknown').toLowerCase();
        stats.fileTypes.set(key, (stats.fileTypes.get(key) || 0) + Number(count || 0));
      }
    }

    // Update total statistics
    stats.totalCommits++;
    stats.filesModified += totalChangedFiles;
    stats.linesChanged += this.estimateLineChanges(totalChangedFiles);
  }

  private calculateTotalTime(timeline: ActivityData[]): number {
    // Estimate coding time based on activity frequency
    const AVERAGE_SESSION_LENGTH = 30; // minutes
    return (timeline.length * AVERAGE_SESSION_LENGTH) / 60; // Convert to hours
  }

  private calculateTimeDistribution(
    timeData: Map<number, number>
  ): TimeDistribution[] {
    return Array.from(timeData.entries()).map(([hour, changes]) => ({
      hour: `${hour % 12 || 12}${hour < 12 ? 'AM' : 'PM'}`,
      changes,
    }));
  }

  private calculateFileTypeStats(
    fileTypes: Map<string, number>
  ): FileTypeStats[] {
    const total = Array.from(fileTypes.values()).reduce((a, b) => a + b, 0);
    return Array.from(fileTypes.entries())
      .map(([ext, count]) => ({
        name: ext.slice(1).toUpperCase(),
        count,
        percentage: Math.round((count / total) * 100),
      }))
      .sort((a, b) => b.count - a.count);
  }

  private estimateLineChanges(totalChangedFiles: number): number {
    // Simple estimation based on file count (privacy-safe)
    return totalChangedFiles * 10; // Rough estimate
  }
}
