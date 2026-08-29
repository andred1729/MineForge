import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { BotIdentitySchema } from './botRoles.js';

export const WorkforceBotRecordSchema = BotIdentitySchema.extend({
  agentId: z.string().min(1),
  sessionId: z.string().min(1),
});
export type WorkforceBotRecord = z.infer<typeof WorkforceBotRecordSchema>;

export const WorkforceStateSchema = z.object({
  version: z.literal(1),
  nextOrdinal: z.number().int().min(1).max(6),
  bots: z.array(WorkforceBotRecordSchema).max(5),
  pendingSessionDeletes: z.array(z.string().min(1)).default([]),
});
export type WorkforceState = z.infer<typeof WorkforceStateSchema>;

const STATE_FILE = 'minecraft-workforce.json';

export function emptyWorkforceState(): WorkforceState {
  return { version: 1, nextOrdinal: 1, bots: [], pendingSessionDeletes: [] };
}

export async function loadWorkforceState(directory: string): Promise<WorkforceState> {
  try {
    const contents = await readFile(join(directory, STATE_FILE), 'utf8');
    return WorkforceStateSchema.parse(JSON.parse(contents));
  } catch (caught) {
    if (caught instanceof Error && 'code' in caught && caught.code === 'ENOENT') {
      return emptyWorkforceState();
    }
    throw new Error('Could not read the Minecraft workforce state file.', { cause: caught });
  }
}

export async function saveWorkforceState({
  directory,
  state,
}: {
  directory: string;
  state: WorkforceState;
}): Promise<void> {
  const parsed = WorkforceStateSchema.parse(state);
  await mkdir(directory, { recursive: true });
  const target = join(directory, STATE_FILE);
  const temporary = `${target}.tmp`;
  await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, target);
}
