// Program-upgrade watchdog — wemissinshi §5: Pump is an upgradeable
// program. If its ProgramData deployment slot changes, the decoder and
// every account assumption is suspect: pause entries immediately, keep
// recording, and require re-verification. Never "try the old decoder."
//
// BPF upgradeable loader layout:
//   Program account:      u32 enum (2 = Program) | programdata pubkey (32)
//   ProgramData account:  u32 enum (3 = ProgramData) | last_deployed_slot u64 | ...

import fs from 'node:fs';
import path from 'node:path';
import { getAccountInfo } from './rpcClient';
import { base58Encode } from './base58';

export interface ProgramCheck {
  ok: boolean;
  /** True when the deployment slot differs from the recorded baseline. */
  changed: boolean;
  message: string;
  deployedSlot?: number;
  /** The ProgramData address this reading came from. The baseline compares it
   *  as well as the slot, so re-recording MUST use the address just observed,
   *  not the one already stored — otherwise a redeploy that also moved the
   *  ProgramData account would keep firing forever. */
  programdata?: string;
}

interface Baseline {
  programdata: string;
  deployedSlot: number;
  recordedAt: number;
}

let baselineFile = '';

export function init(userDataDir: string): void {
  baselineFile = path.join(userDataDir, 'program-baseline.json');
}

function loadBaselines(): Record<string, Baseline> {
  try {
    return JSON.parse(fs.readFileSync(baselineFile, 'utf8')) as Record<string, Baseline>;
  } catch {
    return {};
  }
}

function saveBaselines(b: Record<string, Baseline>): void {
  try {
    const tmp = `${baselineFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(b, null, 2), 'utf8');
    fs.renameSync(tmp, baselineFile);
  } catch {
    /* best-effort */
  }
}

export async function checkProgram(httpUrl: string, programId: string): Promise<ProgramCheck> {
  const prog = await getAccountInfo(httpUrl, programId);
  if (!prog.ok || !prog.data) {
    // RPC trouble is a warning, not an upgrade — availability failures must
    // not permanently pause the engine; the caller logs and retries.
    return { ok: false, changed: false, message: `program account unreadable (${prog.message})` };
  }
  const pdata = prog.data.data;
  if (pdata.length < 36 || pdata.readUInt32LE(0) !== 2) {
    return { ok: false, changed: false, message: 'unexpected program account layout' };
  }
  const programdataAddr = base58Encode(pdata.subarray(4, 36));

  const pd = await getAccountInfo(httpUrl, programdataAddr);
  if (!pd.ok || !pd.data) {
    return { ok: false, changed: false, message: `programdata unreadable (${pd.message})` };
  }
  const d = pd.data.data;
  if (d.length < 12 || d.readUInt32LE(0) !== 3) {
    return { ok: false, changed: false, message: 'unexpected programdata layout' };
  }
  const deployedSlot = Number(d.readBigUInt64LE(4));

  const baselines = loadBaselines();
  const prev = baselines[programId];
  if (!prev) {
    baselines[programId] = { programdata: programdataAddr, deployedSlot, recordedAt: Date.now() };
    saveBaselines(baselines);
    return { ok: true, changed: false, message: `baseline recorded (deploy slot ${deployedSlot})`, deployedSlot, programdata: programdataAddr };
  }
  if (prev.deployedSlot !== deployedSlot || prev.programdata !== programdataAddr) {
    return {
      ok: true,
      changed: true,
      message: `program redeployed: slot ${prev.deployedSlot} → ${deployedSlot}`,
      deployedSlot,
      programdata: programdataAddr,
    };
  }
  return { ok: true, changed: false, message: `unchanged (deploy slot ${deployedSlot})`, deployedSlot, programdata: programdataAddr };
}

/** Re-record the baseline once the decoder has been re-verified against the
 *  new deployment. Called by the engine's automatic re-verification, which
 *  re-reads Global, a live bonding curve and a confirmed on-chain trade and
 *  only gets here when all three still match this build (decoderVerify.ts).
 *  Nothing else may call this: recording a baseline is what lifts the pause,
 *  and it must never be a way to skip the checks. */
export function acceptCurrent(programId: string, deployedSlot: number, programdata: string): void {
  const baselines = loadBaselines();
  baselines[programId] = { programdata, deployedSlot, recordedAt: Date.now() };
  saveBaselines(baselines);
}
