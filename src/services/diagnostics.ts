import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { ZipFile } from 'yazl';
import simpleGit from 'simple-git';

function redactSensitive(text: string, pathsToRedact: string[]): string {
  let out = text;

  // Redact common GitHub token patterns
  out = out.replace(/\bghp_[A-Za-z0-9]{20,}\b/g, '<redacted_token>');
  out = out.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '<redacted_token>');
  out = out.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer <redacted_token>');

  // Redact file paths we know about (workspace, home, tracking dir)
  for (const p of pathsToRedact.filter(Boolean)) {
    // Escape for regex
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(escaped, 'g'), '<redacted_path>');
  }

  // Redact any obvious user home path patterns as a fallback
  out = out.replace(/\/Users\/[^/\s]+/g, '/Users/<redacted_user>');
  out = out.replace(/\\Users\\[^\\\s]+/g, '\\Users\\<redacted_user>');

  return out;
}

function safeRemoteHost(remoteUrl: string): string {
  try {
    // Handle https://host/... and git@host:...
    if (remoteUrl.startsWith('http')) {
      const u = new URL(remoteUrl);
      return u.host;
    }
    const m = remoteUrl.match(/@([^:]+):/);
    return m?.[1] ?? '<unknown>';
  } catch {
    return '<unknown>';
  }
}

function getTrackingDirForWorkspaceFolder(folderPath: string): string {
  const workspaceId = Buffer.from(folderPath)
    .toString('base64')
    .replace(/[/+=]/g, '_');
  return path.join(os.homedir(), '.devtrack', 'tracking', workspaceId);
}

export async function exportDiagnostics(args: {
  context: vscode.ExtensionContext;
  outputChannel: vscode.OutputChannel & { getRecentLines?: () => string[] };
}): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const folderPaths = folders.map((f) => f.uri.fsPath);
  const trackingDirs = folderPaths.map(getTrackingDirForWorkspaceFolder);

  const defaultName = `devtrack-diagnostics-${new Date()
    .toISOString()
    .replace(/[:.]/g, '-')}.zip`;
  const defaultUri = vscode.Uri.file(path.join(os.homedir(), defaultName));

  const dest = await vscode.window.showSaveDialog({
    title: 'Export DevTrack Diagnostics',
    defaultUri,
    filters: { Zip: ['zip'] },
    saveLabel: 'Export',
  });
  if (!dest) {
    return;
  }

  const config = vscode.workspace.getConfiguration('devtrack');
  const settingsSnapshot = {
    repoName: config.get('repoName'),
    repoVisibility: config.get('repoVisibility'),
    privacyLevel: config.get('privacyLevel'),
    autoStart: config.get('autoStart'),
    commitFrequency: config.get('commitFrequency'),
    confirmBeforeCommit: config.get('confirmBeforeCommit'),
    exclude: config.get('exclude'),
    enableAdaptiveScheduling: config.get('enableAdaptiveScheduling'),
    adaptiveEarlyCommitAfterFraction: config.get(
      'adaptiveEarlyCommitAfterFraction'
    ),
    adaptiveMinDistinctFiles: config.get('adaptiveMinDistinctFiles'),
    adaptiveMinKeystrokes: config.get('adaptiveMinKeystrokes'),
    trackedExtensionsMode: config.get('trackedExtensionsMode'),
    trackedExtensions: config.get('trackedExtensions'),
    changeDebounceMs: config.get('changeDebounceMs'),
    defaultIgnoredFoldersEnabled: config.get('defaultIgnoredFoldersEnabled'),
    defaultIgnoredFolders: config.get('defaultIgnoredFolders'),
    minChangesForCommit: config.get('minChangesForCommit'),
    minActiveTimeForCommit: config.get('minActiveTimeForCommit'),
    maxIdleTimeBeforePause: config.get('maxIdleTimeBeforePause'),
    trackKeystrokes: config.get('trackKeystrokes'),
    trackLineChanges: config.get('trackLineChanges'),
    authorStrategy: config.get('authorStrategy'),
    authorName: config.get('authorName') ? '<redacted>' : '',
    authorEmail: config.get('authorEmail') ? '<redacted>' : '',
    showReportOnCommit: config.get('showReportOnCommit'),
  };

  const meta = {
    exportedAt: new Date().toISOString(),
    vscodeAppName: vscode.env.appName,
    vscodeHost: (vscode.env as any).appHost ?? undefined,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    extensionVersion:
      args.context.extension?.packageJSON?.version ??
      args.context.extension?.packageJSON?.version,
    workspaceFolders: folderPaths.length,
  };

  const pathsToRedact = [os.homedir(), ...folderPaths, ...trackingDirs];

  const recentLines = args.outputChannel.getRecentLines
    ? args.outputChannel.getRecentLines()
    : [];
  const logsText = redactSensitive(recentLines.join('\n'), pathsToRedact);

  const trackingInfo: any[] = [];
  for (const [idx, trackingDir] of trackingDirs.entries()) {
    const entry: any = {
      workspaceIndex: idx,
      trackingDirExists: fs.existsSync(trackingDir),
      changes: {},
    };
    try {
      const changesDir = path.join(trackingDir, 'changes');
      if (fs.existsSync(changesDir)) {
        const files = await fs.promises.readdir(changesDir);
        const jsonFiles = files.filter((f) => f.endsWith('.json'));
        entry.changes = {
          totalFiles: files.length,
          jsonFiles: jsonFiles.length,
        };
      }
    } catch {
      // ignore
    }

    try {
      if (fs.existsSync(path.join(trackingDir, '.git'))) {
        const git = simpleGit({
          baseDir: trackingDir,
          maxConcurrentProcesses: 1,
        });
        const branch = await git.branch();
        const status = await git.status();
        const latest = await git.log({ maxCount: 1 });
        const remotes = await git.getRemotes(true);
        entry.git = {
          branch: branch.current,
          ahead: status.ahead,
          behind: status.behind,
          modified: status.modified.length,
          staged: status.staged.length,
          latestCommit: latest.latest?.hash ?? null,
          remotes: remotes.map((r) => ({
            name: r.name,
            host: safeRemoteHost(r.refs.fetch ?? ''),
          })),
        };
      }
    } catch {
      // ignore
    }

    trackingInfo.push(entry);
  }

  const zip = new ZipFile();
  zip.addBuffer(
    Buffer.from(JSON.stringify(meta, null, 2), 'utf8'),
    'meta.json'
  );
  zip.addBuffer(
    Buffer.from(JSON.stringify(settingsSnapshot, null, 2), 'utf8'),
    'settings.json'
  );
  zip.addBuffer(Buffer.from(logsText, 'utf8'), 'logs.txt');
  zip.addBuffer(
    Buffer.from(JSON.stringify(trackingInfo, null, 2), 'utf8'),
    'tracking-repos.json'
  );

  await new Promise<void>((resolve, reject) => {
    zip.end();
    const out = fs.createWriteStream(dest.fsPath);
    out.on('close', () => resolve());
    out.on('error', reject);
    zip.outputStream.pipe(out);
  });

  vscode.window.showInformationMessage(
    `DevTrack: Diagnostics exported to ${path.basename(dest.fsPath)}`
  );
}
