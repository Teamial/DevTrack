/* eslint-disable no-unused-vars */
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
import { fileURLToPath } from 'url';

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
      if (!this.currentTrackingDir) {
        const homeDir = process.env.HOME || process.env.USERPROFILE;
        if (!homeDir) {
          throw new Error('Unable to determine home directory for DevTrack');
        }

        // Create a base tracking directory even without workspace
        this.currentTrackingDir = path.join(
          homeDir,
          '.devtrack',
          'tracking',
          'default'
        );

        // If workspace is available, use workspace-specific directory
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
          const workspaceId = Buffer.from(workspaceFolders[0].uri.fsPath)
            .toString('base64')
            .replace(/[/+=]/g, '_');
          this.currentTrackingDir = path.join(
            homeDir,
            '.devtrack',
            'tracking',
            workspaceId
          );
        }

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
      // Initialize Git first
      await this.ensureGitInitialized();

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
      await this.initializeStatistics(false);

      // Ensure we have the correct tracking branch
      try {
        const branches = await this.git.branch();
        await this.git.checkout('main');
        await this.git.push(['--set-upstream', 'origin', 'main']);
      } catch (error: any) {
        this.outputChannel.appendLine(
          `DevTrack: Error setting up tracking branch - ${error.message}`
        );
        // Continue even if push fails - we'll retry on next operation
      }
    } catch (error: any) {
      this.outputChannel.appendLine(
        `DevTrack: Error ensuring repo setup - ${error.message}`
      );
      throw error;
    }
  }

  private async initializeStatistics(isNewUser: boolean): Promise<void> {
    if (this.hasInitializedStats) {
      return;
    }

    try {
      // Create stats directory if it doesn't exist
      this.statsDir = path.join(this.currentTrackingDir, 'stats');
      if (!fs.existsSync(this.statsDir)) {
        await fs.promises.mkdir(this.statsDir, { recursive: true });

        // Create initial dashboard files
        const dashboardHtml = `
<!DOCTYPE html>
<html>
<head>
  <title>DevTrack Statistics</title>
</head>
<body>
  <div id="root"></div>
</body>
</html>`;

        await fs.promises.writeFile(
          path.join(this.statsDir, 'index.html'),
          dashboardHtml
        );

        // Create empty dashboard.js
        await fs.promises.writeFile(
          path.join(this.statsDir, 'dashboard.js'),
          '// DevTrack Dashboard initialization'
        );
      }

      // Initialize empty stats data
      const initialStats = {
        totalTime: 0,
        filesModified: 0,
        totalCommits: 0,
        linesChanged: 0,
        activityTimeline: [],
        timeDistribution: [],
        fileTypes: [],
      };

      const statsDataPath = path.join(this.statsDir, 'data.json');
      if (!fs.existsSync(statsDataPath)) {
        await fs.promises.writeFile(
          statsDataPath,
          JSON.stringify(initialStats, null, 2)
        );
      }

      // Add stats directory to Git only if it's a new user
      if (isNewUser) {
        await this.git.add(path.join(this.statsDir, '*'));
        await this.git.commit('DevTrack: Initialize statistics tracking');

        // Push changes only if we have a remote set up
        try {
          const currentBranch = (await this.git.branch()).current;
          await this.git.push('origin', currentBranch);
        } catch (pushError) {
          // Log push error but don't fail initialization
          this.outputChannel.appendLine(
            `DevTrack: Warning - Could not push initial stats: ${pushError}`
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

  private async updateStatsData(stats: any): Promise<void> {
    try {
      const statsDir = path.join(this.currentTrackingDir, 'stats');
      const dataDir = path.join(statsDir, 'data');

      // Ensure directories exist
      await fs.promises.mkdir(dataDir, { recursive: true });

      // Update stats data
      const statsDataPath = path.join(dataDir, 'stats.json');
      await fs.promises.writeFile(
        statsDataPath,
        JSON.stringify(stats, null, 2)
      );

      // Create package.json if it doesn't exist
      const packageJsonPath = path.join(statsDir, 'package.json');
      if (!fs.existsSync(packageJsonPath)) {
        const packageJson = {
          name: 'devtrack-stats',
          private: true,
          version: '0.0.0',
          type: 'module',
          scripts: {
            dev: 'vite',
            build: 'vite build',
            preview: 'vite preview',
          },
          dependencies: {
            '@types/react': '^18.2.55',
            '@types/react-dom': '^18.2.19',
            '@vitejs/plugin-react': '^4.2.1',
            react: '^18.2.0',
            'react-dom': '^18.2.0',
            recharts: '^2.12.0',
            vite: '^5.1.0',
          },
        };

        await fs.promises.writeFile(
          packageJsonPath,
          JSON.stringify(packageJson, null, 2)
        );
      }

      // Create vite.config.js if it doesn't exist
      const viteConfigPath = path.join(statsDir, 'vite.config.js');
      if (!fs.existsSync(viteConfigPath)) {
        const viteConfig = `
  import { defineConfig } from 'vite'
  import react from '@vitejs/plugin-react'
  
  export default defineConfig({
    plugins: [react()],
    base: '/code-tracking/stats/',
  })`;

        await fs.promises.writeFile(viteConfigPath, viteConfig);
      }

      // Create index.html if it doesn't exist
      const indexPath = path.join(statsDir, 'index.html');
      if (!fs.existsSync(indexPath)) {
        const indexHtml = `
  <!DOCTYPE html>
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>DevTrack Statistics</title>
    </head>
    <body>
      <div id="root"></div>
      <script type="module" src="/src/main.tsx"></script>
    </body>
  </html>`;

        await fs.promises.writeFile(indexPath, indexHtml);
      }

      // Create main.tsx if it doesn't exist
      const srcDir = path.join(statsDir, 'src');
      await fs.promises.mkdir(srcDir, { recursive: true });

      const mainPath = path.join(srcDir, 'main.tsx');
      if (!fs.existsSync(mainPath)) {
        const mainTsx = `
  import React from 'react'
  import ReactDOM from 'react-dom/client'
  import CodingStatsDashboard from './components/CodingStatsDashboard'
  import './index.css'
  
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <CodingStatsDashboard />
    </React.StrictMode>,
  )`;

        await fs.promises.writeFile(mainPath, mainTsx);
      }

      // Create basic CSS
      const cssPath = path.join(srcDir, 'index.css');
      if (!fs.existsSync(cssPath)) {
        const css = `
  @tailwind base;
  @tailwind components;
  @tailwind utilities;`;

        await fs.promises.writeFile(cssPath, css);
      }

      // Copy your existing components
      const componentsDir = path.join(srcDir, 'components');
      await fs.promises.mkdir(componentsDir, { recursive: true });

      const uiDir = path.join(componentsDir, 'ui');
      await fs.promises.mkdir(uiDir, { recursive: true });

      // Add to Git
      await this.git.add(statsDir);
      await this.git.commit('DevTrack: Update statistics data and website');

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
    const now = new Date();

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

  public async commitAndPush(message: string): Promise<void> {
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

        // Extract file content from the commit message
        const codeBlockRegex = /```\n(.*?):\n([\s\S]*?)```/g;
        let match;
        const timestamp = this.formatTimestamp(new Date());
        const filesToAdd: string[] = [];

        while ((match = codeBlockRegex.exec(message)) !== null) {
          const [_, filename, code] = match;
          const cleanFilename = filename.trim();
          const extension = path.extname(cleanFilename);
          const baseNameWithoutExt = path.basename(cleanFilename, extension);

          // Create filename with timestamp: 2025-02-15-1200-00-AM-original_name.ts
          const timestampedFilename = `${timestamp.sortable}-${baseNameWithoutExt}${extension}`;
          const filePath = path.join(changesDir, timestampedFilename);

          // Write the actual code file
          await fs.promises.writeFile(filePath, code.trim());
          filesToAdd.push(filePath);
        }

        // Update the commit message to include local timezone
        const updatedMessage = message.replace(
          /DevTrack Update - [0-9T:.-Z]+/,
          `DevTrack Update - ${timestamp.readable}`
        );

        this.emitSafe('operation:start', 'commitAndPush');

        await this.withRetry(async () => {
          const branches = await this.git.branch();
          const currentBranch = branches.current;

          // Stage only the new code files
          for (const file of filesToAdd) {
            await this.git.add(file);
          }

          // Commit with the enhanced message
          await this.git.commit(updatedMessage);
          this.emitSafe('commit', updatedMessage);

          try {
            await this.git.push([
              'origin',
              currentBranch,
              '--force-with-lease',
            ]);
            this.emitSafe('push', currentBranch);
          } catch (pushError: any) {
            if (pushError.message.includes('no upstream branch')) {
              await this.setupRemoteTracking();
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
