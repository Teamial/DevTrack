/* eslint-disable no-unused-vars */
/* eslint-disable no-undef */
import * as vscode from 'vscode';
import simpleGit, { SimpleGit, SimpleGitOptions } from 'simple-git';
import * as path from 'path';
import { EventEmitter } from 'events';
import { OutputChannel } from 'vscode';
import { promisify } from 'util';
import { exec } from 'child_process';
import { execSync } from 'child_process';
const execAsync = promisify(exec);
import * as fs from 'fs';

interface GitServiceEvents {
  commit: (message: string) => void;
  error: (error: Error) => void;
  'operation:start': (operation: string) => void;
  'operation:end': (operation: string) => void;
  retry: (operation: string, attempt: number) => void;
  push: (branch: string) => void;
}

interface TrackingMetadata {
  projectPath: string;
  lastSync: string;
  lastCommit?: {
    message: string;
    timestamp: string;
    changesCount: number;
  };
  changes?: Array<{
    timestamp: string;
    files: string[];
    summary: string;
  }>;
}
export class GitService extends EventEmitter {
  private git!: SimpleGit;
  private repoPath!: string;
  private outputChannel: OutputChannel;
  private operationQueue: Promise<any> = Promise.resolve();
  private static MAX_RETRIES = 3;
  private static RETRY_DELAY = 1000;
  private readonly isWindows: boolean = process.platform === 'win32';
  private static readonly MAX_LISTENERS = 10;
  private boundListeners: Set<{
    event: keyof GitServiceEvents;
    listener: Function;
  }> = new Set();

  // Store tracking data in user's home directory to avoid project interference
  private readonly baseTrackingDir: string;
  private currentTrackingDir: string = '';
  private projectIdentifier: string = '';

  constructor(outputChannel: OutputChannel) {
    super();
    this.setMaxListeners(GitService.MAX_LISTENERS);
    this.outputChannel = outputChannel;
    this.setupDefaultErrorHandler();

    // Create base tracking directory in user's home
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    this.baseTrackingDir = path.join(homeDir, '.devtrack');

    // Ensure base directory exists
    if (!fs.existsSync(this.baseTrackingDir)) {
      fs.mkdirSync(this.baseTrackingDir, { recursive: true });
    }
  }
  private setupDefaultErrorHandler(): void {
    if (this.listenerCount('error') === 0) {
      this.on('error', (error: Error) => {
        this.outputChannel.appendLine(
          `DevTrack: Unhandled Git error - ${error.message}`
        );
      });
    }
  }

  // Type-safe event emitter methods
  public on<E extends keyof GitServiceEvents>(
    event: E,
    listener: GitServiceEvents[E]
  ): this {
    if (
      event === 'error' &&
      this.listenerCount('error') >= GitService.MAX_LISTENERS - 1
    ) {
      this.outputChannel.appendLine(
        'DevTrack: Warning - Too many error listeners'
      );
      return this;
    }

    this.boundListeners.add({ event, listener });
    return super.on(event, listener);
  }

  public once<E extends keyof GitServiceEvents>(
    event: E,
    listener: GitServiceEvents[E]
  ): this {
    const onceListener = ((...args: Parameters<GitServiceEvents[E]>) => {
      this.boundListeners.delete({ event, listener });
      return (listener as Function).apply(this, args);
    }) as unknown as GitServiceEvents[E];

    this.boundListeners.add({ event, listener: onceListener });
    return super.once(event, onceListener);
  }

  public removeListener<E extends keyof GitServiceEvents>(
    event: E,
    listener: GitServiceEvents[E]
  ): this {
    this.boundListeners.delete({ event, listener });
    return super.removeListener(event, listener);
  }

  public removeAllListeners(event?: keyof GitServiceEvents): this {
    if (event) {
      this.boundListeners.forEach((listener) => {
        if (listener.event === event) {
          this.boundListeners.delete(listener);
        }
      });
    } else {
      this.boundListeners.clear();
    }
    return super.removeAllListeners(event);
  }

