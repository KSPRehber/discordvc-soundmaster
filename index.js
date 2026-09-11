import "dotenv/config";
import { Readable } from "node:stream";
import { spawn, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  Client,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  ApplicationCommandOptionType,
} from "discord.js";
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  entersState,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  VoiceConnectionDisconnectReason,
  StreamType,
  NoSubscriberBehavior,
} from "@discordjs/voice";

const {
  DISCORD_TOKEN,
  ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID = "21m00Tcm4TlvDq8ikWAM", // Rachel (default ElevenLabs voice)
  ELEVENLABS_MODEL_ID = "eleven_flash_v2_5",
  MAX_MESSAGE_LENGTH = "500",
} = process.env;

if (!DISCORD_TOKEN || !ELEVENLABS_API_KEY) {
  console.error("Missing DISCORD_TOKEN or ELEVENLABS_API_KEY in .env");
  process.exit(1);
}

const MAX_LEN = Number(MAX_MESSAGE_LENGTH) || 500;

// Prefer the binary shipped with the project, fall back to a system install
const localYtdlp = path.join(import.meta.dirname, "yt-dlp");
const YTDLP = existsSync(localYtdlp) ? localYtdlp : "yt-dlp";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

/**
 * Per-guild session state.
 * guildId -> {
 *   connection, channelId,
 *   ttsPlayer, ttsQueue: string[], speaking: boolean,
 *   musicPlayer, musicQueue: Track[], current: Track | null, ytProc
 * }
 * Track: { title, url, duration, requestedBy }
 */
const sessions = new Map();

// ---------- ElevenLabs ----------

