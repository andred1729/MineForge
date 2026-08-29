package com.minecraftagent.spawn;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

final class BotIdentityTest {
  @Test
  void mapsEverySupportedBotToItsDemoRole() {
    assertEquals(BotRole.LUMBERJACK, BotIdentity.parse("ForgeBot1").orElseThrow().role());
    assertEquals(BotRole.MINER, BotIdentity.parse("ForgeBot2\n").orElseThrow().role());
    assertEquals(BotRole.BUILDER, BotIdentity.parse("ForgeBot3").orElseThrow().role());
    assertEquals(BotRole.HUNTER, BotIdentity.parse("ForgeBot4").orElseThrow().role());
    assertEquals(BotRole.SCOUT, BotIdentity.parse("ForgeBot5").orElseThrow().role());
  }

  @Test
  void rejectsAnythingOutsideTheFiveBotContract() {
    assertTrue(BotIdentity.parse("ForgeBot").isEmpty());
    assertTrue(BotIdentity.parse("ForgeBot6").isEmpty());
    assertTrue(BotIdentity.parse("not-a-bot").isEmpty());
  }

  @Test
  void acceptsTheDemoLumberjackCommandSpelling() {
    assertEquals(BotRole.LUMBERJACK, BotRole.parseCommand("lumber-jack").orElseThrow());
    assertEquals(BotRole.LUMBERJACK, BotRole.parseCommand("lumberjack").orElseThrow());
    assertEquals(BotRole.HUNTER, BotRole.parseCommand("HUNTER").orElseThrow());
  }
}
