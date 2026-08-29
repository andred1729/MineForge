import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const commands = [
  'gamerule keepInventory true',
  'time set day',
  'gamerule doDaylightCycle false',
  'fill -8 99 -8 8 99 8 grass_block',
  'fill -8 100 -8 8 107 8 air',
  'fill 6 100 -2 6 105 2 oak_log',
  'tp ForgeBot 0 100 0',
  'clear ForgeBot',
  'give ForgeBot wooden_axe 1',
];

export async function prepareFixture(): Promise<void> {
  for (const command of commands) {
    try {
      await execFileAsync('docker', ['exec', 'minecraft-agent-server', 'rcon-cli', command]);
    } catch (caught) {
      throw new Error(`Minecraft fixture command failed: ${command}`, { cause: caught });
    }
  }
  console.log('Minecraft demo fixture is ready around 0, 100, 0.');
}

void prepareFixture().catch((caught: unknown) => {
  console.error(caught);
  process.exitCode = 1;
});
