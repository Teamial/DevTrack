import * as path from 'path';
import { ChangeType } from './changeAnalyzer';
import { ActivityMetrics, Change } from './tracker';

export type PrivacyLevel = 'aggregateOnly' | 'extensions' | 'relativePaths';

export interface TrackingLogEntryV1 {
  version: 1;
  timestamp: string; // ISO
  workspaceId?: string;
  changeType: ChangeType;
  activity: {
    activeTimeSeconds: number;
    fileChangeEvents: number;
    keystrokes?: number;
  };
  files: {
    totalChangedFiles: number;
    extensions?: Record<string, number>;
    relativePaths?: string[];
  };
}

function countExtensions(relativePaths: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const p of relativePaths) {
    const ext = path.extname(p).toLowerCase() || 'unknown';
    counts[ext] = (counts[ext] ?? 0) + 1;
  }
  return counts;
}

export function buildTrackingLogEntryV1(args: {
  timestamp?: Date;
  changeType: ChangeType;
  activityMetrics: ActivityMetrics;
  relativePaths: string[];
  privacyLevel: PrivacyLevel;
  trackKeystrokes: boolean;
}): TrackingLogEntryV1 {
  const ts = args.timestamp ?? new Date();

  const entry: TrackingLogEntryV1 = {
    version: 1,
    timestamp: ts.toISOString(),
    changeType: args.changeType,
    activity: {
      activeTimeSeconds: Math.round(args.activityMetrics.activeTime),
      fileChangeEvents: args.activityMetrics.fileChanges,
      ...(args.trackKeystrokes
        ? { keystrokes: args.activityMetrics.keystrokes }
        : {}),
    },
    files: {
      totalChangedFiles: args.relativePaths.length,
    },
  };

  if (args.privacyLevel === 'relativePaths') {
    entry.files.relativePaths = args.relativePaths;
  } else if (args.privacyLevel === 'extensions') {
    entry.files.extensions = countExtensions(args.relativePaths);
  }

  return entry;
}

export function getRelativePathsForChanges(changes: Change[]): string[] {
  // Caller should map via vscode.workspace.asRelativePath when available.
  // This helper is mainly for tests or when changes already contain relative paths.
  return changes.map((c) => c.uri.fsPath);
}
