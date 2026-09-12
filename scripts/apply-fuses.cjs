// Flip Electron's fuses on the packaged binary (electron-builder afterPack).
//
// Fuses are bits baked into the Electron executable that disable capabilities
// an attacker would use. Zero runtime cost, and they close holes no amount of
// JS obfuscation can:
//   • RunAsNode OFF — no relaunching the binary as plain Node via
//     ELECTRON_RUN_AS_NODE to run arbitrary code in the app's context.
//   • EnableNodeCliInspectArguments OFF — --inspect is ignored; no CLI debugger.
//   • EnableNodeOptionsEnvironmentVariable OFF — NODE_OPTIONS cannot inject flags.
//   • OnlyLoadAppFromAsar ON — loads only from app.asar, not an unpacked dir.
//   • EnableCookieEncryption ON — at-rest cookie encryption.
//
// Written as CommonJS so electron-builder's require() loads it directly.

const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');
const path = require('node:path');
const fs = require('node:fs');

const ARCH = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };

/**
 * Bytecode is V8 cached data: only a V8 with the same version, flags and CPU
 * features accepts it. Packaging a build whose .jsc files were compiled on
 * another platform or architecture produces an app that dies at boot with
 * "cachedDataRejected". Fail the build here instead, where the message can
 * say what to do. A plain (KRYPT_OBFUSCATE=0) build writes no stamp and is
 * portable, so a missing file is not an error.
 */
function assertBytecodeMatchesTarget(context) {
  const stamp = path.join(process.cwd(), 'dist-electron', 'bytecode-target.json');
  if (!fs.existsSync(stamp)) return;
  let target;
  try {
    target = JSON.parse(fs.readFileSync(stamp, 'utf8'));
  } catch {
    return; // an unreadable stamp is not evidence of a mismatch
  }
  const wantPlatform = context.electronPlatformName === 'win32' ? 'win32' : context.electronPlatformName;
  const wantArch = ARCH[context.arch] ?? String(context.arch);
  if (target.platform === wantPlatform && (target.arch === wantArch || wantArch === 'universal')) return;
  throw new Error(
    `[fuses] this build's V8 bytecode was compiled for ${target.platform} ${target.arch}, but you are packaging for ${wantPlatform} ${wantArch}. ` +
      'The app would fail to start ("cachedDataRejected"). Build and package each platform on that platform (a CI matrix does this), ' +
      'or set KRYPT_OBFUSCATE=0 for a portable plain-JavaScript build.',
  );
}

/**
 * Where electron-builder put app.asar. Windows and Linux lay the app out flat
 * (`<appOutDir>/resources/app.asar`); macOS wraps it in a bundle
 * (`<appOutDir>/<Product>.app/Contents/Resources/app.asar`). The first macOS
 * CI run (2026-09-12) failed in `assertBytecodeIsPackaged` with "no app.asar
 * at release/mac-arm64/resources/app.asar" because only the flat layout was
 * known — the asar was there, one directory deeper.
 */
function packagedAsarPath({ appOutDir, electronPlatformName, packager }) {
  if (electronPlatformName === 'darwin') {
    return path.join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents', 'Resources', 'app.asar');
  }
  return path.join(appOutDir, 'resources', 'app.asar');
}

/**
 * The bytecode must be IN the package, not merely correct on disk.
 *
 * `assertBytecodeMatchesTarget` checks the bytecode's platform and arch. It
 * says nothing about whether the .jsc files reached app.asar — and on
 * 2026-09-09 they did not: a concurrent `npm run build` rewrote them
 * mid-package, electron-builder exited 0, and a 113 MiB installer shipped
 * whose dist-electron held nine .js files (six of them 71–77-byte bytenode
 * stubs) and zero .jsc. That app has no main process; it dies at boot.
 *
 * A stub without its bytecode is the one failure that looks like success all
 * the way to the user, so it is asserted against the artefact itself.
 */
