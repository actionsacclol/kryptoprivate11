// Bundle the REAL electron/evm/scanner.ts with its three RPC modules
// (./pons, ./market, ./fourmeme) redirected to test/stubs/evm/*.mjs.
//
// esbuild's --alias flag only takes package names, so the redirect needs a
// plugin, and the stubs are left EXTERNAL as file URLs: the test and the
// bundle must share one module instance, or the test's scripted rows never
// reach the scanner.
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const stubs = path.join(here, 'stubs', 'evm');

await build({
  entryPoints: [path.join(repo, 'electron/evm/scanner.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: path.join(here, '.evmscanner.stubbed.mjs'),
  external: ['viem', 'ws', 'undici'],
  alias: { electron: path.join(repo, 'test/electronstub.mjs'), '@shared': path.join(repo, 'shared') },
  banner: { js: "import{createRequire}from 'module';const require=createRequire(import.meta.url);" },
  plugins: [
    {
      name: 'stub-rpc',
      setup(b) {
        b.onResolve({ filter: /^\.\/(pons|market|fourmeme)$/ }, (args) => {
          if (!args.importer.replace(/\\/g, '/').endsWith('electron/evm/scanner.ts')) return null;
          return { path: pathToFileURL(path.join(stubs, `${args.path.slice(2)}.mjs`)).href, external: true };
        });
      },
    },
  ],
  logLevel: 'warning',
});
