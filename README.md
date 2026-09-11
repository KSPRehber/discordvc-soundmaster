# Discord TTS Bot

Joins your voice channel (self-deafened, mic open), watches that voice channel's
built-in text chat, and reads every message aloud with ElevenLabs TTS.

## Commands

| Command        | What it does                                                            |
| -------------- | ----------------------------------------------------------------------- |
| `/call`        | Joins the voice channel **you** are in and starts reading its text chat |
| `/leave`       | Leaves the voice channel (you must be in the same channel)              |
| `/play <song>` | Plays a YouTube link or search query (joins your channel if needed)     |
| `/skip`        | Skips what's currently playing — the TTS message, or the song           |
| `/pause`       | Pauses the music                                                        |
| `/resume`      | Resumes the music                                                       |
| `/queue`       | Shows the music queue                                                   |
| `/stop`        | Stops the music and clears the queue                                    |

While music is playing, incoming chat messages pause it, get read aloud, then
the song resumes where it left off. The bot leaves automatically when everyone
else leaves the channel.

Music is streamed with a `yt-dlp` binary in the project root (a system-wide
`yt-dlp` is used as fallback). It is not committed to git — download it with:

```sh
curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o yt-dlp
chmod +x yt-dlp
```

If YouTube ever starts erroring, update it with `./yt-dlp -U`.

## Setup

1. **Create the Discord application** at <https://discord.com/developers/applications>:
   - **Bot** tab → copy the token.
   - **Bot** tab → enable the **Message Content Intent** (required — it reads chat).
   - **OAuth2 → URL Generator**: scopes `bot` + `applications.commands`;
     bot permissions `Connect`, `Speak`, `View Channels`, `Read Message History`.
     Open the generated URL to invite the bot.

2. **Get an ElevenLabs API key** at <https://elevenlabs.io> (Profile → API Keys).

3. **Configure and run**:

   ```sh
   cp .env.example .env   # then fill in DISCORD_TOKEN and ELEVENLABS_API_KEY
   npm install
   npm start
   ```

`ffmpeg` must be installed on the system (it is used to decode the ElevenLabs
MP3 stream into Discord's audio format).

## How it works

- `/call` connects with `selfDeaf: true, selfMute: false` — the bot can't hear
  voice audio, only speak.
- It only reads messages posted in the **text chat of the voice channel it is
  sitting in** (the chat icon on the voice channel), not other text channels.
- Messages are queued per guild, so overlapping messages play in order.
- Mentions are read as names, URLs are read as "link", custom emojis as their
  name, and messages are truncated at `MAX_MESSAGE_LENGTH` characters.
