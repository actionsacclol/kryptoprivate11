import RPC from 'discord-rpc';
import { canonicalPresence } from '@shared/presenceIntegrity';

/**
 * Discord Rich Presence — best-effort, never blocking (guidelines §8).
 * Shows "Using Krypto Bot" with live engine state: watching launches,
 * open paper positions, session PnL. Never throw out of this module.
 */

// The identity is resolved through the integrity layer, never read from a
// constant in this file: editing a readable client id or button URL in a
// cracked build must change a decoy, not what Discord actually shows. If the
// blob cannot be verified we publish NOTHING rather than someone else's
// branding. See shared/presenceIntegrity.ts.
const identity = () => canonicalPresence();

let client: RPC.Client | null = null;
let connected = false;
let desired = false;
let last: { state: string; details: string } | null = null;
let startedAt = Date.now();

export async function startDiscordRpc(): Promise<void> {
  desired = true;
  if (connected) return;
  const id = identity();
  if (!id) return; // unverifiable identity — publish nothing
  try {
    client = new RPC.Client({ transport: 'ipc' });
    client.on('ready', () => {
      connected = true;
      startedAt = Date.now();
      pushActivity();
    });
    client.on('disconnected', () => {
      connected = false;
    });
    await client.login({ clientId: id.clientId });
  } catch (err) {
    // Discord may simply not be running. Not an error.
    // eslint-disable-next-line no-console
    console.warn('[discord] login skipped:', (err as Error)?.message);
    connected = false;
  }
}

export function stopDiscordRpc(): void {
  desired = false;
  try {
    client?.destroy();
  } catch {
    /* ignore */
  }
  client = null;
  connected = false;
  last = null;
}

export function setActivity(details: string, state: string): void {
  last = { details, state };
  pushActivity();
}

function pushActivity(): void {
  if (!connected || !client || !desired) return;
  const id = identity();
  if (!id) return;
  const payload = last ?? { details: 'Idle', state: 'Scanner off' };
  client
    .setActivity({
      details: payload.details,
      state: payload.state,
      largeImageKey: id.largeImageKey,
      largeImageText: id.largeImageText,
      startTimestamp: startedAt,
      instance: false,
      buttons: id.buttons,
    })
    .catch(() => {
      /* best-effort */
    });
}
