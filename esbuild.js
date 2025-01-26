const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

async function build() {
  const context = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'dist/extension.js',
    external: ['vscode'],
    format: 'cjs',
    platform: 'node',
    target: 'node14',
    sourcemap: !production,
    minify: production,
    treeShaking: true,
  });

  if (watch) {
    await context.watch();
    console.log('[watch] build finished, watching for changes...');
  } else {
    await context.rebuild();
    await context.dispose();
    console.log('[build] build finished');
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});