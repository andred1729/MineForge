FROM maven:3.9.11-eclipse-temurin-21 AS plugin-build
WORKDIR /build

COPY packages/minecraft-spawn-plugin/pom.xml ./pom.xml
RUN mvn --batch-mode --no-transfer-progress dependency:go-offline

COPY packages/minecraft-spawn-plugin/src ./src
RUN mvn --batch-mode --no-transfer-progress verify

FROM itzg/minecraft-server:latest
COPY --from=plugin-build /build/target/minecraft-spawn-0.1.0.jar /plugins/MinecraftAgentSpawn.jar
