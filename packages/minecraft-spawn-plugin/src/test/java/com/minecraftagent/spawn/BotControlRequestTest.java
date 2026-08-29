package com.minecraftagent.spawn;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.net.URI;
import java.net.http.HttpRequest;
import org.junit.jupiter.api.Test;

final class BotControlRequestTest {
  @Test
  void targetsAuthenticatedLifecycleEndpoints() {
    BotControlRequest control = new BotControlRequest("ForgeBot2");

    HttpRequest rollback =
        control.toHttpRequest(
            URI.create("http://host.docker.internal:8793/spawn"), "rollback", "shared-token");
    HttpRequest ready =
        control.toHttpRequest(
            URI.create("http://host.docker.internal:8793/spawn"), "ready", "shared-token");

    assertEquals("http://host.docker.internal:8793/spawn/rollback", rollback.uri().toString());
    assertEquals("http://host.docker.internal:8793/spawn/ready", ready.uri().toString());
    assertEquals("shared-token", ready.headers().firstValue("X-Minecraft-Agent-Token").orElseThrow());
  }
}
