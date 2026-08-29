import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { z } from 'zod';

import { BotRoleSchema } from './botRoles.js';
import { WorkforceCapacityError, type SpawnedBot } from './workforceManager.js';

const SpawnRequestSchema = z.object({
  role: BotRoleSchema.optional(),
  requester_name: z.string().regex(/^[A-Za-z0-9_]{1,16}$/),
  requester_uuid: z.uuid(),
  world_name: z.string().min(1).max(128),
  world_uuid: z.uuid(),
  x: z.coerce.number(),
  y: z.coerce.number(),
  z: z.coerce.number(),
  yaw: z.coerce.number(),
  pitch: z.coerce.number(),
});
export type SpawnRequest = z.infer<typeof SpawnRequestSchema>;

const BotLifecycleRequestSchema = z.object({
  username: z.string().regex(/^ForgeBot[1-5]$/),
});

const MAX_BODY_BYTES = 8_192;
const BODY_TIMEOUT_MS = 5_000;

function authorized(request: IncomingMessage, expectedToken: string): boolean {
  const header = request.headers['x-minecraft-agent-token'];
  if (typeof header !== 'string') {
    return false;
  }
  const supplied = Buffer.from(header);
  const expected = Buffer.from(expectedToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function readForm(request: IncomingMessage): Promise<Record<string, string>> {
  const body = await new Promise<string>((resolve, reject) => {
    let value = '';
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      request.removeListener('data', handleData);
      request.removeListener('end', handleEnd);
      request.removeListener('error', handleError);
      request.removeListener('aborted', handleAborted);
    };
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (error === undefined) {
        resolve(value);
      } else {
        reject(error);
      }
    };
    const handleData = (chunk: string) => {
      value += chunk;
      if (Buffer.byteLength(value) > MAX_BODY_BYTES) {
        request.resume();
        finish(new Error('Spawn request body is too large.'));
      }
    };
    const handleEnd = () => {
      finish();
    };
    const handleError = (caught: Error) => {
      finish(caught);
    };
    const handleAborted = () => {
      finish(new Error('Spawn request was aborted.'));
    };
    const timeout = setTimeout(() => {
      finish(new Error('Spawn request body timed out.'));
    }, BODY_TIMEOUT_MS);
    request.setEncoding('utf8');
    request.on('data', handleData);
    request.once('end', handleEnd);
    request.once('error', handleError);
    request.once('aborted', handleAborted);
  });
  const form = new URLSearchParams(body);
  return Object.fromEntries(form);
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

function writeText(response: ServerResponse, status: number, value: string): void {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  response.end(value);
}

export function startSpawnServer({
  host,
  port,
  token,
  spawn,
  rollback,
  ready,
}: {
  host: string;
  port: number;
  token: string;
  spawn: (request: SpawnRequest) => Promise<SpawnedBot>;
  rollback: (username: string) => Promise<boolean>;
  ready: (username: string) => Promise<boolean>;
}) {
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/healthz') {
      writeJson(response, 200, { status: 'ok' });
      return;
    }
    if (
      request.method !== 'POST' ||
      (request.url !== '/spawn' && request.url !== '/spawn/rollback' && request.url !== '/spawn/ready')
    ) {
      writeJson(response, 404, { error: 'Not found.' });
      return;
    }
    if (!authorized(request, token)) {
      writeJson(response, 401, { error: 'Unauthorized.' });
      return;
    }
    void (async () => {
      try {
        const form = await readForm(request);
        if (request.url === '/spawn/rollback' || request.url === '/spawn/ready') {
          const input = BotLifecycleRequestSchema.parse(form);
          const completed =
            request.url === '/spawn/rollback' ? await rollback(input.username) : await ready(input.username);
          writeText(response, completed ? 204 : 409, '');
          return;
        }
        const input = SpawnRequestSchema.parse(form);
        console.log(
          `Minecraft /spawn${input.role === undefined ? '' : ` ${input.role}`} requested by ${input.requester_name} in ${input.world_name}.`,
        );
        const bot = await spawn(input);
        writeText(response, 201, `${bot.username}:${bot.role}`);
      } catch (caught) {
        if (caught instanceof WorkforceCapacityError) {
          writeText(response, 409, caught.message);
          return;
        }
        if (caught instanceof z.ZodError) {
          writeText(response, 400, 'Invalid spawn request.');
          return;
        }
        console.error('Minecraft spawn request failed', caught);
        writeText(response, 500, 'Could not spawn the Minecraft bot.');
      }
    })();
  });
  server.requestTimeout = BODY_TIMEOUT_MS;
  server.headersTimeout = BODY_TIMEOUT_MS;

  return {
    async listen(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve();
        });
      });
    },
    async close(): Promise<void> {
      if (!server.listening) {
        return;
      }
      await new Promise<void>((resolve, reject) => {
        server.close(error => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      });
    },
    port(): number {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('Minecraft spawn server is not listening on a TCP port.');
      }
      return address.port;
    },
  };
}