function assertBytecodeIsPackaged(context) {
  const stamp = path.join(process.cwd(), 'dist-electron', 'bytecode-target.json');
  // No stamp means a plain-JavaScript build: nothing to look for.
  if (!fs.existsSync(stamp)) return;

  const asarPath = packagedAsarPath(context);
  if (!fs.existsSync(asarPath)) {
    throw new Error(`[fuses] no app.asar at ${asarPath} — cannot verify the bytecode shipped`);
  }

  // asar header: uint32 pickle size, uint32 header-object size, uint32 string
  // size, uint32 JSON length, then the JSON itself.
  const fd = fs.openSync(asarPath, 'r');
  let header;
  try {
    const sizeBuf = Buffer.alloc(16);
    fs.readSync(fd, sizeBuf, 0, 16, 0);
    const jsonLen = sizeBuf.readUInt32LE(12);
    const jsonBuf = Buffer.alloc(jsonLen);
    fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
    header = JSON.parse(jsonBuf.toString('utf8'));
  } finally {
    fs.closeSync(fd);
  }

  const files = (header.files && header.files['dist-electron'] && header.files['dist-electron'].files) || {};

  // Not every .js is a bytenode stub — `preload.js` ships as plain JavaScript
  // and has no .jsc by design. The set that MUST be packaged is exactly the
  // set the build produced, so read it off disk rather than guessing from
  // names.
  const built = fs
    .readdirSync(path.join(process.cwd(), 'dist-electron'))
    .filter((n) => n.endsWith('.jsc'));
  if (built.length === 0) {
    throw new Error('[fuses] dist-electron has a bytecode stamp but no .jsc files — the harden step did not run');
  }

  const missing = [];
  for (const jsc of built) {
    const entry = files[jsc];
    // 1 KB: the smallest real .jsc here is ~13 KB, so this catches an absent,
    // truncated or placeholder file without pinning an exact size.
    if (!entry || typeof entry.size !== 'number' || entry.size < 1024) {
      missing.push(`${jsc}${entry ? ` (${entry.size} B)` : ' (absent)'}`);
    }
  }
  if (missing.length) {
    throw new Error(
      `[fuses] the packaged app.asar is missing its V8 bytecode — this build cannot boot.\n` +
        `        ${missing.join('\n        ')}\n` +
        `        Nothing may write to dist-electron while electron-builder runs; re-run \`npm run build && npx electron-builder\` with nothing else touching the tree.`,
    );
  }
  console.log(`[fuses] bytecode verified in app.asar — ${built.length} .jsc file(s) present`);
}

module.exports = async function afterPack(context) {
  const { appOutDir, packager, electronPlatformName } = context;
  assertBytecodeMatchesTarget(context);
  assertBytecodeIsPackaged(context);
  // Linux binaries carry no extension; naming one anyway skipped the fuses
  // silently and shipped an unhardened build.
  const exeName =
    electronPlatformName === 'darwin'
      ? `${packager.appInfo.productFilename}.app`
      : electronPlatformName === 'win32'
        ? `${packager.appInfo.productFilename}.exe`
        : packager.executableName || packager.appInfo.productFilename;
  const electronBinary = path.join(appOutDir, exeName);

  if (!fs.existsSync(electronBinary)) {
    console.warn(`[fuses] binary not found at ${electronBinary} — skipping`);
    return;
  }

  await flipFuses(electronBinary, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: electronPlatformName === 'darwin',
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.EnableCookieEncryption]: true,
  });

  console.log(`[fuses] applied to ${exeName} — RunAsNode/inspect/NODE_OPTIONS off, asar-only on`);
};

// Exported so a test can pin the rules without packaging anything.
module.exports.assertBytecodeMatchesTarget = assertBytecodeMatchesTarget;
module.exports.assertBytecodeIsPackaged = assertBytecodeIsPackaged;
module.exports.packagedAsarPath = packagedAsarPath;
