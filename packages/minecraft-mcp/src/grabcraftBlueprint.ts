import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

const GRABCRAFT_HOST = 'www.grabcraft.com';
const GRABCRAFT_ORIGIN = `https://${GRABCRAFT_HOST}`;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_RENDER_BYTES = 32 * 1024 * 1024;
const IMPORT_TIMEOUT_MS = 15_000;

const SupportedBlockNameSchema = z.enum([
  'birch_planks',
  'cobblestone',
  'crafting_table',
  'dirt',
  'glass',
  'glass_pane',
  'grass_block',
  'gray_wool',
  'jungle_planks',
  'oak_fence',
  'oak_leaves',
  'oak_planks',
  'quartz_block',
]);

const SupportedBlockSchema = z.object({
  dx: z.number().int().min(0),
  dy: z.number().int().min(0),
  dz: z.number().int().min(0),
  block: SupportedBlockNameSchema,
  legacyName: z.string().min(1),
  phase: z.enum(['structure', 'connection', 'plant']),
});

const SkippedMaterialSchema = z.object({
  legacyName: z.string().min(1),
  materialId: z.string(),
  count: z.number().int().positive(),
  reason: z.string().min(1),
});

export const ImportedBlueprintSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(/^[a-z0-9-]+$/),
    title: z.string().min(1),
    author: z.string().min(1),
    sourceUrl: z.url(),
    renderUrl: z.url(),
    fetchedAt: z.iso.datetime(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    dimensions: z.object({
      x: z.number().int().min(1).max(32),
      y: z.number().int().min(1).max(16),
      z: z.number().int().min(1).max(32),
    }),
    sourceBlockCount: z.number().int().positive(),
    supportedBlockCount: z.number().int().nonnegative(),
    skippedBlockCount: z.number().int().nonnegative(),
    materialCounts: z.record(z.string(), z.number().int().nonnegative()),
    layerCounts: z.record(z.string(), z.number().int().nonnegative()),
    skippedMaterials: z.array(SkippedMaterialSchema),
    blocks: z.array(SupportedBlockSchema),
  })
  .superRefine((blueprint, context) => {
    const coordinates = new Set<string>();
    const materialCounts: Record<string, number> = {};
    const layerCounts: Record<string, number> = {};
    for (const block of blueprint.blocks) {
      if (
        block.dx >= blueprint.dimensions.x ||
        block.dy >= blueprint.dimensions.y ||
        block.dz >= blueprint.dimensions.z
      ) {
        context.addIssue({ code: 'custom', path: ['blocks'], message: 'Block lies outside blueprint dimensions.' });
      }
      const coordinate = coordinateKey(block);
      if (coordinates.has(coordinate)) {
        context.addIssue({ code: 'custom', path: ['blocks'], message: `Duplicate block coordinate ${coordinate}.` });
      }
      coordinates.add(coordinate);
      materialCounts[block.block] = (materialCounts[block.block] ?? 0) + 1;
      const layer = String(block.dy + 1);
      layerCounts[layer] = (layerCounts[layer] ?? 0) + 1;
    }
    const skippedCount = blueprint.skippedMaterials.reduce((total, material) => total + material.count, 0);
    if (
      blueprint.supportedBlockCount !== blueprint.blocks.length ||
      blueprint.skippedBlockCount !== skippedCount ||
      blueprint.sourceBlockCount !== blueprint.blocks.length + skippedCount ||
      JSON.stringify(blueprint.materialCounts) !== JSON.stringify(materialCounts) ||
      JSON.stringify(blueprint.layerCounts) !== JSON.stringify(layerCounts)
    ) {
      context.addIssue({ code: 'custom', message: 'Blueprint derived counts do not match its operations.' });
    }
    if (blueprint.digest !== computeImportedBlueprintDigest(blueprint)) {
      context.addIssue({ code: 'custom', path: ['digest'], message: 'Blueprint digest does not match its contents.' });
    }
  });

