import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const commands = [
  'difficulty peaceful',
  'gamerule keepInventory true',
  'time set day',
  'gamerule doDaylightCycle false',
  'fill 2 64 0 34 64 32 grass_block',
  'fill 2 65 0 34 80 32 air',
  'execute positioned 18 65 16 run kill @e[type=item,distance=..48]',
];

export async function prepareBlueprintFixture(): Promise<void> {
  for (const command of commands) {
    try {
      await execFileAsync('docker', ['exec', 'minecraft-agent-server', 'rcon-cli', command]);
    } catch (caught) {
      throw new Error(`Minecraft blueprint fixture command failed: ${command}`, { cause: caught });
    }
  }
  console.log('Complex blueprint site is ready. Use corner origin 2,64,0 and a 32-block plan radius.');
}

void prepareBlueprintFixture().catch((caught: unknown) => {
  console.error(caught);
  process.exitCode = 1;
});
