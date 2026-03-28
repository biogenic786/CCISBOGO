FROM eclipse-temurin:17-jre-alpine

WORKDIR /lavalink

# Copy config
COPY application.yml ./application.yml

# Download Lavalink jar
RUN wget -q https://github.com/lavalink-devs/Lavalink/releases/download/4.0.8/Lavalink.jar

EXPOSE 2333

CMD ["java", "-jar", "Lavalink.jar"]
