// src/services/changeAnalyzer.ts

import * as vscode from 'vscode';
import { Change } from './tracker';
import { OutputChannel } from 'vscode';

export type ChangeType =
  | 'feature'
  | 'bugfix'
  | 'refactor'
  | 'docs'
  | 'style'
  | 'other';

interface ScoreMap {
  feature: number;
  bugfix: number;
  refactor: number;
  docs: number;
  style: number;
}

export interface ChangeAnalysis {
  type: ChangeType;
  confidence: number;
  details: string[];
}

export class ChangeAnalyzer {
  private outputChannel: OutputChannel;

  constructor(outputChannel: OutputChannel) {
    this.outputChannel = outputChannel;
  }

  private readonly INDICATORS = {
    feature: {
      keywords: ['feat', 'feature', 'add', 'implement', 'new'],
      patterns: [
        /new (class|interface|type|enum|function|component)/i,
        /implement.*feature/i,
        /\+\s*export/,
      ],
    },
    bugfix: {
      keywords: ['fix', 'bug', 'issue', 'crash', 'error', 'resolve'],
      patterns: [
        /fix(es|ed)?/i,
        /\b(bug|issue|crash|error)\b/i,
        /catch\s*\(/,
        /try\s*{/,
      ],
    },
    refactor: {
      keywords: [
        'refactor',
        'restructure',
        'reorganize',
        'improve',
        'optimize',
      ],
      patterns: [
        /refactor/i,
        /\brenamed?\b/i,
        /\bmoved?\b/i,
        /\bcleanup\b/i,
        /\boptimize(d)?\b/i,
      ],
    },
    docs: {
      keywords: ['doc', 'comment', 'readme', 'changelog'],
      patterns: [
        /\/\*\*?[\s\S]*?\*\//, // JSDoc comments
        /^\s*\/\//, // Single line comments
        /\.md$/i, // Markdown files
      ],
    },
    style: {
      keywords: ['style', 'format', 'lint', 'prettier'],
      patterns: [/\bindent/i, /\bformat/i, /\.css$/, /\.scss$/, /style:\s/],
    },
  };

  public async analyzeChanges(changes: Change[]): Promise<ChangeAnalysis> {
    try {
      const scores: ScoreMap = {
        feature: 0,
        bugfix: 0,
        refactor: 0,
        docs: 0,
        style: 0,
      };

      const details: string[] = [];

      for (const change of changes) {
        const content = await this.getFileContent(change.uri);
        const filename = change.uri.fsPath.toLowerCase();

        // Analyze file extension and name
        if (filename.endsWith('.test.ts') || filename.endsWith('.spec.ts')) {
          scores.feature += 0.5;
          details.push('Test file changes detected');
        }

        // Analyze content changes
        for (const [type, indicators] of Object.entries(this.INDICATORS)) {
          if (this.isValidChangeType(type)) {
            // Check keywords in content
            const keywordMatches = indicators.keywords.filter((keyword) =>
              content.toLowerCase().includes(keyword.toLowerCase())
            );

            // Check regex patterns
            const patternMatches = indicators.patterns.filter((pattern) =>
              pattern.test(content)
            );

            if (keywordMatches.length > 0) {
              scores[type] += keywordMatches.length * 0.5;
              details.push(
                `Found ${type} keywords: ${keywordMatches.join(', ')}`
              );
            }

            if (patternMatches.length > 0) {
              scores[type] += patternMatches.length;
              details.push(`Detected ${type} patterns in code`);
            }
          }
        }
      }

      // Determine the most likely type
      const maxScore = Math.max(...Object.values(scores));
      const type =
        (Object.entries(scores).find(
          ([, score]) => score === maxScore
        )?.[0] as ChangeType) || 'other';

      // Calculate confidence (0-1)
      const totalScore = Object.values(scores).reduce((a, b) => a + b, 0);
      const confidence = totalScore > 0 ? maxScore / totalScore : 0;

      return {
        type,
        confidence,
        details: [...new Set(details)], // Remove duplicates
      };
    } catch (error) {
      this.outputChannel.appendLine(`Error analyzing changes: ${error}`);
      return { type: 'other', confidence: 0, details: [] };
    }
  }

  private isValidChangeType(type: string): type is keyof ScoreMap {
    return type in this.INDICATORS;
  }

  private async getFileContent(uri: vscode.Uri): Promise<string> {
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      return document.getText();
    } catch (error) {
      this.outputChannel.appendLine(`Error reading file content: ${error}`);
      return '';
    }
  }
}
