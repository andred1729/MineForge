package com.minecraftagent.spawn;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

final class BotIdentityTest {
  @Test
  void parsesTheBackendSelectedRoleIndependentlyFromTheBotSlot() {
    assertEquals(BotRole.GENERALIST, BotIdentity.parse("ForgeBot1:generalist").orElseThrow().role());
    assertEquals(BotRole.HUNTER, BotIdentity.parse("ForgeBot1:hunter").orElseThrow().role());
    assertEquals(BotRole.LUMBERJACK, BotIdentity.parse("ForgeBot2:lumberjack\n").orElseThrow().role());
    assertEquals(BotRole.LUMBERJACK, BotRole.parseCommand("lumber-jack").orElseThrow());
    assertEquals(BotRole.HUNTER, BotRole.parseCommand("hunter").orElseThrow());
  }

  @Test
  void rejectsAnythingOutsideTheFiveBotContract() {
    assertTrue(BotIdentity.parse("ForgeBot1").isEmpty());
    assertTrue(BotIdentity.parse("ForgeBot6:hunter").isEmpty());
    assertTrue(BotIdentity.parse("ForgeBot1:unknown").isEmpty());
    assertTrue(BotIdentity.parse("not-a-bot").isEmpty());
  }
}
