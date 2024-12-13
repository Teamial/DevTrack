// src/services/projectContext.ts
import * as vscode from 'vscode';
import { Change } from './tracker';
import * as path from 'path';

interface CommitHistory {
  timestamp: number;
  summary: string;
  files: string[];
  hash?: string;
}

interface ProjectStats {
  mostChangedFiles: Map<string, number>;
  recentMilestones: string[];
  activeBranch: string;
  lastCommitTime: Date;
}

interface GitCommit {
  hash: string;
  message: string;
  commitDate: Date;
  files: { uri: vscode.Uri }[];
}

export class ProjectContext {
  private outputChannel: vscode.OutputChannel;
  private extensionContext: vscode.ExtensionContext;
  private commitHistory: CommitHistory[] = [];
  private projectStats: ProjectStats = {
    mostChangedFiles: new Map(),
    recentMilestones: [],
    activeBranch: '',
    lastCommitTime: new Date(),
  };

  constructor(
    outputChannel: vscode.OutputChannel,
    extensionContext: vscode.ExtensionContext
  ) {
    this.outputChannel = outputChannel;
    this.extensionContext = extensionContext;
    this.loadContext();
  }

  private async loadContext() {
    try {
      await this.loadGitHistory();
      await this.updateProjectStats();
      this.outputChannel.appendLine('DevTrack: Loaded project context');
    } catch (error) {
      this.outputChannel.appendLine(
        `DevTrack: Error loading context: ${error}`
      );
    }
  }

  private async loadGitHistory() {
    try {
      const gitExt = vscode.extensions.getExtension('vscode.git');
      if (gitExt) {
        const git = gitExt.exports.getAPI(1);
        if (git.repositories.length > 0) {
          const repo = git.repositories[0];
          const commits = (await repo.log({ maxEntries: 50 })) as GitCommit[];

          this.commitHistory = commits.map((commit: GitCommit) => ({
            timestamp: commit.commitDate.getTime(),
            summary: commit.message,
            files:
              commit.files?.map((f) =>
                vscode.workspace.asRelativePath(f.uri)
              ) || [],
            hash: commit.hash,
          }));
        }
      }
    } catch (error) {
      this.outputChannel.appendLine(
        `DevTrack: Error loading git history: ${error}`
      );
    }
  }

  private shouldTrackFile(filePath: string): boolean {
    // Ignore specific patterns
    const ignorePatterns = [
      'node_modules',
      '.git',
      '.DS_Store',
      'dist',
      'out',
      'build',
      '.vscode',
    ];

    // Get file extension
    const fileExt = path.extname(filePath).toLowerCase().slice(1);

    // Track only specific file types
    const trackedExtensions = [
      'ts',
      'js',
      'py',
      'java',
      'c',
      'cpp',
      'h',
      'hpp',
      'css',
      'scss',
      'html',
      'jsx',
      'tsx',
      'vue',
      'php',
      'rb',
      'go',
      'rs',
      'swift',
      'md',
      'json',
      'yml',
      'yaml',
    ];

    return (
      !ignorePatterns.some((pattern) => filePath.includes(pattern)) &&
      Boolean(fileExt) &&
      trackedExtensions.includes(fileExt)
    );
  }

  public async addCommit(summary: string, changes: Change[]) {
    try {
      const trackedFiles = changes
        .map((change) => vscode.workspace.asRelativePath(change.uri))
        .filter((filePath) => this.shouldTrackFile(filePath));

      // eslint-disable-next-line no-unused-vars
      const commit: CommitHistory = {
        timestamp: Date.now(),
        summary: summary,
        files: trackedFiles,
      };

      await this.loadGitHistory(); // Refresh Git history
      await this.updateProjectStats();
    } catch (error) {
      this.outputChannel.appendLine(`DevTrack: Error adding commit: ${error}`);
    }
  }

  private async updateProjectStats() {
    try {
      const stats = new Map<string, number>();

      // Update file change frequencies from Git history
      this.commitHistory.forEach((commit) => {
        commit.files.forEach((file) => {
          if (this.shouldTrackFile(file)) {
            const count = stats.get(file) || 0;
            stats.set(file, count + 1);
          }
        });
      });

      // Sort by frequency
      const sortedFiles = new Map(
        [...stats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
      );

      // Get git branch
      let currentBranch = '';
      try {
        const gitExt = vscode.extensions.getExtension('vscode.git');
        if (gitExt) {
          const git = gitExt.exports.getAPI(1);
          if (git.repositories.length > 0) {
            currentBranch = git.repositories[0].state.HEAD?.name || '';
          }
        }
      } catch (error) {
        this.outputChannel.appendLine(
          `DevTrack: Error getting git branch: ${error}`
        );
      }

      this.projectStats = {
        mostChangedFiles: sortedFiles,
        recentMilestones: [],
        activeBranch: currentBranch,
        lastCommitTime: new Date(
          this.commitHistory[0]?.timestamp || Date.now()
        ),
      };
    } catch (error) {
      this.outputChannel.appendLine(
        `DevTrack: Error updating project stats: ${error}`
      );
    }
  }

  public getContextForSummary(currentChanges: Change[]): string {
    let context = '';

    try {
      // Get current changed files
      const currentFiles = currentChanges
        .map((change) => path.basename(change.uri.fsPath))
        .filter((file, index, self) => self.indexOf(file) === index);

      if (currentFiles.length > 0) {
        context += `Files: ${currentFiles.join(', ')}. `;
      }

      // Add branch context
      if (this.projectStats.activeBranch) {
        context += `[${this.projectStats.activeBranch}] `;
      }
    } catch (error) {
      this.outputChannel.appendLine(
        `DevTrack: Error generating context summary: ${error}`
      );
    }

    return context;
  }
}
