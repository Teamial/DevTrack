/* eslint-disable no-console */
/* eslint-disable no-undef */
import * as path from 'path';
import Mocha from 'mocha';
import { glob } from 'glob';

export async function run(): Promise<void> {
  // Create the mocha test
  const mocha = new Mocha({
    ui: 'tdd',
    color: true,
  });

  const testsRoot = path.resolve(__dirname, '..');
  const options = { cwd: testsRoot };

  try {
    // Find test files
    const files = await glob('**/**.test.ts', options);

    // Add files to the test suite
    files.forEach((f) => mocha.addFile(path.resolve(testsRoot, f)));

    // Run the mocha test
    return new Promise<void>((resolve, reject) => {
      try {
        mocha.run((failures: number) => {
          if (failures > 0) {
            reject(new Error(`${failures} tests failed.`));
          } else {
            resolve();
          }
        });
      } catch (err) {
        console.error(
          'Test execution error:',
          err instanceof Error ? err.message : String(err)
        );
        reject(err);
      }
    });
  } catch (err) {
    console.error(
      'Test setup error:',
      err instanceof Error ? err.message : String(err)
    );
    throw err;
  }
}
