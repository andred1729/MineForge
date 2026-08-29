package com.minecraftagent.spawn;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

final class BotIdentityTest {
  @Test
  void mapsEverySupportedBotToItsDemoRole() {
    assertEquals("Lumberjack", BotIdentity.parse("ForgeBot1").orElseThrow().role());
    assertEquals("Miner", BotIdentity.parse("ForgeBot2\n").orElseThrow().role());
    assertEquals("Builder", BotIdentity.parse("ForgeBot3").orElseThrow().role());
    assertEquals("Hunter", BotIdentity.parse("ForgeBot4").orElseThrow().role());
    assertEquals("Scout", BotIdentity.parse("ForgeBot5").orElseThrow().role());
  }

  @Test
  void rejectsAnythingOutsideTheFiveBotContract() {
    assertTrue(BotIdentity.parse("ForgeBot").isEmpty());
    assertTrue(BotIdentity.parse("ForgeBot6").isEmpty());
    assertTrue(BotIdentity.parse("not-a-bot").isEmpty());
  }
}
