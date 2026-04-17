require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, Events } = require('discord.js');
const Database = require('better-sqlite3');
const path = require('path');

// 🔒 Global Error Handling
process.on('unhandledRejection', (reason, promise) => console.error('⚠️ Unhandled Rejection:', reason));
process.on('uncaughtException', (err) => { console.error('💥 Uncaught Exception:', err); process.exit(1); });

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMembers
    ]
});

// 🗄️ Database Setup (Lightweight & Fast)
const dbPath = path.join(__dirname, 'points.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.prepare(`CREATE TABLE IF NOT EXISTS user_points (
    user_id TEXT PRIMARY KEY,
    points INTEGER DEFAULT 0
)`).run();

// ⚙️ Config Validation
const BOT_TOKEN = process.env.BOT_TOKEN;
const TRACKED_VC_IDS = (process.env.TRACKED_VC_IDS || '').split(',').map(id => id.trim()).filter(id => id.length > 0);
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;

if (!BOT_TOKEN || !LOG_CHANNEL_ID || TRACKED_VC_IDS.length === 0) {
    console.error('❌ .env mein BOT_TOKEN, LOG_CHANNEL_ID, aur TRACKED_VC_IDS zaroori hain!');
    process.exit(1);
}

const activeUsers = new Map(); // userId -> { joinTime, vcId }

// ✅ Conditions Checks
function isValidAccount(user) {
    const accountAgeMs = Date.now() - user.createdAt.getTime();
    const minAgeMs = 14 * 24 * 60 * 60 * 1000; // 14 Days
    return accountAgeMs >= minAgeMs;
}

function canEarnPoints(voiceState) {
    // AFK channel ya Deafened hone par points nahi milenge
    return !(voiceState.selfDeaf || voiceState.channel?.afk);
}
// 🎧 Voice State Tracker
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
    try {
        const userId = newState.userId;

        // VC Join
        if (!oldState.channelId && newState.channelId && TRACKED_VC_IDS.includes(newState.channelId)) {
            if (isValidAccount(newState.member.user) && canEarnPoints(newState)) {
                activeUsers.set(userId, { vcId: newState.channelId, joinTime: Date.now() });
            }
        }
        // VC Leave
        else if (oldState.channelId && TRACKED_VC_IDS.includes(oldState.channelId) && !newState.channelId) {
            activeUsers.delete(userId);
        }
        // VC Move / State Change (Mute/Deaf/Afk toggle)
        else if (oldState.channelId && TRACKED_VC_IDS.includes(oldState.channelId)) {
            const isTracked = TRACKED_VC_IDS.includes(newState.channelId);
            if (!isTracked || !canEarnPoints(newState)) activeUsers.delete(userId);
            else if (canEarnPoints(newState) && !activeUsers.has(userId)) {
                if (isValidAccount(newState.member.user)) activeUsers.set(userId, { vcId: newState.channelId, joinTime: Date.now() });
            }
        }
    } catch (err) {
        console.error('🔍 VoiceStateUpdate Error:', err.message);
    }
});

// ⏱️ Points Distribution Interval (Har 60 Seconds)
setInterval(async () => {
    if (activeUsers.size === 0) return;

    let logChannel;
    try {
        logChannel = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
        if (!logChannel) return console.error('📭 Log channel fetch nahi hua.');
    } catch (err) {
        return console.error('📭 Log Channel Error:', err.message);
    }

    const batchUpdates = [];

    for (const [userId, data] of activeUsers.entries()) {
        try {
            const guild = logChannel.guild;
            const voiceState = guild.voiceStates.get(userId);

            if (!voiceState || !TRACKED_VC_IDS.includes(voiceState.channelId) || !canEarnPoints(voiceState)) {
                activeUsers.delete(userId);
                continue;            }

            const isStreaming = voiceState.selfStream || false;
            const points = isStreaming ? 5 : 3;
            batchUpdates.push({ userId, points, isStreaming, member: voiceState.member });
        } catch (err) {
            activeUsers.delete(userId);
        }
    }

    // 💾 DB Batch Update
    if (batchUpdates.length > 0) {
        const stmt = db.prepare(`INSERT INTO user_points (user_id, points) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET points = points + excluded.points`);
        const updateMany = db.transaction((users) => {
            for (const u of users) stmt.run(u.userId, u.points);
        });
        updateMany(batchUpdates);
    }

    // 📜 Premium Embed Logs
    for (const u of batchUpdates) {
        try {
            const embed = new EmbedBuilder()
                .setTitle('🎧 VC Points Earned')
                .setDescription(`**${u.member.user.tag}** ne VC mein active time spend kiya.`)
                .setColor(u.isStreaming ? 0xFF4500 : 0x00FF7F) // 🟠 Stream | 🟢 Normal
                .addFields(
                    { name: '📊 Status', value: u.isStreaming ? '📺 Screen Sharing' : '🎤 Voice Active', inline: true },
                    { name: '⏱️ Duration', value: '1 Minute', inline: true },
                    { name: '💰 Points Awarded', value: `+${u.points} Points`, inline: true }
                )
                .setThumbnail(u.member.user.displayAvatarURL({ dynamic: true }))
                .setFooter({ text: 'Premium VC Tracker • Auto-Logged', iconURL: client.user.displayAvatarURL() })
                .setTimestamp();

            await logChannel.send({ embeds: [embed] });
        } catch (err) {
            console.error('📜 Log Embed Error:', err.message);
        }
    }
}, 60000);

// 🟢 Bot Ready
client.on(Events.Ready, () => {
    console.log(`✅ Bot online: ${client.user.tag}`);
    console.log(`🎯 Tracking ${TRACKED_VC_IDS.length} VC(s)`);
    console.log(`📜 Logs: #${logChannel?.name || LOG_CHANNEL_ID}`);
});

// 🚪 Graceful Shutdown (Railway Friendly)const gracefulShutdown = () => { db.close(); process.exit(0); };
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// 🔑 Login
client.login(BOT_TOKEN).catch(err => {
    console.error('❌ Login Failed:', err.message);
    process.exit(1);
});
