import { Buffer } from 'buffer';
import * as vscode from 'vscode';
import simpleGit, { SimpleGit, SimpleGitOptions } from 'simple-git';
import * as path from 'path';
import { EventEmitter } from 'events';
import { OutputChannel } from 'vscode';
import { promisify } from 'util';
import { exec } from 'child_process';
import { execSync } from 'child_process';
import process from 'process';
const execAsync = promisify(exec);
import * as fs from 'fs';
import { randomUUID } from 'node:crypto';
import { TrackingLogEntryV1 } from './trackingLog';

interface TimeDistribution {
  hour: number;
  changes: number;
}

interface ActivityTimelineEntry {
  date: string;
  commits: number;
  filesChanged: number;
}

interface FileTypeStats {
  name: string;
  count: number;
  percentage: number;
}

interface DevTrackStats {
  totalTime: number;
  filesModified: number;
  totalCommits: number;
  linesChanged: number;
  activityTimeline: ActivityTimelineEntry[];
  timeDistribution: TimeDistribution[];
  fileTypes: FileTypeStats[];
}

interface GitServiceEvents {
  commit: (message: string) => void;
  error: (error: Error) => void;
  'operation:start': (operation: string) => void;
  'operation:end': (operation: string) => void;
  retry: (operation: string, attempt: number) => void;
  push: (branch: string) => void;
}
interface TimeStampFormat {
  sortable: string;
  readable: string;
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
  private processQueue: Promise<any> = Promise.resolve();
  private git!: SimpleGit;
  private repoPath!: string;
  private currentTrackingDir: string = '';
  private outputChannel: OutputChannel;
  private operationQueue: Promise<any> = Promise.resolve();
  private statsDir: string = '';
  private hasInitializedStats: boolean = false;
  private static MAX_RETRIES = 3;
  private static RETRY_DELAY = 1000;
  private static readonly PROCESS_LIMIT = 5;
  private activeProcesses = 0;
  private readonly isWindows: boolean = process.platform === 'win32';
  private static readonly MAX_LISTENERS = 10;
  private boundListeners: Set<{
    event: keyof GitServiceEvents;
    listener: Function;
  }> = new Set();

  // Store tracking data in user's home directory to avoid project interference
  private readonly baseTrackingDir: string;
  // private currentTrackingDir: string = '';
  private projectIdentifier: string = '';

  constructor(outputChannel: OutputChannel, trackingDir?: string) {
    super();
    this.setMaxListeners(GitService.MAX_LISTENERS);
    this.outputChannel = outputChannel;
    this.setupDefaultErrorHandler();

    // Create base tracking directory in user's home
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    this.baseTrackingDir = path.join(homeDir, '.devtrack');

    // Allow caller to pin the tracking dir (multi-root support)
    if (trackingDir) {
      this.currentTrackingDir = trackingDir;
    }

    // Ensure base directory exists
    if (!fs.existsSync(this.baseTrackingDir)) {
      fs.mkdirSync(this.baseTrackingDir, { recursive: true });
    }
  }

  private getGitHubNoReplyEmail(login: string, id?: number): string {
    // Preferred GitHub noreply format that is reliably associated with the user:
    //   <id>+<login>@users.noreply.github.com
    // Fallback:
    //   <login>@users.noreply.github.com
    if (typeof id === 'number' && Number.isFinite(id)) {
      return `${id}+${login}@users.noreply.github.com`;
    }
    return `${login}@users.noreply.github.com`;
  }

  /**
   * Configure commit attribution inside the tracking repository so GitHub
   * credits commits to the authenticated user.
   */
  public async configureCommitAttribution(identity: {
    login: string;
    id?: number;
  }): Promise<void> {
    if (!identity?.login) {
      return;
    }

    await this.ensureGitInitialized();

    const config = vscode.workspace.getConfiguration('devtrack');
    const strategy =
      (config.get<'githubNoreply' | 'localGitConfig' | 'custom'>(
        'authorStrategy'
      ) ||
        'githubNoreply') ??
      'githubNoreply';

    if (strategy === 'localGitConfig') {
      // Do not override local repo config. Warn if it looks likely to not count.
      const email = await this.tryGetLocalUserEmail();
      if (!email || !this.looksLikeValidEmail(email)) {
        void vscode.window
          .showWarningMessage(
            'DevTrack: Your Git author email is missing or invalid. GitHub contributions may not count for DevTrack commits.',
            'Open Settings'
          )
          .then((choice) => {
            if (choice === 'Open Settings') {
              vscode.commands.executeCommand(
                'workbench.action.openSettings',
                'devtrack.authorStrategy'
              );
            }
          });
      } else if (!this.looksLikeGitHubLinkedEmail(email)) {
        void vscode.window
          .showWarningMessage(
            `DevTrack: Your Git author email (${email}) may not be linked to GitHub. Contributions may not count.`,
            'Open Settings'
          )
          .then((choice) => {
            if (choice === 'Open Settings') {
              vscode.commands.executeCommand(
                'workbench.action.openSettings',
                'devtrack.authorStrategy'
              );
            }
          });
      }
      this.outputChannel.appendLine(
        'DevTrack: Using local Git config for commit attribution (no override).'
      );
      return;
    }

    if (strategy === 'custom') {
      const name = String(config.get<string>('authorName') || '').trim();
      const email = String(config.get<string>('authorEmail') || '').trim();
      if (!name || !email || !this.looksLikeValidEmail(email)) {
        void vscode.window
          .showWarningMessage(
            'DevTrack: Custom author is selected but authorName/authorEmail is missing or invalid. Contributions may not count.',
            'Open Settings'
          )
          .then((choice) => {
            if (choice === 'Open Settings') {
              vscode.commands.executeCommand(
                'workbench.action.openSettings',
                'devtrack.authorStrategy'
              );
            }
          });
      }
      if (email && this.looksLikeValidEmail(email)) {
        await this.git.addConfig(
          'user.name',
          name || identity.login,
          false,
          'local'
        );
        await this.git.addConfig('user.email', email, false, 'local');
        this.outputChannel.appendLine(
          `DevTrack: Configured tracking repo commit identity as ${name || identity.login} <${email}>`
        );
      }
      return;
    }

    // Default: GitHub noreply
    const email = this.getGitHubNoReplyEmail(identity.login, identity.id);
    await this.git.addConfig('user.name', identity.login, false, 'local');
    await this.git.addConfig('user.email', email, false, 'local');

    this.outputChannel.appendLine(
      `DevTrack: Configured tracking repo commit identity as ${identity.login} <${email}>`
    );
  }

