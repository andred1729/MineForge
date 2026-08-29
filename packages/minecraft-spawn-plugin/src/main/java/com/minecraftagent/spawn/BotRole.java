package com.minecraftagent.spawn;

import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.Optional;

enum BotRole {
  LUMBERJACK("lumberjack", "lumber-jack", "Lumberjack", 1),
  MINER("miner", "miner", "Miner", 2),
  BUILDER("builder", "builder", "Builder", 3),
  HUNTER("hunter", "hunter", "Hunter", 4),
  SCOUT("scout", "scout", "Scout", 5);

  private final String wireName;
  private final String commandName;
  private final String displayName;
  private final int slot;

  BotRole(String wireName, String commandName, String displayName, int slot) {
    this.wireName = wireName;
    this.commandName = commandName;
    this.displayName = displayName;
    this.slot = slot;
  }

  String wireName() {
    return wireName;
  }

  String commandName() {
    return commandName;
  }

  String displayName() {
    return displayName;
  }

  int slot() {
    return slot;
  }

  static Optional<BotRole> parseCommand(String value) {
    String normalized = value.toLowerCase(Locale.ROOT);
    if (normalized.equals("lumberjack")) {
      normalized = "lumber-jack";
    }
    final String candidate = normalized;
    return Arrays.stream(values()).filter(role -> role.commandName.equals(candidate)).findFirst();
  }

  static BotRole forSlot(int slot) {
    return Arrays.stream(values())
        .filter(role -> role.slot == slot)
        .findFirst()
        .orElseThrow(() -> new IllegalArgumentException("Unsupported ForgeBot slot: " + slot));
  }

  static List<String> commandNames() {
    return Arrays.stream(values()).map(BotRole::commandName).toList();
  }
}