async function synthesize(text) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream?output_format=mp3_44100_128`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVENLABS_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      model_id: ELEVENLABS_MODEL_ID,
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });
  if (!res.ok) {
    throw new Error(`ElevenLabs ${res.status}: ${await res.text()}`);
  }
  return Readable.fromWeb(res.body);
}

// ---------- YouTube (yt-dlp) ----------

function ytInfo(query) {
  return new Promise((resolve, reject) => {
    execFile(
      YTDLP,
      [
        "--default-search", "ytsearch",
        "--no-playlist",
        "--flat-playlist",
        "--no-warnings",
        "-J", query,
      ],
      { maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(new Error("yt-dlp lookup failed"));
        let data;
        try {
          data = JSON.parse(stdout);
        } catch {
          return reject(new Error("yt-dlp returned invalid data"));
        }
        const entry = data._type === "playlist" ? data.entries?.[0] : data;
        if (!entry) return reject(new Error("No results found"));
        resolve({
          title: entry.title ?? "Unknown title",
          url: entry.webpage_url ?? entry.url,
          duration: entry.duration ?? null,
        });
      }
    );
  });
}

function ytStream(url) {
  return spawn(
    YTDLP,
    ["-f", "bestaudio/best", "-o", "-", "--quiet", "--no-warnings", url],
    { stdio: ["ignore", "pipe", "ignore"] }
  );
}

function fmtDuration(seconds) {
  if (seconds == null) return "";
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? ` [${h}:${pad(m % 60)}:${pad(s % 60)}]` : ` [${m}:${pad(s % 60)}]`;
}

// ---------- Music playback ----------

function playNextTrack(session) {
  if (session.ytProc) {
    session.ytProc.kill("SIGKILL");
    session.ytProc = null;
  }
  session.current = session.musicQueue.shift() ?? null;
  if (!session.current) return;

  const child = ytStream(session.current.url);
  session.ytProc = child;
  child.on("error", (err) => console.error("yt-dlp error:", err.message));
  const resource = createAudioResource(child.stdout, {
    inputType: StreamType.Arbitrary,
  });
  session.musicPlayer.play(resource);
  // Don't steal the mic mid-announcement; the TTS drain handler hands it back
  if (!session.speaking) session.connection.subscribe(session.musicPlayer);
}

// ---------- TTS queue ----------

function enqueueTts(session, text) {
  session.ttsQueue.push(text);
  if (!session.speaking) void speakNext(session);
}

async function speakNext(session) {
  const text = session.ttsQueue.shift();
  if (text === undefined) {
    session.speaking = false;
    // Give the mic back to the music and resume where it left off
    if (session.current) {
      session.connection.subscribe(session.musicPlayer);
      session.musicPlayer.unpause();
    }
    return;
  }
  session.speaking = true;
  if (session.current) session.musicPlayer.pause();
  session.connection.subscribe(session.ttsPlayer);
  try {
    const stream = await synthesize(text);
    const resource = createAudioResource(stream, {
      inputType: StreamType.Arbitrary,
    });
    session.ttsPlayer.play(resource);
  } catch (err) {
    console.error("TTS failed:", err.message);
    void speakNext(session); // skip this message, keep the queue moving
  }
}

function destroySession(guildId) {
  const session = sessions.get(guildId);
  if (!session) return;
  sessions.delete(guildId);
  session.ttsQueue.length = 0;
  session.musicQueue.length = 0;
  session.current = null;
  if (session.ytProc) session.ytProc.kill("SIGKILL");
  session.ttsPlayer.stop(true);
  session.musicPlayer.stop(true);
  if (session.connection.state.status !== VoiceConnectionStatus.Destroyed) {
    session.connection.destroy();
  }
}

// ---------- Message → speech ----------

function prepareText(message) {
  // cleanContent resolves mentions/channels to readable names
  let text = message.cleanContent
    .replace(/<a?:(\w+):\d+>/g, "$1") // custom emojis -> their name
    .replace(/https?:\/\/\S+/g, "link") // don't read URLs out loud
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  if (text.length > MAX_LEN) text = text.slice(0, MAX_LEN);
  return text;
}

client.on("messageCreate", (message) => {
  if (message.author.bot || !message.inGuild()) return;
  const session = sessions.get(message.guildId);
  // Only read the text chat built into the voice channel we're sitting in
  if (!session || message.channelId !== session.channelId) return;
  const text = prepareText(message);
  if (text) enqueueTts(session, text);
});

// ---------- Voice connection ----------

async function connect(voiceChannel) {
  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    selfDeaf: true, // deafened, mic open
    selfMute: false,
  });

  connection.on("stateChange", (oldS, newS) => {
    if (oldS.status !== newS.status)
      console.log(`Voice: ${oldS.status} -> ${newS.status}`);
  });

  const ttsPlayer = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
  });
  const musicPlayer = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
  });
  connection.subscribe(ttsPlayer);

  const session = {
    connection,
    channelId: voiceChannel.id,
    ttsPlayer,
    ttsQueue: [],
    speaking: false,
    musicPlayer,
    musicQueue: [],
    current: null,
    ytProc: null,
  };

  ttsPlayer.on(AudioPlayerStatus.Idle, () => void speakNext(session));
  ttsPlayer.on("error", (err) => {
    console.error("TTS player error:", err.message);
    void speakNext(session);
  });

  musicPlayer.on(AudioPlayerStatus.Idle, () => playNextTrack(session));
  musicPlayer.on("error", (err) => {
    console.error("Music player error:", err.message);
    playNextTrack(session);
  });

  connection.on(VoiceConnectionStatus.Disconnected, async (_old, newState) => {
    // Moved between channels or websocket hiccup -> let it resume; otherwise clean up
    if (
      newState.reason === VoiceConnectionDisconnectReason.WebSocketClose &&
      newState.closeCode === 4014
    ) {
      try {
        await entersState(connection, VoiceConnectionStatus.Connecting, 5_000);
      } catch {
        destroySession(voiceChannel.guild.id);
      }
    } else if (connection.rejoinAttempts < 5) {
      setTimeout(() => connection.rejoin(), (connection.rejoinAttempts + 1) * 5_000);
    } else {
      destroySession(voiceChannel.guild.id);
    }
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
  } catch (err) {
    connection.destroy();
    throw err;
  }

  sessions.set(voiceChannel.guild.id, session);
  return session;
}

// Leave automatically when the bot is alone in the channel; track channel moves
client.on("voiceStateUpdate", (oldState, newState) => {
  const guildId = oldState.guild.id;
  const session = sessions.get(guildId);
  if (!session) return;

  // If the bot itself was moved to another channel, follow its text chat
  if (newState.id === client.user.id && newState.channelId) {
    session.channelId = newState.channelId;
  }

  const channel = oldState.guild.channels.cache.get(session.channelId);
  if (channel && channel.members.filter((m) => !m.user.bot).size === 0) {
    destroySession(guildId);
  }
});

// ---------- Slash commands ----------

const commands = [
  {
    name: "call",
    description: "Join your voice channel and read its text chat aloud",
  },
  { name: "leave", description: "Leave the voice channel" },
  {
    name: "play",
    description: "Play a song from YouTube (URL or search)",
    options: [
      {
        name: "song",
        description: "YouTube link or search terms",
        type: ApplicationCommandOptionType.String,
        required: true,
      },
    ],
  },
  { name: "skip", description: "Skip what's currently playing (message or song)" },
  { name: "pause", description: "Pause the music" },
  { name: "resume", description: "Resume the music" },
  { name: "queue", description: "Show the music queue" },
  { name: "stop", description: "Stop the music and clear the queue" },
];

async function ensureSession(interaction) {
  const voiceChannel = interaction.member.voice?.channel;
  if (!voiceChannel) {
    return { error: "You need to be in a voice channel first." };
  }
  const existing = sessions.get(interaction.guildId);
  if (existing?.channelId === voiceChannel.id) return { session: existing };

  const perms = voiceChannel.permissionsFor(interaction.guild.members.me);
  if (
    !perms.has(PermissionFlagsBits.Connect) ||
    !perms.has(PermissionFlagsBits.Speak)
  ) {
    return { error: "I don't have permission to connect and speak in that channel." };
  }
  if (existing) destroySession(interaction.guildId);
  try {
    return { session: await connect(voiceChannel), joined: voiceChannel };
  } catch (err) {
    console.error("Failed to join voice:", err);
    return { error: "Couldn't connect to the voice channel, try again." };
  }
}

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand() || !interaction.inGuild()) return;

  const reply = (content) =>
    interaction.reply({ content, flags: MessageFlags.Ephemeral });
  const session = sessions.get(interaction.guildId);

  switch (interaction.commandName) {
    case "call": {
      if (session && session.channelId === interaction.member.voice?.channelId) {
        return reply("I'm already in your channel.");
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const res = await ensureSession(interaction);
      return interaction.editReply(
        res.error ??
          `Joined **${res.joined?.name ?? "your channel"}** — I'll read messages from its text chat.`
      );
    }

    case "leave": {
      if (!session) return reply("I'm not in a voice channel.");
      if (interaction.member.voice?.channelId !== session.channelId) {
        return reply("You need to be in my voice channel to send me away.");
      }
      destroySession(interaction.guildId);
      return reply("Left the voice channel. 👋");
    }

    case "play": {
      await interaction.deferReply();
      const res = await ensureSession(interaction);
      if (res.error) return interaction.editReply(res.error);
      const s = res.session;

      let track;
      try {
        track = await ytInfo(interaction.options.getString("song", true));
      } catch (err) {
        return interaction.editReply(`Couldn't find that: ${err.message}`);
      }
      track.requestedBy = interaction.member.displayName;
      s.musicQueue.push(track);

      if (!s.current) {
        playNextTrack(s);
        return interaction.editReply(
          `🎵 Now playing: **${track.title}**${fmtDuration(track.duration)}`
        );
      }
      return interaction.editReply(
        `➕ Queued (#${s.musicQueue.length}): **${track.title}**${fmtDuration(track.duration)}`
      );
    }

    case "skip": {
      if (!session) return reply("I'm not in a voice channel.");
      if (session.speaking) {
        session.ttsPlayer.stop(); // Idle handler advances the TTS queue
        return reply("Skipped the message.");
      }
      if (session.current) {
        const skipped = session.current.title;
        session.musicPlayer.stop(); // Idle handler starts the next track
        return reply(`⏭️ Skipped **${skipped}**.`);
      }
      return reply("Nothing is playing right now.");
    }

    case "pause": {
      if (!session?.current) return reply("No music is playing.");
      session.musicPlayer.pause();
      return reply("⏸️ Paused.");
    }

    case "resume": {
      if (!session?.current) return reply("No music is playing.");
      if (session.speaking) return reply("Wait for me to finish reading a message.");
      session.musicPlayer.unpause();
      return reply("▶️ Resumed.");
    }

    case "queue": {
      if (!session || (!session.current && session.musicQueue.length === 0)) {
        return reply("The queue is empty.");
      }
      const lines = [];
      if (session.current) {
        lines.push(
          `**Now playing:** ${session.current.title}${fmtDuration(session.current.duration)} — ${session.current.requestedBy}`
        );
      }
      session.musicQueue.slice(0, 10).forEach((t, i) => {
        lines.push(`\`${i + 1}.\` ${t.title}${fmtDuration(t.duration)} — ${t.requestedBy}`);
      });
      if (session.musicQueue.length > 10) {
        lines.push(`…and ${session.musicQueue.length - 10} more`);
      }
      return reply(lines.join("\n"));
    }

    case "stop": {
      if (!session?.current && !session?.musicQueue.length) {
        return reply("No music is playing.");
      }
      session.musicQueue.length = 0;
      session.current = null;
      if (session.ytProc) {
        session.ytProc.kill("SIGKILL");
        session.ytProc = null;
      }
      session.musicPlayer.stop(true);
      return reply("⏹️ Stopped the music and cleared the queue.");
    }
  }
});

// ---------- Startup ----------

client.once("clientReady", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  // Per-guild registration is instant (global can take up to an hour to propagate)
  for (const guild of client.guilds.cache.values()) {
    await guild.commands.set(commands).catch((err) =>
      console.error(`Failed to register commands in ${guild.name}:`, err.message)
    );
  }
  console.log(`Slash commands registered in ${client.guilds.cache.size} guild(s).`);
});

client.on("guildCreate", (guild) => {
  guild.commands.set(commands).catch(console.error);
});

client.login(DISCORD_TOKEN);
