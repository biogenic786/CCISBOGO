const { Client, GatewayIntentBits } = require("discord.js");
const { joinVoiceChannel } = require("@discordjs/voice");
const Queue = require("./queue");
const Player = require("./player");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});
client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});
const TOKEN = process.env.DISCORD_TOKEN;

const queues = new Map();
const players = new Map();

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

// ─────────────────────────────────────────────────────────────
// Resolve a query into an array of songs:
//   - Playlist URL  → array of all video URLs
//   - Single URL    → [url]
//   - Search term   → ['ytsearch1:term']
// ─────────────────────────────────────────────────────────────
function resolveQuery(query) {
  return new Promise((resolve, reject) => {
    const isUrl = query.startsWith("http://") || query.startsWith("https://");
    const isPlaylist =
      query.includes("playlist?list=") ||
      query.includes("&list=") ||
      query.includes("/sets/"); // SoundCloud playlists

    if (isPlaylist) {
      console.log(`📋 Detected playlist — extracting URLs...`);
      execFile(
        "yt-dlp",
        ["--flat-playlist", "--print", "%(url)s", "--no-warnings", query],
        { maxBuffer: 10 * 1024 * 1024 }, // 10MB buffer for large playlists
        (err, stdout, stderr) => {
          if (err) {
            console.error("💥 Playlist extraction error:", stderr);
            return reject(err);
          }
          const urls = stdout.trim().split("\n").filter(Boolean);
          console.log(`📋 Found ${urls.length} songs in playlist`);
          resolve(urls);
        },
      );
    } else if (isUrl) {
      resolve([query]);
    } else {
      // Name-based search — player.js prepends ytsearch1:
      resolve([query]);
    }
  });
}

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith("!")) return;

  console.log(`📩 ${message.author.tag}: ${message.content}`);

  const args = message.content.slice(1).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  // ─────────────────────────────────────────────
  // 🎵 PLAY  (!play / !p)
  // ─────────────────────────────────────────────
  if (command === "play" || command === "p") {
    const query = args.join(" ");
    if (!query)
      return message.reply(
        "❌ Provide a song name, YouTube URL, or playlist URL.",
      );

    const vc = message.member?.voice?.channel;
    if (!vc) return message.reply("❌ Join a voice channel first.");

    const isPlaylist =
      query.includes("playlist?list=") ||
      query.includes("&list=") ||
      query.includes("/sets/");

    if (isPlaylist) {
      message.reply("📋 Loading playlist, please wait...");
    }

    let songs;
    try {
      songs = await resolveQuery(query);
    } catch (err) {
      console.error("💥 resolveQuery failed:", err);
      return message.reply(
        "❌ Failed to load that playlist or URL. Is it public?",
      );
    }

    if (songs.length === 0) return message.reply("❌ No songs found.");

    let serverQueue = queues.get(message.guild.id);
    if (!serverQueue) {
      serverQueue = new Queue();
      queues.set(message.guild.id, serverQueue);
    }

    songs.forEach((s) => serverQueue.add(s));

    if (songs.length === 1) {
      message.reply(`✅ Added to queue: **${query}**`);
    } else {
      message.reply(`✅ Added **${songs.length}** songs to queue!`);
    }

    if (!serverQueue.playing) {
      const connection = joinVoiceChannel({
        channelId: vc.id,
        guildId: message.guild.id,
        adapterCreator: message.guild.voiceAdapterCreator,
      });

      const player = new Player(connection, serverQueue);
      players.set(message.guild.id, player);
      serverQueue.playing = true;
      player.playNext();
    }
    return;
  }

  // ─────────────────────────────────────────────
  // ⏭ SKIP  (!skip / !s)
  // ─────────────────────────────────────────────
  if (command === "skip" || command === "s") {
    const player = players.get(message.guild.id);
    if (!player) return message.reply("❌ Nothing is playing.");
    player.audioPlayer.stop();
    message.reply("⏭ Skipped!");
    return;
  }

  // ─────────────────────────────────────────────
  // ⛔ STOP  (!stop)
  // ─────────────────────────────────────────────
  if (command === "stop") {
    const player = players.get(message.guild.id);
    if (player) {
      player.cleanup();
      player.audioPlayer.stop(true);
      player.connection.destroy();
    }
    queues.delete(message.guild.id);
    players.delete(message.guild.id);
    message.reply("⛔ Stopped and left the channel.");
    return;
  }

  // ─────────────────────────────────────────────
  // 📋 QUEUE  (!queue / !q)
  // ─────────────────────────────────────────────
  if (command === "queue" || command === "q") {
    const serverQueue = queues.get(message.guild.id);
    if (!serverQueue || serverQueue.songs.length === 0) {
      return message.reply("📭 Queue is empty.");
    }

    const preview = serverQueue.songs.slice(0, 10);
    const remaining = serverQueue.songs.length - preview.length;

    const list = preview
      .map((s, i) => {
        const display = s.startsWith("http") ? s.substring(0, 60) + "..." : s;
        return `${i + 1}. ${display}`;
      })
      .join("\n");

    let reply = `📋 **Queue (${serverQueue.songs.length} songs):**\n${list}`;
    if (remaining > 0) reply += `\n_...and ${remaining} more_`;

    message.reply(reply);
    return;
  }

  // ─────────────────────────────────────────────
  // 🔀 SHUFFLE  (!shuffle)
  // ─────────────────────────────────────────────
  if (command === "shuffle") {
    const serverQueue = queues.get(message.guild.id);
    if (!serverQueue || serverQueue.songs.length === 0) {
      return message.reply("📭 Queue is empty.");
    }
    serverQueue.shuffle();
    message.reply("🔀 Queue shuffled!");
    return;
  }

  // ─────────────────────────────────────────────
  // 🗑️ CLEAR  (!clear)
  // ─────────────────────────────────────────────
  if (command === "clear") {
    const serverQueue = queues.get(message.guild.id);
    if (!serverQueue || serverQueue.songs.length === 0) {
      return message.reply("📭 Queue is already empty.");
    }
    const count = serverQueue.songs.length;
    serverQueue.clear();
    message.reply(`🗑️ Cleared **${count}** songs from the queue.`);
    return;
  }

  // ─────────────────────────────────────────────
  // ❓ HELP  (!help / !h)
  // ─────────────────────────────────────────────
  if (command === "help" || command === "h") {
    message.reply(
      "🎵 **Music Bot Commands:**\n" +
        "`!play <name/url/playlist>` or `!p` — Play a song, search by name, or load a playlist\n" +
        "`!skip` or `!s`                     — Skip current song\n" +
        "`!stop`                             — Stop and leave channel\n" +
        "`!queue` or `!q`                    — Show queue\n" +
        "`!shuffle`                          — Shuffle queue\n" +
        "`!clear`                            — Clear the queue\n" +
        "`!help`                             — Show this message",
    );
    return;
  }
});

process.on("uncaughtException", (err) =>
  console.error("💥 Uncaught Exception:", err),
);
process.on("unhandledRejection", (err) =>
  console.error("💥 Unhandled Rejection:", err),
);

client.login(TOKEN);
