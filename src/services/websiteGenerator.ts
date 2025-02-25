/* eslint-disable no-unused-vars */
// src/services/websiteGenerator.ts
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { OutputChannel } from 'vscode';

// Sample data for initial website
const DEFAULT_STATS = {
  activityTimeline: [
    { date: '2025-01-01', commits: 5, filesChanged: 12, linesChanged: 102 },
    { date: '2025-01-02', commits: 3, filesChanged: 7, linesChanged: 64 },
    { date: '2025-01-03', commits: 6, filesChanged: 14, linesChanged: 155 },
    { date: '2025-01-05', commits: 2, filesChanged: 5, linesChanged: 43 },
    { date: '2025-01-07', commits: 4, filesChanged: 9, linesChanged: 89 },
  ],
  fileTypes: [
    { type: 'JS', count: 12 },
    { type: 'TS', count: 18 },
    { type: 'CSS', count: 5 },
    { type: 'HTML', count: 3 },
    { type: 'JSON', count: 7 },
  ],
  timeDistribution: [
    { hour: '9AM', changes: 12 },
    { hour: '12PM', changes: 5 },
    { hour: '3PM', changes: 8 },
    { hour: '6PM', changes: 15 },
    { hour: '9PM', changes: 20 },
  ],
  totalTime: 24.5,
  filesModified: 54,
  totalCommits: 82,
  linesChanged: 1146,
};

export class WebsiteGenerator {
  private outputChannel: OutputChannel;
  private trackingDir: string;

  constructor(outputChannel: OutputChannel, trackingDir: string) {
    this.outputChannel = outputChannel;
    this.trackingDir = trackingDir;
  }

  /**
   * Generate all necessary files for the statistics website in the tracking repository
   */
  public async generateWebsite(): Promise<void> {
    try {
      const statsDir = path.join(this.trackingDir, 'stats');
      await fs.promises.mkdir(statsDir, { recursive: true });

      // Create basic website structure
      await this.createBaseStructure(statsDir);

      // Create React component directories
      const srcDir = path.join(statsDir, 'src');
      const componentsDir = path.join(srcDir, 'components');
      const uiDir = path.join(componentsDir, 'ui');

      await fs.promises.mkdir(srcDir, { recursive: true });
      await fs.promises.mkdir(componentsDir, { recursive: true });
      await fs.promises.mkdir(uiDir, { recursive: true });

      // Copy existing component files or create new ones
      await this.copyDashboardComponent(componentsDir);
      await this.createUIComponents(uiDir);

      // Create GitHub Actions workflow for deployment
      await this.createGitHubWorkflow();

      this.outputChannel.appendLine(
        'DevTrack: Statistics website files generated successfully'
      );
    } catch (error) {
      this.outputChannel.appendLine(
        `DevTrack: Error generating website files - ${error}`
      );
      throw error;
    }
  }

  /**
   * Create UI components needed for the dashboard
   */
  private async createUIComponents(uiDir: string): Promise<void> {
    // Create card.tsx component
    const cardComponent = `
  import * as React from "react";
  
  interface CardProps {
    children: React.ReactNode;
    className?: string;
  }
  
  export function Card({
    children,
    className = '',
    ...props
  }: CardProps & React.ComponentProps<'div'>) {
    return (
      <div className={\`rounded-lg border \${className}\`} {...props}>
        {children}
      </div>
    );
  }
  
  interface CardHeaderProps {
    children: React.ReactNode;
    className?: string;
  }
  
  export function CardHeader({
    children,
    className = '',
    ...props
  }: CardHeaderProps & React.ComponentProps<'div'>) {
    return (
      <div className={\`flex flex-col space-y-1.5 p-6 \${className}\`} {...props}>
        {children}
      </div>
    );
  }
  
  interface CardTitleProps {
    children: React.ReactNode;
    className?: string;
  }
  
  export function CardTitle({
    children,
    className = '',
    ...props
  }: CardTitleProps & React.ComponentProps<'h3'>) {
    return (
      <h3
        className={\`text-2xl font-semibold leading-none tracking-tight \${className}\`}
        {...props}
      >
        {children}
      </h3>
    );
  }
  
  interface CardContentProps {
    children: React.ReactNode;
    className?: string;
  }
  
  export function CardContent({
    children,
    className = '',
    ...props
  }: CardContentProps & React.ComponentProps<'div'>) {
    return (
      <div className={\`p-6 pt-0 \${className}\`} {...props}>
        {children}
      </div>
    );
  }
  `;

    await fs.promises.writeFile(path.join(uiDir, 'card.tsx'), cardComponent);
  }

