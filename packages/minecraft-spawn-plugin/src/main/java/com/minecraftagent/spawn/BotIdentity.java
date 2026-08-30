package com.minecraftagent.spawn;

import java.util.Optional;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

record BotIdentity(String username, int slot, BotRole role) {
  private static final Pattern RESPONSE =
      Pattern.compile("(ForgeBot([1-5])):(generalist|lumberjack|miner|builder|hunter|scout)");

  static Optional<BotIdentity> parse(String responseBody) {
    String candidate = responseBody.trim();
    Matcher matcher = RESPONSE.matcher(candidate);
    if (!matcher.matches()) {
      return Optional.empty();
    }
    int slot = Integer.parseInt(matcher.group(2));
    Optional<BotRole> role = BotRole.parseWireName(matcher.group(3));
    return role.map(value -> new BotIdentity(matcher.group(1), slot, value));
  }
}
