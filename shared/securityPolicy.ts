// Which actions need proof, and what proof. Pure, so the rules are tested
// without a window.
//
// The owner's rule (2026-11-04): 2FA is the user's choice. Off, nothing changes.
// On, EVERY withdrawal needs a code at any amount, because a rule on "full"
// withdrawals is walked around by a 99% send or ten small ones. The other doors
// to the same money need it too: exporting a key, importing one (import then
// fund), changing where withdrawals go, turning on a switch that moves money by
// itself.
//
// Sells and order execution are never gated. A lost phone must not be able to
// trap anyone in a position (order-safety-rules).

export type ProofKind =
  /** Money leaving, or a door to it. A code when 2FA is on. */
  | 'money'
  /** A key or phrase leaving or entering. The password as well, when set. */
  | 'keys'
  /** Changing the protection itself. */
  | 'security';

export type ProofLevel = 'none' | 'password' | 'code' | 'password+code';

export function proofLevel(kind: ProofKind, passwordOn: boolean, totpOn: boolean): ProofLevel {
  if (kind === 'money') return totpOn ? 'code' : 'none';
  if (totpOn) return 'password+code';
  return passwordOn ? 'password' : 'none';
}

/** Every IPC channel that must prove the user is there. test/security.test.mjs
 *  reads ipc.ts and fails if any of these handlers stops calling requireProof. */
export const PROOF_CHANNELS = [
  // Money out.
  'send:execute',
  'wallet:withdraw',
  'calloutRewards:withdrawUsdc',
  'bridge:send',
  'aio:moveSend',
  'aio:compress',
  // Keys out.
  'wallet:exportKey',
  'evm:wallet:exportKey',
  'aio:reveal',
  'aio:create',
  // Keys in: import a key you hold, fund it from the others, and the withdrawal
  // rule has been walked around.
  'wallet:import',
  'evm:wallet:import',
  'aio:import',
  'pump:importAccount',
  // Doors and destruction.
  'wallet:setHome',
  'wallet:remove',
  'evm:wallet:remove',
  'aio:remove',
  'profiles:duplicate',
  'profiles:remove',
  // Handing control to something else.
  'mcp:setEnabled',
  'mcp:setAccess',
  'mcp:newToken',
  'mcp:setBudget',
  'bots:pair',
  'settings:update',
] as const;

/** Channels that must never be gated: getting out of a position. */
export const NEVER_GATED_CHANNELS = ['live:sellToken', 'live:sellAll', 'live:sellDust', 'evm:sell', 'evm:sellAll', 'kryptoMode:sellAll', 'kryptoTrader:sellAll'] as const;

interface GatedSettings {
  execution?: { autoCashout?: boolean; cashoutThresholdSol?: number };
  aio?: { floatEnabled?: boolean; floatUsd?: number };
  bridge?: { enabled?: boolean };
  launch?: { enabled?: boolean };
  bots?: {
    telegram?: { token?: string; enabled?: boolean };
    discord?: { token?: string; enabled?: boolean };
    trading?: { enabled?: boolean } & Record<string, unknown>;
  };
}

/**
 * What in this settings patch moves money by itself or hands control elsewhere,
 * in words for the proof window. Empty when the patch is harmless: most settings
 * changes must stay one click. Only turning something ON or WIDENING it counts,
 * so a user can always turn these off without a code.
 */
export function gatedSettingsDiff(before: GatedSettings, patch: GatedSettings): string[] {
  const out: string[] = [];
  const turnedOn = (next: boolean | undefined, prev: boolean | undefined): boolean => next === true && prev !== true;
  if (turnedOn(patch.execution?.autoCashout, before.execution?.autoCashout)) out.push('Turn on automatic cash-out to your withdrawal address');
  const nextThreshold = patch.execution?.cashoutThresholdSol;
  const prevThreshold = before.execution?.cashoutThresholdSol;
  if (typeof nextThreshold === 'number' && typeof prevThreshold === 'number' && nextThreshold < prevThreshold) {
    out.push(`Lower the cash-out threshold from ${prevThreshold} to ${nextThreshold} SOL`);
  }
  if (turnedOn(patch.aio?.floatEnabled, before.aio?.floatEnabled)) out.push('Turn on the All-in-One float, which moves money between chains by itself');
  const nextFloat = patch.aio?.floatUsd;
  const prevFloat = before.aio?.floatUsd;
  if (typeof nextFloat === 'number' && typeof prevFloat === 'number' && nextFloat > prevFloat) out.push(`Raise the All-in-One float from $${prevFloat} to $${nextFloat}`);
  if (turnedOn(patch.bridge?.enabled, before.bridge?.enabled)) out.push('Turn on Bridge');
  if (turnedOn(patch.launch?.enabled, before.launch?.enabled)) out.push('Turn on Launch a Token');
  for (const kind of ['telegram', 'discord'] as const) {
    const next = patch.bots?.[kind]?.token;
    if (typeof next === 'string' && next !== '' && next !== (before.bots?.[kind]?.token ?? '')) out.push(`Change the ${kind === 'telegram' ? 'Telegram' : 'Discord'} bot token`);
  }
  const nextTrading = patch.bots?.trading;
  const prevTrading = before.bots?.trading;
  if (nextTrading && JSON.stringify(nextTrading) !== JSON.stringify(prevTrading)) {
    if (nextTrading.enabled === true) out.push(prevTrading?.enabled === true ? 'Change the limits on trading from a chat' : 'Turn on trading from a chat');
  }
  return out;
}

export interface SecurityStatus {
  /** An app password is set. */
  password: boolean;
  /** Authenticator codes are on. */
  twoFactor: boolean;
  backupCodesLeft: number;
  /** Minutes idle before the screen locks. 0 is never. */
  idleMinutes: number;
  /** When a lost-authenticator reset can be finished (ms), or null. */
  resetDueAt: number | null;
  /** Keys found only in an old file and moved into the vault. */
  orphanKeys: number;
  /** Something is wrong with the security files themselves. */
  problem: string | null;
  /** Wallets whose key cannot be used on this machine. */
  unusableKeys: string[];
}

export const IDLE_OPTIONS = [0, 5, 15, 60] as const;
export const DEFAULT_IDLE_MINUTES = 15;
export const TOTP_RESET_WAIT_MS = 72 * 3_600_000;
export const BACKUP_CODE_COUNT = 10;
export const EXPORT_CONFIRM_PHRASE = 'EXPORT PLAINTEXT';
