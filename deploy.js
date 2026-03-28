// Run this ONCE to register slash commands with Discord:
// node deploy.js

const { REST, Routes, SlashCommandBuilder } = require("discord.js");

const commands = [
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Play a song or playlist from YouTube or Spotify")
    .addStringOption((opt) =>
      opt
        .setName("query")
        .setDescription("Song name, YouTube URL/playlist, or Spotify link")
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("skip")
    .setDescription("Skip the current song"),
  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Stop playing and leave the voice channel"),
  new SlashCommandBuilder()
    .setName("queue")
    .setDescription("Show the current queue"),
  new SlashCommandBuilder()
    .setName("shuffle")
    .setDescription("Shuffle the queue"),
  new SlashCommandBuilder().setName("clear").setDescription("Clear the queue"),
].map((cmd) => cmd.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log("🔄 Registering slash commands...");
    await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), {
      body: commands,
    });
    console.log("✅ Slash commands registered!");
  } catch (err) {
    console.error("💥 Failed to register commands:", err);
  }
})();