  /**
   * Create GitHub Actions workflow for deployment
   */
  private async createGitHubWorkflow(): Promise<void> {
    try {
      // Create .github/workflows directory
      const workflowsDir = path.join(this.trackingDir, '.github', 'workflows');
      await fs.promises.mkdir(workflowsDir, { recursive: true });

      // Create GitHub Pages deployment workflow
      const workflowContent = `name: Deploy Stats Website
  
  on:
    push:
      branches: [ main ]
      paths:
        - 'stats/**'
        - 'public/data/**'
  
  permissions:
    contents: read
    pages: write
    id-token: write
  
  # Allow only one concurrent deployment
  concurrency:
    group: "pages"
    cancel-in-progress: true
  
  jobs:
    build:
      runs-on: ubuntu-latest
      steps:
        - name: Checkout
          uses: actions/checkout@v3
          
        - name: Setup Node
          uses: actions/setup-node@v3
          with:
            node-version: "18"
            cache: 'npm'
            cache-dependency-path: './stats/package-lock.json'
            
        - name: Setup Pages
          uses: actions/configure-pages@v3
          
        - name: Install dependencies
          run: |
            cd stats
            npm ci
            
        - name: Build
          run: |
            cd stats
            npm run build
            
        - name: Upload artifact
          uses: actions/upload-pages-artifact@v2
          with:
            path: './stats/dist'
            
    deploy:
      environment:
        name: github-pages
        url: \${{ steps.deployment.outputs.page_url }}
      runs-on: ubuntu-latest
      needs: build
      steps:
        - name: Deploy to GitHub Pages
          id: deployment
          uses: actions/deploy-pages@v2
  `;

      const workflowPath = path.join(workflowsDir, 'deploy-stats.yml');
      await fs.promises.writeFile(workflowPath, workflowContent);

      this.outputChannel.appendLine(
        'DevTrack: Created GitHub Actions workflow for website deployment'
      );
    } catch (error) {
      this.outputChannel.appendLine(
        `DevTrack: Error creating GitHub workflow - ${error}`
      );
    }
  }

