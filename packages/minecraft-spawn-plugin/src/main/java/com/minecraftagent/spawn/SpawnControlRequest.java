package com.minecraftagent.spawn;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpRequest;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.StringJoiner;
import java.util.UUID;

record SpawnControlRequest(
    UUID requesterUuid,
    String requesterName,
    UUID worldUuid,
    String worldName,
    double x,
    double y,
    double z,
    float yaw,
    float pitch,
    String requestedRole) {

  HttpRequest toHttpRequest(URI endpoint, String token) {
    return HttpRequest.newBuilder(endpoint)
        .timeout(Duration.ofSeconds(45))
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("Accept", "text/plain")
        .header("X-Minecraft-Agent-Token", token)
        .POST(HttpRequest.BodyPublishers.ofString(toFormBody()))
        .build();
  }

  String toFormBody() {
    Map<String, String> values = new LinkedHashMap<>();
    values.put("requester_uuid", requesterUuid.toString());
    values.put("requester_name", requesterName);
    values.put("world_uuid", worldUuid.toString());
    values.put("world_name", worldName);
    values.put("x", Double.toString(x));
    values.put("y", Double.toString(y));
    values.put("z", Double.toString(z));
    values.put("yaw", Float.toString(yaw));
    values.put("pitch", Float.toString(pitch));
    values.put("requested_role", requestedRole);

    StringJoiner encoded = new StringJoiner("&");
    values.forEach(
        (key, value) -> encoded.add(encode(key) + "=" + encode(value)));
    return encoded.toString();
  }

  private static String encode(String value) {
    return URLEncoder.encode(value, StandardCharsets.UTF_8);
  }
}
