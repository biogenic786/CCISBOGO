const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActivityType,
} = require("discord.js");
const { joinVoiceChannel } = require("@discordjs/voice");
const { execFile } = require("child_process");
const Queue = require("./queue");
const Player = require("./player");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    // Note: MessageContent intent no longer needed for slash commands
  ],
});

const TOKEN = process.env.DISCORD_TOKEN;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

const queues = new Map();
const players = new Map();

// ─────────────────────────────────────────────────────────────
// Rate limiting — 3 second cooldown per user per command
// ─────────────────────────────────────────────────────────────
const cooldowns = new Map();

function isOnCooldown(userId, seconds = 3) {
  const now = Date.now();
  const last = cooldowns.get(userId) || 0;
  if (now - last < seconds * 1000) {
    const remaining = ((seconds * 1000 - (now - last)) / 1000).toFixed(1);
    return remaining; // returns seconds remaining as string
  }
  cooldowns.set(userId, now);
  return false;
}

// ─────────────────────────────────────────────────────────────
// Now Playing embed builder
// ─────────────────────────────────────────────────────────────
function buildNowPlayingEmbed({
  title,
  url,
  thumbnail,
  requester,
  source,
  queueLength,
}) {
  const sourceEmoji =
    source === "spotify" ? "🎧 Spotify → YouTube" : "▶️ YouTube";
  const color = source === "spotify" ? 0x1db954 : 0xff0000;

  return new EmbedBuilder()
    .setColor(color)
    .setAuthor({ name: "🎵 Now Playing" })
    .setTitle(title || "Unknown Title")
    .setURL(url || null)
    .setThumbnail(thumbnail || null)
    .addFields(
      { name: "Source", value: sourceEmoji, inline: true },
      { name: "Requested", value: `<@${requester}>`, inline: true },
      { name: "In Queue", value: `${queueLength} song(s)`, inline: true },
    )
    .setFooter({
      text: "Use /skip to skip • /stop to stop • /queue to view queue",
    })
    .setTimestamp();
}

