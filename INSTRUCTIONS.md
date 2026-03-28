# 🎵 Music Bot — Lavalink Railway Deployment Guide

## Overview

Your bot now uses **Lavalink** for audio. You need **two Railway services**:

| Service | What it runs | Docker context |
|---------|-------------|----------------|
| `music-bot` | Node.js bot | root `Dockerfile` |
| `lavalink` | Java audio server | `lavalink/Dockerfile` |

---

## Step 1 — Prepare the repo

You can delete these files — they are no longer needed:
```
ffmpeg.exe
ffplay.exe
ffprobe.exe
yt-dlp.exe
player.js
queue.js
cookies.txt
```

Commit and push everything to GitHub.

---

## Step 2 — Deploy the Lavalink service on Railway

1. Go to [railway.app](https://railway.app) → your project.
2. Click **+ New Service → GitHub Repo** → select this repo.
3. In the service settings → **Build** tab:
   - Set **Root Directory** to `lavalink`
   - Railway will automatically use `lavalink/Dockerfile`
4. Set these **Environment Variables** on the Lavalink service:

   | Variable | Value |
   |----------|-------|
   | `LAVALINK_PASSWORD` | A strong password (e.g. `s3cur3p@ss`) |
   | `SPOTIFY_CLIENT_ID` | Your Spotify app client ID |
   | `SPOTIFY_CLIENT_SECRET` | Your Spotify app client secret |

5. Set **Networking** → expose port `2333` internally (Railway does this automatically for private networking).
6. Deploy. In logs you should see:
   ```
   Lavalink is ready to accept connections.
   ```

> [!NOTE]
> Spotify credentials are only needed on the **Lavalink** service, not the bot service.

---

## Step 3 — Deploy the Bot service on Railway

1. Click **+ New Service → GitHub Repo** → same repo again.
2. Root directory stays as `/` (default). Railway uses the root `Dockerfile`.
3. Set these **Environment Variables** on the bot service:

   | Variable | Value |
   |----------|-------|
   | `DISCORD_TOKEN` | Your bot token |
   | `DISCORD_CLIENT_ID` | Your bot application ID |
   | `LAVALINK_HOST` | Internal hostname of the Lavalink service (see below) |
   | `LAVALINK_PORT` | `2333` |
   | `LAVALINK_PASSWORD` | Same password used in the Lavalink service |
   | `LAVALINK_SECURE` | `false` |

### Getting the Lavalink internal hostname

In Railway, go to your **Lavalink service → Settings → Networking**. Copy the **Private Domain** (looks like `lavalink.railway.internal`). Use that as `LAVALINK_HOST`.

4. Deploy. In logs you should see:
   ```
   ✅ Logged in as YourBot#1234
   ✅ Lavalink node connected: railway-lavalink
   ```

---

## Step 4 — Register Slash Commands

Run this **once** locally (with your `.env` filled in):

```bash
npm install
node deploy.js
```

✅ `Slash commands registered!`

---

## Available Commands

| Command | Description |
|---------|-------------|
| `/play <query>` | Play a song, YouTube URL/playlist, or Spotify link |
| `/skip` | Skip current song |
| `/pause` | Pause playback |
| `/resume` | Resume playback |
| `/stop` | Stop and leave voice channel |
| `/nowplaying` | Show currently playing song |
| `/queue` | Show the queue |
| `/shuffle` | Shuffle the queue |
| `/clear` | Clear the queue |
| `/volume <0-200>` | Set volume |

---

## Spotify Support

Spotify is handled by the **LavaSrc plugin** running inside Lavalink — no special code needed in the bot. Just paste a Spotify track, album, or playlist URL into `/play`.

You need a **free** Spotify developer app:
1. Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
2. Create an app → copy **Client ID** and **Client Secret**
3. Set as `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` on the **Lavalink** Railway service

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `Lavalink node error: connect ECONNREFUSED` | Wrong `LAVALINK_HOST` or Lavalink service not running |
| Bot joins but no audio | Check Lavalink logs for plugin download errors |
| Spotify not loading | Check `SPOTIFY_CLIENT_ID`/`SECRET` on Lavalink service |
| Commands not showing in Discord | Re-run `node deploy.js` |
