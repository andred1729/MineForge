import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

const BootstrapStateSchema = z.object({
  agentId: z.string().min(1),
  connectorName: z.string().min(1),
  sessionId: z.string().min(1),
});

export type BootstrapState = z.infer<typeof BootstrapStateSchema>;

const STATE_FILE = 'trueforge-session.json';

export async function loadBootstrapState(directory: string): Promise<BootstrapState | null> {
  try {
    const contents = await readFile(join(directory, STATE_FILE), 'utf8');
    return BootstrapStateSchema.parse(JSON.parse(contents));
  } catch (caught) {
    if (caught instanceof Error && 'code' in caught && caught.code === 'ENOENT') {
      return null;
    }
    throw new Error('Could not read the Minecraft TrueForge state file.', { cause: caught });
  }
}

export async function saveBootstrapState({
  directory,
  state,
}: {
  directory: string;
  state: BootstrapState;
}): Promise<void> {
  await mkdir(directory, { recursive: true });
  const target = join(directory, STATE_FILE);
  const temporary = `${target}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, target);
}
