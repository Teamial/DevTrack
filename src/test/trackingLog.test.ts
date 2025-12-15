import { strictEqual, ok } from 'assert';
import { buildTrackingLogEntryV1 } from '../services/trackingLog';

suite('TrackingLog', () => {
  test('buildTrackingLogEntryV1 does not include relative paths by default', () => {
    const entry = buildTrackingLogEntryV1({
      changeType: 'feature',
      activityMetrics: {
        activeTime: 61,
        fileChanges: 3,
        keystrokes: 120,
        lastActiveTimestamp: new Date(),
      },
      relativePaths: ['src/a.ts', 'src/b.ts', 'README.md'],
      privacyLevel: 'extensions',
      trackKeystrokes: true,
    });

    strictEqual(entry.version, 1);
    strictEqual(entry.files.totalChangedFiles, 3);
    strictEqual(typeof entry.files.extensions, 'object');
    strictEqual(entry.files.relativePaths, undefined);
    ok(entry.activity.keystrokes !== undefined);
  });

  test('buildTrackingLogEntryV1 omits keystrokes when disabled', () => {
    const entry = buildTrackingLogEntryV1({
      changeType: 'bugfix',
      activityMetrics: {
        activeTime: 10,
        fileChanges: 1,
        keystrokes: 999,
        lastActiveTimestamp: new Date(),
      },
      relativePaths: ['src/a.ts'],
      privacyLevel: 'aggregateOnly',
      trackKeystrokes: false,
    });

    strictEqual(entry.activity.keystrokes, undefined);
    strictEqual(entry.files.extensions, undefined);
    strictEqual(entry.files.relativePaths, undefined);
  });
});


