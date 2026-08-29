import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

const GRABCRAFT_HOST = 'www.grabcraft.com';
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_RENDER_BYTES = 32 * 1024 * 1024;

const SupportedBlockSchema = z.object({
  dx: z.number().int().min(0),
  dy: z.number().int().min(0),
  dz: z.number().int().min(0),
  block: z.string().min(1),
  legacyName: z.string().min(1),
  phase: z.enum(['structure', 'connection', 'plant']),
});

const SkippedMaterialSchema = z.object({
  legacyName: z.string().min(1),
  materialId: z.string(),
  count: z.number().int().positive(),
  reason: z.string().min(1),
});

export const ImportedBlueprintSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  title: z.string().min(1),
  author: z.string().min(1),
  sourceUrl: z.url(),
  renderUrl: z.url(),
  fetchedAt: z.iso.datetime(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  dimensions: z.object({
    x: z.number().int().positive(),
    y: z.number().int().positive(),
    z: z.number().int().positive(),
  }),
  sourceBlockCount: z.number().int().positive(),
  supportedBlockCount: z.number().int().nonnegative(),
  skippedBlockCount: z.number().int().nonnegative(),
  materialCounts: z.record(z.string(), z.number().int().nonnegative()),
  layerCounts: z.record(z.string(), z.number().int().nonnegative()),
  skippedMaterials: z.array(SkippedMaterialSchema),
  blocks: z.array(SupportedBlockSchema),
});

export type ImportedBlueprint = z.infer<typeof ImportedBlueprintSchema>;
export type ImportedBlueprintBlock = z.infer<typeof SupportedBlockSchema>;

interface LegacyBlock {
  x: number;
  y: number;
  z: number;
  name: string;
  materialId: string;
  texture: string;
}

interface SupportedMapping {
  block: string;
  phase: ImportedBlueprintBlock['phase'];
}

const SIMPLE_BLOCKS = new Map<string, SupportedMapping>([
  ['Quartz Block', { block: 'quartz_block', phase: 'structure' }],
  ['Oak Leaves (No Decay)', { block: 'oak_leaves', phase: 'structure' }],
  ['Oak Leaves (No Decay and Check Decay)', { block: 'oak_leaves', phase: 'structure' }],
  ['Cobblestone', { block: 'cobblestone', phase: 'structure' }],
  ['Birch Wood Plank', { block: 'birch_planks', phase: 'structure' }],
  ['Glass', { block: 'glass', phase: 'structure' }],
  ['Gray Wool', { block: 'gray_wool', phase: 'structure' }],
  ['Oak Wood Plank', { block: 'oak_planks', phase: 'structure' }],
  ['Glass Pane', { block: 'glass_pane', phase: 'connection' }],
  ['Oak Fence', { block: 'oak_fence', phase: 'connection' }],
  ['Jungle Wood Plank', { block: 'jungle_planks', phase: 'structure' }],
  ['Crafting Table', { block: 'crafting_table', phase: 'structure' }],
]);

function mappingFor(block: LegacyBlock): SupportedMapping | null {
  if (block.name === 'Grass') {
    return null;
  }
  return SIMPLE_BLOCKS.get(block.name) ?? null;
}

function skipReasonFor(block: LegacyBlock): string {
  if (
    block.name === 'Grass' ||
    block.name === 'Dirt' ||
    ['Azure Bluet', 'Oxeye Daisy', 'Poppy', 'Dandelion'].includes(block.name)
  ) {
    return 'Landscaping is replaced by the prepared flat demo site.';
  }
  return 'Exact placement state is not supported by the demo builder.';
}

function matchRequired(source: string, expression: RegExp, label: string): string {
  const match = expression.exec(source)?.[1];
  if (match === undefined) {
    throw new Error(`GrabCraft page did not expose ${label}.`);
  }
  return match;
}

function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`GrabCraft ${label} is invalid.`);
  }
  return parsed;
}

function textFromHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, '')
    .replaceAll('&nbsp;', ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseLegacyBlocks(source: string): LegacyBlock[] {
  const assignment = /^\s*var\s+myRenderObject\s*=\s*([\s\S]*?)\s*;?\s*$/.exec(source)?.[1];
  if (assignment === undefined) {
    throw new Error('GrabCraft render data is not a myRenderObject assignment.');
  }

  const raw = z.record(z.string(), z.unknown()).parse(JSON.parse(assignment));
  const blocks: LegacyBlock[] = [];
  const coordinates = new Set<string>();
  for (const [layerKey, layer] of Object.entries(raw)) {
    const columns = z.record(z.string(), z.unknown()).parse(layer);
    for (const [columnKey, column] of Object.entries(columns)) {
      const cells = z.record(z.string(), z.unknown()).parse(column);
      for (const [cellKey, value] of Object.entries(cells)) {
        const parsed = z
          .object({
            x: z.coerce.number().int().positive(),
            y: z.coerce.number().int().positive(),
            z: z.coerce.number().int().positive(),
            name: z.string().min(1),
            mat_id: z.coerce.string(),
            texture: z.string().default(''),
          })
          .parse(value);
        if (String(parsed.y) !== layerKey || String(parsed.x) !== columnKey || String(parsed.z) !== cellKey) {
          throw new Error('GrabCraft render keys do not match their block coordinates.');
        }
        const coordinate = `${String(parsed.x)},${String(parsed.y)},${String(parsed.z)}`;
        if (coordinates.has(coordinate)) {
          throw new Error(`GrabCraft render data repeats coordinate ${coordinate}.`);
        }
        coordinates.add(coordinate);
        blocks.push({
          x: parsed.x,
          y: parsed.y,
          z: parsed.z,
          name: parsed.name.trim(),
          materialId: parsed.mat_id,
          texture: parsed.texture,
        });
      }
    }
  }
  return blocks;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function phaseOrder(phase: ImportedBlueprintBlock['phase']): number {
  return phase === 'structure' ? 0 : phase === 'connection' ? 1 : 2;
}

export async function importGrabcraftBlueprint(
  sourceUrl: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<ImportedBlueprint> {
  const source = new URL(sourceUrl);
  if (source.protocol !== 'https:' || source.hostname !== GRABCRAFT_HOST) {
    throw new Error(`Blueprint imports are restricted to https://${GRABCRAFT_HOST}/ pages.`);
  }

  const pageResponse = await fetchImplementation(source);
  if (!pageResponse.ok) {
    throw new Error(`GrabCraft page returned HTTP ${String(pageResponse.status)}.`);
  }
  const html = await pageResponse.text();
  if (Buffer.byteLength(html) > MAX_PAGE_BYTES) {
    throw new Error('GrabCraft page is unexpectedly large.');
  }
  const renderPath = matchRequired(
    html,
    /<script\s+src=["']([^"']*\/js\/RenderObject\/myRenderObject_\d+\.js)["']/i,
    'render data',
  );
  const renderSourceUrl = new URL(renderPath, source);
  if (renderSourceUrl.protocol !== 'https:' || renderSourceUrl.hostname !== GRABCRAFT_HOST) {
    throw new Error('GrabCraft render data points outside the allowed host.');
  }
  const renderUrl = renderSourceUrl.toString();
  const renderResponse = await fetchImplementation(renderUrl);
  if (!renderResponse.ok) {
    throw new Error(`GrabCraft render data returned HTTP ${String(renderResponse.status)}.`);
  }
  const renderSource = await renderResponse.text();
  if (Buffer.byteLength(renderSource) > MAX_RENDER_BYTES) {
    throw new Error('GrabCraft render data is unexpectedly large.');
  }
  const legacyBlocks = parseLegacyBlocks(renderSource);

  const dimensions = {
    x: parsePositiveInteger(matchRequired(html, /var\s+dimX\s*=\s*(\d+)/, 'width'), 'width'),
    y: parsePositiveInteger(matchRequired(html, /var\s+dimY\s*=\s*(\d+)/, 'height'), 'height'),
    z: parsePositiveInteger(matchRequired(html, /var\s+dimZ\s*=\s*(\d+)/, 'depth'), 'depth'),
  };
  const declaredBlockCount = parsePositiveInteger(
    matchRequired(html, /Block count:(?:&nbsp;|\s)*(\d+)/i, 'block count'),
    'block count',
  );
  const declaredLayers = parsePositiveInteger(
    matchRequired(html, /var\s+totalPositions\s*=\s*(\d+)/, 'layer count'),
    'layer count',
  );
  const title = textFromHtml(matchRequired(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i, 'title'));
  const author = textFromHtml(matchRequired(html, /Author:(?:&nbsp;|\s)*([^<\r\n]+)/i, 'author'));

  if (legacyBlocks.length !== declaredBlockCount) {
    throw new Error(
      `GrabCraft declared ${String(declaredBlockCount)} blocks but render data contains ${String(legacyBlocks.length)}.`,
    );
  }
  if (declaredLayers !== dimensions.y) {
    throw new Error(`GrabCraft declared ${String(declaredLayers)} layers for height ${String(dimensions.y)}.`);
  }
  if (dimensions.x * dimensions.y * dimensions.z > 100_000) {
    throw new Error('GrabCraft blueprint volume exceeds the demo importer limit.');
  }

  for (const block of legacyBlocks) {
    if (block.x > dimensions.x || block.y > dimensions.y || block.z > dimensions.z) {
      throw new Error(`GrabCraft block ${String(block.x)},${String(block.y)},${String(block.z)} exceeds dimensions.`);
    }
  }

  const blocks: ImportedBlueprintBlock[] = [];
  const skipped = new Map<string, z.infer<typeof SkippedMaterialSchema>>();
  for (const legacy of legacyBlocks) {
    const mapping = mappingFor(legacy);
    if (mapping === null) {
      const key = `${legacy.name}\u0000${legacy.materialId}`;
      const current = skipped.get(key);
      skipped.set(key, {
        legacyName: legacy.name,
        materialId: legacy.materialId,
        count: (current?.count ?? 0) + 1,
        reason: skipReasonFor(legacy),
      });
      continue;
    }
    blocks.push({
      dx: legacy.x - 1,
      dy: legacy.y - 1,
      dz: legacy.z - 1,
      block: mapping.block,
      legacyName: legacy.name,
      phase: mapping.phase,
    });
  }
  blocks.sort(
    (left, right) =>
      left.dy - right.dy ||
      phaseOrder(left.phase) - phaseOrder(right.phase) ||
      left.dx - right.dx ||
      (left.dx % 2 === 0 ? left.dz - right.dz : right.dz - left.dz),
  );

  const materialCounts: Record<string, number> = {};
  const layerCounts: Record<string, number> = {};
  for (const block of blocks) {
    materialCounts[block.block] = (materialCounts[block.block] ?? 0) + 1;
    const layer = String(block.dy + 1);
    layerCounts[layer] = (layerCounts[layer] ?? 0) + 1;
  }
  const digest = createHash('sha256')
    .update(JSON.stringify({ sourceUrl: source.toString(), dimensions, blocks }))
    .digest('hex');

  return ImportedBlueprintSchema.parse({
    schemaVersion: 1,
    id: `grabcraft-${slugify(title)}`,
    title,
    author,
    sourceUrl: source.toString(),
    renderUrl,
    fetchedAt: new Date().toISOString(),
    digest,
    dimensions,
    sourceBlockCount: legacyBlocks.length,
    supportedBlockCount: blocks.length,
    skippedBlockCount: legacyBlocks.length - blocks.length,
    materialCounts,
    layerCounts,
    skippedMaterials: [...skipped.values()].sort((left, right) => right.count - left.count),
    blocks,
  });
}

export class BlueprintCatalog {
  private readonly directory: string;

  constructor(stateDirectory: string) {
    this.directory = path.join(stateDirectory, 'blueprints');
  }

  async save(blueprint: ImportedBlueprint): Promise<string> {
    await mkdir(this.directory, { recursive: true });
    const filename = path.join(this.directory, `${blueprint.id}.json`);
    await writeFile(filename, `${JSON.stringify(blueprint, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    return filename;
  }

  async load(blueprintId: string): Promise<ImportedBlueprint> {
    if (!/^[a-z0-9-]+$/.test(blueprintId)) {
      throw new Error('Blueprint id contains unsupported characters.');
    }
    try {
      return ImportedBlueprintSchema.parse(
        JSON.parse(await readFile(path.join(this.directory, `${blueprintId}.json`), 'utf8')),
      );
    } catch (caught) {
      if (caught instanceof Error && 'code' in caught && caught.code === 'ENOENT') {
        throw new Error(`Blueprint ${blueprintId} is not imported.`, { cause: caught });
      }
      throw new Error(`Blueprint ${blueprintId} could not be loaded.`, { cause: caught });
    }
  }
}