export type ImportedBlueprint = z.infer<typeof ImportedBlueprintSchema>;
export type ImportedBlueprintBlock = z.infer<typeof SupportedBlockSchema>;

function coordinateKey(block: Pick<ImportedBlueprintBlock, 'dx' | 'dy' | 'dz'>): string {
  return `${String(block.dx)},${String(block.dy)},${String(block.dz)}`;
}

export function computeImportedBlueprintDigest(
  blueprint: Omit<ImportedBlueprint, 'digest' | 'fetchedAt' | 'materialCounts' | 'layerCounts' | 'supportedBlockCount'>,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        schemaVersion: blueprint.schemaVersion,
        id: blueprint.id,
        title: blueprint.title,
        author: blueprint.author,
        sourceUrl: blueprint.sourceUrl,
        renderUrl: blueprint.renderUrl,
        dimensions: blueprint.dimensions,
        sourceBlockCount: blueprint.sourceBlockCount,
        skippedBlockCount: blueprint.skippedBlockCount,
        skippedMaterials: blueprint.skippedMaterials,
        blocks: blueprint.blocks,
      }),
    )
    .digest('hex');
}

interface LegacyBlock {
  x: number;
  y: number;
  z: number;
  name: string;
  materialId: string;
  texture: string;
}

interface SupportedMapping {
  block: z.infer<typeof SupportedBlockNameSchema>;
  phase: ImportedBlueprintBlock['phase'];
}

interface MappedCandidate extends ImportedBlueprintBlock {
  materialId: string;
}

const SIMPLE_BLOCKS = new Map<string, SupportedMapping>([
  ['Quartz Block', { block: 'quartz_block', phase: 'structure' }],
  ['Oak Leaves (No Decay)', { block: 'oak_leaves', phase: 'structure' }],
  ['Oak Leaves (No Decay and Check Decay)', { block: 'oak_leaves', phase: 'structure' }],
  ['Dirt', { block: 'dirt', phase: 'structure' }],
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
    return block.materialId === '14' ? { block: 'grass_block', phase: 'structure' } : null;
  }
  return SIMPLE_BLOCKS.get(block.name) ?? null;
}