  // Safe emit method with type checking
  protected emitSafe<E extends keyof GitServiceEvents>(
    event: E,
    ...args: Parameters<GitServiceEvents[E]>
  ): boolean {
    try {
      if (this.listenerCount(event) === 0 && event !== 'error') {
        // If no listeners for non-error events, log it
        this.outputChannel.appendLine(
          `DevTrack: No listeners for event - ${String(event)}`
        );
        return false;
      }
      return super.emit(event, ...args);
    } catch (error) {
      this.outputChannel.appendLine(
        `DevTrack: Error emitting event ${String(event)} - ${error}`
      );
      this.emit('error', new Error(`Event emission failed: ${error}`));
      return false;
    }
  }

  private async verifyLinuxPermissions(): Promise<void> {
    if (!this.isWindows) {
      try {
        // Check if git commands can be executed
        await execAsync('git --version');

        // Check if .gitconfig is accessible
        const homeDir = process.env.HOME;
        if (homeDir) {
          const gitConfig = path.join(homeDir, '.gitconfig');
          try {
            await fs.promises.access(
              gitConfig,
              fs.constants.R_OK | fs.constants.W_OK
            );
          } catch {
            // Create .gitconfig if it doesn't exist
            await fs.promises.writeFile(gitConfig, '', { mode: 0o644 });
          }
        }
      } catch (error: any) {
        this.outputChannel.appendLine(
          `DevTrack: Linux permissions check failed - ${error.message}`
        );
        throw new Error(
          'Git permissions issue detected. Please check your Git installation and permissions.'
        );
      }
    }
  }

  private async checkGitEnvironment(): Promise<void> {
    try {
      const { stdout } = await execAsync('git --version');
      const match = stdout.match(/git version (\d+\.\d+\.\d+)/);
      if (!match) {
        throw new Error('Unable to determine Git version');
      }

      const version = match[1];
      const [major, minor] = version.split('.').map(Number);

      if (major < 2 || (major === 2 && minor < 30)) {
        throw new Error(
          `Git version ${version} is not supported. Please upgrade to 2.30.0 or later.`
        );
      }

      this.outputChannel.appendLine(
        `DevTrack: Git version ${version} verified`
      );
    } catch (error: any) {
      throw new Error(`Git environment check failed: ${error.message}`);
    }
  }

