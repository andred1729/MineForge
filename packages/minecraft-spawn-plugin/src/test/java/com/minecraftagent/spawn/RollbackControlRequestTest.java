package com.minecraftagent.spawn;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.net.URI;
import java.net.http.HttpRequest;
import org.junit.jupiter.api.Test;

final class RollbackControlRequestTest {
  @Test
  void targetsAuthenticatedRollbackEndpoint() {
    HttpRequest request =
        new RollbackControlRequest("ForgeBot2")
            .toHttpRequest(URI.create("http://host.docker.internal:8793/spawn"), "shared-token");

    assertEquals("http://host.docker.internal:8793/spawn/rollback", request.uri().toString());
    assertEquals("shared-token", request.headers().firstValue("X-Minecraft-Agent-Token").orElseThrow());
  }
}