  /**
   * Create base structure for the React application
   */
  private async createBaseStructure(statsDir: string): Promise<void> {
    // Create package.json
    const packageJson = {
      name: 'devtrack-stats',
      private: true,
      version: '1.0.0',
      type: 'module',
      scripts: {
        dev: 'vite',
        build: 'vite build',
        preview: 'vite preview',
      },
      dependencies: {
        react: '^18.2.0',
        'react-dom': '^18.2.0',
        recharts: '^2.12.0',
        'lucide-react': '^0.330.0',
      },
      devDependencies: {
        '@types/react': '^18.2.55',
        '@types/react-dom': '^18.2.19',
        '@vitejs/plugin-react': '^4.2.1',
        typescript: '^5.2.2',
        vite: '^5.1.0',
        autoprefixer: '^10.4.17',
        postcss: '^8.4.35',
        tailwindcss: '^3.4.1',
      },
    };

    await fs.promises.writeFile(
      path.join(statsDir, 'package.json'),
      JSON.stringify(packageJson, null, 2)
    );

    // Create vite.config.ts
    const viteConfig = `
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  base: './', // Makes it work in GitHub Pages
});
`;

    await fs.promises.writeFile(
      path.join(statsDir, 'vite.config.ts'),
      viteConfig
    );

    // Create index.html
    const indexHtml = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>DevTrack - Coding Statistics</title>
    <meta name="description" content="Track your coding journey with DevTrack" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;

    await fs.promises.writeFile(path.join(statsDir, 'index.html'), indexHtml);

    // Create tsconfig.json
    const tsConfig = {
      compilerOptions: {
        target: 'ES2020',
        useDefineForClassFields: true,
        lib: ['ES2020', 'DOM', 'DOM.Iterable'],
        module: 'ESNext',
        skipLibCheck: true,
        moduleResolution: 'bundler',
        allowImportingTsExtensions: true,
        resolveJsonModule: true,
        isolatedModules: true,
        noEmit: true,
        jsx: 'react-jsx',
        strict: true,
        noUnusedLocals: true,
        noUnusedParameters: true,
        noFallthroughCasesInSwitch: true,
      },
      include: ['src'],
      references: [{ path: './tsconfig.node.json' }],
    };

    await fs.promises.writeFile(
      path.join(statsDir, 'tsconfig.json'),
      JSON.stringify(tsConfig, null, 2)
    );

    // Create tsconfig.node.json
    const tsNodeConfig = {
      compilerOptions: {
        composite: true,
        skipLibCheck: true,
        module: 'ESNext',
        moduleResolution: 'bundler',
        allowSyntheticDefaultImports: true,
      },
      include: ['vite.config.ts'],
    };

    await fs.promises.writeFile(
      path.join(statsDir, 'tsconfig.node.json'),
      JSON.stringify(tsNodeConfig, null, 2)
    );

    // Create postcss.config.js
    const postcssConfig = `
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
}
`;

    await fs.promises.writeFile(
      path.join(statsDir, 'postcss.config.js'),
      postcssConfig
    );

    // Create tailwind.config.js
    const tailwindConfig = `
/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {},
  },
  plugins: [],
  darkMode: 'class',
}
`;

    await fs.promises.writeFile(
      path.join(statsDir, 'tailwind.config.js'),
      tailwindConfig
    );

    // Create src/index.css
    const srcDir = path.join(statsDir, 'src');
    await fs.promises.mkdir(srcDir, { recursive: true });

    const indexCss = `
@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  font-family: Inter, system-ui, Avenir, Helvetica, Arial, sans-serif;
  line-height: 1.5;
  font-weight: 400;
}

body {
  margin: 0;
  min-width: 320px;
  min-height: 100vh;
}

/* Dark mode styles */
.dark {
  color-scheme: dark;
}
`;

    await fs.promises.writeFile(path.join(srcDir, 'index.css'), indexCss);

    // Create src/main.tsx
    const mainTsx = `
import React from 'react'
import ReactDOM from 'react-dom/client'
import CodingStatsDashboard from './components/CodingStatsDashboard'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <CodingStatsDashboard />
  </React.StrictMode>,
)
`;

    await fs.promises.writeFile(path.join(srcDir, 'main.tsx'), mainTsx);

    // Create a types file for data
    const typesFile = `
export interface ActivityData {
  date: string;
  commits: number;
  filesChanged: number;
  linesChanged: number;
}

export interface FileStats {
  type: string;
  count: number;
}

export interface TimeDistribution {
  hour: string;
  changes: number;
}

export interface CodingStats {
  activityTimeline: ActivityData[];
  fileTypes: FileStats[];
  timeDistribution: TimeDistribution[];
  totalTime?: number;
  filesModified?: number;
  totalCommits?: number;
  linesChanged?: number;
}
`;

    await fs.promises.writeFile(path.join(srcDir, 'types.ts'), typesFile);

    // Create a data loader utility
    const dataUtil = `
import { CodingStats } from './types';

// Default sample data in case stats.json doesn't exist yet
const DEFAULT_STATS: CodingStats = ${JSON.stringify(DEFAULT_STATS, null, 2)};

export async function loadStats(): Promise<CodingStats> {
  try {
    // Try to load stats.json
    const response = await fetch('./data/stats.json');
    if (response.ok) {
      return await response.json();
    }
    console.warn('Stats data not found, using default data');
    return DEFAULT_STATS;
  } catch (error) {
    console.error('Error loading stats:', error);
    return DEFAULT_STATS;
  }
}
`;

    await fs.promises.writeFile(path.join(srcDir, 'dataUtils.ts'), dataUtil);

    // Create data directory
    const dataDir = path.join(statsDir, 'public', 'data');
    await fs.promises.mkdir(dataDir, { recursive: true });

    // Create sample stats.json
    await fs.promises.writeFile(
      path.join(dataDir, 'stats.json'),
      JSON.stringify(DEFAULT_STATS, null, 2)
    );
  }

  /**
   * Copy and adapt the existing dashboard component
   */
  private async copyDashboardComponent(componentsDir: string): Promise<void> {
    // Get workspace folders
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      throw new Error('No workspace folder is open');
    }

