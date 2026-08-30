package com.minecraftagent.spawn;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.EnumSet;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import org.bukkit.Bukkit;
import org.bukkit.HeightMap;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.World;
import org.bukkit.block.Block;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.Player;
import org.bukkit.event.player.PlayerTeleportEvent;
import org.bukkit.inventory.ItemStack;
import org.bukkit.plugin.java.JavaPlugin;

public final class MinecraftAgentSpawnPlugin extends JavaPlugin {
  private static final Set<Material> NATURAL_SURFACE =
      EnumSet.of(
          Material.GRASS_BLOCK,
          Material.DIRT,
          Material.COARSE_DIRT,
          Material.PODZOL,
          Material.MYCELIUM,
          Material.MOSS_BLOCK,
          Material.MUD,
          Material.STONE,
          Material.ANDESITE,
          Material.DIORITE,
          Material.GRANITE,
          Material.DEEPSLATE,
          Material.SAND,
          Material.RED_SAND,
          Material.GRAVEL,
          Material.SNOW_BLOCK);
  private static final int MAX_SEARCH_RADIUS = 24;

  private HttpClient httpClient;
  private URI spawnEndpoint;
  private String spawnToken;
  private String botSkin;
  private final AtomicBoolean spawnInFlight = new AtomicBoolean();

  @Override
  public void onEnable() {
    spawnEndpoint =
        URI.create(
            environment("MINECRAFT_SPAWN_URL", "http://host.docker.internal:8793/spawn"));
    spawnToken = environment("MINECRAFT_SPAWN_TOKEN", "minecraft-agent-local-demo");
    botSkin = environment("MINECRAFT_BOT_SKIN", "Steve");
    if (!botSkin.matches("[A-Za-z0-9_]{1,32}")) {
      getLogger().warning("MINECRAFT_BOT_SKIN is invalid; using Steve.");
      botSkin = "Steve";
    }
    httpClient =
        HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build();
    getLogger().info("/spawn is connected to " + spawnEndpoint);
  }

  @Override
  public boolean onCommand(
      CommandSender sender, Command command, String label, String[] arguments) {
    if (!(sender instanceof Player requester)) {
      sender.sendMessage("Only an in-game player can choose a ForgeBot spawn location.");
      return true;
    }
    if (arguments.length > 1) {
      requester.sendMessage("Usage: /spawn X");
      return true;
    }
    Optional<BotRole> requestedRole = Optional.empty();
    if (requester.getWorld().getEnvironment() != World.Environment.NORMAL) {
      requester.sendMessage("ForgeBots can currently be spawned only in the Overworld.");
      return true;
    }
    if (!spawnInFlight.compareAndSet(false, true)) {
      requester.sendMessage("A ForgeBot spawn is already being placed. Try again in a moment.");
      return true;
    }

    Location requestedLocation = requester.getLocation().clone();
    SpawnControlRequest request =
        new SpawnControlRequest(
            requestedRole,
            requester.getUniqueId(),
            requester.getName(),
            requester.getWorld().getUID(),
            requester.getWorld().getName(),
            requestedLocation.getX(),
            requestedLocation.getY(),
            requestedLocation.getZ(),
            requestedLocation.getYaw(),
            requestedLocation.getPitch());

    httpClient
        .sendAsync(
            request.toHttpRequest(spawnEndpoint, spawnToken),
            HttpResponse.BodyHandlers.ofString())
        .whenComplete(
            (response, failure) ->
                Bukkit.getScheduler()
                    .runTask(
                        this,
                        () ->
                            finishSpawn(
                                requester.getUniqueId(), requestedRole, requestedLocation, response, failure)));
    return true;
  }