// ─────────────────────────────────────────────────────────────
// Fetch YouTube video metadata (title + thumbnail)
// ─────────────────────────────────────────────────────────────
async function getYouTubeMeta(videoUrl) {
  try {
    const videoId = videoUrl.match(
      /(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    )?.[1];
    if (!videoId) return { title: videoUrl, thumbnail: null };

    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}&key=${YOUTUBE_API_KEY}`,
    );
    const data = await res.json();
    const snippet = data.items?.[0]?.snippet;

    return {
      title: snippet?.title || videoUrl,
      thumbnail: snippet?.thumbnails?.high?.url || null,
    };
  } catch {
    return { title: videoUrl, thumbnail: null };
  }
}

// ─────────────────────────────────────────────────────────────
// Spotify auth
// ─────────────────────────────────────────────────────────────
let spotifyToken = null;
let spotifyTokenExpiry = 0;

async function getSpotifyToken() {
  if (spotifyToken && Date.now() < spotifyTokenExpiry) return spotifyToken;
  const creds = Buffer.from(
    `${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`,
  ).toString("base64");
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${creds}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const data = await res.json();
  spotifyToken = data.access_token;
  spotifyTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  console.log("🎧 Spotify token refreshed");
  return spotifyToken;
}

async function getSpotifyTrack(trackId) {
  const token = await getSpotifyToken();
  const res = await fetch(`https://api.spotify.com/v1/tracks/${trackId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  return `${data.name} - ${data.artists?.[0]?.name}`;
}

async function getSpotifyPlaylist(playlistId) {
  const token = await getSpotifyToken();
  const tracks = [];
  let url = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100`;
  while (url) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    for (const item of data.items) {
      const t = item.track;
      if (t?.name) tracks.push(`${t.name} - ${t.artists?.[0]?.name || ""}`);
    }
    url = data.next;
  }
  return tracks;
}

async function getSpotifyAlbum(albumId) {
  const token = await getSpotifyToken();
  const tracks = [];
  let url = `https://api.spotify.com/v1/albums/${albumId}/tracks?limit=50`;
  while (url) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    for (const t of data.items)
      tracks.push(`${t.name} - ${t.artists?.[0]?.name || ""}`);
    url = data.next;
  }
  return tracks;
}

// ─────────────────────────────────────────────────────────────
// YouTube search
// ─────────────────────────────────────────────────────────────
async function searchYouTube(query) {
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=1&key=${YOUTUBE_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  const videoId = data.items?.[0]?.id?.videoId;
  if (!videoId) throw new Error(`No YouTube results for: ${query}`);
  return `https://www.youtube.com/watch?v=${videoId}`;
}

// ─────────────────────────────────────────────────────────────
// Parse Spotify URL
// ─────────────────────────────────────────────────────────────
function parseSpotifyUrl(url) {
  const match = url.match(
    /spotify\.com\/(track|playlist|album)\/([a-zA-Z0-9]+)/,
  );
  if (!match) return null;
  return { type: match[1], id: match[2] };
}

// ─────────────────────────────────────────────────────────────
// Main resolver — always returns { urls: [], source: 'yt'|'spotify' }
// ─────────────────────────────────────────────────────────────
async function resolveQuery(query) {
  const isUrl = query.startsWith("http://") || query.startsWith("https://");
  const isPlaylist =
    query.includes("playlist?list=") ||
    query.includes("&list=") ||
    query.includes("/sets/");

  // ── Spotify ────────────────────────────────────────────────
  if (isUrl && query.includes("spotify.com")) {
    const spotify = parseSpotifyUrl(query);
    if (!spotify) throw new Error("Invalid Spotify URL");

    if (spotify.type === "track") {
      const searchTerm = await getSpotifyTrack(spotify.id);
      const ytUrl = await searchYouTube(searchTerm);
      return { urls: [ytUrl], source: "spotify" };
    }

    if (spotify.type === "playlist") {
      const tracks = await getSpotifyPlaylist(spotify.id);
      const urls = [];
      for (const t of tracks) {
        try {
          urls.push(await searchYouTube(t));
        } catch {
          /* skip unfound */
        }
      }
      return { urls, source: "spotify" };
    }

    if (spotify.type === "album") {
      const tracks = await getSpotifyAlbum(spotify.id);
      const urls = [];
      for (const t of tracks) {
        try {
          urls.push(await searchYouTube(t));
        } catch {
          /* skip unfound */
        }
      }
      return { urls, source: "spotify" };
    }
  }

  // ── YouTube playlist ───────────────────────────────────────
  if (isUrl && isPlaylist) {
    return new Promise((resolve, reject) => {
      execFile(
        "yt-dlp",
        ["--flat-playlist", "--print", "%(url)s", "--no-warnings", query],
        { maxBuffer: 10 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            console.error("💥 Playlist error:", stderr);
            return reject(err);
          }
          const urls = stdout.trim().split("\n").filter(Boolean);
          resolve({ urls, source: "yt" });
        },
      );
    });
  }

  // ── YouTube single URL ─────────────────────────────────────
  if (isUrl) return { urls: [query], source: "yt" };

  // ── Search by name ─────────────────────────────────────────
  const ytUrl = await searchYouTube(query);
  return { urls: [ytUrl], source: "yt" };
}

// ─────────────────────────────────────────────────────────────
// Bot ready
// ─────────────────────────────────────────────────────────────
client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  client.user.setActivity("music 🎵", { type: ActivityType.Listening });
});

