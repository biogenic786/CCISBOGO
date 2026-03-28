const {
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  StreamType,
  VoiceConnectionStatus,
} = require("@discordjs/voice");
const { EmbedBuilder } = require("discord.js");
const { spawn } = require("child_process");
const fs = require("fs");

class Player {
  constructor(connection, queue, textChannel) {
    this.connection = connection;
    this.queue = queue;
    this.textChannel = textChannel;

    this.audioPlayer = createAudioPlayer();
    this.connection.subscribe(this.audioPlayer);

    this.current = null;
    this.startTime = null;

    this.connection.on("stateChange", (_, n) => {
      if (n.status === VoiceConnectionStatus.Disconnected) {
        this.cleanup();
        this.queue.playing = false;
        this.audioPlayer.stop(true);
      }
    });

    this.audioPlayer.on(AudioPlayerStatus.Idle, () => {
      this.playNext();
    });

    this.audioPlayer.on("error", (err) => {
      console.error("💥 Player error:", err.message);
      this.retryOrSkip();
    });
  }

  cleanup() {
    if (this.proc) {
      try {
        this.proc.kill("SIGKILL");
      } catch {}
      this.proc = null;
    }
  }

  // ─────────────────────────────
  // Progress bar
  // ─────────────────────────────
  progressBar(current, total, size = 20) {
    const percent = current / total;
    const filled = Math.round(size * percent);
    return "▰".repeat(filled) + "▱".repeat(size - filled);
  }

  formatTime(sec) {
    if (!sec) return "0:00";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60)
      .toString()
      .padStart(2, "0");
    return `${m}:${s}`;
  }

  async getMeta(url) {
    return {
      title: url,
      duration: 180, // fallback (yt-dlp metadata parsing is optional upgrade)
    };
  }

  // Player class
  async sendNowPlaying(song) {
    if (!this.textChannel) return;
    const meta = await this.getMeta(song.url);
    const embed = new EmbedBuilder().setTitle(meta.title);
    // send normal message — NOT interaction.reply
    this.textChannel.send({ embeds: [embed] });
  }

  // ─────────────────────────────
  // Retry system
  // ─────────────────────────────
  retryOrSkip() {
    if (!this.current) return this.playNext();

    this.current.retries = (this.current.retries || 0) + 1;

    if (this.current.retries <= 2) {
      console.log("🔁 Retrying...");
      this.play(this.current);
    } else {
      console.log("⏭ Skipping (failed)");
      this.playNext();
    }
  }

  // ─────────────────────────────
  // Preload next song (no-gap)
  // ─────────────────────────────
  preloadNext() {
    if (this.queue.songs.length === 0) return;

    const next = this.queue.songs[0];
    console.log("⚡ Preloading next:", next.url);

    spawn("yt-dlp", [
      "-f",
      "bestaudio[ext=webm]/bestaudio",
      "-o",
      "-",
      next.url,
    ]);
  }

  // ─────────────────────────────
  // Play
  // ─────────────────────────────
  play(song) {
    this.cleanup();

    this.current = song;
    this.startTime = Date.now();

    const args = [
      "-f",
      "bestaudio[ext=webm]/bestaudio",
      "--no-warnings",
      "-o",
      "-",
      song.url,
    ];

    if (fs.existsSync("cookies.txt")) {
      args.unshift("--cookies", "cookies.txt");
    }

    this.proc = spawn("yt-dlp", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.proc.stderr.on("data", (d) => console.log("[yt-dlp]", d.toString()));

    this.proc.on("close", (code) => {
      if (code !== 0) this.retryOrSkip();
    });

    const resource = createAudioResource(this.proc.stdout, {
      inputType: StreamType.WebmOpus,
    });

    this.audioPlayer.play(resource);

    this.sendNowPlaying(song);
    this.preloadNext();
  }

  playNext() {
    if (this.queue.songs.length === 0) {
      console.log("📭 Queue empty");
      this.queue.playing = false;
      return;
    }

    const song = this.queue.songs.shift();
    this.play(song);
  }
}

module.exports = Player;
