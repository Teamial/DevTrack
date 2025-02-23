/* eslint-disable no-undef */
/* eslint-disable no-unused-vars */
import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
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

interface ActivityData {
  date: string;
  commits: number;
  filesChanged: number;
  linesChanged: number;
}

interface FileStats {
  type: string;
  count: number;
}

interface TimeDistribution {
  hour: string;
  changes: number;
}

// Declare global types for VSCode webview
declare global {
  interface Window {
    vscode?: {
      postMessage: (message: { command: string; theme?: string }) => void;
    };
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
    // First check stored preference
    const stored = localStorage.getItem('devtrack-dashboard-theme');
    if (stored) {
      return stored === 'dark';
    }

    // Then check if VSCode is in dark mode
    if (window.vscode) {
      return document.body.classList.contains('vscode-dark');
    }

    // Finally fallback to system preference
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
    if (window.vscode) {
      window.vscode?.postMessage({
        command: 'themeChanged',
        theme: isDarkMode ? 'dark' : 'light',
      });
    }
  }, [isDarkMode]);

  useEffect(() => {
    // Watch for VSCode theme changes
    const observer = new MutationObserver((mutations: MutationRecord[]) => {
      mutations.forEach((mutation: MutationRecord) => {
        if ((mutation.target as Element).classList.contains('vscode-dark')) {
          setIsDarkMode(true);
        } else if (
          (mutation.target as Element).classList.contains('vscode-light')
        ) {
          setIsDarkMode(false);
        }
      });
    });

    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['class'],
    });

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    // Load initial stats from VSCode if available
    if (window.initialStats) {
      setActivityData(window.initialStats.activityTimeline || []);
      setFileStats(window.initialStats.fileTypes || []);
      setTimeDistribution(window.initialStats.timeDistribution || []);
      setLoading(false);
    }

    // Listen for stats updates from VSCode
    const messageHandler = (event: MessageEvent<any>) => {
      const message = event.data as {
        command: string;
        stats?: {
          activityTimeline: Array<ActivityData>;
          fileTypes: Array<FileStats>;
          timeDistribution: Array<TimeDistribution>;
        };
      };
      if (message.command === 'updateStats' && message.stats) {
        setActivityData(message.stats.activityTimeline || []);
        setFileStats(message.stats.fileTypes || []);
        setTimeDistribution(message.stats.timeDistribution || []);
      }
    };

    window.addEventListener('message', messageHandler);
    return () => window.removeEventListener('message', messageHandler);
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
        className={`flex items-center justify-center h-64 ${themeColors.text}`}
      >
        <div className="text-lg">Loading statistics...</div>
      </div>
    );
  }

  return (
    <div
      className={`w-full max-w-6xl mx-auto p-4 space-y-6 ${themeColors.background} min-h-screen`}
    >
      {/* Theme Toggle */}
      <div className="flex justify-end">
        <button
          onClick={() => setIsDarkMode(!isDarkMode)}
          className={`p-2 rounded-lg ${isDarkMode ? 'bg-gray-700 hover:bg-gray-600' : 'bg-gray-100 hover:bg-gray-200'} transition-colors`}
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
        <Card className={`${themeColors.cardBg} ${themeColors.border} border`}>
          <CardContent className="pt-6">
            <div className="flex items-center space-x-4">
              <Clock className="h-8 w-8 text-blue-500" />
              <div>
                <p className={`text-sm ${themeColors.subtext}`}>
                  Total Coding Hours
                </p>
                <h3 className={`text-2xl font-bold ${themeColors.text}`}>
                  24.5
                </h3>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className={`${themeColors.cardBg} ${themeColors.border} border`}>
          <CardContent className="pt-6">
            <div className="flex items-center space-x-4">
              <FileCode className="h-8 w-8 text-green-500" />
              <div>
                <p className={`text-sm ${themeColors.subtext}`}>
                  Files Modified
                </p>
                <h3 className={`text-2xl font-bold ${themeColors.text}`}>54</h3>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className={`${themeColors.cardBg} ${themeColors.border} border`}>
          <CardContent className="pt-6">
            <div className="flex items-center space-x-4">
              <GitBranch className="h-8 w-8 text-purple-500" />
              <div>
                <p className={`text-sm ${themeColors.subtext}`}>
                  Total Commits
                </p>
                <h3 className={`text-2xl font-bold ${themeColors.text}`}>82</h3>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className={`${themeColors.cardBg} ${themeColors.border} border`}>
          <CardContent className="pt-6">
            <div className="flex items-center space-x-4">
              <ArrowUpDown className="h-8 w-8 text-orange-500" />
              <div>
                <p className={`text-sm ${themeColors.subtext}`}>
                  Lines Changed
                </p>
                <h3 className={`text-2xl font-bold ${themeColors.text}`}>
                  1,146
                </h3>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Activity Timeline */}
      <Card className={`${themeColors.cardBg} ${themeColors.border} border`}>
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
      <Card className={`${themeColors.cardBg} ${themeColors.border} border`}>
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
      <Card className={`${themeColors.cardBg} ${themeColors.border} border`}>
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

export default CodingStatsDashboard;
