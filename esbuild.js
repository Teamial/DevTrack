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
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    target: 'node14',
    outfile: 'dist/extension.js',
    external: [
      'vscode',
      'path',
      'fs',
      'events',
      'child_process',
      'crypto',
      'util',
      'os',
      '@octokit/*',
      'simple-git',
      'minimatch',
      'node-schedule'
    ],
    logLevel: 'silent',
    plugins: [esbuildProblemMatcherPlugin],
    treeShaking: true,
    metafile: true,
  });

  if (watch) {
    await ctx.watch();
  } else {
    const result = await ctx.rebuild();
    
    // Log bundle analysis in non-watch mode
    if (!watch) {
      const analysis = await esbuild.analyzeMetafile(result.metafile);
      console.log('Bundle analysis:', analysis);
    }
    
    await ctx.dispose();
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});