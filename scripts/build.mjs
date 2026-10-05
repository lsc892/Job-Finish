import { build } from 'esbuild';
await build({ entryPoints: ['src/extension.ts'], outfile: 'dist/extension.cjs',
  bundle: true, platform: 'node', format: 'cjs', target: 'node22', sourcemap: true,
  external: ['vscode', 'koffi', 'node-notifier', '@anthropic-ai/claude-agent-sdk'] });
