require("dotenv").config();
const { Client, GatewayIntentBits, EmbedBuilder, ActivityType } = require("discord.js");
const { Manager, Connectors } = require("moonlink.js");

// ─────────────────────────────────────────────────────────────
// Discord client
// ─────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// ─────────────────────────────────────────────────────────────
// Lavalink manager
// ─────────────────────────────────────────────────────────────
const manager = new Manager({
  nodes: [
    {
      identifier: "railway-lavalink",
      host: process.env.LAVALINK_HOST || "localhost",
      port: parseInt(process.env.LAVALINK_PORT || "2333"),
      password: process.env.LAVALINK_PASSWORD || "youshallnotpass",
      secure: process.env.LAVALINK_SECURE === "true",
    },
  ],
  sendPayload: (guildId, payload) => {
    const guild = client.guilds.cache.get(guildId);
    if (guild) guild.shard.send(payload);
  },
});

// Bridge moonlink.js with discord.js
manager.use(new Connectors.DiscordJS(client));

// ─────────────────────────────────────────────────────────────
// Lavalink events
// ─────────────────────────────────────────────────────────────
manager.on("nodeConnect", (node) =>
  console.log(`✅ Lavalink node connected: ${node.identifier}`)
);
manager.on("nodeError", (node, err) =>
  console.error(`💥 Lavalink node error [${node.identifier}]:`, err.message)
);

manager.on("trackStart", (player, track) => {
  const channel = client.channels.cache.get(player.textChannelId);
  if (!channel) return;

  const sourceEmoji = track.info.sourceName === "spotify" ? "🎧 Spotify" : "▶️ YouTube";
  const color = track.info.sourceName === "spotify" ? 0x1db954 : 0xff0000;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setAuthor({ name: "🎵 Now Playing" })
    .setTitle(track.info.title || "Unknown Title")
    .setURL(track.info.uri || null)
    .setThumbnail(track.info.artworkUrl || null)
    .addFields(
      { name: "Artist", value: track.info.author || "Unknown", inline: true },
      { name: "Source", value: sourceEmoji, inline: true },
      {
        name: "Requested by",
        value: track.info.requester ? `<@${track.info.requester}>` : "Unknown",
        inline: true,
      }
    )
    .setFooter({ text: "Use /skip • /pause • /stop • /queue" })
    .setTimestamp();

  channel.send({ embeds: [embed] });
});

manager.on("trackEnd", (player) => {
  if (player.queue.size === 0) {
    const channel = client.channels.cache.get(player.textChannelId);
    if (channel) channel.send("✅ Queue finished. Leaving voice channel.");
    player.destroy();
  }
});

manager.on("trackError", (player, track, payload) => {
  console.error(`💥 Track error [${track?.info?.title}]:`, payload?.exception?.message);
  const channel = client.channels.cache.get(player.textChannelId);
  if (channel) channel.send(`❌ Error playing **${track?.info?.title}** — skipping.`);
  player.skip();
});

// ─────────────────────────────────────────────────────────────
// Rate limiting — 3 second cooldown per user per command
// ─────────────────────────────────────────────────────────────
const cooldowns = new Map();

function isOnCooldown(userId, seconds = 3) {
  const now = Date.now();
  const last = cooldowns.get(userId) || 0;
  if (now - last < seconds * 1000) {
    const remaining = ((seconds * 1000 - (now - last)) / 1000).toFixed(1);
    return remaining;
  }
  cooldowns.set(userId, now);
  return false;
}

// ─────────────────────────────────────────────────────────────
// Helper: resolve Spotify URLs via LavaSrc plugin identifiers
// ─────────────────────────────────────────────────────────────
function buildSearchIdentifier(query) {
  const isUrl = query.startsWith("http://") || query.startsWith("https://");

  if (isUrl) {
    // Pass URLs directly — Lavalink/LavaSrc handles YouTube, Spotify, SoundCloud
    return query;
  }

  // Plain text — search YouTube
  return `ytsearch:${query}`;
}

