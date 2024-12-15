/* eslint-disable no-undef */
/* eslint-disable no-unused-vars */
import simpleGit, { SimpleGit } from 'simple-git';
import * as vscode from 'vscode';
import * as path from 'path';
import { minimatch } from 'minimatch';
import { EventEmitter } from 'events';
import { OutputChannel } from 'vscode';
import * as fs from 'fs';

export class GitService extends EventEmitter {
  private git: SimpleGit;
  private repoPath: string;
  private outputChannel: OutputChannel;
  private trackingDirectory: string;
  private initialTimestampFile: string;
  private isCommitting: boolean = false;

  constructor(outputChannel: OutputChannel) {
    super();
    this.outputChannel = outputChannel;
    const workspaceFolders = vscode.workspace.workspaceFolders;

    if (!workspaceFolders || workspaceFolders.length === 0) {
      vscode.window.showErrorMessage(
        'DevTrack: No workspace folder is open. Please open a folder to start tracking.'
      );
      throw new Error('No workspace folder open.');
    }

    const workspaceFolder = workspaceFolders[0].uri.fsPath;
    this.repoPath = workspaceFolder;
    this.trackingDirectory = path.join(this.repoPath, '.devtrack');
    this.initialTimestampFile = path.join(
      this.trackingDirectory,
      'initial_timestamp'
    );

    if (!path.isAbsolute(this.repoPath)) {
      throw new Error('Invalid repository path.');
    }

    this.git = simpleGit({
      baseDir: this.repoPath,
      binary: 'git',
      maxConcurrentProcesses: 1,
      trimmed: false,
    });
  }

  async initializeRepo(remoteUrl: string): Promise<void> {
    try {
      // Check if git is installed
      try {
        await this.git.raw(['--version']);
      } catch (error) {
        throw new Error('Git is not installed or not accessible');
      }

      const isRepo = await this.git.checkIsRepo();

      if (!isRepo) {
        await this.git.init();
        await this.git.addConfig('core.autocrlf', 'false');
        await this.git.addConfig('user.name', 'DevTrack');
        await this.git.addConfig(
          'user.email',
          'devtrack@users.noreply.github.com'
        );
        this.outputChannel.appendLine(
          'DevTrack: Initialized new Git repository.'
        );
      } else {
        const isDevTrackRepo = await this.isDevTrackRepo();
        if (isDevTrackRepo) {
          this.outputChannel.appendLine(
            'DevTrack: Repository already initialized.'
          );
          return;
        }
      }

      await this.setupInitialConfig(remoteUrl);
    } catch (error: any) {
      this.outputChannel.appendLine(
        `DevTrack: Failed to initialize Git repository. ${error.message}`
      );
      throw error;
    }
  }

  private async isDevTrackRepo(): Promise<boolean> {
    try {
      const devtrackPath = path.join(this.repoPath, '.devtrack');
      await vscode.workspace.fs.stat(vscode.Uri.file(devtrackPath));
      return true;
    } catch {
      return false;
    }
  }

  private async setupInitialConfig(remoteUrl: string): Promise<void> {
    try {
      // Create .devtrack directory and store initial timestamp
      await vscode.workspace.fs.createDirectory(
        vscode.Uri.file(this.trackingDirectory)
      );
      const timestamp = Date.now();
      await vscode.workspace.fs.writeFile(
        vscode.Uri.file(this.initialTimestampFile),
        Buffer.from(timestamp.toString(), 'utf8')
      );

      // Create README in .devtrack
      const readmePath = path.join(this.trackingDirectory, 'README.md');
      const readmeContent = `# DevTrack Activity Log

This directory is managed by DevTrack to track your coding activity.
Only files modified after ${new Date(timestamp).toLocaleString()} will be tracked.

## Configuration
- Commit Frequency: ${vscode.workspace.getConfiguration('devtrack').get('commitFrequency')} minutes
- Excluded Patterns: ${JSON.stringify(vscode.workspace.getConfiguration('devtrack').get('exclude'))}
`;
      await vscode.workspace.fs.writeFile(
        vscode.Uri.file(readmePath),
        Buffer.from(readmeContent, 'utf8')
      );

      // Create .gitignore if it doesn't exist
      const gitignorePath = path.join(this.repoPath, '.gitignore');
      if (!fs.existsSync(gitignorePath)) {
        const defaultIgnores = [
          'node_modules/',
          'dist/',
          '.DS_Store',
          'build/',
          'coverage/',
          '.env',
          '*.log',
          '.vscode/',
          'temp/',
          '*.tmp',
        ].join('\n');

        await vscode.workspace.fs.writeFile(
          vscode.Uri.file(gitignorePath),
          Buffer.from(defaultIgnores, 'utf8')
        );
      }

      // Configure remote
      await this.configureRemote(remoteUrl);

      // Set up main branch
      await this.setupMainBranch();

      // Initial commit with only DevTrack files
      await this.git.add(['.devtrack/**/*', '.gitignore']);
      await this.git.commit('DevTrack: Initialize repository tracking');
      await this.git.push(['-u', 'origin', 'main']);

      this.outputChannel.appendLine(
        'DevTrack: Initial setup completed successfully.'
      );
    } catch (error: any) {
      throw new Error(
        `Failed to set up initial configuration: ${error.message}`
      );
    }
  }

