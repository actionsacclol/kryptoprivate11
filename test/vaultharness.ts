// One bundle holding every module a password move touches, so the test drives
// them sharing one vault, as the app does. Re-importing it is a process restart.
export * as vault from '../electron/system/vault';
export * as vaultMigrate from '../electron/system/vaultMigrate';
export * as securityState from '../electron/system/securityState';
export * as keyExport from '../electron/system/keyExport';
export * as wallet from '../electron/system/wallet';
export * as evmWallet from '../electron/evm/evmWallet';
export * as aioWallet from '../electron/system/aioWallet';
export * as crypto_ from '../electron/system/vaultCrypto';
