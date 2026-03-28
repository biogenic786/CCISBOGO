const {
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  StreamType,
  VoiceConnectionStatus
} = require('@discordjs/voice');
const { spawn } = require('child_process');

class Player {
  constructor(connection, queue) {
    this.connection = connection;
    this.queue = queue;
    this.audioPlayer = createAudioPlayer();
    this.ytdlp = null;
    this.ffmpeg = null;

    this.connection.subscribe(this.audioPlayer);

    // Handle voice disconnects
    this.connection.on('stateChange', (oldState, newState) => {
      console.log(`🔄 Voice state: ${oldState.status} → ${newState.status}`);
      if (newState.status === VoiceConnectionStatus.Disconnected) {
        console.log('⚠️ Disconnected — stopping.');
        this.cleanup();
        this.queue.playing = false;
        this.audioPlayer.stop(true);
      }
    });

    // Auto-play next when current song ends
    this.audioPlayer.on(AudioPlayerStatus.Idle, () => {
      console.log('⏭ Song ended — checking queue...');
      this.playNext();
    });

    // Audio player error: skip to next
    this.audioPlayer.on('error', error => {
      console.error('💥 Audio player error:', error.message);
      this.cleanup();
      this.playNext();
    });

    this.audioPlayer.on('stateChange', (oldState, newState) => {
      console.log(`🎶 Player: ${oldState.status} → ${newState.status}`);
    });
  }

  // Kill any running yt-dlp / ffmpeg processes to prevent leaks
  cleanup() {
    if (this.ytdlp) {
      try { this.ytdlp.kill('SIGKILL'); } catch (_) {}
      this.ytdlp = null;
    }
    if (this.ffmpeg) {
      try { this.ffmpeg.kill('SIGKILL'); } catch (_) {}
      this.ffmpeg = null;
    }
  }

  playNext() {
    this.cleanup();

    if (this.queue.songs.length === 0) {
      console.log('📭 Queue empty — done.');
      this.queue.playing = false;

      // Auto-disconnect after 30s of silence
      setTimeout(() => {
        if (!this.queue.playing) {
          try { this.connection.destroy(); } catch (_) {}
        }
      }, 30_000);
      return;
    }

    const query = this.queue.songs.shift();
    const isUrl = query.startsWith('http://') || query.startsWith('https://');

    // Use ytsearch1: for name-based searches
    const ytdlpTarget = isUrl ? query : `ytsearch1:${query}`;
    console.log(`▶️ Now playing: ${query}`);

    // ── yt-dlp ──────────────────────────────────────────────────
    // NOTE: No --no-playlist here. Playlist URLs are already
    // expanded into individual video URLs by resolveQuery()
    // in index.js before they reach the queue, so each entry
    // in the queue is always a single video URL or search term.
    this.ytdlp = spawn('yt-dlp', [
      '-f', 'bestaudio[ext=webm]/bestaudio[acodec=opus]/bestaudio',
      '--no-warnings',
      '-o', '-',
      ytdlpTarget
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    this.ytdlp.stderr.on('data', data => {
      console.log(`[yt-dlp] ${data.toString().trim()}`);
    });

    this.ytdlp.on('error', err => {
      console.error('💥 yt-dlp error:', err.message);
      this.cleanup();
      this.playNext();
    });

    // ── ffmpeg ───────────────────────────────────────────────────
    this.ffmpeg = spawn('ffmpeg', [
      '-i', 'pipe:0',
      '-f', 's16le',
      '-ar', '48000',
      '-ac', '2',
      '-af', 'volume=0.85',
      '-loglevel', 'warning',
      'pipe:1'
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    this.ffmpeg.stderr.on('data', data => {
      console.log(`[ffmpeg] ${data.toString().trim()}`);
    });

    this.ffmpeg.on('error', err => {
      console.error('💥 ffmpeg error:', err.message);
      this.cleanup();
      this.playNext();
    });

    this.ffmpeg.on('close', code => {
      if (code !== 0 && code !== null) {
        console.warn(`⚠️ ffmpeg exited with code ${code}`);
      }
    });

    // Pipe yt-dlp → ffmpeg
    this.ytdlp.stdout.pipe(this.ffmpeg.stdin);

    // Suppress expected EPIPE errors on skip
    this.ffmpeg.stdin.on('error', err => {
      if (err.code !== 'EPIPE') console.error('💥 ffmpeg stdin error:', err.message);
    });
    this.ytdlp.stdout.on('error', err => {
      if (err.code !== 'EPIPE') console.error('💥 yt-dlp stdout error:', err.message);
    });

    const resource = createAudioResource(this.ffmpeg.stdout, {
      inputType: StreamType.Raw
    });

    resource.playStream.on('error', err => {
      console.error('💥 Resource stream error:', err.message);
      this.cleanup();
      this.playNext();
    });

    this.audioPlayer.play(resource);
  }
}

module.exports = Player;
