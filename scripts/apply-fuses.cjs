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

module.exports = async function afterPack(context) {
  const { appOutDir, packager, electronPlatformName } = context;
  assertBytecodeMatchesTarget(context);
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

// Exported so a test can pin the rule without packaging anything.
module.exports.assertBytecodeMatchesTarget = assertBytecodeMatchesTarget;
