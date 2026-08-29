package com.minecraftagent.spawn;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.net.URI;
import java.net.http.HttpRequest;
import java.util.UUID;
import org.junit.jupiter.api.Test;

final class SpawnControlRequestTest {
  @Test
  void encodesRequesterAndLocationWithoutPuttingTheTokenInTheBody() {
    SpawnControlRequest request =
        new SpawnControlRequest(
            UUID.fromString("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
            "Player One",
            UUID.fromString("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"),
            "Demo World",
            12.5,
            64.0,
            -3.25,
            90.0f,
            5.0f);

    String body = request.toFormBody();

    assertTrue(body.contains("requester_name=Player+One"));
    assertTrue(body.contains("world_name=Demo+World"));
    assertTrue(body.contains("z=-3.25"));
    assertTrue(!body.contains("secret-token"));

    HttpRequest httpRequest =
        request.toHttpRequest(URI.create("http://host.docker.internal:8793/spawn"), "secret-token");
    assertEquals("secret-token", httpRequest.headers().firstValue("X-Minecraft-Agent-Token").orElseThrow());
    assertEquals("POST", httpRequest.method());
  }
}
