import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const commands = [
  'difficulty peaceful',
  'gamerule keepInventory true',
  'time set day',
  'gamerule doDaylightCycle false',
  'fill 46 99 -18 81 99 17 grass_block',
  'fill 46 100 -18 81 115 17 air',
  'execute positioned 64 100 0 run kill @e[type=item,distance=..48]',
  'gamemode creative ForgeBot',
  'tp ForgeBot 64.5 100 0.5',
  'clear ForgeBot',
  'give ForgeBot quartz_block 64',
  'give ForgeBot oak_leaves 64',
  'give ForgeBot cobblestone 64',
  'give ForgeBot birch_planks 64',
  'give ForgeBot glass 64',
  'give ForgeBot gray_wool 64',
  'give ForgeBot oak_planks 64',
  'give ForgeBot glass_pane 64',
  'give ForgeBot grass_block 64',
  'give ForgeBot dirt 64',
  'give ForgeBot oak_fence 10',
  'give ForgeBot jungle_planks 3',
  'give ForgeBot crafting_table 1',
];

export async function prepareBlueprintFixture(): Promise<void> {
  for (const command of commands) {
    try {
      await execFileAsync('docker', ['exec', 'minecraft-agent-server', 'rcon-cli', command]);
    } catch (caught) {
      throw new Error(`Minecraft blueprint fixture command failed: ${command}`, { cause: caught });
    }
  }
  console.log('Complex blueprint site is ready. Use corner origin 48,100,-16 and a 32-block plan radius.');
}

void prepareBlueprintFixture().catch((caught: unknown) => {
  console.error(caught);
  process.exitCode = 1;
});