function skipReasonFor(block: LegacyBlock): string {
  if (block.name === 'Grass' || ['Azure Bluet', 'Oxeye Daisy', 'Poppy', 'Dandelion'].includes(block.name)) {
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

async function readResponseText(response: Response, maximumBytes: number, label: string): Promise<string> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && Number.parseInt(declaredLength, 10) > maximumBytes) {
    throw new Error(`${label} is unexpectedly large.`);
  }
  if (response.body === null) {
    return '';
  }
  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) {
      break;
    }
    const value = result.value;
    bytes += value.byteLength;
    if (bytes > maximumBytes) {
      await reader.cancel();
      throw new Error(`${label} is unexpectedly large.`);
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

function assertResponseUrl(response: Response, expectedUrl: URL, label: string): void {
  if (response.url !== '' && response.url !== expectedUrl.toString()) {
    throw new Error(`${label} redirected outside its exact allowed URL.`);
  }
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

function compareCandidates(left: ImportedBlueprintBlock, right: ImportedBlueprintBlock): number {
  return (
    left.dy - right.dy ||
    phaseOrder(left.phase) - phaseOrder(right.phase) ||
    left.dx - right.dx ||
    (left.dx % 2 === 0 ? left.dz - right.dz : right.dz - left.dz)
  );
}

function addSkipped(
  skipped: Map<string, z.infer<typeof SkippedMaterialSchema>>,
  block: Pick<LegacyBlock, 'name' | 'materialId'>,
  reason: string,
): void {
  const key = `${block.name}\u0000${block.materialId}\u0000${reason}`;
  const current = skipped.get(key);
  skipped.set(key, {
    legacyName: block.name,
    materialId: block.materialId,
    count: (current?.count ?? 0) + 1,
    reason,
  });
}

function hasPlacementSupport(block: ImportedBlueprintBlock, placed: ReadonlySet<string>): boolean {
  if (block.dy === 0) {
    return true;
  }
  const neighbors = [
    { dx: block.dx, dy: block.dy - 1, dz: block.dz },
    { dx: block.dx - 1, dy: block.dy, dz: block.dz },
    { dx: block.dx + 1, dy: block.dy, dz: block.dz },
    { dx: block.dx, dy: block.dy, dz: block.dz - 1 },
    { dx: block.dx, dy: block.dy, dz: block.dz + 1 },
  ];
  return neighbors.some(neighbor => placed.has(coordinateKey(neighbor)));
}

function scheduleSupportedBlocks({
  candidates,
  skipped,
}: {
  candidates: MappedCandidate[];
  skipped: Map<string, z.infer<typeof SkippedMaterialSchema>>;
}): ImportedBlueprintBlock[] {
  const placed = new Set<string>();
  const scheduled: ImportedBlueprintBlock[] = [];
  const layers = new Map<number, MappedCandidate[]>();
  for (const candidate of candidates) {
    const layer = layers.get(candidate.dy) ?? [];
    layer.push(candidate);
    layers.set(candidate.dy, layer);
  }

  for (const dy of [...layers.keys()].sort((left, right) => left - right)) {
    let pending = [...(layers.get(dy) ?? [])].sort(compareCandidates);
    while (pending.length > 0) {
      const deferred: MappedCandidate[] = [];
      let progress = 0;
      for (const candidate of pending) {
        if (!hasPlacementSupport(candidate, placed)) {
          deferred.push(candidate);
          continue;
        }
        const block: ImportedBlueprintBlock = {
          dx: candidate.dx,
          dy: candidate.dy,
          dz: candidate.dz,
          block: candidate.block,
          legacyName: candidate.legacyName,
          phase: candidate.phase,
        };
        scheduled.push(block);
        placed.add(coordinateKey(block));
        progress += 1;
      }
      if (progress === 0) {
        for (const candidate of deferred) {
          addSkipped(
            skipped,
            { name: candidate.legacyName, materialId: candidate.materialId },
            'No supported placement face is reachable in the conservative build order.',
          );
        }
        break;
      }
      pending = deferred;
    }
  }
  return scheduled;
}

export async function importGrabcraftBlueprint(
  sourceUrl: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<ImportedBlueprint> {
  const source = new URL(sourceUrl);
  if (
    source.origin !== GRABCRAFT_ORIGIN ||
    source.username !== '' ||
    source.password !== '' ||
    !/^\/minecraft\/[a-z0-9-]+\/[a-z0-9-]+\/?$/.test(source.pathname)
  ) {
    throw new Error(`Blueprint imports are restricted to https://${GRABCRAFT_HOST}/ pages.`);
  }
  source.hash = '';
  source.search = '';

  const pageResponse = await fetchImplementation(source, {
    redirect: 'error',
    signal: AbortSignal.timeout(IMPORT_TIMEOUT_MS),
  });
  if (!pageResponse.ok) {
    throw new Error(`GrabCraft page returned HTTP ${String(pageResponse.status)}.`);
  }
  assertResponseUrl(pageResponse, source, 'GrabCraft page');
  const html = await readResponseText(pageResponse, MAX_PAGE_BYTES, 'GrabCraft page');
  const renderPath = matchRequired(
    html,
    /<script\s+src=["']([^"']*\/js\/RenderObject\/myRenderObject_\d+\.js)["']/i,
    'render data',
  );
  const renderSourceUrl = new URL(renderPath, source);
  if (
    renderSourceUrl.origin !== GRABCRAFT_ORIGIN ||
    !/^\/js\/RenderObject\/myRenderObject_\d+\.js$/.test(renderSourceUrl.pathname) ||
    renderSourceUrl.search !== '' ||
    renderSourceUrl.hash !== ''
  ) {
    throw new Error('GrabCraft render data points outside the allowed host.');
  }
  const renderUrl = renderSourceUrl.toString();
  const renderResponse = await fetchImplementation(renderSourceUrl, {
    redirect: 'error',
    signal: AbortSignal.timeout(IMPORT_TIMEOUT_MS),
  });
  if (!renderResponse.ok) {
    throw new Error(`GrabCraft render data returned HTTP ${String(renderResponse.status)}.`);
  }
  assertResponseUrl(renderResponse, renderSourceUrl, 'GrabCraft render data');
  const renderSource = await readResponseText(renderResponse, MAX_RENDER_BYTES, 'GrabCraft render data');
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

  const candidates: MappedCandidate[] = [];
  const skipped = new Map<string, z.infer<typeof SkippedMaterialSchema>>();
  for (const legacy of legacyBlocks) {
    const mapping = mappingFor(legacy);
    if (mapping === null) {
      addSkipped(skipped, legacy, skipReasonFor(legacy));
      continue;
    }
    candidates.push({
      dx: legacy.x - 1,
      dy: legacy.y - 1,
      dz: legacy.z - 1,
      block: mapping.block,
      legacyName: legacy.name,
      phase: mapping.phase,
      materialId: legacy.materialId,
    });
  }
  const blocks = scheduleSupportedBlocks({ candidates, skipped });

  const materialCounts: Record<string, number> = {};
  const layerCounts: Record<string, number> = {};
  for (const block of blocks) {
    materialCounts[block.block] = (materialCounts[block.block] ?? 0) + 1;
    const layer = String(block.dy + 1);
    layerCounts[layer] = (layerCounts[layer] ?? 0) + 1;
  }
  const skippedMaterials = [...skipped.values()].sort(
    (left, right) =>
      right.count - left.count ||
      left.legacyName.localeCompare(right.legacyName) ||
      left.materialId.localeCompare(right.materialId),
  );
  const immutable = {
    schemaVersion: 1,
    id: `grabcraft-${slugify(title)}`,
    title,
    author,
    sourceUrl: source.toString(),
    renderUrl,
    dimensions,
    sourceBlockCount: legacyBlocks.length,
    skippedBlockCount: legacyBlocks.length - blocks.length,
    skippedMaterials,
    blocks,
  } as const;

  return ImportedBlueprintSchema.parse({
    ...immutable,
    fetchedAt: new Date().toISOString(),
    digest: computeImportedBlueprintDigest(immutable),
    supportedBlockCount: blocks.length,
    materialCounts,
    layerCounts,
  });
}

export class BlueprintCatalog {
  private readonly directory: string;

  constructor(stateDirectory: string) {
    this.directory = path.join(stateDirectory, 'blueprints');
  }

  async save(blueprint: ImportedBlueprint): Promise<string> {
    const validated = ImportedBlueprintSchema.parse(blueprint);
    await mkdir(this.directory, { recursive: true });
    const filename = path.join(this.directory, `${validated.id}.json`);
    await writeFile(filename, `${JSON.stringify(validated, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    return filename;
  }

  async load(blueprintId: string): Promise<ImportedBlueprint> {
    if (!/^[a-z0-9-]+$/.test(blueprintId)) {
      throw new Error('Blueprint id contains unsupported characters.');
    }
    try {
      const blueprint = ImportedBlueprintSchema.parse(
        JSON.parse(await readFile(path.join(this.directory, `${blueprintId}.json`), 'utf8')),
      );
      if (blueprint.id !== blueprintId) {
        throw new Error('Blueprint id does not match its catalog filename.');
      }
      return blueprint;
    } catch (caught) {
      if (caught instanceof Error && 'code' in caught && caught.code === 'ENOENT') {
        throw new Error(`Blueprint ${blueprintId} is not imported.`, { cause: caught });
      }
      throw new Error(`Blueprint ${blueprintId} could not be loaded.`, { cause: caught });
    }
  }
}
