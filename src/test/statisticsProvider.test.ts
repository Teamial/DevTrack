import { strictEqual } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { StatisticsProvider } from '../services/statisticsProvider';

suite('StatisticsProvider', () => {
  test('aggregates TrackingLogEntryV1 json files', async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'devtrack-'));
    const trackingDir = tmp;
    const changesDir = path.join(trackingDir, 'changes');
    await fs.promises.mkdir(changesDir, { recursive: true });

    const base = {
      version: 1,
      changeType: 'feature',
      activity: { activeTimeSeconds: 60, fileChangeEvents: 2, keystrokes: 10 },
      files: { totalChangedFiles: 2, extensions: { '.ts': 2 } },
    };

    await fs.promises.writeFile(
      path.join(changesDir, 'a.json'),
      JSON.stringify({ ...base, timestamp: '2025-12-15T10:00:00.000Z' }),
      'utf8'
    );
    await fs.promises.writeFile(
      path.join(changesDir, 'b.json'),
      JSON.stringify({ ...base, timestamp: '2025-12-15T11:00:00.000Z', files: { totalChangedFiles: 1, extensions: { '.md': 1 } } }),
      'utf8'
    );

    const outputChannel = vscode.window.createOutputChannel('DevTrack Test');
    const provider = new StatisticsProvider(outputChannel, trackingDir);
    const stats = await provider.getStatistics();

    strictEqual(stats.totalCommits, 2);
    strictEqual(stats.filesModified, 3);
    // 10 lines estimate per file
    strictEqual(stats.linesChanged, 30);
    // fileTypes should include TS and MD
    const types = stats.fileTypes.map((t) => t.name).sort();
    strictEqual(types.includes('TS'), true);
    strictEqual(types.includes('MD'), true);
  });
});


