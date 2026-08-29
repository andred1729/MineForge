package com.minecraftagent.spawn;

import java.util.Arrays;

enum BotRole {
  LUMBERJACK("Lumberjack", 1),
  MINER("Miner", 2),
  BUILDER("Builder", 3),
  HUNTER("Hunter", 4),
  SCOUT("Scout", 5);

  private final String displayName;
  private final int slot;

  BotRole(String displayName, int slot) {
    this.displayName = displayName;
    this.slot = slot;
  }

  String displayName() {
    return displayName;
  }

  int slot() {
    return slot;
  }

  static BotRole forSlot(int slot) {
    return Arrays.stream(values())
        .filter(role -> role.slot == slot)
        .findFirst()
        .orElseThrow(() -> new IllegalArgumentException("Unsupported ForgeBot slot: " + slot));
  }
}