  private looksLikeValidEmail(email: string): boolean {
    if (!email) {
      return false;
    }
    // Light heuristic
    return email.includes('@') && !email.includes(' ') && !email.endsWith('@');
  }

  private looksLikeGitHubLinkedEmail(email: string): boolean {
    if (!this.looksLikeValidEmail(email)) {
      return false;
    }
    // Strong signals that usually count if account is configured correctly
    if (email.endsWith('@users.noreply.github.com')) {
      return true;
    }
    // Otherwise unknown; treat as possibly unlinked
    return false;
  }

  private async tryGetLocalUserEmail(): Promise<string | null> {
    try {
      const res = await this.git.raw([
        'config',
        '--local',
        '--get',
        'user.email',
      ]);
      const v = String(res || '').trim();
      return v || null;
    } catch {
      return null;
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

  private async withProcessLimit<T>(operation: () => Promise<T>): Promise<T> {
    while (this.activeProcesses >= GitService.PROCESS_LIMIT) {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
    }

    this.activeProcesses++;
    try {
      return await operation();
    } finally {
      this.activeProcesses--;
    }
  }

  private async withRetry<T>(
    operation: () => Promise<T>,
    retries = GitService.MAX_RETRIES
  ): Promise<T> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        return await this.withProcessLimit(operation);
      } catch (error: any) {
        if (error.message?.includes('EAGAIN') && attempt < retries) {
          this.outputChannel.appendLine(
            `DevTrack: Git process limit reached, retrying (${attempt}/${retries})...`
          );
          await new Promise((resolve) =>
            globalThis.setTimeout(resolve, GitService.RETRY_DELAY * attempt)
          );
          continue;
        }
        throw error;
      }
    }
    throw new Error('Maximum retry attempts reached');
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

