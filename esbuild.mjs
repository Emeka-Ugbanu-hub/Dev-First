import esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const extensionCtx = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outfile: 'dist/extension.js',
  external: ['vscode', 'onnxruntime-node', 'onnxruntime-web', 'sharp', '@vscode/tree-sitter-wasm'],
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
});

const panelCtx = await esbuild.context({
  entryPoints: ['webview/src/architecturePanel.ts'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  outfile: 'dist/architecturePanel.js',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
});

if (watch) {
  await Promise.all([extensionCtx.watch(), panelCtx.watch()]);
  console.log('[esbuild] watching...');
} else {
  await Promise.all([extensionCtx.rebuild(), panelCtx.rebuild()]);
  await Promise.all([extensionCtx.dispose(), panelCtx.dispose()]);
}
