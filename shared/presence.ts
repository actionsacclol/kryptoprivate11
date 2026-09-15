// Discord Rich Presence — the readable half of the attribution identity.
//
// This is the app's only outbound advertising: while presence is on, everyone
// in a user's Discord sees what they are running and gets two buttons to the
// site and the server. It costs the user nothing and it is how the product
// spreads, which makes it the second thing a cracker strips after the fee.
//
// These constants are the READABLE copy, and they are deliberately the easy
// thing to find. The values actually sent to Discord are decoded from the
// blob in presenceIntegrity.ts, so editing anything here changes a decoy:
// the presence still carries the real client id and the real buttons, and
// the edit trips a canary instead (canary.ts).
//
// A user turning presence OFF in Settings is not tampering and never trips
// anything — the toggle is theirs, and it is off by default. Only editing
// these values does.

export interface PresenceIdentity {
  /** Discord application id the presence is published under. */
  clientId: string;
  /** The two buttons shown under the presence card, in order. */
  buttons: Array<{ label: string; url: string }>;
  /** Art asset key registered on the Discord application. */
  largeImageKey: string;
  /** Hover text on the art — the product name as the world sees it. */
  largeImageText: string;
}

export const PRESENCE: PresenceIdentity = {
  clientId: '1495323918234423406',
  buttons: [
    { label: 'Free Tools', url: 'https://krypt.cc/tools' },
    // The token, not the Discord invite. Discord allows exactly two buttons,
    // and the mint is the same one shared/krypto.ts pins for the Hub card —
    // repeated as a literal rather than imported because this constant is
    // hashed into the integrity blob and has to be readable on its own.
    { label: '$KRYPTO', url: 'https://pump.fun/coin/2qEubd7GwtZbCqDu1uQwNC4kNaJLBdRUcWKpckTypump' },
  ],
  largeImageKey: 'krypt',
  largeImageText: 'Krypto Bot',
};

/** One canonical string for the whole identity — the form the blob encodes.
 *  Field order is part of the contract; changing it means regenerating. */
export function packIdentity(p: PresenceIdentity): string {
  return [
    p.clientId,
    p.buttons[0]?.label ?? '',
    p.buttons[0]?.url ?? '',
    p.buttons[1]?.label ?? '',
    p.buttons[1]?.url ?? '',
    p.largeImageKey,
    p.largeImageText,
  ].join('|');
}

export function unpackIdentity(packed: string): PresenceIdentity | null {
  const f = packed.split('|');
  if (f.length !== 7) return null;
  return {
    clientId: f[0],
    buttons: [
      { label: f[1], url: f[2] },
      { label: f[3], url: f[4] },
    ],
    largeImageKey: f[5],
    largeImageText: f[6],
  };
}