  private async ensureGitInitialized(): Promise<void> {
    try {
      if (!this.git) {
        // Get tracking directory first
        await this.createTrackingDirectory();

        const options: Partial<SimpleGitOptions> = {
          baseDir: this.currentTrackingDir,
          binary: this.findGitExecutable(),
          maxConcurrentProcesses: 1,
        };

        this.git = simpleGit(options);

        // Set the repo path to the tracking directory
        this.repoPath = this.currentTrackingDir;

        this.outputChannel.appendLine('DevTrack: Git initialized successfully');
      }
    } catch (error: any) {
      this.outputChannel.appendLine(
        `DevTrack: Failed to initialize Git - ${error.message}`
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
    try {
      if (this.currentTrackingDir) {
        await fs.promises.mkdir(this.currentTrackingDir, { recursive: true });
        return;
      }
      if (!this.currentTrackingDir) {
        const homeDir = process.env.HOME || process.env.USERPROFILE;
        if (!homeDir) {
          throw new Error('Unable to determine home directory for DevTrack');
        }

        // Get workspace-specific ID for tracking directory
        const workspaceFolders = vscode.workspace.workspaceFolders;
        const workspaceId =
          workspaceFolders && workspaceFolders.length > 0
            ? Buffer.from(workspaceFolders[0].uri.fsPath)
                .toString('base64')
                .replace(/[/+=]/g, '_')
            : 'default';

        this.currentTrackingDir = path.join(
          homeDir,
          '.devtrack',
          'tracking',
          workspaceId
        );

        if (!fs.existsSync(this.currentTrackingDir)) {
          await fs.promises.mkdir(this.currentTrackingDir, { recursive: true });
        }

        this.outputChannel.appendLine(
          `DevTrack: Created tracking directory at ${this.currentTrackingDir}`
        );
      }
    } catch (error: any) {
      this.outputChannel.appendLine(
        `DevTrack: Error creating tracking directory - ${error.message}`
      );
      throw error;
    }
  }

  private async setupRemoteTracking(): Promise<void> {
    try {
      if (!this.git) {
        throw new Error('Git not initialized');
      }

      // Initialize the repository with an empty commit if needed
      const isRepo = await this.git.checkIsRepo();
      if (!isRepo) {
        await this.git.init();
        // Create an empty .gitkeep to ensure we can create the initial commit
        const gitkeepPath = path.join(this.currentTrackingDir, '.gitkeep');
        await fs.promises.writeFile(gitkeepPath, '');
        await this.git.add('.gitkeep');
        await this.git.commit('DevTrack: Initialize tracking repository');
      }

      // Ensure we're on main branch
      try {
        const branches = await this.git.branch();

        // If main branch doesn't exist, create it
        if (!branches.all.includes('main')) {
          // Create and checkout main branch
          await this.git.raw(['checkout', '-b', 'main']);
          this.outputChannel.appendLine(
            'DevTrack: Created and checked out main branch'
          );
        } else {
          // Switch to main branch if it exists
          await this.git.checkout('main');
          this.outputChannel.appendLine(
            'DevTrack: Switched to existing main branch'
          );
        }

        // Set up tracking with origin/main
        try {
          await this.git.push(['--set-upstream', 'origin', 'main']);
          this.outputChannel.appendLine(
            'DevTrack: Set up tracking with origin/main'
          );
        } catch (pushError: any) {
          if (pushError.message.includes('no upstream branch')) {
            // Force push to establish the branch
            await this.git.push(['-u', 'origin', 'main', '--force']);
            this.outputChannel.appendLine(
              'DevTrack: Established main branch on remote'
            );
          } else {
            throw pushError;
          }
        }
      } catch (error: any) {
        this.outputChannel.appendLine(
          `DevTrack: Branch setup error - ${error.message}`
        );
        throw error;
      }
    } catch (error: any) {
      this.outputChannel.appendLine(
        `DevTrack: Error in setupRemoteTracking - ${error.message}`
      );
      throw error;
    }
  }

  private async syncWithRemoteRebase(branch: string): Promise<void> {
    if (!this.git) {
      throw new Error('Git not initialized');
    }

    try {
      await this.git.fetch('origin', branch);
      // Rebase local commits on top of remote to reduce merge commits and conflicts.
      await this.git.raw(['rebase', `origin/${branch}`]);
      this.outputChannel.appendLine('DevTrack: Synced with remote via rebase');
    } catch (error: any) {
      // Attempt to abort a partial rebase so future attempts work.
      try {
        await this.git.raw(['rebase', '--abort']);
      } catch {
        // ignore
      }
      throw error;
    }
  }

  private isNonFastForwardPushError(error: any): boolean {
    const msg = String(error?.message || '');
    return (
      msg.includes('[rejected]') ||
      msg.toLowerCase().includes('fetch first') ||
      msg.toLowerCase().includes('non-fast-forward') ||
      msg.toLowerCase().includes('failed to push some refs')
    );
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
    } catch {
      this.outputChannel.appendLine(
        'DevTrack: Failed to update tracking metadata'
      );
    }
  }

  private async setupGitHubWorkflow(): Promise<void> {
    try {
      // Create .github/workflows directory in tracking repo
      const workflowsDir = path.join(
        this.currentTrackingDir,
        '.github',
        'workflows'
      );
      await fs.promises.mkdir(workflowsDir, { recursive: true });

      // Create build-and-deploy.yml
      const workflowPath = path.join(workflowsDir, 'build-and-deploy.yml');
      const workflowContent = `name: Build and Deploy Stats
  
  on:
    push:
      branches: [ main ]
      paths:
        - 'stats/**'
        - 'stats-data/**'
  
  jobs:
    build-and-deploy:
      runs-on: ubuntu-latest
      permissions:
        pages: write
        id-token: write
      environment:
        name: github-pages
        url: \${{ steps.deployment.outputs.page_url }}
      steps:
        - uses: actions/checkout@v3
        
        - name: Set up Node.js
          uses: actions/setup-node@v3
          with:
            node-version: '18'
            cache: 'npm'
            
        - name: Install Dependencies
          run: |
            cd stats
            npm install
            
        - name: Build Website
          run: |
            cd stats
            npm run build
            
        - name: Setup Pages
          uses: actions/configure-pages@v4
          
        - name: Upload artifact
          uses: actions/upload-pages-artifact@v3
          with:
            path: stats/dist
            
        - name: Deploy to GitHub Pages
          id: deployment
          uses: actions/deploy-pages@v4`;

      await fs.promises.writeFile(workflowPath, workflowContent);

      // Add and commit the workflow file
      await this.git.add(workflowPath);
      await this.git.commit(
        'DevTrack: Add GitHub Actions workflow for stats website'
      );

      const currentBranch = (await this.git.branch()).current;
      await this.git.push('origin', currentBranch);

      this.outputChannel.appendLine(
        'DevTrack: GitHub Actions workflow setup complete'
      );
    } catch (error) {
      this.outputChannel.appendLine(
        `DevTrack: Error setting up GitHub Actions workflow - ${error}`
      );
      throw error;
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
  // Add a .gitignore to ensure we don't track workspace files
  private async setupGitignore(): Promise<void> {
    const gitignorePath = path.join(this.currentTrackingDir, '.gitignore');
    const gitignoreContent = `
# DevTrack - Only track specific directories
/*

# Allow DevTrack directories
!/stats/
!/changes/
!/.gitignore
!/.gitkeep

# Ensure no workspace files are tracked
*.workspace
*.code-workspace
.vscode/
node_modules/
`;

    await fs.promises.writeFile(gitignorePath, gitignoreContent);
    await this.git.add('.gitignore');
    await this.git.commit('DevTrack: Add gitignore to protect workspace');
  }
  public async initializeRepo(remoteUrl: string): Promise<void> {
    return this.enqueueOperation(async () => {
      try {
        if (!(await this.validateWorkspace())) {
          return;
        }

        // Initialize Git first
        await this.ensureGitInitialized();
        await this.setupGitignore();
        await this.createTrackingDirectory();
        await this.setupGitHubWorkflow();

        const changesDir = path.join(this.currentTrackingDir, 'changes');
        if (!fs.existsSync(changesDir)) {
          await fs.promises.mkdir(changesDir, { recursive: true });
        }

        // Create .gitkeep to ensure the changes directory is tracked
        const gitkeepPath = path.join(changesDir, '.gitkeep');
        if (!fs.existsSync(gitkeepPath)) {
          await fs.promises.writeFile(gitkeepPath, '');
        }

        const gitignorePath = path.join(this.currentTrackingDir, '.gitignore');
        const gitignoreContent = `
    # DevTrack - Ignore system files only
    .DS_Store
    node_modules/
    .vscode/
    *.log
    
    # Ensure changes directory is tracked
    !changes/
    !changes/*
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

          await this.git.add(['.gitignore', 'changes/.gitkeep']);
          await this.git.commit('DevTrack: Initialize tracking repository');

          // Explicitly create and checkout main branch
          await this.git.raw(['branch', '-M', 'main']);
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

        // Ensure we're on main branch before setting up tracking
        const branches = await this.git.branch();
        if (!branches.current || branches.current !== 'main') {
          await this.git.checkout('main');
        }

        // Setup remote tracking
        await this.setupRemoteTracking();
        await this.initializeStatistics(true);

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
      // Initialize Git first - this should set up our dedicated tracking directory
      await this.ensureGitInitialized();

      // After ensureGitInitialized, this.git should be pointing to our tracking dir
      // Now we check if it's already a repo
      const isRepo = await this.git.checkIsRepo();
      if (!isRepo) {
        // If not a repo, initialize it
        await this.git.init();
        this.outputChannel.appendLine(
          'DevTrack: Initialized new Git repository in tracking directory'
        );

        // Set up Git config
        await this.git.addConfig('user.name', 'DevTrack', false, 'local');
        await this.git.addConfig(
          'user.email',
          'devtrack@example.com',
          false,
          'local'
        );

        // Create and checkout main branch
        await this.git.raw(['branch', '-M', 'main']);

        // Add remote
        await this.git.addRemote('origin', remoteUrl);
        this.outputChannel.appendLine(
          `DevTrack: Added remote origin ${remoteUrl}`
        );

        // Create initial commit if needed
        const gitkeepPath = path.join(this.currentTrackingDir, '.gitkeep');
        await fs.promises.writeFile(gitkeepPath, '');
        await this.git.add('.gitkeep');
        await this.git.commit('DevTrack: Initialize tracking repository');

        // Push to remote
        try {
          await this.git.push(['--set-upstream', 'origin', 'main']);
        } catch (pushError: any) {
          // Handle first push error (likely because remote repo is empty)
          if (pushError.message.includes('no upstream branch')) {
            await this.git.push(['-u', 'origin', 'main', '--force']);
          } else {
            throw pushError;
          }
        }
      } else {
        // Repository exists, ensure remote is set up correctly
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

        // Ensure we're on main branch
        try {
          await this.git.checkout('main');
          await this.git.push(['--set-upstream', 'origin', 'main']);
        } catch (error: any) {
          this.outputChannel.appendLine(
            `DevTrack: Error setting up tracking branch - ${error.message}`
          );
          // Continue even if push fails - we'll retry on next operation
        }
      }

      // Initialize statistics
      await this.initializeStatistics(false);

      // Make sure tracking repo is in sync with remote before finishing setup
      try {
        await this.git.fetch('origin', 'main');

        // Check if we have remote history
        const remoteExists = await this.git.raw([
          'ls-remote',
          '--exit-code',
          'origin',
          'main',
        ]);
        if (remoteExists) {
          this.outputChannel.appendLine(
            'DevTrack: Remote repository exists, syncing...'
          );

          try {
            // Try to merge remote content
            await this.git.merge([
              'origin/main',
              '--allow-unrelated-histories',
              '--no-edit',
            ]);
            this.outputChannel.appendLine('DevTrack: Merged remote history');
          } catch (mergeError: any) {
            this.outputChannel.appendLine(
              `DevTrack: Couldn't automatically merge - ${mergeError.message}`
            );

            // If merge fails, we need a more aggressive approach - get remote and recommit our changes
            try {
              // Pull with reset
              await this.git.reset(['--hard', 'origin/main']);
              this.outputChannel.appendLine(
                'DevTrack: Reset to match remote state'
              );

              // We'll re-add our files in the first commit
            } catch (resetError: any) {
              this.outputChannel.appendLine(
                `DevTrack: Reset failed - ${resetError.message}`
              );
              // Continue anyway
            }
          }
        }
      } catch (syncError: any) {
        this.outputChannel.appendLine(
          `DevTrack: Repository sync skipped - ${syncError.message}`
        );
        // This is normal for first-time setup, so just continue
      }

      this.outputChannel.appendLine(
        'DevTrack: Repository setup completed successfully'
      );
    } catch (error: any) {
      this.outputChannel.appendLine(
        `DevTrack: Error ensuring repo setup - ${error.message}`
      );
      throw error;
    }
  }

  async initializeStatistics(isNewUser: boolean): Promise<void> {
    if (this.hasInitializedStats) {
      return;
    }

    try {
      // Import WebsiteGenerator dynamically to avoid circular dependencies
      const { WebsiteGenerator } = await import('./websiteGenerator');
      const websiteGenerator = new WebsiteGenerator(
        this.outputChannel,
        this.currentTrackingDir
      );

      // Create stats directory if it doesn't exist
      this.statsDir = path.join(this.currentTrackingDir, 'stats');
      if (!fs.existsSync(this.statsDir)) {
        await fs.promises.mkdir(this.statsDir, { recursive: true });

        // Generate website files
        await websiteGenerator.generateWebsite();

        this.outputChannel.appendLine(
          'DevTrack: Generated statistics website files'
        );
      }

      // Create data directory for stats data
      const dataDir = path.join(this.statsDir, 'public', 'data');
      if (!fs.existsSync(dataDir)) {
        await fs.promises.mkdir(dataDir, { recursive: true });
      }

      // Initialize empty stats data if it doesn't exist
      const statsDataPath = path.join(dataDir, 'stats.json');
      if (!fs.existsSync(statsDataPath)) {
        // Get initial stats if possible
        const initialStats = await this.getUpdatedStats();
        await fs.promises.writeFile(
          statsDataPath,
          JSON.stringify(initialStats, null, 2)
        );
      }

      // Add stats directory to Git only if it's a new user
      if (isNewUser) {
        await this.git.add(this.statsDir);
        await this.git.commit('DevTrack: Initialize statistics website');

        // Push changes only if we have a remote set up
        try {
          const currentBranch = (await this.git.branch()).current;
          await this.git.push('origin', currentBranch);
        } catch (pushError) {
          // Log push error but don't fail initialization
          this.outputChannel.appendLine(
            `DevTrack: Warning - Could not push initial website: ${pushError}`
          );
        }
      }

      this.hasInitializedStats = true;
      this.outputChannel.appendLine(
        'DevTrack: Statistics tracking initialized successfully'
      );
    } catch (error) {
      this.outputChannel.appendLine(
        `DevTrack: Failed to initialize statistics - ${error}`
      );
      // Don't throw the error - allow the app to continue without stats
      this.hasInitializedStats = false;
    }
  }

  async updateStatsData(stats: any): Promise<void> {
    try {
      const statsDir = path.join(this.currentTrackingDir, 'stats');
      const dataDir = path.join(statsDir, 'public', 'data');

      // Ensure directories exist
      await fs.promises.mkdir(dataDir, { recursive: true });

      // Update stats data
      const statsDataPath = path.join(dataDir, 'stats.json');
      await fs.promises.writeFile(
        statsDataPath,
        JSON.stringify(stats, null, 2)
      );

      // Add to Git
      await this.git.add([statsDataPath]);
      await this.git.commit('DevTrack: Update statistics data');

      const currentBranch = (await this.git.branch()).current;
      await this.git.push('origin', currentBranch);

      this.outputChannel.appendLine(
        'DevTrack: Statistics data updated and pushed'
      );
    } catch (error) {
      this.outputChannel.appendLine(
        `DevTrack: Error updating stats data - ${error}`
      );
      throw error;
    }
  }

  private async getUpdatedStats(): Promise<DevTrackStats> {
    // Get updated statistics based on recent commits
    const log = await this.git.log();

    const stats: DevTrackStats = {
      totalTime: 0,
      filesModified: 0,
      totalCommits: log.total,
      linesChanged: 0,
      activityTimeline: [] as ActivityTimelineEntry[],
      timeDistribution: [] as TimeDistribution[],
      fileTypes: [] as FileTypeStats[],
    };

    // Initialize timeDistribution array with all hours
    for (let i = 0; i < 24; i++) {
      stats.timeDistribution.push({ hour: i, changes: 0 });
    }

    // Create a map to accumulate timeline data
    const timelineMap = new Map<string, ActivityTimelineEntry>();

    // Process commits
    for (const commit of log.all) {
      const commitDate = new Date(commit.date);
      const hourOfDay = commitDate.getHours();

      // Update time distribution
      stats.timeDistribution[hourOfDay].changes++;

      // Update activity timeline
      const dateKey = commitDate.toISOString().split('T')[0];
      if (!timelineMap.has(dateKey)) {
        timelineMap.set(dateKey, {
          date: dateKey,
          commits: 0,
          filesChanged: 0,
        });
      }

      const timelineEntry = timelineMap.get(dateKey)!;
      timelineEntry.commits++;

      // Estimate files changed from commit message
      const filesChanged = commit.message
        .split('\n')
        .filter((line) => line.trim().startsWith('-')).length;
      timelineEntry.filesChanged += filesChanged || 1; // At least 1 file per commit
    }

    // Convert timeline map to array and sort by date
    stats.activityTimeline = Array.from(timelineMap.values()).sort((a, b) =>
      a.date.localeCompare(b.date)
    );

    // Calculate total modified files
    stats.filesModified = stats.activityTimeline.reduce(
      (total, entry) => total + entry.filesChanged,
      0
    );

    // Estimate total time (30 minutes per commit as a rough estimate)
    stats.totalTime = Math.round((stats.totalCommits * 30) / 60); // Convert to hours

    // Calculate file types from recent commits
    const fileTypesMap = new Map<string, number>();
    for (const commit of log.all.slice(0, 100)) {
      // Look at last 100 commits
      const files =
        commit.message.match(/\.(ts|js|tsx|jsx|css|html|md)x?/g) || [];
      for (const file of files) {
        const ext = file.replace('.', '').toLowerCase();
        fileTypesMap.set(ext, (fileTypesMap.get(ext) || 0) + 1);
      }
    }

    // Convert file types to array with percentages
    const totalFiles = Array.from(fileTypesMap.values()).reduce(
      (a, b) => a + b,
      0
    );
    stats.fileTypes = Array.from(fileTypesMap.entries()).map(
      ([name, count]) => ({
        name: name.toUpperCase(),
        count,
        percentage: Math.round((count / totalFiles) * 100),
      })
    );

    return stats;
  }

  private async verifyCommitTracking(message: string): Promise<void> {
    try {
      // Check if the commit was actually saved
      const log = await this.git.log({ maxCount: 1 });

      if (log.latest?.message !== message) {
        this.outputChannel.appendLine(
          'DevTrack: Warning - Last commit message does not match expected message'
        );
        this.outputChannel.appendLine(`Expected: ${message}`);
        this.outputChannel.appendLine(
          `Actual: ${log.latest?.message || 'No commit found'}`
        );
      } else {
        this.outputChannel.appendLine(
          'DevTrack: Successfully verified commit was tracked'
        );
      }
    } catch (error) {
      this.outputChannel.appendLine(
        `DevTrack: Error verifying commit - ${error}`
      );
    }
  }

  public async commitAndPush(
    message: string,
    logEntry?: TrackingLogEntryV1
  ): Promise<void> {
    return this.enqueueOperation(async () => {
      try {
        if (!this.git) {
          throw new Error('Git not initialized');
        }

        // Create a changes directory if it doesn't exist
        const changesDir = path.join(this.currentTrackingDir, 'changes');
        if (!fs.existsSync(changesDir)) {
          await fs.promises.mkdir(changesDir, { recursive: true });
        }

        // Append-only JSON log entry (no code snippets / file contents).
        let logFileRelPath: string | null = null;
        if (logEntry) {
          const safeIso = new Date().toISOString().replace(/[:.]/g, '-');
          const filename = `${safeIso}-${randomUUID()}.json`;
          logFileRelPath = path.join('changes', filename);
          const logFileAbsPath = path.join(
            this.currentTrackingDir,
            logFileRelPath
          );

          const entryToWrite: TrackingLogEntryV1 = {
            ...logEntry,
            workspaceId:
              logEntry.workspaceId ?? path.basename(this.currentTrackingDir),
          };

          await fs.promises.writeFile(
            logFileAbsPath,
            JSON.stringify(entryToWrite, null, 2),
            'utf8'
          );
        }

        this.emitSafe('operation:start', 'commitAndPush');

        await this.withRetry(async () => {
          const branches = await this.git.branch();
          const currentBranch = branches.current;

          // Stage the new log entry (or everything, for non-log operations like website generation)
          if (logFileRelPath) {
            await this.git.add(logFileRelPath);
          } else {
            await this.git.add('.');
          }

          // If nothing is staged, do not create empty commits.
          const status = await this.git.status();
          if (
            status.staged.length === 0 &&
            status.created.length === 0 &&
            status.modified.length === 0 &&
            status.deleted.length === 0
          ) {
            this.outputChannel.appendLine(
              'DevTrack: No changes staged; skipping commit'
            );
            return;
          }

          // Commit with a metadata-only message
          await this.git.commit(message);
          this.emitSafe('commit', message);
          try {
            // Sync using rebase to minimize conflicts/merges.
            try {
              await this.syncWithRemoteRebase(currentBranch);
            } catch (syncError: any) {
              this.outputChannel.appendLine(
                `DevTrack: Sync warning - ${syncError.message}`
              );
              // Continue anyway - we'll try to push; if rejected, user needs to resolve.
            }

            // Try normal push first
            await this.git.push(['origin', currentBranch]);
            this.emitSafe('push', currentBranch);
          } catch (pushError: any) {
            if (pushError.message.includes('no upstream branch')) {
              await this.setupRemoteTracking();
              await this.git.push(['origin', currentBranch]);
              this.emitSafe('push', currentBranch);
            } else if (this.isNonFastForwardPushError(pushError)) {
              // Remote advanced (another machine). Try: fetch + rebase + retry push once.
              this.outputChannel.appendLine(
                'DevTrack: Push rejected (remote ahead). Attempting rebase and retry...'
              );
              try {
                await this.syncWithRemoteRebase(currentBranch);
                await this.git.push(['origin', currentBranch]);
                this.emitSafe('push', currentBranch);
              } catch (retryError: any) {
                const retryMsg = String(retryError?.message || retryError);
                this.outputChannel.appendLine(
                  `DevTrack: Auto-sync failed; cannot push safely. ${retryMsg}`
                );
                throw new Error(
                  'Remote tracking repo has new commits that could not be rebased automatically. ' +
                    'To fix: open the tracking repo directory (~/.devtrack/tracking/<workspaceId>), run `git pull --rebase`, resolve conflicts if any, then retry. ' +
                    'If histories are unrelated, recreate the tracking repo or clear the local tracking directory for this workspace.'
                );
              }
            } else {
              throw pushError;
            }
          }
        });

        this.emitSafe('operation:end', 'commitAndPush');
        const stats = await this.getUpdatedStats();
        await this.updateStatsData(stats);
      } catch (error: any) {
        this.outputChannel.appendLine(
          `DevTrack: Git commit failed - ${error.message}`
        );
        this.emitSafe('error', error);
        throw error;
      }
    });
  }

  private formatTimestamp(date: Date): TimeStampFormat {
    const pad = (num: number): string => num.toString().padStart(2, '0');

    // Format time in 12-hour format with AM/PM
    const formatTime = (date: Date): string => {
      let hours = date.getHours();
      const minutes = date.getMinutes();
      const seconds = date.getSeconds();
      const ampm = hours >= 12 ? 'PM' : 'AM';

      // Convert to 12-hour format
      hours = hours % 12;
      hours = hours ? hours : 12; // the hour '0' should be '12'

      return `${pad(hours)}${pad(minutes)}-${pad(seconds)}-${ampm}`;
    };

    // Get local date components
    const year = date.getFullYear();
    const month = pad(date.getMonth() + 1);
    const day = pad(date.getDate());

    // Get timezone
    const timezone = date
      .toLocaleTimeString('en-us', { timeZoneName: 'short' })
      .split(' ')[2];

    // For file name (now includes AM/PM)
    const sortableTimestamp = `${year}-${month}-${day}-${formatTime(date)}`;

    // For commit message (human readable with timezone)
    const readableTimestamp = `${date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })} at ${date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    })} ${timezone}`;

    return {
      sortable: sortableTimestamp,
      readable: readableTimestamp,
    };
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
        } catch {
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
            } catch {
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

  // private async cleanupGitLocks(): Promise<void> {
  //   try {
  //     const gitDir = path.join(this.currentTrackingDir, '.git');
  //     const lockFiles = ['index.lock', 'HEAD.lock'];

  //     for (const lockFile of lockFiles) {
  //       const lockPath = path.join(gitDir, lockFile);
  //       if (fs.existsSync(lockPath)) {
  //         try {
  //           fs.unlinkSync(lockPath);
  //         } catch (error) {
  //           this.outputChannel.appendLine(
  //             `DevTrack: Could not remove lock file ${lockPath}: ${error}`
  //           );
  //         }
  //       }
  //     }
  //   } catch (error) {
  //     this.outputChannel.appendLine(
  //       `DevTrack: Error cleaning up Git locks: ${error}`
  //     );
  //   }
  // }

  // private async initGitConfig() {
  //   try {
  //     if (!this.git) {
  //       throw new Error('Git not initialized');
  //     }

  //     await this.git.addConfig('core.autocrlf', 'true');
  //     await this.git.addConfig('core.safecrlf', 'false');
  //     await this.git.addConfig('core.longpaths', 'true');

  //     if (this.isWindows) {
  //       await this.git.addConfig('core.quotepath', 'false');
  //       await this.git.addConfig('core.ignorecase', 'true');
  //     }
  //   } catch (error) {
  //     this.outputChannel.appendLine(
  //       `DevTrack: Error initializing Git config: ${error}`
  //     );
  //     throw error;
  //   }
  // }

  // private async verifyGitConfig(): Promise<void> {
  //   try {
  //     // Get Git executable path with proper escaping for Windows
  //     const gitPath = this.findGitExecutable();
  //     const normalizedGitPath = this.isWindows
  //       ? gitPath.replace(/\\/g, '/')
  //       : gitPath;

  //     // Basic Git version check
  //     try {
  //       const versionCmd = this.isWindows
  //         ? `"${normalizedGitPath}"`
  //         : normalizedGitPath;
  //       execSync(`${versionCmd} --version`, { encoding: 'utf8' });
  //       this.outputChannel.appendLine(
  //         `DevTrack: Successfully verified Git at: ${normalizedGitPath}`
  //       );
  //     } catch (error: any) {
  //       throw new Error(`Git executable validation failed: ${error.message}`);
  //     }

  //     // Test Git configuration with normalized paths
  //     const testGit = simpleGit({
  //       baseDir: this.repoPath,
  //       binary: normalizedGitPath,
  //       maxConcurrentProcesses: 1,
  //       unsafe: {
  //         allowUnsafeCustomBinary: true,
  //       },
  //       ...(this.isWindows && {
  //         config: [
  //           'core.quotePath=false',
  //           'core.preloadIndex=true',
  //           'core.fscache=true',
  //           'core.ignorecase=true',
  //         ],
  //       }),
  //     });

  //     // Verify basic Git configuration
  //     await testGit.raw(['config', '--list']);
  //     this.outputChannel.appendLine('DevTrack: Git configuration verified');

  //     // Check repository state
  //     const isRepo = await testGit.checkIsRepo();
  //     if (isRepo) {
  //       const remotes = await testGit.getRemotes(true);
  //       if (remotes.length === 0) {
  //         this.outputChannel.appendLine('DevTrack: No remote configured');
  //       }
  //     }

  //     // Windows-specific checks
  //     if (this.isWindows) {
  //       try {
  //         await testGit.raw(['config', '--system', '--list']);
  //         this.outputChannel.appendLine(
  //           'DevTrack: Windows Git system configuration verified'
  //         );
  //       } catch (error) {
  //         // Don't throw on system config access issues
  //         this.outputChannel.appendLine(
  //           'DevTrack: System Git config check skipped (normal on some Windows setups)'
  //         );
  //       }
  //     }
  //   } catch (error: any) {
  //     this.outputChannel.appendLine(
  //       `DevTrack: Git config verification failed - ${error.message}`
  //     );
  //     throw new Error(`Git configuration error: ${error.message}`);
  //   }
  // }

  // private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
  //   let lastError: Error | null = null;

  //   for (let attempt = 1; attempt <= GitService.MAX_RETRIES; attempt++) {
  //     try {
  //       return await operation();
  //     } catch (error: any) {
  //       lastError = error;
  //       this.outputChannel.appendLine(
  //         `DevTrack: Operation failed (attempt ${attempt}/${GitService.MAX_RETRIES}): ${error.message}`
  //       );

  //       if (attempt < GitService.MAX_RETRIES) {
  //         await new Promise((resolve) =>
  //           globalThis.setTimeout(resolve, GitService.RETRY_DELAY * attempt)
  //         );
  //         await this.cleanupGitLocks();
  //       }
  //     }
  //   }

  //   throw lastError;
  // }

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

  // private handleGitError(error: any): void {
  //   let errorMessage = 'Git operation failed';

  //   if (error.message?.includes('ENOENT')) {
  //     errorMessage =
  //       process.platform === 'win32'
  //         ? 'Git not found. Please install Git for Windows from https://git-scm.com/download/win'
  //         : 'Git is not accessible. Please ensure Git is installed.';
  //   } else if (error.message?.includes('spawn git ENOENT')) {
  //     errorMessage =
  //       process.platform === 'win32'
  //         ? 'Git not found in PATH. Please restart VS Code after installing Git.'
  //         : 'Failed to spawn Git process. Please verify your Git installation.';
  //   } else if (error.message?.includes('not a git repository')) {
  //     errorMessage =
  //       'Not a Git repository. Please initialize the repository first.';
  //   }

  //   this.outputChannel.appendLine(
  //     `DevTrack: ${errorMessage} - ${error.message}`
  //   );
  //   vscode.window.showErrorMessage(`DevTrack: ${errorMessage}`);
  // }

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

  // public async cleanup(): Promise<void> {
  //   if (this.currentTrackingDir && fs.existsSync(this.currentTrackingDir)) {
  //     try {
  //       await fs.promises.rm(this.currentTrackingDir, {
  //         recursive: true,
  //         force: true,
  //       });
  //       this.outputChannel.appendLine(
  //         'DevTrack: Tracking directory cleaned up'
  //       );
  //     } catch (error) {
  //       this.outputChannel.appendLine(
  //         'DevTrack: Failed to clean up tracking directory'
  //       );
  //     }
  //   }
  // }
  // Add cleanup method
  public cleanup(): void {
    this.activeProcesses = 0;
    this.processQueue = Promise.resolve();
  }

  public dispose(): void {
    this.removeAllListeners();
    this.operationQueue = Promise.resolve();
    this.cleanup();
  }
}
