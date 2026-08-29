import { loadMinecraftConfig } from './config.js';
import { BlueprintCatalog, importGrabcraftBlueprint } from './grabcraftBlueprint.js';

const sourceUrl = process.argv.slice(2).find(argument => argument !== '--');
if (sourceUrl === undefined) {
  throw new Error('Usage: pnpm minecraft:blueprint:import -- <grabcraft-url>');
}

const config = loadMinecraftConfig();
const blueprint = await importGrabcraftBlueprint(sourceUrl);
const filename = await new BlueprintCatalog(config.stateDirectory).save(blueprint);

console.log(`Imported ${blueprint.title} as ${blueprint.id}`);
console.log(
  `${String(blueprint.supportedBlockCount)} supported blocks; ${String(blueprint.skippedBlockCount)} unsupported blocks skipped`,
);
console.log(`Digest: ${blueprint.digest}`);
console.log(`Local artifact: ${filename}`);
