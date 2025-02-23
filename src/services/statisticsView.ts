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

      // Get the dashboard HTML content
      const dashboardHtml = await fs.promises.readFile(
        this.statsHtmlPath,
        'utf8'
      );

      // Create webview content with current stats and theme
      const webviewContent = this.getWebviewContent(
        dashboardHtml,
        stats,
        savedTheme
      );

      this.panel.webview.html = webviewContent;

      if (this.isFirstLoad) {
        this.isFirstLoad = false;
        this.outputChannel.appendLine('DevTrack: Statistics view initialized');
      }
    } catch (error) {
      this.outputChannel.appendLine(`Error updating webview: ${error}`);
      this.panel.webview.html = this.getErrorContent();
    }
  }

  private getWebviewContent(
    dashboardHtml: string,
    stats: any,
    theme: string
  ): string {
    // Get webview URIs for any local resources
    const scriptUri = this.panel!.webview.asWebviewUri(
      vscode.Uri.file(path.join(this.trackingDir, 'stats', 'dashboard.js'))
    );

    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>DevTrack Statistics</title>
        <script src="https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js"></script>
        <script src="https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js"></script>
        <script src="https://cdnjs.cloudflare.com/ajax/libs/recharts/2.12.0/Recharts.js"></script>
        <link href="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css" rel="stylesheet">
        <script>
          window.vscode = acquireVsCodeApi();
          window.initialStats = ${JSON.stringify(stats)};
          window.initialTheme = "${theme}";
        </script>
      </head>
      <body>
        <div id="root"></div>
        <script src="${scriptUri}"></script>
      </body>
      </html>
    `;
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
