# Minecraft MCP bridge

## Small Modern Villa demo

The complex-build demo imports GrabCraft's [Small Modern Villa](https://www.grabcraft.com/minecraft/small-modern-villa/modern-houses) into the local, gitignored `.data/blueprints` directory:

```sh
pnpm minecraft:blueprint:import 'https://www.grabcraft.com/minecraft/small-modern-villa/modern-houses'
pnpm minecraft:blueprint:fixture
```

The importer discovers and validates the page's machine-readable render data. It never evaluates remote JavaScript. The normalized artifact records its source, author, dimensions, supported material bill, skipped materials, and an immutable digest.

The demo builds the 1,430 orientation-independent structure, glazing, and hedge blocks. It intentionally skips landscaping supplied by the prepared flat site and blocks that need exact facing, half, fluid, or multiblock placement. The skipped list is visible through `inspect_blueprint` before approval.

Use blueprint id `grabcraft-small-modern-villa`. The fixture centers ForgeBot around `64,100,0`, prepares a build site, provisions the exact supported material bill, and uses corner origin `48,100,-16`. ForgeBot alone is placed in creative mode so it can fly to upper placements; the world and human players remain in survival. Every villa block is still placed and verified through Mineflayer.

TrueForge approves an immutable binding containing the blueprint id, digest, and origin once. The agent then calls `execute_blueprint_batch` from batch zero through completion. Repeating a partially completed batch is safe because the bridge checks the live block at every target.

No extracted GrabCraft blueprint is committed to this repository. Re-run the import command when preparing a new local demo environment.