  private async configureRemote(remoteUrl: string): Promise<void> {
    const remotes = await this.git.getRemotes(true);
    const originRemote = remotes.find((remote) => remote.name === 'origin');

    if (originRemote) {
      if (originRemote.refs.fetch !== remoteUrl) {
        await this.git.removeRemote('origin');
        await this.git.addRemote('origin', remoteUrl);
      }
    } else {
      await this.git.addRemote('origin', remoteUrl);
    }
  }

  private async setupMainBranch(): Promise<void> {
    const branchSummary = await this.git.branchLocal();
    if (!branchSummary.current || branchSummary.current !== 'main') {
      await this.git.checkoutLocalBranch('main');
    }
  }

  async commitAndPush(message: string): Promise<void> {
    if (this.isCommitting) {
      this.outputChannel.appendLine('DevTrack: Another commit is in progress');
      return;
    }

    this.isCommitting = true;
    let currentBranch: string | undefined;

    try {
      // Get modified files
      const trackedFiles = await this.getModifiedFiles();

      if (!trackedFiles.length) {
        this.outputChannel.appendLine('DevTrack: No files to commit');
        return;
      }

      // Store current branch
      const branchInfo = await this.git.branch();
      currentBranch = branchInfo.current;

      // Ensure we're on main
      if (currentBranch !== 'main') {
        await this.git.checkout('main');
      }

      // Pull latest changes
      try {
        await this.git.pull('origin', 'main', { '--rebase': 'true' });
      } catch (pullError) {
        this.outputChannel.appendLine(
          'DevTrack: Pull failed (continuing anyway)'
        );
      }

      // Stage files
      for (const file of trackedFiles) {
        try {
          await this.git.add(file);
        } catch (error) {
          this.outputChannel.appendLine(`DevTrack: Failed to stage ${file}`);
        }
      }

      // Verify staged files
      const status = await this.git.status();
      if (status.staged.length === 0) {
        this.outputChannel.appendLine(
          'DevTrack: No files were staged successfully'
        );
        return;
      }

      // Commit and push
      await this.git.commit(message);
      await this.git.push('origin', 'main');

      this.emit('commit', message);
      this.outputChannel.appendLine(
        `DevTrack: Successfully committed and pushed: "${message}"`
      );
    } catch (error: any) {
      this.outputChannel.appendLine(
        `DevTrack: Git operation failed: ${error.message}`
      );
      throw error;
    } finally {
      // Restore original branch if needed
      if (currentBranch && currentBranch !== 'main') {
        try {
          await this.git.checkout(currentBranch);
        } catch (error) {
          this.outputChannel.appendLine(
            `DevTrack: Failed to restore original branch: ${error}`
          );
        }
      }
      this.isCommitting = false;
    }
  }

  private async getInitialTimestamp(): Promise<number> {
    try {
      const timestampBuffer = await vscode.workspace.fs.readFile(
        vscode.Uri.file(this.initialTimestampFile)
      );
      return parseInt(timestampBuffer.toString(), 10);
    } catch {
      return Date.now(); // Fallback to current time if file doesn't exist
    }
  }

  private async getModifiedFiles(): Promise<string[]> {
    try {
      const status = await this.git.status();
      const initialTimestamp = await this.getInitialTimestamp();
      this.outputChannel.appendLine(
        `DevTrack: Initial timestamp: ${new Date(initialTimestamp).toLocaleString()}`
      );

      const config = vscode.workspace.getConfiguration('devtrack');
      const excludePatterns = config.get<string[]>('exclude') || [];

      const trackedFiles = await Promise.all(
        status.files
          .filter((file) => {
            // Skip DevTrack files
            if (
              file.path.startsWith('.devtrack/') ||
              file.path === '.gitignore'
            ) {
              return false;
            }

            // Skip excluded patterns
            if (
              excludePatterns.some((pattern) => minimatch(file.path, pattern))
            ) {
              return false;
            }

            // Check file type
            if (!this.isTrackedFileType(file.path)) {
              return false;
            }

            return true;
          })
          .map(async (file) => {
            const fullPath = path.join(this.repoPath, file.path);

            // Handle deleted files
            if (file.index === 'D' || file.working_dir === 'D') {
              return file.path;
            }

            try {
              const stats = await fs.promises.stat(fullPath);
              // Only include files modified after initial setup
              if (stats.mtimeMs > initialTimestamp) {
                return file.path;
              }
            } catch {
              // Skip if file can't be accessed
              return null;
            }
            return null;
          })
      );

      return trackedFiles.filter((file): file is string => file !== null);
    } catch (error) {
      this.outputChannel.appendLine(
        `DevTrack: Error getting modified files: ${error}`
      );
      return [];
    }
  }

  private isTrackedFileType(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase().slice(1);
    const supportedExtensions = new Set([
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
    ]);

    return supportedExtensions.has(ext);
  }
}
