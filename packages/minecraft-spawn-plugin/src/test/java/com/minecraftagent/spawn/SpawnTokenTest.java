package com.minecraftagent.spawn;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class SpawnTokenTest {
  @Test
  void acceptsStrongExactToken() {
    assertTrue(MinecraftAgentSpawnPlugin.validSpawnToken("0123456789abcdef0123456789abcdef"));
  }

  @Test
  void rejectsMissingShortAndWhitespaceWrappedTokens() {
    assertFalse(MinecraftAgentSpawnPlugin.validSpawnToken(null));
    assertFalse(MinecraftAgentSpawnPlugin.validSpawnToken("too-short"));
    assertFalse(MinecraftAgentSpawnPlugin.validSpawnToken(" 0123456789abcdef0123456789abcdef "));
  }
}