  private void finishSpawn(
      UUID requesterUuid,
      Optional<BotRole> requestedRole,
      Location requestedLocation,
      HttpResponse<String> response,
      Throwable failure) {
    Player requester = Bukkit.getPlayer(requesterUuid);
    if (failure != null) {
      spawnInFlight.set(false);
      getLogger().warning("ForgeBot spawn request failed: " + failure.getMessage());
      tell(requester, "The ForgeBot manager is unavailable. Check the demo process and try again.");
      return;
    }
    if (response.statusCode() == 409) {
      spawnInFlight.set(false);
      tell(requester, safeLogBody(response.body()));
      return;
    }
    if (response.statusCode() != 201) {
      spawnInFlight.set(false);
      getLogger().warning(
          "ForgeBot manager returned HTTP "
              + response.statusCode()
              + ": "
              + safeLogBody(response.body()));
      tell(requester, "TrueForge could not create that ForgeBot. Try again.");
      return;
    }

    Optional<BotIdentity> parsed = BotIdentity.parse(response.body());
    if (parsed.isEmpty()) {
      spawnInFlight.set(false);
      getLogger().warning("ForgeBot manager returned an invalid bot identity.");
      tell(requester, "The ForgeBot manager returned an invalid response.");
      return;
    }
    BotIdentity identity = parsed.get();
    if (requestedRole.isPresent() && identity.role() != requestedRole.get()) {
      rollback(identity, requester, "did not match the requested role");
      return;
    }
    Player bot = Bukkit.getPlayerExact(identity.username());
    if (bot == null) {
      rollback(identity, requester, "did not join Minecraft");
      return;
    }

    World world = Bukkit.getWorld(requestedLocation.getWorld().getUID());
    if (world == null) {
      rollback(identity, requester, "could not access the requested world");
      return;
    }
    Optional<Location> safeLocation = findSafeLocation(world, requestedLocation, identity.slot());
    if (safeLocation.isEmpty()) {
      rollback(identity, requester, "could not find safe natural ground nearby");
      return;
    }

    if (!bot.teleport(safeLocation.get(), PlayerTeleportEvent.TeleportCause.PLUGIN)) {
      rollback(identity, requester, "could not be placed safely");
      return;
    }
    bot.setFallDistance(0);
    giveStartingKit(bot, identity.role());
    applyClassicSkin(identity.username());
    spawnInFlight.set(false);
    tell(
        requester,
        "Go to the TrueForge console to assign work to " + identity.username() + ".");
    notifyReady(identity, requester);
  }

  private void rollback(BotIdentity identity, Player requester, String reason) {
    tell(requester, identity.username() + " " + reason + "; rolling back its slot.");
    BotControlRequest request = new BotControlRequest(identity.username());
    httpClient
        .sendAsync(
            request.toHttpRequest(spawnEndpoint, "rollback", spawnToken),
            HttpResponse.BodyHandlers.ofString())
        .whenComplete(
            (response, failure) -> {
              spawnInFlight.set(false);
              if (failure != null) {
                getLogger().severe(
                    "Could not roll back " + identity.username() + ": " + failure.getMessage());
                return;
              }
              if (response.statusCode() != 204) {
                getLogger().severe(
                    "Rollback for "
                        + identity.username()
                        + " returned HTTP "
                        + response.statusCode()
                        + ": "
                        + safeLogBody(response.body()));
              }
            });
  }

  private void notifyReady(BotIdentity identity, Player requester) {
    BotControlRequest request = new BotControlRequest(identity.username());
    httpClient
        .sendAsync(
            request.toHttpRequest(spawnEndpoint, "ready", spawnToken),
            HttpResponse.BodyHandlers.ofString())
        .whenComplete(
            (response, failure) -> {
              if (failure != null) {
                getLogger().warning(
                    "Could not initialize "
                        + identity.username()
                        + " in TrueForge: "
                        + failure.getMessage());
                return;
              }
              if (response.statusCode() != 204) {
                getLogger().warning(
                    "TrueForge initialization for "
                        + identity.username()
                        + " returned HTTP "
                        + response.statusCode());
                Bukkit.getScheduler()
                    .runTask(
                        this,
                        () ->
                            tell(
                                requester,
                                "The bot is ready, but its TrueForge introduction did not start."));
              }
            });
  }