    // Try to find the existing component
    const workspaceRoot = workspaceFolders[0].uri.fsPath;
    const possiblePaths = [
      path.join(workspaceRoot, 'src', 'components', 'CodingStatsDashboard.tsx'),
      path.join(
        workspaceRoot,
        'src',
        'components',
        'ui',
        'CodingStatsDashboard.tsx'
      ),
    ];

    let sourceContent = '';
    for (const possiblePath of possiblePaths) {
      try {
        sourceContent = await fs.promises.readFile(possiblePath, 'utf8');
        this.outputChannel.appendLine(
          `DevTrack: Found dashboard component at ${possiblePath}`
        );
        break;
      } catch (error) {
        // Continue trying other paths
      }
    }

    // If we couldn't find the component, create a new one based on what we know
    if (!sourceContent) {
      sourceContent = this.generateDashboardComponent();
      this.outputChannel.appendLine(
        'DevTrack: Created new dashboard component'
      );
    } else {
      // Adapt the component to the new environment
      sourceContent = this.adaptDashboardComponent(sourceContent);
      this.outputChannel.appendLine(
        'DevTrack: Adapted existing dashboard component'
      );
    }

    await fs.promises.writeFile(
      path.join(componentsDir, 'CodingStatsDashboard.tsx'),
      sourceContent
    );
  }

  /**
   * Adapt the existing dashboard component to work in the standalone website
   */
  private adaptDashboardComponent(content: string): string {
    // Replace type imports with local type definitions
    content = content.replace(
      /import.*\{.*Card.*\}.*from.*/,
      "import { Card, CardContent, CardHeader, CardTitle } from './ui/card';"
    );

    // Add import for the data utilities
    content = content.replace(
      /import React.*/,
      `import React, { useState, useEffect } from 'react';\nimport { loadStats } from '../dataUtils';`
    );

    // Replace VSCode-specific global declarations with our own
    const vscodeGlobalReplacement = `
// Type definitions for our data
import { ActivityData, FileStats, TimeDistribution } from '../types';

// Global window types for our app
declare global {
  interface Window {
    initialStats?: {
      activityTimeline: ActivityData[];
      fileTypes: FileStats[];
      timeDistribution: TimeDistribution[];
    };
  }
}`;

    content = content.replace(
      /\/\/ Declare global types for VSCode webview[\s\S]*?interface Window {[\s\S]*?}\s*}/,
      vscodeGlobalReplacement
    );

    // Update useEffect to use our data loader
    const loadDataEffect = `
  useEffect(() => {
    // Load statistics data
    const loadStatsData = async () => {
      try {
        const stats = await loadStats();
        setActivityData(stats.activityTimeline || []);
        setFileStats(stats.fileTypes || []);
        setTimeDistribution(stats.timeDistribution || []);
        setLoading(false);
      } catch (error) {
        console.error('Failed to load statistics:', error);
        setLoading(false);
      }
    };

    loadStatsData();
  }, []);`;

    // Replace existing useEffect that loads data
    content = content.replace(
      /useEffect\(\s*\(\)\s*=>\s*{[\s\S]*?Load initial stats[\s\S]*?}\s*\), \[\]/,
      loadDataEffect
    );

    if (content.indexOf(loadDataEffect) === -1) {
      // If we couldn't find the pattern to replace, try a more general approach
      content = content.replace(
        /useEffect\(\s*\(\)\s*=>\s*{[\s\S]*?window\.addEventListener[\s\S]*?}\s*\), \[\]/,
        loadDataEffect
      );
    }

    return content;
  }

  /**
   * Generate a new dashboard component if we couldn't find the existing one
   */
  private generateDashboardComponent(): string {
    return `import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { loadStats } from '../dataUtils';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  BarChart,
  Bar,
} from 'recharts';
import {
  Clock,
  FileCode,
  GitBranch,
  ArrowUpDown,
  Moon,
  Sun,
} from 'lucide-react';

// Type definitions for our data
import { ActivityData, FileStats, TimeDistribution } from '../types';

// Global window types for our app
declare global {
  interface Window {
    initialStats?: {
      activityTimeline: ActivityData[];
      fileTypes: FileStats[];
      timeDistribution: TimeDistribution[];
    };
  }
}

const CodingStatsDashboard = () => {
  const [activityData, setActivityData] = useState<ActivityData[]>([]);
  const [fileStats, setFileStats] = useState<FileStats[]>([]);
  const [timeDistribution, setTimeDistribution] = useState<TimeDistribution[]>(
    []
  );
  const [loading, setLoading] = useState(true);
  const [isDarkMode, setIsDarkMode] = useState(() => {
    // Check stored preference
    const stored = localStorage.getItem('devtrack-dashboard-theme');
    if (stored) {
      return stored === 'dark';
    }

    // Fallback to system preference
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  });

  useEffect(() => {
    // Save theme preference
    localStorage.setItem(
      'devtrack-dashboard-theme',
      isDarkMode ? 'dark' : 'light'
    );
    // Apply theme classes
    document.body.classList.toggle('dark', isDarkMode);
  }, [isDarkMode]);

  useEffect(() => {
    // Load statistics data
    const loadStatsData = async () => {
      try {
        const stats = await loadStats();
        setActivityData(stats.activityTimeline || []);
        setFileStats(stats.fileTypes || []);
        setTimeDistribution(stats.timeDistribution || []);
        setLoading(false);
      } catch (error) {
        console.error('Failed to load statistics:', error);
        setLoading(false);
      }
    };

    loadStatsData();
  }, []);

  const themeColors = {
    text: isDarkMode ? 'text-gray-100' : 'text-gray-900',
    subtext: isDarkMode ? 'text-gray-300' : 'text-gray-500',
    background: isDarkMode ? 'bg-gray-900' : 'bg-white',
    cardBg: isDarkMode ? 'bg-gray-800' : 'bg-white',
    border: isDarkMode ? 'border-gray-700' : 'border-gray-200',
    chartColors: {
      grid: isDarkMode ? '#374151' : '#e5e7eb',
      text: isDarkMode ? '#e5e7eb' : '#4b5563',
      line1: isDarkMode ? '#93c5fd' : '#3b82f6',
      line2: isDarkMode ? '#86efac' : '#22c55e',
      line3: isDarkMode ? '#fde047' : '#eab308',
      bar: isDarkMode ? '#93c5fd' : '#3b82f6',
    },
  };

  if (loading) {
    return (
      <div
        className={\`flex items-center justify-center h-64 \${themeColors.text}\`}
      >
        <div className="text-lg">Loading statistics...</div>
      </div>
    );
  }

  return (
    <div
      className={\`w-full max-w-6xl mx-auto p-4 space-y-6 \${themeColors.background} min-h-screen\`}
    >
      {/* Theme Toggle */}
      <div className="flex justify-end">
        <button
          onClick={() => setIsDarkMode(!isDarkMode)}
          className={\`p-2 rounded-lg \${isDarkMode ? 'bg-gray-700 hover:bg-gray-600' : 'bg-gray-100 hover:bg-gray-200'} transition-colors\`}
          aria-label={
            isDarkMode ? 'Switch to light mode' : 'Switch to dark mode'
          }
        >
          {isDarkMode ? (
            <Sun className="h-5 w-5 text-yellow-400" />
          ) : (
            <Moon className="h-5 w-5 text-gray-600" />
          )}
        </button>
      </div>

      {/* Overview Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className={\`\${themeColors.cardBg} \${themeColors.border} border\`}>
          <CardContent className="pt-6">
            <div className="flex items-center space-x-4">
              <Clock className="h-8 w-8 text-blue-500" />
              <div>
                <p className={\`text-sm \${themeColors.subtext}\`}>
                  Total Coding Hours
                </p>
                <h3 className={\`text-2xl font-bold \${themeColors.text}\`}>
                  24.5
                </h3>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className={\`\${themeColors.cardBg} \${themeColors.border} border\`}>
          <CardContent className="pt-6">
            <div className="flex items-center space-x-4">
              <FileCode className="h-8 w-8 text-green-500" />
              <div>
                <p className={\`text-sm \${themeColors.subtext}\`}>
                  Files Modified
                </p>
                <h3 className={\`text-2xl font-bold \${themeColors.text}\`}>54</h3>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className={\`\${themeColors.cardBg} \${themeColors.border} border\`}>
          <CardContent className="pt-6">
            <div className="flex items-center space-x-4">
              <GitBranch className="h-8 w-8 text-purple-500" />
              <div>
                <p className={\`text-sm \${themeColors.subtext}\`}>
                  Total Commits
                </p>
                <h3 className={\`text-2xl font-bold \${themeColors.text}\`}>82</h3>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className={\`\${themeColors.cardBg} \${themeColors.border} border\`}>
          <CardContent className="pt-6">
            <div className="flex items-center space-x-4">
              <ArrowUpDown className="h-8 w-8 text-orange-500" />
              <div>
                <p className={\`text-sm \${themeColors.subtext}\`}>
                  Lines Changed
                </p>
                <h3 className={\`text-2xl font-bold \${themeColors.text}\`}>
                  1,146
                </h3>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Activity Timeline */}
      <Card className={\`\${themeColors.cardBg} \${themeColors.border} border\`}>
        <CardHeader>
          <CardTitle className={themeColors.text}>
            Coding Activity Timeline
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={activityData}>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke={themeColors.chartColors.grid}
                />
                <XAxis
                  dataKey="date"
                  stroke={themeColors.chartColors.text}
                  tick={{ fill: themeColors.chartColors.text }}
                />
                <YAxis
                  yAxisId="left"
                  stroke={themeColors.chartColors.text}
                  tick={{ fill: themeColors.chartColors.text }}
                />
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  stroke={themeColors.chartColors.text}
                  tick={{ fill: themeColors.chartColors.text }}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: isDarkMode ? '#1f2937' : '#ffffff',
                    borderColor: isDarkMode ? '#374151' : '#e5e7eb',
                    color: isDarkMode ? '#f3f4f6' : '#111827',
                  }}
                  labelStyle={{ color: isDarkMode ? '#f3f4f6' : '#111827' }}
                />
                <Legend
                  wrapperStyle={{ color: themeColors.chartColors.text }}
                />
                <Line
                  yAxisId="left"
                  type="monotone"
                  dataKey="commits"
                  stroke={themeColors.chartColors.line1}
                  name="Commits"
                />
                <Line
                  yAxisId="left"
                  type="monotone"
                  dataKey="filesChanged"
                  stroke={themeColors.chartColors.line2}
                  name="Files Changed"
                />
                <Line
                  yAxisId="right"
                  type="monotone"
                  dataKey="linesChanged"
                  stroke={themeColors.chartColors.line3}
                  name="Lines Changed"
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      {/* File Type Distribution */}
      <Card className={\`\${themeColors.cardBg} \${themeColors.border} border\`}>
        <CardHeader>
          <CardTitle className={themeColors.text}>
            File Type Distribution
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={fileStats}>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke={themeColors.chartColors.grid}
                />
                <XAxis
                  dataKey="type"
                  stroke={themeColors.chartColors.text}
                  tick={{ fill: themeColors.chartColors.text }}
                />
                <YAxis
                  stroke={themeColors.chartColors.text}
                  tick={{ fill: themeColors.chartColors.text }}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: isDarkMode ? '#1f2937' : '#ffffff',
                    borderColor: isDarkMode ? '#374151' : '#e5e7eb',
                    color: isDarkMode ? '#f3f4f6' : '#111827',
                  }}
                  labelStyle={{ color: isDarkMode ? '#f3f4f6' : '#111827' }}
                />
                <Legend
                  wrapperStyle={{ color: themeColors.chartColors.text }}
                />
                <Bar
                  dataKey="count"
                  fill={themeColors.chartColors.bar}
                  name="Files"
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      {/* Daily Distribution */}
      <Card className={\`\${themeColors.cardBg} \${themeColors.border} border\`}>
        <CardHeader>
          <CardTitle className={themeColors.text}>
            Daily Coding Distribution
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={timeDistribution}>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke={themeColors.chartColors.grid}
                />
                <XAxis
                  dataKey="hour"
                  stroke={themeColors.chartColors.text}
                  tick={{ fill: themeColors.chartColors.text }}
                />
                <YAxis
                  stroke={themeColors.chartColors.text}
                  tick={{ fill: themeColors.chartColors.text }}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: isDarkMode ? '#1f2937' : '#ffffff',
                    borderColor: isDarkMode ? '#374151' : '#e5e7eb',
                    color: isDarkMode ? '#f3f4f6' : '#111827',
                  }}
                  labelStyle={{ color: isDarkMode ? '#f3f4f6' : '#111827' }}
                />
                <Legend
                  wrapperStyle={{ color: themeColors.chartColors.text }}
                />
                <Bar
                  dataKey="changes"
                  fill={themeColors.chartColors.bar}
                  name="Code Changes"
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default CodingStatsDashboard;`;
  }
}