// ─────────────────────────────────────────────────────────────
// Embed builders
// ─────────────────────────────────────────────────────────────
function buildQueueEmbed(player) {
  const tracks = player.queue.tracks || [];
  const current = player.current;

  const lines = [];
  if (current) {
    lines.push(`🎵 **Now:** [${current.info.title}](${current.info.uri})`);
  }

  const upNext = tracks.slice(0, 10);
  upNext.forEach((t, i) => {
    lines.push(`${i + 1}. [${t.info.title}](${t.info.uri})`);
  });

  const remaining = tracks.length - upNext.length;
  if (remaining > 0) lines.push(`_...and ${remaining} more_`);

  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`📋 Queue — ${tracks.length} song(s) in queue`)
    .setDescription(lines.join("\n") || "Queue is empty.");
}

// ─────────────────────────────────────────────────────────────
// Bot ready
// ─────────────────────────────────────────────────────────────
client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  manager.init(client.user.id);
  client.user.setActivity("music 🎵", { type: ActivityType.Listening });
});

// ─────────────────────────────────────────────────────────────
// Slash command handler
// ─────────────────────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, user, member, guild } = interaction;

  // Rate limit
  const cooldown = isOnCooldown(user.id, 3);
  if (cooldown) {
    return interaction.reply({
      content: `⏳ Slow down! Wait **${cooldown}s** before using another command.`,
      ephemeral: true,
    });
  }

  console.log(`📩 /${commandName} by ${user.tag}`);

  // ──────────────────────────────────────────────
  // /play
  // ──────────────────────────────────────────────
  if (commandName === "play") {
    const query = interaction.options.getString("query");
    const vc = member?.voice?.channel;

    if (!vc) {
      return interaction.reply({
        content: "❌ Join a voice channel first.",
        ephemeral: true,
      });
    }

    await interaction.deferReply();

    // Get or create player
    let player = manager.players.get(guild.id);
    if (!player) {
      player = manager.createPlayer({
        guildId: guild.id,
        voiceChannelId: vc.id,
        textChannelId: interaction.channelId,
        autoPlay: true,
        volume: 80,
      });
    }

    // Connect to voice if not already
    if (!player.connected) {
      await player.connect();
    }

    // Load tracks
    const identifier = buildSearchIdentifier(query);
    let result;
    try {
      result = await manager.search({
        query: identifier,
        requester: user.id,
        source: "youtube",
      });
    } catch (err) {
      console.error("💥 Search error:", err);
      return interaction.editReply("❌ Failed to search. Is the Lavalink server running?");
    }

    if (!result || !result.tracks || result.tracks.length === 0) {
      return interaction.editReply("❌ No results found.");
    }

    // Handle different load types
    const loadType = result.loadType;

    if (loadType === "playlist") {
      // Full playlist
      for (const track of result.tracks) {
        player.queue.add(track);
      }
      const playlistName = result.playlistInfo?.name || "Playlist";
      if (!player.playing && !player.paused) await player.play();
      return interaction.editReply(
        `📋 **${playlistName}** — Added **${result.tracks.length}** songs to the queue!`
      );
    } else {
      // Single track or search result (take first)
      const track = result.tracks[0];
      player.queue.add(track);

      if (!player.playing && !player.paused) await player.play();

      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setAuthor({ name: "➕ Added to Queue" })
        .setTitle(track.info.title)
        .setURL(track.info.uri)
        .setThumbnail(track.info.artworkUrl || null)
        .addFields(
          { name: "Artist", value: track.info.author || "Unknown", inline: true },
          {
            name: "Queue Position",
            value: String(player.queue.size),
            inline: true,
          }
        );

      return interaction.editReply({ embeds: [embed] });
    }
  }

  // ──────────────────────────────────────────────
  // /skip
  // ──────────────────────────────────────────────
  if (commandName === "skip") {
    const player = manager.players.get(guild.id);
    if (!player || !player.playing) {
      return interaction.reply({ content: "❌ Nothing is playing.", ephemeral: true });
    }
    await player.skip();
    return interaction.reply("⏭ Skipped!");
  }

  // ──────────────────────────────────────────────
  // /pause
  // ──────────────────────────────────────────────
  if (commandName === "pause") {
    const player = manager.players.get(guild.id);
    if (!player || !player.playing) {
      return interaction.reply({ content: "❌ Nothing is playing.", ephemeral: true });
    }
    if (player.paused) {
      return interaction.reply({ content: "⏸ Already paused.", ephemeral: true });
    }
    await player.pause(true);
    return interaction.reply("⏸ Paused.");
  }

  // ──────────────────────────────────────────────
  // /resume
  // ──────────────────────────────────────────────
  if (commandName === "resume") {
    const player = manager.players.get(guild.id);
    if (!player) {
      return interaction.reply({ content: "❌ Nothing is playing.", ephemeral: true });
    }
    if (!player.paused) {
      return interaction.reply({ content: "▶️ Already playing.", ephemeral: true });
    }
    await player.pause(false);
    return interaction.reply("▶️ Resumed.");
  }

  // ──────────────────────────────────────────────
  // /stop
  // ──────────────────────────────────────────────
  if (commandName === "stop") {
    const player = manager.players.get(guild.id);
    if (player) {
      player.queue.clear();
      await player.destroy();
    }
    return interaction.reply("⛔ Stopped and left the channel.");
  }

  // ──────────────────────────────────────────────
  // /queue
  // ──────────────────────────────────────────────
  if (commandName === "queue") {
    const player = manager.players.get(guild.id);
    if (!player || (!player.current && player.queue.size === 0)) {
      return interaction.reply({ content: "📭 Queue is empty.", ephemeral: true });
    }
    return interaction.reply({ embeds: [buildQueueEmbed(player)] });
  }

  // ──────────────────────────────────────────────
  // /nowplaying
  // ──────────────────────────────────────────────
  if (commandName === "nowplaying") {
    const player = manager.players.get(guild.id);
    if (!player || !player.current) {
      return interaction.reply({ content: "❌ Nothing is playing.", ephemeral: true });
    }
    const track = player.current;
    const sourceEmoji = track.info.sourceName === "spotify" ? "🎧 Spotify" : "▶️ YouTube";
    const color = track.info.sourceName === "spotify" ? 0x1db954 : 0xff0000;

    const embed = new EmbedBuilder()
      .setColor(color)
      .setAuthor({ name: "🎵 Now Playing" })
      .setTitle(track.info.title)
      .setURL(track.info.uri)
      .setThumbnail(track.info.artworkUrl || null)
      .addFields(
        { name: "Artist", value: track.info.author || "Unknown", inline: true },
        { name: "Source", value: sourceEmoji, inline: true },
        { name: "Volume", value: `${player.volume}%`, inline: true }
      );

    return interaction.reply({ embeds: [embed] });
  }

  // ──────────────────────────────────────────────
  // /volume
  // ──────────────────────────────────────────────
  if (commandName === "volume") {
    const player = manager.players.get(guild.id);
    if (!player) {
      return interaction.reply({ content: "❌ Nothing is playing.", ephemeral: true });
    }
    const vol = interaction.options.getInteger("level");
    if (vol < 0 || vol > 200) {
      return interaction.reply({ content: "❌ Volume must be between 0 and 200.", ephemeral: true });
    }
    await player.setVolume(vol);
    return interaction.reply(`🔊 Volume set to **${vol}%**.`);
  }

  // ──────────────────────────────────────────────
  // /shuffle
  // ──────────────────────────────────────────────
  if (commandName === "shuffle") {
    const player = manager.players.get(guild.id);
    if (!player || player.queue.size === 0) {
      return interaction.reply({ content: "📭 Queue is empty.", ephemeral: true });
    }
    player.queue.shuffle();
    return interaction.reply("🔀 Queue shuffled!");
  }

  // ──────────────────────────────────────────────
  // /clear
  // ──────────────────────────────────────────────
  if (commandName === "clear") {
    const player = manager.players.get(guild.id);
    if (!player || player.queue.size === 0) {
      return interaction.reply({ content: "📭 Queue is already empty.", ephemeral: true });
    }
    const count = player.queue.size;
    player.queue.clear();
    return interaction.reply(`🗑️ Cleared **${count}** songs from the queue.`);
  }
});

// ─────────────────────────────────────────────────────────────
// Error handlers
// ─────────────────────────────────────────────────────────────
process.on("uncaughtException", (err) =>
  console.error("💥 Uncaught Exception:", err)
);
process.on("unhandledRejection", (err) =>
  console.error("💥 Unhandled Rejection:", err)
);

client.login(process.env.DISCORD_TOKEN);
