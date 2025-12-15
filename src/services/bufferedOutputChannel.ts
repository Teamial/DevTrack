import * as vscode from 'vscode';

export class BufferedOutputChannel implements vscode.OutputChannel {
  public readonly name: string;
  private readonly lines: string[] = [];

  constructor(
    private readonly inner: vscode.OutputChannel,
    private readonly maxLines: number = 500
  ) {
    this.name = inner.name;
  }

  append(value: string): void {
    this.capture(value);
    this.inner.append(value);
  }

  appendLine(value: string): void {
    this.capture(value + '\n');
    this.inner.appendLine(value);
  }

  clear(): void {
    this.lines.length = 0;
    this.inner.clear();
  }

  replace(value: string): void {
    this.lines.length = 0;
    this.capture(value + '\n');
    this.inner.replace(value);
  }

  // Match VS Code OutputChannel overloads
  show(column?: vscode.ViewColumn, preserveFocus?: boolean): void;
  show(preserveFocus?: boolean): void;
  show(arg1?: vscode.ViewColumn | boolean, arg2?: boolean): void {
    (this.inner as any).show(arg1 as any, arg2);
  }

  hide(): void {
    this.inner.hide();
  }

  dispose(): void {
    this.inner.dispose();
  }

  getRecentLines(): string[] {
    return [...this.lines];
  }

  private capture(chunk: string): void {
    const parts = chunk.split(/\r?\n/);
    for (const p of parts) {
      if (p === '') {
        continue;
      }
      this.lines.push(p);
    }
    if (this.lines.length > this.maxLines) {
      this.lines.splice(0, this.lines.length - this.maxLines);
    }
  }
}
