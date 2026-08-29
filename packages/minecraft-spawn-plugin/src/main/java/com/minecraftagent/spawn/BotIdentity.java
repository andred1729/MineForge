package com.minecraftagent.spawn;

import java.util.Optional;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

record BotIdentity(String username, int slot, String role) {
  private static final Pattern USERNAME = Pattern.compile("ForgeBot([1-5])");
  private static final String[] ROLES = {
    "Lumberjack", "Miner", "Builder", "Hunter", "Scout"
  };

  static Optional<BotIdentity> parse(String responseBody) {
    String candidate = responseBody.trim();
    Matcher matcher = USERNAME.matcher(candidate);
    if (!matcher.matches()) {
      return Optional.empty();
    }
    int slot = Integer.parseInt(matcher.group(1));
    return Optional.of(new BotIdentity(candidate, slot, ROLES[slot - 1]));
  }
}
