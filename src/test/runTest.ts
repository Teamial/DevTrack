/* eslint-disable no-console */

import { resolve } from 'path';
import type { TestOptions } from '@vscode/test-electron';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  try {
    // The folder containing the Extension Manifest package.json
    const extensionPath = resolve(__dirname, '../../');

    const testRunnerOptions: TestOptions = {
      extensionDevelopmentPath: extensionPath,
      launchArgs: [],
      version: 'stable',
      extensionTestsPath: '',
    };

    // Download VS Code, unzip it and run the integration test
    await runTests(testRunnerOptions);
  } catch (err: unknown) {
    if (err instanceof Error) {
      console.error('Failed to run tests:', err.message);
    }
    process.exit(1);
  }
}

void main();
