# TitanBot - Ultimate Discord Bot

**TitanBot** is a powerful, feature-rich Discord bot designed to enhance your server experience with comprehensive moderation tools, engaging economy systems, utility features, and much more. Built with modern Discord.js v14 and PostgreSQL for optimal performance and data persistence.

[![Support Server](https://img.shields.io/badge/-Support%20Server-%235865F2?logo=discord&logoColor=white&style=flat-square&logoWidth=20)](https://discord.gg/8kJBYhTGW9)
[![Discord.js](https://img.shields.io/npm/v/discord.js?style=flat-square&labelColor=%23202225&color=%23202225&logo=npm&logoColor=white&logoWidth=20)](https://www.npmjs.com/package/discord.js)
![PostgreSQL](https://img.shields.io/badge/-PostgreSQL-%23336791?logo=postgresql&logoColor=white&style=flat-square&logoWidth=20)

## Table of Contents

- [Features Overview](#features-overview)
- [Ticket AI Assistant](#ticket-ai)
- [Quick Setup](#quick-setup)
- [Manual Installation Steps](#manual-installation-steps)
- [Support Server](https://discord.gg/QnWNz2dKCE)
- [Required Bot Intents](#bot-intents)
- [Contributing](CONTRIBUTING.md)

<a name="features-overview"></a>
## Features Overview

TitanBot offers a complete suite of tools for Discord server management and community engagement:

<table>
<tr>
<td width="50%" valign="top">

### Moderation & Administration
- **Mass Actions** - Bulk ban/kick capabilities
- **User Notes** - Keep detailed moderation records
- **Case Management** - View and track all mod actions
- **Honeypot** - Bait channel that catches spam bots; anyone who messages there is softbanned (kicked) and counted

### Economy System
- **Shop & Inventory** - Buy and manage items
- **Gambling** - Risk it for rewards
- **Pay System** - Transfer money between users

### Fun & Entertainment
- **Random Facts** - Learn something new
- **Wanted Poster** - Create fun wanted images
- **Text Reversal** - Reverse any text

### Advanced Ticket System
- **AI Assistant** - Turns on automatically in every new ticket (answer-only, no actions)
- **Request Human** - One-click escalation that pings staff and pauses the AI in that ticket
- **Claim & Priority** - Staff ticket management
- **Ticket Limits** - Prevent spam
- **Transcript System** - Save ticket history

### Server Stats
- **Member Counter** - Live member count channels
- **Voice Counters** - Track voice stats
- **Dynamic Updates** - Real-time channel updates

### Reaction Roles
- **Role Assignment** - Self-assignable roles
- **Emoji Selection** - Reaction-based system
- **Multi-role Support** - Multiple role options

</td>
<td width="50%" valign="top">

### Leveling & XP System
- **XP Tracking** - Automatic message-based XP
- **Level Roles** - Auto-assign roles by level
- **Custom Configuration** - Personalize leveling

### Giveaways & Events
- **Multiple Winners** - Support multi-winner giveaways
- **Auto Picking** - Automatic winner selection
- **Reroll System** - Pick new winners if needed

### Birthday System
- **Birthday Tracking** - Never miss a birthday
- **Auto Announcements** - Celebrate automatically
- **Timezone Support** - Accurate worldwide tracking

### Utility Tools
- **Report System** - Report issues to staff
- **Todo Lists** - Personal task management
- **First Message** - Jump to channel's first message

### Welcome System
- **Welcome Messages** - Greet new members
- **Auto Roles** - Assign roles on join
- **Custom Embeds** - Personalized messages
  
### Music
- **24/7 Mode** - Play music 24/7
- **Interactive Button System** - Manage music through buttons
- **YouTube Support** - Play YouTube videos, Shorts, and playlists by link, or search YouTube / YouTube Music
- **Multi-Platform** - Also plays spotify, deezer, soundcloud, and apple music links
  
</td>
</tr>
</table>

<a name="honeypot"></a>
## Honeypot (Spam Bot Trap)

The honeypot posts a warning embed in a channel of your choice. Any message sent there
(bot or human) is deleted and the author is **softbanned** (kicked). Every kick increments
the counter in the embed footer.

```
/honeypot setup [channel]   Post the honeypot embed (defaults to the current channel)
/honeypot text              Change the heading, description, counter label, icon, or color
/honeypot status            Show the current honeypot configuration
/honeypot remove            Delete the embed and disable the honeypot
```

The default embed style:

```
[icon] DO NOT SEND
       MESSAGES IN THIS
       CHANNEL

This channel is used to catch spam bots. Any messages sent here will result in a **softban.**

Kicks: 0
```

Requires the **Manage Server** permission. The bot needs **View Channel**, **Send Messages**,
and **Embed Links** in the honeypot channel, plus **Kick Members** to softban offenders.
Server owners and administrators are never kicked by the honeypot.

<a name="ticket-ai"></a>
## Ticket AI Assistant

TitanBot can answer basic questions inside support tickets automatically.

- **Answer-first by design** — the assistant replies with text and has no tools. Its only
  safety-scoped side effects are closing a resolved ticket and warning the ticket creator
  for clear, deliberate misuse; it can never give/remove roles, ban, timeout, manage
  channels, change permissions, run commands, generate images, create files, or take any
  other action. Three AI warnings are required before a kick is considered.
- **Always on** — when a ticket is created, the assistant greets the user and starts answering.
  There is no enable command.
- **Player reports** — if the ticket looks like a player report, the assistant keeps asking until
  the reporter gives a **username** and a **video** (upload or clip link).
- **Request Human button** — every ticket shows a **🧑‍💼 Request Human** button.
  Clicking it pings the configured staff user and the AI **stops replying** in that ticket.
- **Honest fallback** — if the AI doesn't know an answer or can't help, it says so and
  points the user to Request Human instead of making things up.
- **Spam-safe** — burst coalescing, per-user rate limits, a per-ticket reply cap, duplicate
  reply suppression, and a provider circuit breaker keep it quiet and cheap.
- Replies are sent as embeds with all mention parsing disabled, so the AI can never ping
  `@everyone`, roles, or users.

### Setup

Add an OpenAI-compatible API key to your environment and restart the bot:

```env
AI_TICKETS_ENABLED=true
AI_API_KEY=your_api_key_here
# Leave the next two blank to auto-detect from the key prefix
# (gsk_ → Groq, sk-or- → OpenRouter, sk- → OpenAI).
# AI_API_BASE_URL=
# AI_TICKET_MODEL=
TICKET_HUMAN_NOTIFY_USER_ID=1377402826514235442   # user pinged on "Request Human"
```

`AI_API_KEY` is the documented variable. The key prefix is detected automatically,
so a Groq key (`gsk_...`) pasted there is routed to Groq — it is **not** sent to
OpenAI. A provider-specific key already in your environment is also picked up
(with a matching default endpoint and model):

| Variable | Default endpoint | Default model |
| --- | --- | --- |
| `AI_API_KEY` (`gsk_...`) | `https://api.groq.com/openai/v1` | `qwen/qwen3.6-27b` |
| `AI_API_KEY` (`sk-...`) | `https://api.openai.com/v1` | `gpt-4o-mini` |
| `OPENAI_API_KEY` | `https://api.openai.com/v1` | `gpt-4o-mini` |
| `OPENROUTER_API_KEY` | `https://openrouter.ai/api/v1` | `openai/gpt-4o-mini` |
| `GROQ_API_KEY` | `https://api.groq.com/openai/v1` | `qwen/qwen3.6-27b` |
| `DEEPSEEK_API_KEY` | `https://api.deepseek.com/v1` | `deepseek-chat` |
| `TOGETHER_API_KEY` | `https://api.together.xyz/v1` | `Llama-3.1-8B-Instruct-Turbo` |
| `XAI_API_KEY` | `https://api.x.ai/v1` | `grok-2-latest` |
| `MISTRAL_API_KEY` | `https://api.mistral.ai/v1` | `mistral-small-latest` |

A *custom* `AI_API_BASE_URL` / `AI_TICKET_MODEL` still overrides the defaults.
The stock `.env.example` OpenAI values (`https://api.openai.com/v1`, `gpt-4o-mini`)
are ignored when the key is clearly from another provider, so copying the example
file next to a Groq key no longer 401s. Keys are read tolerantly — surrounding
quotes, trailing newlines and stray whitespace (the usual result of pasting into
a hosting panel) are stripped automatically.

> Groq's old default `llama-3.1-8b-instant` is shut down for free/developer
> tiers on 2026-08-16. TitanBot now uses `qwen/qwen3.6-27b` on Groq.
> `openai/gpt-oss-20b` was tried first but **forces tool calling**: plain text
> requests get rejected with HTTP 400 `tool_use_failed` ("Tool choice is none,
> but model called a tool"). If you explicitly set `AI_TICKET_MODEL` to a
> gpt-oss model, the bot automatically retries with tool use pinned off and a
> lower temperature, but the Qwen default is the reliable choice.

Without a key, chat answers stay off. Player-report collection (username + video) and AI logs still work. Clear, deliberate spam/trolling still receives the same guarded AI warning flow when the assistant is enabled, so a provider refusing to emit an action token cannot silently disable warnings.

### AI logs (player reports)

Pick where the assistant should post report logs:

```
/ticket ai logs channel:#staff-ai-logs
```

That channel receives a log when a ticket looks like a **player report**, when the
reporter adds a username or video, and when the report is ready for staff.

### Verifying / troubleshooting the key

The bot prints the assistant's state on startup, e.g.
`🤖 Ticket AI: ready | key: AI_API_KEY (sk-a••••••6789) | model: gpt-4o-mini`.

If it says the AI is inactive, the message names the actual cause:

| Message | Cause / fix |
| --- | --- |
| `No API key found` | No key variable is set in the environment the bot actually runs in. |
| `still holds the example placeholder value` | `.env` was copied from `.env.example` but never edited. |
| `AI_TICKETS_ENABLED is set to a false value` | The key is fine — the master switch is off. Set it to `true`. |
| `401 Unauthorized` | The provider rejected the key (wrong/revoked key, or wrong provider for `AI_API_BASE_URL`). |
| `400 Bad Request` | The provider rejected the request. The log now includes its safe error text plus the configured endpoint and model; correct `AI_API_BASE_URL` / `AI_TICKET_MODEL` if needed. Unsupported optional parameters are retried automatically with a minimal compatible request. `Tool choice is none, but model called a tool` (Groq `tool_use_failed`) is retried automatically with tool use pinned off; if it persists, switch `AI_TICKET_MODEL` to `qwen/qwen3.6-27b`. |
| `404` | Wrong `AI_API_BASE_URL`, or the model name doesn't exist on that provider. |
| `429` | Out of quota / rate limited — check billing at your provider. |

`.env` is always read from the folder containing `package.json`, so the bot picks up
your key even when it is launched from a different working directory (systemd, pm2,
Docker). Real environment variables take priority over `.env`, except when they are
empty — a blank value never shadows a real one.

### Managing it per server

```
/ticket ai logs channel:#staff-ai-logs                 Where player-report logs are sent
/ticket ai logs channel:#staff-ai-logs notify_user:@User  Also override the Request Human ping
```

The assistant turns on automatically in every new ticket. It only responds to the ticket
creator (never to staff, bots, or commands), and only in open tickets where no human has
been requested.

<a name="quick-setup"></a>
## Quick Setup (Recommended for non-coders)

### Video Tutorial
For a detailed step-by-step setup guide, watch our comprehensive video tutorial:
[**TitanBot Setup Tutorial**](https://www.youtube.com/@TouchDisc)

## Docker Deployment (Recommended)

TitanBot is fully containerized for easy deployment.

1. **Clone the repository:**
   ```bash
   git clone https://github.com/codebymitch/TitanBot.git
   cd TitanBot
   ```

2. **Configure environment variables:**
   ```bash
   cp .env.example .env
   ```
   Set at minimum `DISCORD_TOKEN`, `CLIENT_ID`, and `GUILD_ID`. Docker Compose also reads `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB` from `.env` (defaults: `titanbot` / `password` / `titanbot`).

3. **Build and start the containers:**
   ```bash
   docker compose up -d --build
   ```

4. **Check status:**
   ```bash
   docker compose ps
   curl http://localhost:3000/health
   ```

This starts the bot and PostgreSQL. The compose file sets `POSTGRES_SSL=false` and `AUTO_MIGRATE=true` for the bundled database. Music uses public Lavalink v4 nodes from `lavalink/nodes.json` by default.

### Music

Music uses [Lavalink v4](https://github.com/lavalink-devs/Lavalink) via [Riffy](https://github.com/riffy-rb/riffy), similar to [Musicify](https://github.com/codebymitch/Musicify).

1. By default, the bot loads multiple public v4 SSL nodes from [`lavalink/nodes.json`](lavalink/nodes.json) (sourced from [lavalink.darrennathanael.com](https://lavalink.darrennathanael.com/SSL/Lavalink-SSL/)). Edit that file to add or remove nodes.
2. To self-host Lavalink instead, run `docker compose --profile local-lavalink up -d` and set single-node env vars in `.env`:
   ```env
   LAVALINK_HOST=lavalink
   LAVALINK_PORT=2333
   LAVALINK_PASSWORD=youshallnotpass
   LAVALINK_SECURE=false
   ```
   Remove or rename `lavalink/nodes.json` so the bot falls back to those env vars.
3. Override nodes inline with `LAVALINK_NODES` (JSON array) or point at another file with `LAVALINK_NODES_FILE`.
4. Use `/play <song>` from a voice channel, or `/join` to connect without playing. Paste any **YouTube** link (`youtube.com/watch`, `youtu.be`, `music.youtube.com`, Shorts, and playlists all work) and it plays directly. For searches, `/play` defaults to YouTube Music; use the `source` option to search **YouTube**, Spotify, SoundCloud, or Deezer instead (or type a prefix like `ytsearch:` / `ytmsearch:` directly into the query). Prefix shortcuts: `join`, `np`, `leave`, `pause`, `resume`, `skip`, `stop`, `volume <0-100>`, or `music <subcommand>`. Use `/now-playing` and `/queue` for status; `/music` for loop, shuffle, seek, and other controls.

### Using GitHub Container Registry

The bot is automatically published to GitHub Container Registry on every push to main.

```bash
docker pull ghcr.io/codebymitch/titanbot:main
```

<a name="manual-installation-steps"></a>
## Manual Installation Steps

### Prerequisites
- Node.js 20.10.0 or higher
- PostgreSQL server (recommended) or memory storage fallback
- Discord bot application with proper intents

1. **Clone the Repository**
   ```bash
   git clone https://github.com/codebymitch/TitanBot.git
   cd TitanBot
   ```

2. **Install Dependencies**
   ```bash
   npm install
   ```

3. **Configure Environment Variables**
   ```bash
   cp .env.example .env
   ```
   Edit `.env` with your configuration (only the following variables require configuration, leave remaining variables as default):
   ```env
   # Discord Bot Configuration
   DISCORD_TOKEN=your_discord_bot_token_here
   CLIENT_ID=your_discord_client_id_here
   GUILD_ID=your_discord_guild_id_here

   # PostgreSQL Configuration (Primary Database)
   POSTGRES_URL=postgresql://postgres:yourpassword@localhost:5432/titanbot
   POSTGRES_HOST=localhost
   POSTGRES_PORT=5432
   POSTGRES_DB=titanbot
   POSTGRES_USER=postgres
   POSTGRES_PASSWORD=yourpassword
   ```

   Production note:
   - `NODE_ENV=production`
   - `LOG_LEVEL=warn` for a clean production console (critical issues + startup status)
   - `LOG_LEVEL=info` if you want more detailed operational logs
   - If your chosen `PORT` is already used, TitanBot automatically tries the next port(s)

   Environment options reference:
   - `NODE_ENV`: `development`, `production`, `test` (any non-`production` value is treated as non-production)
   - `LOG_LEVEL`: `error`, `warn`, `info`, `http`, `verbose`, `debug`, `silly`
   - Accepted aliases for `LOG_LEVEL` in this bot: `warns`, `warning`, `warnings` → `warn`

   Recommended production `.env` (easy mode + default mode):
   ```env
   NODE_ENV=production
   LOG_LEVEL=warn
   WEB_HOST=0.0.0.0
   PORT=3000
   PORT_RETRY_ATTEMPTS=5
   ```
   This gives clear startup/online status messages while keeping logs simple for non-technical operators.
   If port `3000` is busy, the bot tries the next available ports automatically (up to `PORT_RETRY_ATTEMPTS`).

### Multiple servers

Slash commands are registered **globally** on startup (via `CLIENT_ID`), so the bot works in every server it is invited to. `GUILD_ID` stays in the tutorial `.env` for setup steps but is not used for command registration.

Notes:
- Global slash commands may take up to about an hour to propagate on first deploy
- Each server has **isolated** data: config, economy, tickets, leveling, dashboards, warnings, etc. (all keys are scoped as `guild:{guildId}:...`)
- In the [Discord Developer Portal](https://discord.com/developers/applications), ensure your bot is not restricted to a single guild if you plan to invite it elsewhere
- Generate an OAuth2 invite URL from the [Discord Developer Portal](https://discord.com/developers/applications) (OAuth2 → URL Generator, scopes: `bot` and `applications.commands`)

4. **Setup PostgreSQL Database** (Optional but recommended)
   ```bash
   # Create database and user
   createdb titanbot
   createuser titanbot
   psql -c "ALTER USER titanbot PASSWORD 'yourpassword';"
   psql -c "GRANT ALL PRIVILEGES ON DATABASE titanbot TO titanbot;"
   ```

5. **Verify Database Setup**
   ```bash
   npm run migrate:check
   ```

6. **Start the Bot**
   ```bash
   npm start
   ```

> **Note on database migrations:** Schema tables and legacy key migrations run
> **automatically on startup**, so` managed hosts like **Railway** need no manual
> migration step — just deploy/restart. To disable auto-migration set
> `AUTO_MIGRATE=false`. You can still run a manual key migration locally with
> `node scripts/migrate-keys.js --dry-run` (preview) or `node scripts/migrate-keys.js`.
<a name="bot-intents"></a>

## Required Bot Intents
TitanBot requires the following Discord intents:
- **Guilds**
- **Guild Messages**
- **Message Content**
- **Guild Members**
- **Guild Message Reactions**
- **Guild Voice States**
- **Direct Messages**
- **Bot**
- **Applications.commands**

### Required Permissions
- **View Channels**
- **Send Messages**
- **Embed Links**
- **Attach Files**
- **Read Message History**
- **Manage Messages**
- **Manage Channels**
- **Manage Roles**
- **Kick Members**
- **Manage Messages**
- **Ban Members**
- **Moderate Members**
- **Connect**

## License

TitanBot is released under the MIT License. See [LICENSE](LICENSE) for details.

## Thank You

Thank you for choosing TitanBot for your Discord server! We're constantly working to improve and add new features based on community feedback.

*Last updated: May 2026*
