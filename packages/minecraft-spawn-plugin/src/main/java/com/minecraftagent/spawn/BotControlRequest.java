package com.minecraftagent.spawn;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpRequest;
import java.nio.charset.StandardCharsets;
import java.time.Duration;

record BotControlRequest(String username) {
  HttpRequest toHttpRequest(URI spawnEndpoint, String action, String token) {
    URI endpoint = spawnEndpoint.resolve("/spawn/" + action);
    String body = "username=" + URLEncoder.encode(username, StandardCharsets.UTF_8);
    return HttpRequest.newBuilder(endpoint)
        .timeout(Duration.ofSeconds(10))
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("Accept", "text/plain")
        .header("X-Minecraft-Agent-Token", token)
        .POST(HttpRequest.BodyPublishers.ofString(body))
        .build();
  }
}
