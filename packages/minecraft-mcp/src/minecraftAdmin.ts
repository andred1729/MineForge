import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
const MINECRAFT_USERNAME = /^[A-Za-z0-9_]{1,16}$/;

export interface MinecraftAdminPort {
  setCreativeMode(username: string): Promise<void>;
  teleport(username: string, position: { x: number; y: number; z: number }): Promise<void>;
}

export class DockerMinecraftAdmin implements MinecraftAdminPort {
  constructor(private readonly containerName = 'minecraft-agent-server') {}

  async setCreativeMode(username: string): Promise<void> {
    this.assertUsername(username);
    await this.runRcon(['gamemode', 'creative', username]);
  }

  async teleport(username: string, position: { x: number; y: number; z: number }): Promise<void> {
    this.assertUsername(username);
    await this.runRcon(['tp', username, String(position.x), String(position.y), String(position.z)]);
  }

  private assertUsername(username: string): void {
    if (!MINECRAFT_USERNAME.test(username)) {
      throw new Error('Minecraft admin action rejected an invalid bot username.');
    }
  }

  private async runRcon(arguments_: string[]): Promise<void> {
    try {
      await executeFile('docker', ['exec', this.containerName, 'rcon-cli', ...arguments_], {
        timeout: 5_000,
        windowsHide: true,
      });
    } catch (caught) {
      throw new Error('The local Minecraft server rejected the bounded admin action.', { cause: caught });
    }
  }
}