// ─────────────────────────────────────────────────────────────
// Slash command handler
// ─────────────────────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, user, member, guild } = interaction;

  // ── Rate limit check ───────────────────────────────────────
  const cooldown = isOnCooldown(user.id, 3);
  if (cooldown) {
    return interaction.reply({
      content: `⏳ Slow down! Wait **${cooldown}s** before using another command.`,
      ephemeral: true, // only visible to the user who triggered it
    });
  }

  console.log(`📩 /${commandName} by ${user.tag}`);

  // ────────────────────────────────────────────────────────────
  // /play
  // ────────────────────────────────────────────────────────────
  if (commandName === "play") {
    const query = interaction.options.getString("query");
    const vc = member?.voice?.channel;
    if (!vc)
      return interaction.reply({
        content: "❌ Join a voice channel first.",
        ephemeral: true,
      });

    const isSpotifyPlaylist =
      query.includes("spotify.com/playlist") ||
      query.includes("spotify.com/album");
    const isYtPlaylist =
      query.includes("playlist?list=") || query.includes("&list=");

    // Defer reply for operations that take time
    await interaction.deferReply();

    let result;
    try {
      result = await resolveQuery(query);
    } catch (err) {
      console.error("💥 resolveQuery failed:", err);
      return interaction.editReply(
        "❌ Failed to load that link. Is it public?",
      );
    }

    const { urls, source } = result;
    if (!urls || urls.length === 0)
      return interaction.editReply("❌ No songs found.");

    let serverQueue = queues.get(guild.id);
    if (!serverQueue) {
      serverQueue = new Queue();
      queues.set(guild.id, serverQueue);
    }

    // Store source alongside each URL for embed use
    urls.forEach((url) => serverQueue.add({ url, source, requester: user.id }));

    if (!serverQueue.playing) {
      const connection = joinVoiceChannel({
        channelId: vc.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
      });

      const player = new Player(connection, serverQueue, interaction.channel);
      players.set(guild.id, player);
      serverQueue.playing = true;
      player.playNext();
    }

    // Reply
    if (urls.length === 1) {
      const meta = await getYouTubeMeta(urls[0]);
      const embed = buildNowPlayingEmbed({
        title: meta.title,
        url: urls[0],
        thumbnail: meta.thumbnail,
        requester: user.id,
        source,
        queueLength: serverQueue.songs.length,
      });
      return interaction.editReply({ embeds: [embed] });
    } else {
      const sourceLabel = source === "spotify" ? "🎧 Spotify" : "📋 YouTube";
      return interaction.editReply(
        `${sourceLabel} — Added **${urls.length}** songs to queue!`,
      );
    }
  }

  // ────────────────────────────────────────────────────────────
  // /skip
  // ────────────────────────────────────────────────────────────
  if (commandName === "skip") {
    const player = players.get(guild.id);
    if (!player)
      return interaction.reply({
        content: "❌ Nothing is playing.",
        ephemeral: true,
      });
    player.audioPlayer.stop();
    return interaction.reply("⏭ Skipped!");
  }

  // ────────────────────────────────────────────────────────────
  // /stop
  // ────────────────────────────────────────────────────────────
  if (commandName === "stop") {
    const player = players.get(guild.id);
    if (player) {
      player.cleanup();
      player.audioPlayer.stop(true);
      player.connection.destroy();
    }
    queues.delete(guild.id);
    players.delete(guild.id);
    return interaction.reply("⛔ Stopped and left the channel.");
  }

  // ────────────────────────────────────────────────────────────
  // /queue
  // ────────────────────────────────────────────────────────────
  if (commandName === "queue") {
    const serverQueue = queues.get(guild.id);
    if (!serverQueue || serverQueue.songs.length === 0) {
      return interaction.reply({
        content: "📭 Queue is empty.",
        ephemeral: true,
      });
    }

    const preview = serverQueue.songs.slice(0, 10);
    const remaining = serverQueue.songs.length - preview.length;

    const list = preview
      .map((s, i) => {
        const display = s.url.startsWith("http")
          ? s.url.substring(0, 55) + "..."
          : s.url;
        return `${i + 1}. ${display}`;
      })
      .join("\n");

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`📋 Queue — ${serverQueue.songs.length} song(s)`)
      .setDescription(
        list + (remaining > 0 ? `\n_...and ${remaining} more_` : ""),
      );

    return interaction.reply({ embeds: [embed] });
  }

  // ────────────────────────────────────────────────────────────
  // /shuffle
  // ────────────────────────────────────────────────────────────
  if (commandName === "shuffle") {
    const serverQueue = queues.get(guild.id);
    if (!serverQueue || serverQueue.songs.length === 0) {
      return interaction.reply({
        content: "📭 Queue is empty.",
        ephemeral: true,
      });
    }
    serverQueue.shuffle();
    return interaction.reply("🔀 Queue shuffled!");
  }

  // ────────────────────────────────────────────────────────────
  // /clear
  // ────────────────────────────────────────────────────────────
  if (commandName === "clear") {
    const serverQueue = queues.get(guild.id);
    if (!serverQueue || serverQueue.songs.length === 0) {
      return interaction.reply({
        content: "📭 Queue is already empty.",
        ephemeral: true,
      });
    }
    const count = serverQueue.songs.length;
    serverQueue.clear();
    return interaction.reply(`🗑️ Cleared **${count}** songs from the queue.`);
  }
});

process.on("uncaughtException", (err) =>
  console.error("💥 Uncaught Exception:", err),
);
process.on("unhandledRejection", (err) =>
  console.error("💥 Unhandled Rejection:", err),
);

client.login(TOKEN);
