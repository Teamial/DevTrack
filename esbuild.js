// esbuild.js
const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: 'esbuild-problem-matcher',

  setup(build) {
    build.onStart(() => {
      console.log('[build] Build started');
    });
    build.onEnd((result) => {
      if (result.errors.length > 0) {
        result.errors.forEach(({ text, location }) => {
          console.log(`✘ [ERROR] ${text}`);
          if (location) {
            console.log(`    ${location.file}:${location.line}:${location.column}`);
          }
        });
      }
      console.log('[build] Build finished');
    });
  },
};

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs', // CommonJS format for VS Code extensions
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    logLevel: 'silent',
    plugins: [esbuildProblemMatcherPlugin],
  });

  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch(e => {
  console.error(e); // Use console.error instead of this.outputChannel.appendLine(e);
  process.exit(1);
});
