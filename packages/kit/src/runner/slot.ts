// The slot: one letter per machine that names whose persona accounts a run resets and signs in. The run lock only
// covers one machine, so two machines on the same slot would end each other's sessions: against a shared (remote)
// target the slot is never guessed. It comes from `--slot`, else `CREDLESS_SLOT`, else the first line of the slot
// file; local targets (the demo, the self-tests) default to `a`; `health` touches no account and needs none.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KIT_NAME } from '../brand.ts';
import { DEFAULTS, ENV, PATTERNS } from '../types.ts';

export type SlotSource = 'flag' | 'env' | 'file' | 'default' | 'none';

export interface SlotResolution {
  /** null when nothing named one */
  slot: string | null;
  source: SlotSource;
  /** where the slot file is on this machine (for messages) */
  file: string;
  /** how `source` is spelled in a message: `--slot`, `CREDLESS_SLOT` or the file path */
  sourceLabel: string;
}

export interface SlotOptions {
  flag?: string;
  env?: NodeJS.ProcessEnv;
  /** the slot file to read instead of the platform default */
  file?: string;
  platform?: NodeJS.Platform;
  homedir?: string;
}

/** `$XDG_CONFIG_HOME/<kit>/slot` or `~/.config/<kit>/slot` on POSIX; `%APPDATA%\<kit>\slot` on Windows. */
export function slotFilePath(options: Pick<SlotOptions, 'env' | 'platform' | 'homedir'> = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.homedir ?? os.homedir();
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, KIT_NAME, 'slot');
  }
  const config = env.XDG_CONFIG_HOME || path.join(home, '.config');
  return path.join(config, KIT_NAME, 'slot');
}

/** Flag, then environment, then the slot file's first line. Does not validate: see {@link checkSlot}. */
export function resolveSlot(options: SlotOptions = {}): SlotResolution {
  const env = options.env ?? process.env;
  const file = options.file ?? slotFilePath(options);
  if (options.flag !== undefined && options.flag !== '') {
    return { slot: options.flag, source: 'flag', file, sourceLabel: '--slot' };
  }
  const fromEnv = env[ENV.SLOT];
  if (fromEnv !== undefined && fromEnv !== '')
    return { slot: fromEnv.trim(), source: 'env', file, sourceLabel: ENV.SLOT };
  try {
    const first = fs.readFileSync(file, 'utf8').split(/\r?\n/)[0] ?? '';
    const slot = first.replace(/\s+/g, '');
    if (slot) return { slot, source: 'file', file, sourceLabel: file };
  } catch {
    // no slot file: fine for local targets
  }
  return { slot: null, source: 'none', file, sourceLabel: 'nothing' };
}

export class SlotError extends Error {
  override readonly name = 'SlotError';
}

/** The message for a slot that is not one lowercase letter. */
export function badSlotMessage(resolution: SlotResolution): string {
  return `the slot must be one lowercase letter (from --slot, ${ENV.SLOT} or ${resolution.file}); got "${resolution.slot}" from ${resolution.sourceLabel}`;
}

/** The message for a remote target with no slot: the exact "no slot for <target>" pattern tests look for. */
export function noSlotMessage(target: string, resolution: SlotResolution): string {
  return `no slot for ${target}: pass --slot <letter>, or write your letter to ${resolution.file}. Every machine has its own letter, so two runs never share accounts`;
}

export interface CheckSlotOptions {
  target: string;
  /** a `local` target (the demo, the self-tests) defaults to `a` */
  local: boolean;
  /** `health` needs no slot: it touches no account */
  needsNone?: boolean;
}

/** The slot a run uses, or a {@link SlotError} with the exact reason. Checked before any secret is read. */
export function checkSlot(resolution: SlotResolution, options: CheckSlotOptions): { slot: string; source: SlotSource } {
  if (resolution.slot !== null) {
    if (!PATTERNS.slot.test(resolution.slot)) throw new SlotError(badSlotMessage(resolution));
    return { slot: resolution.slot, source: resolution.source };
  }
  if (options.local || options.needsNone) return { slot: DEFAULTS.slot, source: 'default' };
  throw new SlotError(noSlotMessage(options.target, resolution));
}