  private Optional<Location> findSafeLocation(World world, Location origin, int slot) {
    double phase = ((slot - 1) * Math.PI * 2.0) / 5.0;
    for (int radius = 3; radius <= MAX_SEARCH_RADIUS; radius++) {
      int samples = Math.max(12, radius * 4);
      for (int sample = 0; sample < samples; sample++) {
        double angle = phase + ((sample * Math.PI * 2.0) / samples);
        int x = origin.getBlockX() + (int) Math.round(Math.cos(angle) * radius);
        int z = origin.getBlockZ() + (int) Math.round(Math.sin(angle) * radius);
        int groundY = world.getHighestBlockYAt(x, z, HeightMap.MOTION_BLOCKING_NO_LEAVES);
        if (!isSafeNaturalColumn(world, x, groundY, z) || isOccupied(world, x, groundY + 1, z)) {
          continue;
        }
        return Optional.of(
            new Location(world, x + 0.5, groundY + 1.0, z + 0.5, origin.getYaw(), 0));
      }
    }
    return Optional.empty();
  }

  private boolean isSafeNaturalColumn(World world, int x, int groundY, int z) {
    Block ground = world.getBlockAt(x, groundY, z);
    Block foundation = world.getBlockAt(x, groundY - 1, z);
    Block feet = world.getBlockAt(x, groundY + 1, z);
    Block head = world.getBlockAt(x, groundY + 2, z);
    return NATURAL_SURFACE.contains(ground.getType())
        && ground.getType().isSolid()
        && foundation.getType().isSolid()
        && !foundation.isLiquid()
        && feet.isPassable()
        && !feet.isLiquid()
        && head.isPassable()
        && !head.isLiquid();
  }

  private boolean isOccupied(World world, int x, int y, int z) {
    for (Player player : world.getPlayers()) {
      Location location = player.getLocation();
      double dx = location.getX() - (x + 0.5);
      double dy = location.getY() - y;
      double dz = location.getZ() - (z + 0.5);
      if ((dx * dx) + (dy * dy) + (dz * dz) < 4.0) {
        return true;
      }
    }
    return false;
  }

  private void giveStartingKit(Player bot, BotRole role) {
    bot.getInventory().clear();
    add(bot, Material.STONE_AXE, 1);
    add(bot, Material.IRON_PICKAXE, 1);
    add(bot, Material.IRON_SWORD, 1);
    add(bot, Material.BAKED_POTATO, 16);
    switch (role) {
      case GENERALIST -> {
        // The console assignment determines the job; keep the initial kit neutral.
      }
      case LUMBERJACK -> {
        add(bot, Material.OAK_SAPLING, 8);
      }
      case MINER -> {
        add(bot, Material.TORCH, 64);
        add(bot, Material.LADDER, 32);
      }
      case BUILDER -> {
        add(bot, Material.OAK_PLANKS, 256);
        add(bot, Material.COBBLESTONE, 128);
        add(bot, Material.GLASS_PANE, 64);
        add(bot, Material.OAK_DOOR, 1);
        add(bot, Material.TORCH, 32);
      }
      case HUNTER -> {
        add(bot, Material.SHIELD, 1);
      }
      case SCOUT -> {
        add(bot, Material.COMPASS, 1);
        add(bot, Material.SPYGLASS, 1);
      }
    }
  }

  private void add(Player bot, Material material, int quantity) {
    int remaining = quantity;
    int stackSize = material.getMaxStackSize();
    while (remaining > 0) {
      int amount = Math.min(remaining, stackSize);
      bot.getInventory().addItem(new ItemStack(material, amount));
      remaining -= amount;
    }
  }

  private void applyClassicSkin(String username) {
    if (!Bukkit.getPluginManager().isPluginEnabled("SkinsRestorer")) {
      getLogger().warning("SkinsRestorer is unavailable; " + username + " will use its client default skin.");
      return;
    }
    boolean dispatched =
        Bukkit.dispatchCommand(
            Bukkit.getConsoleSender(), "skin set " + botSkin + " " + username + " classic");
    if (!dispatched) {
      getLogger().warning("Could not dispatch the SkinsRestorer command for " + username + '.');
    }
  }

  private void tell(Player player, String message) {
    if (player != null) {
      player.sendMessage(message);
    }
  }

  private String safeLogBody(String body) {
    String singleLine = body.replace('\n', ' ').replace('\r', ' ').trim();
    return singleLine.substring(0, Math.min(singleLine.length(), 160));
  }

  private String environment(String name, String fallback) {
    String value = System.getenv(name);
    if (value == null || value.isBlank()) {
      return fallback;
    }
    return value.trim();
  }
}
