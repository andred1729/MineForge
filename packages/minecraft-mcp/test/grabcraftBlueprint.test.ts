import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { BlueprintCatalog, importGrabcraftBlueprint } from '../src/grabcraftBlueprint.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async directory => await rm(directory, { recursive: true })));
});

function renderAssignment(
  entries: Array<{ x: number; y: number; z: number; name: string; materialId: string; texture?: string }>,
): string {
  const object: Record<string, Record<string, Record<string, unknown>>> = {};
  for (const entry of entries) {
    object[String(entry.y)] ??= {};
    object[String(entry.y)]![String(entry.x)] ??= {};
    object[String(entry.y)]![String(entry.x)]![String(entry.z)] = {
      x: entry.x,
      y: String(entry.y),
      z: String(entry.z),
      name: entry.name,
      mat_id: entry.materialId,
      texture: entry.texture ?? '',
    };
  }
  return `var myRenderObject = ${JSON.stringify(object)};`;
}

describe('GrabCraft blueprint import', () => {
  it('maps the conservative structural allowlist and records every skipped block', async () => {
    const page = `
      <h1>Test Villa</h1>
      <h3><i></i>Author:&nbsp;Builder<br />Block count:&nbsp;5<br /></h3>
      <script src="https://www.grabcraft.com/js/RenderObject/myRenderObject_1.js"></script>
      <script>var dimX = 4; var dimY = 2; var dimZ = 2; var totalPositions = 2;</script>
    `;
    const render = renderAssignment([
      { x: 1, y: 1, z: 1, name: 'Quartz Block', materialId: '155' },
      { x: 2, y: 1, z: 1, name: 'Oak Leaves (No Decay)', materialId: '18' },
      { x: 3, y: 1, z: 1, name: 'Glass Pane', materialId: '102' },
      { x: 4, y: 1, z: 1, name: 'Grass', materialId: '14', texture: '2_0.png' },
      { x: 1, y: 2, z: 1, name: 'Quartz Stairs (East, Normal)', materialId: '156' },
    ]);
    const fetchImplementation = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      return new Response(url.endsWith('.js') ? render : page, { status: 200 });
    }) as typeof fetch;

    const blueprint = await importGrabcraftBlueprint(
      'https://www.grabcraft.com/minecraft/test-villa/modern-houses',
      fetchImplementation,
    );

    expect(blueprint).toMatchObject({
      id: 'grabcraft-test-villa',
      author: 'Builder',
      sourceBlockCount: 5,
      supportedBlockCount: 4,
      skippedBlockCount: 1,
      dimensions: { x: 4, y: 2, z: 2 },
      materialCounts: { quartz_block: 1, oak_leaves: 1, glass_pane: 1, grass_block: 1 },
    });
    expect(blueprint.blocks.map(block => block.block)).toEqual([
      'quartz_block',
      'oak_leaves',
      'grass_block',
      'glass_pane',
    ]);
    expect(blueprint.skippedMaterials).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          legacyName: 'Quartz Stairs (East, Normal)',
          reason: expect.stringContaining('not supported'),
        }),
      ]),
    );
    expect(blueprint.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('fails closed by skipping mapped blocks with no prior placement support', async () => {
    const page = `
      <h1>Floating Glass</h1><h3>Author:&nbsp;Builder<br />Block count:&nbsp;1<br /></h3>
      <script src="/js/RenderObject/myRenderObject_4.js"></script>
      <script>var dimX = 1; var dimY = 2; var dimZ = 1; var totalPositions = 2;</script>
    `;
    const render = renderAssignment([{ x: 1, y: 2, z: 1, name: 'Glass', materialId: '20' }]);
    const blueprint = await importGrabcraftBlueprint(
      'https://www.grabcraft.com/minecraft/floating-glass/other',
      (async input => new Response(String(input).endsWith('.js') ? render : page)) as typeof fetch,
    );

    expect(blueprint.supportedBlockCount).toBe(0);
    expect(blueprint.skippedBlockCount).toBe(1);
    expect(blueprint.skippedMaterials).toEqual([
      expect.objectContaining({ legacyName: 'Glass', reason: expect.stringContaining('No supported placement face') }),
    ]);
  });

  it('round-trips imported artifacts through a project-owned local catalog', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'minecraft-blueprints-'));
    temporaryDirectories.push(directory);
    const catalog = new BlueprintCatalog(directory);
    const page = `
      <h1>One Block</h1><h3>Author:&nbsp;Builder<br />Block count:&nbsp;1<br /></h3>
      <script src="/js/RenderObject/myRenderObject_2.js"></script>
      <script>var dimX = 1; var dimY = 1; var dimZ = 1; var totalPositions = 1;</script>
    `;
    const render = renderAssignment([{ x: 1, y: 1, z: 1, name: 'Glass', materialId: '20' }]);
    const blueprint = await importGrabcraftBlueprint(
      'https://www.grabcraft.com/minecraft/one-block/other',
      (async input => new Response(String(input).endsWith('.js') ? render : page)) as typeof fetch,
    );

    const filename = await catalog.save(blueprint);

    expect(filename).toContain('grabcraft-one-block.json');
    await expect(catalog.load(blueprint.id)).resolves.toEqual(blueprint);
    await expect(catalog.load('../escape')).rejects.toThrow('unsupported characters');
  });

  it('rejects catalog content tampered after approval without changing its digest', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'minecraft-blueprints-'));
    temporaryDirectories.push(directory);
    const catalog = new BlueprintCatalog(directory);
    const page = `
      <h1>Immutable Block</h1><h3>Author:&nbsp;Builder<br />Block count:&nbsp;1<br /></h3>
      <script src="/js/RenderObject/myRenderObject_3.js"></script>
      <script>var dimX = 1; var dimY = 1; var dimZ = 1; var totalPositions = 1;</script>
    `;
    const render = renderAssignment([{ x: 1, y: 1, z: 1, name: 'Glass', materialId: '20' }]);
    const blueprint = await importGrabcraftBlueprint(
      'https://www.grabcraft.com/minecraft/immutable-block/other',
      (async input => new Response(String(input).endsWith('.js') ? render : page)) as typeof fetch,
    );
    const filename = await catalog.save(blueprint);
    const tampered = JSON.parse(await readFile(filename, 'utf8')) as {
      blocks: Array<{ block: string }>;
      materialCounts: Record<string, number>;
    };
    tampered.blocks[0]!.block = 'quartz_block';
    tampered.materialCounts = { quartz_block: 1 };
    await writeFile(filename, JSON.stringify(tampered));

    await expect(catalog.load(blueprint.id)).rejects.toThrow('could not be loaded');
  });

  it('rejects non-GrabCraft import hosts before fetching', async () => {
    const fetchImplementation = vi.fn() as unknown as typeof fetch;
    await expect(importGrabcraftBlueprint('https://example.com/blueprint', fetchImplementation)).rejects.toThrow(
      'restricted',
    );
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('rejects render URLs outside the exact GrabCraft render path', async () => {
    const page = `
      <h1>Redirect</h1><h3>Author:&nbsp;Builder<br />Block count:&nbsp;1<br /></h3>
      <script src="https://evil.example/js/RenderObject/myRenderObject_1.js"></script>
      <script>var dimX = 1; var dimY = 1; var dimZ = 1; var totalPositions = 1;</script>
    `;
    await expect(
      importGrabcraftBlueprint(
        'https://www.grabcraft.com/minecraft/redirect/other',
        (async () => new Response(page)) as typeof fetch,
      ),
    ).rejects.toThrow('outside the allowed host');
  });

  it('rejects oversized responses before parsing them', async () => {
    const response = new Response('small', { headers: { 'content-length': String(3 * 1024 * 1024) } });
    await expect(
      importGrabcraftBlueprint(
        'https://www.grabcraft.com/minecraft/oversized/other',
        (async () => response) as typeof fetch,
      ),
    ).rejects.toThrow('unexpectedly large');
  });
});
