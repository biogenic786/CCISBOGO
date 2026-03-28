// Run this ONCE to register slash commands with Discord:
// node deploy.js

require("dotenv").config();
const { REST, Routes, SlashCommandBuilder } = require("discord.js");

const commands = [
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Play a song, YouTube URL, YouTube playlist, or Spotify link")
    .addStringOption((opt) =>
      opt
        .setName("query")
        .setDescription("Song name, YouTube URL/playlist, or Spotify track/album/playlist URL")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("skip")
    .setDescription("Skip the current song"),

  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Stop playing and leave the voice channel"),

  new SlashCommandBuilder()
    .setName("pause")
    .setDescription("Pause the current song"),

  new SlashCommandBuilder()
    .setName("resume")
    .setDescription("Resume a paused song"),

  new SlashCommandBuilder()
    .setName("nowplaying")
    .setDescription("Show what is currently playing"),

  new SlashCommandBuilder()
    .setName("queue")
    .setDescription("Show the current queue"),

  new SlashCommandBuilder()
    .setName("shuffle")
    .setDescription("Shuffle the queue"),

  new SlashCommandBuilder()
    .setName("clear")
    .setDescription("Clear the queue"),

  new SlashCommandBuilder()
    .setName("volume")
    .setDescription("Set the playback volume (0–200)")
    .addIntegerOption((opt) =>
      opt
        .setName("level")
        .setDescription("Volume level (0–200, default 80)")
        .setRequired(true)
        .setMinValue(0)
        .setMaxValue(200)
    ),
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
