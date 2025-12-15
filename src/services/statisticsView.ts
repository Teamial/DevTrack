// src/services/statisticsView.ts
import * as vscode from 'vscode';
import { setInterval, clearInterval } from 'node:timers';
import { StatisticsProvider } from './statisticsProvider';
import * as fs from 'fs';
import * as path from 'path';

export class StatisticsView {
  private panel: vscode.WebviewPanel | undefined;
  private disposables: vscode.Disposable[] = [];
  private updateInterval: ReturnType<typeof setInterval> | undefined;
  private statsHtmlPath: string;
  private isFirstLoad: boolean = true;

  constructor(
    private context: vscode.ExtensionContext,
    private statisticsProvider: StatisticsProvider,
    private outputChannel: vscode.OutputChannel,
    private trackingDir: string
  ) {
    this.statsHtmlPath = path.join(this.trackingDir, 'stats', 'index.html');
  }

  public show() {
    const columnToShowIn = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (this.panel) {
      this.panel.reveal(columnToShowIn);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'devtrackStats',
      'DevTrack Coding Statistics',
      columnToShowIn || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.file(this.trackingDir),
          vscode.Uri.file(path.join(this.context.extensionPath, 'media')),
        ],
      }
    );

    // Set webview content
    this.updateWebview();

    // Handle messages from the webview
    this.panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case 'refresh':
            await this.updateStatistics();
            break;
          case 'themeChanged':
            await this.context.globalState.update(
              'devtrackTheme',
              message.theme
            );
            break;
        }
      },
      null,
      this.disposables
    );

    // Handle panel disposal
    this.panel.onDidDispose(
      () => {
        this.panel = undefined;
        this.stopAutoRefresh();
        this.dispose();
      },
      null,
      this.disposables
    );

    // Start auto-refresh if not already running
    this.setupAutoRefresh();
  }

  private async updateWebview() {
    if (!this.panel) {
      return;
    }

    try {
      const stats = await this.statisticsProvider.getStatistics();
      const savedTheme = await this.context.globalState.get(
        'devtrackTheme',
        'system'
      );

      // Render a local, dependency-free dashboard (works in VS Code + Cursor without bundling)
      this.panel.webview.html = this.getWebviewContent(stats, savedTheme);

      if (this.isFirstLoad) {
        this.isFirstLoad = false;
        this.outputChannel.appendLine('DevTrack: Statistics view initialized');
      }
    } catch (error) {
      this.outputChannel.appendLine(`Error updating webview: ${error}`);
      this.panel.webview.html = this.getErrorContent();
    }
  }

  private getWebviewContent(stats: any, theme: string): string {
    const safeStats = JSON.stringify(stats ?? {});
    const safeTheme = JSON.stringify(theme ?? 'system');

    // Minimal dashboard with no external dependencies (more reliable across IDEs).
    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>DevTrack Statistics</title>
    <style>
      :root { color-scheme: light dark; }
      body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; padding: 16px; }
      .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
      .card { border: 1px solid rgba(127,127,127,0.25); border-radius: 10px; padding: 12px; }
      .label { opacity: 0.7; font-size: 12px; }
      .value { font-size: 22px; font-weight: 700; margin-top: 6px; }
      h2 { margin: 18px 0 10px; font-size: 16px; }
      table { width: 100%; border-collapse: collapse; }
      th, td { text-align: left; padding: 8px; border-bottom: 1px solid rgba(127,127,127,0.25); font-size: 13px; }
      .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 12px; }
      @media (max-width: 980px) { .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .row { grid-template-columns: 1fr; } }
      button { padding: 8px 10px; border-radius: 8px; border: 1px solid rgba(127,127,127,0.35); background: transparent; cursor: pointer; }
      .topbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .muted { opacity: 0.75; font-size: 12px; }
    </style>
    <script>
      const vscode = acquireVsCodeApi();
      const stats = ${safeStats};
      const theme = ${safeTheme};
      function fmt(n) { return typeof n === 'number' ? n.toLocaleString() : String(n ?? '0'); }
      function render() {
        document.getElementById('totalTime').textContent = fmt(Math.round((stats.totalTime ?? 0) * 10) / 10) + 'h';
        document.getElementById('filesModified').textContent = fmt(stats.filesModified ?? 0);
        document.getElementById('totalCommits').textContent = fmt(stats.totalCommits ?? 0);
        document.getElementById('linesChanged').textContent = fmt(stats.linesChanged ?? 0);
        const themeEl = document.getElementById('theme');
        if (themeEl) themeEl.textContent = theme;

        const ft = (stats.fileTypes ?? []).slice(0, 12);
        document.getElementById('fileTypesBody').innerHTML = ft.map(r => 
          '<tr><td>' + (r.name ?? 'Unknown') + '</td><td>' + fmt(r.count ?? 0) + '</td><td>' + fmt(r.percentage ?? 0) + '%</td></tr>'
        ).join('') || '<tr><td colspan=\"3\" class=\"muted\">No data yet</td></tr>';

        const tl = (stats.activityTimeline ?? []).slice(-14);
        document.getElementById('timelineBody').innerHTML = tl.map(r =>
          '<tr><td>' + (r.date ?? '') + '</td><td>' + fmt(r.commits ?? 0) + '</td><td>' + fmt(r.filesChanged ?? 0) + '</td><td>' + fmt(r.linesChanged ?? 0) + '</td></tr>'
        ).join('') || '<tr><td colspan=\"4\" class=\"muted\">No data yet</td></tr>';
      }
      window.addEventListener('message', (event) => {
        const msg = event.data;
        if (msg?.command === 'updateStats' && msg?.stats) {
          Object.assign(stats, msg.stats);
          render();
        }
      });
      window.addEventListener('DOMContentLoaded', render);
      function refresh() { vscode.postMessage({ command: 'refresh' }); }
    </script>
  </head>
  <body>
    <div class="topbar">
      <div>
        <div style="font-weight:700;">DevTrack Coding Statistics</div>
        <div class="muted">Theme: <span id="theme"></span></div>
      </div>
      <button onclick="refresh()">Refresh</button>
    </div>

    <div style="height: 12px;"></div>
    <div class="grid">
      <div class="card"><div class="label">Total Coding Time</div><div class="value" id="totalTime">0h</div></div>
      <div class="card"><div class="label">Files Modified</div><div class="value" id="filesModified">0</div></div>
      <div class="card"><div class="label">Total Commits</div><div class="value" id="totalCommits">0</div></div>
      <div class="card"><div class="label">Lines Changed (est.)</div><div class="value" id="linesChanged">0</div></div>
    </div>

    <div class="row">
      <div class="card">
        <h2>Recent Activity (last 14 days with data)</h2>
        <table>
          <thead><tr><th>Date</th><th>Commits</th><th>Files</th><th>Lines (est.)</th></tr></thead>
          <tbody id="timelineBody"></tbody>
        </table>
      </div>
      <div class="card">
        <h2>File Types</h2>
        <table>
          <thead><tr><th>Type</th><th>Count</th><th>%</th></tr></thead>
          <tbody id="fileTypesBody"></tbody>
        </table>
      </div>
    </div>
  </body>
</html>`;
  }

  private getErrorContent(): string {
    return `
      <!DOCTYPE html>
      <html>
        <body>
          <div style="display: flex; justify-content: center; align-items: center; height: 100vh;">
            <div style="text-align: center;">
              <h2>Failed to load statistics</h2>
              <button onclick="window.vscode.postMessage({command: 'refresh'})">
                Retry
              </button>
            </div>
          </div>
        </body>
      </html>
    `;
  }

  private setupAutoRefresh() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }

    this.updateInterval = setInterval(
      () => {
        this.updateStatistics();
      },
      5 * 60 * 1000
    ); // Update every 5 minutes
  }

  private stopAutoRefresh() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = undefined;
    }
  }

  private async updateStatistics() {
    if (!this.panel) {
      return;
    }

    try {
      const stats = await this.statisticsProvider.getStatistics();
      this.panel.webview.postMessage({ command: 'updateStats', stats });
    } catch (error) {
      this.outputChannel.appendLine(`Error updating statistics: ${error}`);
    }
  }

  public dispose() {
    this.stopAutoRefresh();
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }
}
