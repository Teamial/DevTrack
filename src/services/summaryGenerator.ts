import { Change } from './tracker';

export class SummaryGenerator {
  generateSummary(changes: Change[]): string {
    if (changes.length === 0) {
      return 'No changes recorded in the last interval.';
    }

    const summaryMap: Map<string, number> = new Map();

    changes.forEach(change => {
      const fileName = change.uri.fsPath.split(/[\\/]/).pop() || 'unknown file';
      const key = `${change.type} ${fileName}`;
      summaryMap.set(key, (summaryMap.get(key) || 0) + 1);
    });

    const summaries = Array.from(summaryMap.entries()).map(
      ([action, count]) => `${count} ${action}`
    );

    return summaries.join('; ') + '.';
  }
}