  private async initializeTracking(): Promise<void> {
    try {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        throw new Error('No workspace folder is open');
      }

      const projectPath = workspaceFolders[0].uri.fsPath;

      // Create a unique identifier for the project based on its path
      this.projectIdentifier = Buffer.from(projectPath)
        .toString('base64')
        .replace(/[/+=]/g, '_');

      // Create project-specific tracking directory in user's home directory
      this.currentTrackingDir = path.join(
        this.baseTrackingDir,
        this.projectIdentifier
      );

      if (!fs.existsSync(this.currentTrackingDir)) {
        await fs.promises.mkdir(this.currentTrackingDir, { recursive: true });
      }

      // Initialize Git in tracking directory only
      const options: Partial<SimpleGitOptions> = {
        baseDir: this.currentTrackingDir,
        binary: this.findGitExecutable(),
        maxConcurrentProcesses: 1,
      };

      this.git = simpleGit(options);
      this.repoPath = this.currentTrackingDir; // Update repoPath to use tracking directory

      this.outputChannel.appendLine(
        `DevTrack: Tracking directory initialized at ${this.currentTrackingDir}`
      );
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.outputChannel.appendLine(
        `DevTrack: Tracking initialization failed - ${errorMessage}`
      );
      throw error;
    }
  }

  private async validateWorkspace(): Promise<boolean> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      this.outputChannel.appendLine('DevTrack: No workspace folder is open');
      return false;
    }

    // Only validate Git is installed, don't check workspace Git status
    try {
      await this.checkGitEnvironment();
      return true;
    } catch (error) {
      this.outputChannel.appendLine(
        `DevTrack: Git validation failed - ${error}`
      );
      return false;
    }
  }

  private async createTrackingDirectory(): Promise<void> {
    if (!this.currentTrackingDir) {
      const homeDir = process.env.HOME || process.env.USERPROFILE;
      if (!homeDir) {
        throw new Error('Unable to determine home directory for DevTrack');
      }

      // Create a unique tracking directory under .devtrack in home directory
      const workspaceId = Buffer.from(
        vscode.workspace.workspaceFolders![0].uri.fsPath
      )
        .toString('base64')
        .replace(/[/+=]/g, '_');

      this.currentTrackingDir = path.join(
        homeDir,
        '.devtrack',
        'tracking',
        workspaceId
      );

      if (!fs.existsSync(this.currentTrackingDir)) {
        await fs.promises.mkdir(this.currentTrackingDir, { recursive: true });
      }
    }
  }

  private async setupRemoteTracking(): Promise<void> {
    try {
      if (!this.git) {
        throw new Error('Git not initialized');
      }

      const branches = await this.git.branch();
      const currentBranch = branches.current;

      // Instead of pulling all files, we'll only push our changes
      try {
        // Set upstream without pulling
        await this.git.push([
          '--set-upstream',
          'origin',
          currentBranch,
          '--force',
        ]);
        this.outputChannel.appendLine(
          `DevTrack: Set upstream tracking for ${currentBranch}`
        );
      } catch (error) {
        this.outputChannel.appendLine(
          `DevTrack: Failed to set upstream - ${error}`
        );
        throw error;
      }
    } catch (error) {
      this.outputChannel.appendLine(
        `DevTrack: Error in setupRemoteTracking - ${error}`
      );
      throw error;
    }
  }

  public async commitAndPush(message: string): Promise<void> {
    return this.enqueueOperation(async () => {
      try {
        if (!this.git) {
          throw new Error('Git not initialized');
        }

        this.emitSafe('operation:start', 'commitAndPush');

        await this.withRetry(async () => {
          // Get current branch
          const branches = await this.git.branch();
          const currentBranch = branches.current;

          // Stage only tracking metadata files
          const trackingFiles = [
            'tracking.json',
            'changes/*.json', // Only track change record files
          ];

          // Stage specific files instead of all files
          for (const pattern of trackingFiles) {
            await this.git.add(pattern);
          }

          // Commit changes
          await this.git.commit(message);
          this.emitSafe('commit', message);

          try {
            // Push with force-with-lease to ensure we don't overwrite others' changes
            // but also don't pull their changes into our workspace
            await this.git.push([
              'origin',
              currentBranch,
              '--force-with-lease',
            ]);
            this.emitSafe('push', currentBranch);
          } catch (pushError: any) {
            if (pushError.message.includes('no upstream branch')) {
              await this.setupRemoteTracking();
              // Try push again after setting upstream
              await this.git.push([
                'origin',
                currentBranch,
                '--force-with-lease',
              ]);
            } else {
              throw pushError;
            }
          }
        });

        this.emitSafe('operation:end', 'commitAndPush');
      } catch (error: any) {
        this.outputChannel.appendLine(
          `DevTrack: Git commit failed - ${error.message}`
        );
        this.emitSafe('error', error);
        throw error;
      }
    });
  }

  public async initializeRepo(remoteUrl: string): Promise<void> {
    return this.enqueueOperation(async () => {
      try {
        if (!(await this.validateWorkspace())) {
          return;
        }

        // Create tracking directory in user's home
        await this.createTrackingDirectory();

        // Create a .gitignore file to ignore everything except tracking files
        const gitignorePath = path.join(this.currentTrackingDir, '.gitignore');
        const gitignoreContent = `
  # Ignore everything by default
  *
  **/*
  
  # Track only specific files
  !tracking.json
  !changes/
  !changes/*.json
  !.gitignore
  `;
        await fs.promises.writeFile(gitignorePath, gitignoreContent);

        const options: Partial<SimpleGitOptions> = {
          baseDir: this.currentTrackingDir,
          binary: this.findGitExecutable(),
          maxConcurrentProcesses: 1,
        };

        this.git = simpleGit(options);

        const isRepo = await this.git.checkIsRepo();

        if (!isRepo) {
          await this.git.init();
          await this.git.addConfig('user.name', 'DevTrack', false, 'local');
          await this.git.addConfig(
            'user.email',
            'devtrack@example.com',
            false,
            'local'
          );

          // Create initial metadata
          await this.updateTrackingMetadata({
            projectPath: vscode.workspace.workspaceFolders![0].uri.fsPath,
            lastSync: new Date().toISOString(),
            changes: [],
          });

          // Only add specific files
          await this.git.add('.gitignore');
          await this.git.add('tracking.json');
          await this.git.commit('DevTrack: Initialize tracking');
        }

        // Check if remote exists
        const remotes = await this.git.getRemotes();
        const hasOrigin = remotes.some((remote) => remote.name === 'origin');

        if (!hasOrigin) {
          await this.git.addRemote('origin', remoteUrl);
          this.outputChannel.appendLine(
            `DevTrack: Added remote origin ${remoteUrl}`
          );
        } else {
          await this.git.remote(['set-url', 'origin', remoteUrl]);
          this.outputChannel.appendLine(
            `DevTrack: Updated remote origin to ${remoteUrl}`
          );
        }

        // Setup remote tracking without pulling
        await this.setupRemoteTracking();

        this.outputChannel.appendLine(
          'DevTrack: Repository initialization complete'
        );
      } catch (error: any) {
        this.outputChannel.appendLine(
          `DevTrack: Failed to initialize repository - ${error.message}`
        );
        throw error;
      }
    });
  }

  // Helper method to ensure repository and remote are properly set up
  public async ensureRepoSetup(remoteUrl: string): Promise<void> {
    try {
      if (!this.git) {
        throw new Error('Git not initialized');
      }

      const isRepo = await this.git.checkIsRepo();
      if (!isRepo) {
        await this.initializeRepo(remoteUrl);
        return;
      }

      // Check remote
      const remotes = await this.git.getRemotes();
      const hasOrigin = remotes.some((remote) => remote.name === 'origin');

      if (!hasOrigin) {
        await this.git.addRemote('origin', remoteUrl);
        this.outputChannel.appendLine(
          `DevTrack: Added remote origin ${remoteUrl}`
        );
      } else {
        // Update existing remote URL
        await this.git.remote(['set-url', 'origin', remoteUrl]);
        this.outputChannel.appendLine(
          `DevTrack: Updated remote origin to ${remoteUrl}`
        );
      }

      // Ensure we have the correct tracking branch
      try {
        const branches = await this.git.branch();
        const currentBranch = branches.current;
        await this.git.push('origin', currentBranch, ['--set-upstream']);
      } catch (error: any) {
        this.outputChannel.appendLine(
          `DevTrack: Error setting up tracking branch - ${error.message}`
        );
      }
    } catch (error: any) {
      this.outputChannel.appendLine(
        `DevTrack: Error ensuring repo setup - ${error.message}`
      );
      throw error;
    }
  }

  private isGitVersionSupported(version: string): boolean {
    const [major, minor] = version.split('.').map(Number);
    return major > 2 || (major === 2 && minor >= 30); // Example: Minimum version is 2.30.0
  }

  private findGitExecutable(): string {
    try {
      if (this.isWindows) {
        // Try to get Git path from environment variables first
        const pathEnv = process.env.PATH || '';
        const paths = pathEnv.split(path.delimiter);

        // Always use forward slashes for Windows paths
        for (const basePath of paths) {
          const gitExePath = path.join(basePath, 'git.exe').replace(/\\/g, '/');
          if (fs.existsSync(gitExePath)) {
            this.outputChannel.appendLine(
              `DevTrack: Found Git in PATH at ${gitExePath}`
            );
            return 'git';
          }
        }

        // Check common installation paths with forward slashes
        const commonPaths = [
          'C:/Program Files/Git/cmd/git.exe',
          'C:/Program Files (x86)/Git/cmd/git.exe',
        ];

        for (const gitPath of commonPaths) {
          if (fs.existsSync(gitPath)) {
            this.outputChannel.appendLine(`DevTrack: Found Git at ${gitPath}`);
            return gitPath;
          }
        }

        // Last resort: try where command
        try {
          const gitPathFromWhere = execSync('where git', { encoding: 'utf8' })
            .split('\n')[0]
            .trim()
            .replace(/\\/g, '/');
          if (gitPathFromWhere && fs.existsSync(gitPathFromWhere)) {
            this.outputChannel.appendLine(
              `DevTrack: Found Git using 'where' command at ${gitPathFromWhere}`
            );
            return gitPathFromWhere;
          }
        } catch (error) {
          this.outputChannel.appendLine('DevTrack: Git not found in PATH');
        }

        // Final fallback
        return 'git';
      } else {
        // Unix-like systems
        try {
          // Try multiple methods to find Git
          const methods = ['which git', 'command -v git', 'type -p git'];

          for (const method of methods) {
            try {
              const gitPath = execSync(method, { encoding: 'utf8' }).trim();
              if (gitPath && fs.existsSync(gitPath)) {
                this.outputChannel.appendLine(
                  `DevTrack: Found Git using '${method}' at ${gitPath}`
                );
                return gitPath;
              }
            } catch (e) {
              // Continue to next method
            }
          }

          // Check common Linux paths
          const commonPaths = [
            '/usr/bin/git',
            '/usr/local/bin/git',
            '/opt/local/bin/git',
          ];

          for (const gitPath of commonPaths) {
            if (fs.existsSync(gitPath)) {
              this.outputChannel.appendLine(
                `DevTrack: Found Git at ${gitPath}`
              );
              return gitPath;
            }
          }

          // Fallback to 'git' and let the system resolve it
          return 'git';
        } catch {
          return 'git';
        }
      }
    } catch (error) {
      this.outputChannel.appendLine(
        `DevTrack: Error finding Git executable - ${error}`
      );
      return 'git';
    }
  }

  private async cleanupGitLocks(): Promise<void> {
    try {
      const gitDir = path.join(this.currentTrackingDir, '.git');
      const lockFiles = ['index.lock', 'HEAD.lock'];

      for (const lockFile of lockFiles) {
        const lockPath = path.join(gitDir, lockFile);
        if (fs.existsSync(lockPath)) {
          try {
            fs.unlinkSync(lockPath);
          } catch (error) {
            this.outputChannel.appendLine(
              `DevTrack: Could not remove lock file ${lockPath}: ${error}`
            );
          }
        }
      }
    } catch (error) {
      this.outputChannel.appendLine(
        `DevTrack: Error cleaning up Git locks: ${error}`
      );
    }
  }

  private async initGitConfig() {
    try {
      if (!this.git) {
        throw new Error('Git not initialized');
      }

      await this.git.addConfig('core.autocrlf', 'true');
      await this.git.addConfig('core.safecrlf', 'false');
      await this.git.addConfig('core.longpaths', 'true');

      if (this.isWindows) {
        await this.git.addConfig('core.quotepath', 'false');
        await this.git.addConfig('core.ignorecase', 'true');
      }
    } catch (error) {
      this.outputChannel.appendLine(
        `DevTrack: Error initializing Git config: ${error}`
      );
      throw error;
    }
  }

  private async verifyGitConfig(): Promise<void> {
    try {
      // Get Git executable path with proper escaping for Windows
      const gitPath = this.findGitExecutable();
      const normalizedGitPath = this.isWindows
        ? gitPath.replace(/\\/g, '/')
        : gitPath;

      // Basic Git version check
      try {
        const versionCmd = this.isWindows
          ? `"${normalizedGitPath}"`
          : normalizedGitPath;
        execSync(`${versionCmd} --version`, { encoding: 'utf8' });
        this.outputChannel.appendLine(
          `DevTrack: Successfully verified Git at: ${normalizedGitPath}`
        );
      } catch (error: any) {
        throw new Error(`Git executable validation failed: ${error.message}`);
      }

      // Test Git configuration with normalized paths
      const testGit = simpleGit({
        baseDir: this.repoPath,
        binary: normalizedGitPath,
        maxConcurrentProcesses: 1,
        unsafe: {
          allowUnsafeCustomBinary: true,
        },
        ...(this.isWindows && {
          config: [
            'core.quotePath=false',
            'core.preloadIndex=true',
            'core.fscache=true',
            'core.ignorecase=true',
          ],
        }),
      });

      // Verify basic Git configuration
      await testGit.raw(['config', '--list']);
      this.outputChannel.appendLine('DevTrack: Git configuration verified');

      // Check repository state
      const isRepo = await testGit.checkIsRepo();
      if (isRepo) {
        const remotes = await testGit.getRemotes(true);
        if (remotes.length === 0) {
          this.outputChannel.appendLine('DevTrack: No remote configured');
        }
      }

      // Windows-specific checks
      if (this.isWindows) {
        try {
          await testGit.raw(['config', '--system', '--list']);
          this.outputChannel.appendLine(
            'DevTrack: Windows Git system configuration verified'
          );
        } catch (error) {
          // Don't throw on system config access issues
          this.outputChannel.appendLine(
            'DevTrack: System Git config check skipped (normal on some Windows setups)'
          );
        }
      }
    } catch (error: any) {
      this.outputChannel.appendLine(
        `DevTrack: Git config verification failed - ${error.message}`
      );
      throw new Error(`Git configuration error: ${error.message}`);
    }
  }
  catch(error: any) {
    this.outputChannel.appendLine(
      `DevTrack: Git config verification failed - ${error.message}`
    );
    throw new Error(`Git configuration error: ${error.message}`);
  }

  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= GitService.MAX_RETRIES; attempt++) {
      try {
        return await operation();
      } catch (error: any) {
        lastError = error;
        this.outputChannel.appendLine(
          `DevTrack: Operation failed (attempt ${attempt}/${GitService.MAX_RETRIES}): ${error.message}`
        );

        if (attempt < GitService.MAX_RETRIES) {
          await new Promise((resolve) =>
            setTimeout(resolve, GitService.RETRY_DELAY * attempt)
          );
          await this.cleanupGitLocks();
        }
      }
    }

    throw lastError;
  }

  private async updateTrackingMetadata(
    data: Partial<TrackingMetadata>
  ): Promise<void> {
    const metadataPath = path.join(this.currentTrackingDir, 'tracking.json');
    let metadata: TrackingMetadata;

    try {
      if (fs.existsSync(metadataPath)) {
        metadata = JSON.parse(await fs.promises.readFile(metadataPath, 'utf8'));
      } else {
        metadata = {
          projectPath: '',
          lastSync: new Date().toISOString(),
          changes: [],
        };
      }

      metadata = { ...metadata, ...data };
      await fs.promises.writeFile(
        metadataPath,
        JSON.stringify(metadata, null, 2)
      );
    } catch (error) {
      this.outputChannel.appendLine(
        'DevTrack: Failed to update tracking metadata'
      );
    }
  }

  public async recordChanges(
    message: string,
    changedFiles: string[]
  ): Promise<void> {
    if (!this.currentTrackingDir) {
      await this.initializeTracking();
    }

    return this.enqueueOperation(async () => {
      try {
        // Create a change record
        const change = {
          timestamp: new Date().toISOString(),
          files: changedFiles,
          summary: message,
        };

        // Update metadata with new change
        const metadataPath = path.join(
          this.currentTrackingDir,
          'tracking.json'
        );
        const metadata: TrackingMetadata = JSON.parse(
          await fs.promises.readFile(metadataPath, 'utf8')
        );

        metadata.changes = metadata.changes || [];
        metadata.changes.push(change);
        metadata.lastSync = change.timestamp;

        // Save updated metadata
        await fs.promises.writeFile(
          metadataPath,
          JSON.stringify(metadata, null, 2)
        );

        // Commit change to tracking repository
        if (this.git) {
          await this.git.add('.');
          await this.git.commit(message);
        }

        this.outputChannel.appendLine(
          'DevTrack: Changes recorded successfully'
        );
      } catch (error: any) {
        this.outputChannel.appendLine(
          `DevTrack: Failed to record changes - ${error.message}`
        );
        throw error;
      }
    });
  }

  public async commitChanges(message: string, changes: any[]): Promise<void> {
    return this.enqueueOperation(async () => {
      try {
        if (!this.git) {
          throw new Error('Tracking repository not initialized');
        }

        // Create change snapshot
        const snapshotPath = path.join(this.currentTrackingDir, 'changes');
        if (!fs.existsSync(snapshotPath)) {
          await fs.promises.mkdir(snapshotPath, { recursive: true });
        }

        // Save change data
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const snapshotFile = path.join(
          snapshotPath,
          `changes-${timestamp}.json`
        );
        await fs.promises.writeFile(
          snapshotFile,
          JSON.stringify({ message, changes }, null, 2)
        );

        // Update tracking metadata
        await this.updateTrackingMetadata({
          lastCommit: {
            message,
            timestamp,
            changesCount: changes.length,
          },
        });

        // Commit to tracking repository
        await this.git.add('.');
        await this.git.commit(message);

        this.outputChannel.appendLine(
          'DevTrack: Changes committed to tracking repository'
        );
      } catch (error: any) {
        this.outputChannel.appendLine(
          `DevTrack: Commit failed - ${error.message}`
        );
        throw error;
      }
    });
  }

  private handleGitError(error: any): void {
    let errorMessage = 'Git operation failed';

    if (error.message?.includes('ENOENT')) {
      errorMessage =
        process.platform === 'win32'
          ? 'Git not found. Please install Git for Windows from https://git-scm.com/download/win'
          : 'Git is not accessible. Please ensure Git is installed.';
    } else if (error.message?.includes('spawn git ENOENT')) {
      errorMessage =
        process.platform === 'win32'
          ? 'Git not found in PATH. Please restart VS Code after installing Git.'
          : 'Failed to spawn Git process. Please verify your Git installation.';
    } else if (error.message?.includes('not a git repository')) {
      errorMessage =
        'Not a Git repository. Please initialize the repository first.';
    }

    this.outputChannel.appendLine(
      `DevTrack: ${errorMessage} - ${error.message}`
    );
    vscode.window.showErrorMessage(`DevTrack: ${errorMessage}`);
  }

  private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    this.operationQueue = this.operationQueue
      .then(() => operation())
      .catch((error) => {
        this.outputChannel.appendLine(`DevTrack: Operation failed: ${error}`);
        throw error;
      });
    return this.operationQueue;
  }

  // Helper method to check if we have any listeners for an event
  public hasListeners(event: keyof GitServiceEvents): boolean {
    return this.listenerCount(event) > 0;
  }

  public async cleanup(): Promise<void> {
    if (this.currentTrackingDir && fs.existsSync(this.currentTrackingDir)) {
      try {
        await fs.promises.rm(this.currentTrackingDir, {
          recursive: true,
          force: true,
        });
        this.outputChannel.appendLine(
          'DevTrack: Tracking directory cleaned up'
        );
      } catch (error) {
        this.outputChannel.appendLine(
          'DevTrack: Failed to clean up tracking directory'
        );
      }
    }
  }

  public dispose(): void {
    this.removeAllListeners();
    this.operationQueue = Promise.resolve();
    this.cleanup().catch(() => {});
  }
}
