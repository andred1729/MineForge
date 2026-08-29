import { createServer } from 'node:net';

import { describe, expect, it } from 'vitest';

import { isTcpPortAvailable } from '../src/mineflayerBot.js';

describe('Prismarine viewer port', () => {
  it('reports an occupied port without throwing and becomes available after release', async () => {
    const owner = createServer();
    await new Promise<void>((resolve, reject) => {
      owner.once('error', reject);
      owner.listen(0, () => {
        owner.off('error', reject);
        resolve();
      });
    });
    const address = owner.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Test server did not bind to a TCP port.');
    }

    expect(await isTcpPortAvailable(address.port)).toBe(false);
    await new Promise<void>((resolve, reject) => {
      owner.close(error => {
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      });
    });
    expect(await isTcpPortAvailable(address.port)).toBe(true);
  });
});
