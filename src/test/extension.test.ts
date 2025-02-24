/* eslint-disable no-undef */
/* eslint-disable no-unused-vars */
import { strictEqual } from 'assert';
import { ExtensionContext, window } from 'vscode';
import * as extension from '../extension';

suite('Extension Test Suite', () => {
  window.showInformationMessage('Start all tests.');

  test('Sample test', () => {
    strictEqual(-1, [1, 2, 3].indexOf(5));
    strictEqual(-1, [1, 2, 3].indexOf(0));
  });
});
