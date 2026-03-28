const {
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  StreamType,
  VoiceConnectionStatus,
} = require("@discordjs/voice");
const { EmbedBuilder } = require("discord.js");
const { spawn } = require("child_process");

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

class Player {
  constructor(connection, queue, textChannel) {
    this.connection = connection;
    this.queue = queue;
    this.textChannel = textChannel; // send now playing embeds here
    this.audioPlayer = createAudioPlayer();
    this.ytdlp = null;
    this.ffmpeg = null;

    this.connection.subscribe(this.audioPlayer);

    this.connection.on("stateChange", (oldState, newState) => {
      console.log(`🔄 Voice state: ${oldState.status} → ${newState.status}`);
      if (newState.status === VoiceConnectionStatus.Disconnected) {
        console.log("⚠️ Disconnected — stopping.");
        this.cleanup();
        this.queue.playing = false;
        this.audioPlayer.stop(true);
      }
    });

    this.audioPlayer.on(AudioPlayerStatus.Idle, () => {
      console.log("⏭ Song ended — checking queue...");
      this.playNext();
    });

    this.audioPlayer.on("error", (error) => {
      console.error("💥 Audio player error:", error.message);
      this.cleanup();
      this.playNext();
    });

    this.audioPlayer.on("stateChange", (oldState, newState) => {
      console.log(`🎶 Player: ${oldState.status} → ${newState.status}`);
    });
  }

  cleanup() {
    if (this.ytdlp) {
      try {
        this.ytdlp.kill("SIGKILL");
      } catch (_) {}
      this.ytdlp = null;
    }
    if (this.ffmpeg) {
      try {
        this.ffmpeg.kill("SIGKILL");
      } catch (_) {}
      this.ffmpeg = null;
    }
  }

  // Fetch YouTube title + thumbnail for embed
  async getYouTubeMeta(videoUrl) {
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

  // Send now playing embed to the text channel
  async sendNowPlayingEmbed(song) {
    if (!this.textChannel) return;
    try {
      const meta = await this.getYouTubeMeta(song.url);
      const source = song.source || "yt";
      const color = source === "spotify" ? 0x1db954 : 0xff0000;
      const sourceLabel =
        source === "spotify" ? "🎧 Spotify → YouTube" : "▶️ YouTube";

      const embed = new EmbedBuilder()
        .setColor(color)
        .setAuthor({ name: "🎵 Now Playing" })
        .setTitle(meta.title)
        .setURL(song.url)
        .setThumbnail(meta.thumbnail)
        .addFields(
          { name: "Source", value: sourceLabel, inline: true },
          {
            name: "Requested",
            value: `<@${song.requester || "0"}>`,
            inline: true,
          },
          {
            name: "In Queue",
            value: `${this.queue.songs.length} song(s)`,
            inline: true,
          },
        )
        .setFooter({
          text: "Use /skip to skip • /stop to stop • /queue to view queue",
        })
        .setTimestamp();

      this.textChannel.send({ embeds: [embed] });
    } catch (err) {
      console.error("💥 Failed to send now playing embed:", err.message);
    }
  }

  playNext() {
    this.cleanup();

    if (this.queue.songs.length === 0) {
      console.log("📭 Queue empty — done.");
      this.queue.playing = false;
      setTimeout(() => {
        if (!this.queue.playing) {
          try {
            this.connection.destroy();
          } catch (_) {}
        }
      }, 30_000);
      return;
    }

    const song = this.queue.songs.shift(); // { url, source, requester }
    console.log(`▶️ Now playing: ${song.url}`);

    // Send now playing embed (non-blocking)
    this.sendNowPlayingEmbed(song);

    // ── yt-dlp ─────────────────────────────────────────────────
    this.ytdlp = spawn(
      "yt-dlp",
      [
        "-f",
        "bestaudio[ext=webm]/bestaudio[acodec=opus]/bestaudio",
        "--no-warnings",
        "-o",
        "-",
        song.url,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    this.ytdlp.stderr.on("data", (data) =>
      console.log(`[yt-dlp] ${data.toString().trim()}`),
    );
    this.ytdlp.on("error", (err) => {
      console.error("💥 yt-dlp error:", err.message);
      this.cleanup();
      this.playNext();
    });

    // ── ffmpeg ─────────────────────────────────────────────────
    this.ffmpeg = spawn(
      "ffmpeg",
      [
        "-i",
        "pipe:0",
        "-f",
        "s16le",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-af",
        "volume=0.85",
        "-loglevel",
        "warning",
        "pipe:1",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    this.ffmpeg.stderr.on("data", (data) =>
      console.log(`[ffmpeg] ${data.toString().trim()}`),
    );
    this.ffmpeg.on("error", (err) => {
      console.error("💥 ffmpeg error:", err.message);
      this.cleanup();
      this.playNext();
    });
    this.ffmpeg.on("close", (code) => {
      if (code !== 0 && code !== null)
        console.warn(`⚠️ ffmpeg exited with code ${code}`);
    });

    this.ytdlp.stdout.pipe(this.ffmpeg.stdin);

    this.ffmpeg.stdin.on("error", (err) => {
      if (err.code !== "EPIPE") console.error("💥 ffmpeg stdin:", err.message);
    });
    this.ytdlp.stdout.on("error", (err) => {
      if (err.code !== "EPIPE") console.error("💥 yt-dlp stdout:", err.message);
    });

    const resource = createAudioResource(this.ffmpeg.stdout, {
      inputType: StreamType.Raw,
    });
    resource.playStream.on("error", (err) => {
      console.error("💥 Resource stream error:", err.message);
      this.cleanup();
      this.playNext();
    });

    this.audioPlayer.play(resource);
  }
}

module.exports = Player;
