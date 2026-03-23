require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, Events } = require('discord.js');
const mineflayer = require('mineflayer');
const { JSONFile, Low } = require('lowdb');
const { v4: uuidv4 } = require('uuid');

const db = new Low(new JSONFile('./db.json'));
await db.read();
db.data ||= { users: {} };

const discordClient = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const activeBots = new Map(); // userId → mineflayer bot

// ====================== פונקציות Minecraft ======================
async function startMinecraftBot(userId) {
  const user = db.data.users[userId];
  if (!user || user.status === 'running') return false;

  const bot = mineflayer.createBot({
    host: user.serverIp,
    port: user.serverPort,
    username: user.mcUsername,
    auth: 'offline',           // ← רק offline כמו שביקשת
    version: false
  });

  bot.once('spawn', async () => {
    console.log(`✅ [${userId}] התחבר והגיע לשרת!`);
    if (user.loginPassword) {
      bot.chat(`/login ${user.loginPassword}`);
      console.log(`🔑 שלחתי /login`);
    }
    user.status = 'running';
    await db.write();
  });

  bot.on('error', (err) => {
    console.error(`❌ [${userId}]`, err.message);
    user.status = 'stopped';
    db.write();
    activeBots.delete(userId);
  });

  bot.on('kicked', (reason) => {
    console.log(`🚪 [${userId}] נבעט: ${reason}`);
    user.status = 'stopped';
    db.write();
    activeBots.delete(userId);
    // auto reconnect אחרי 10 שניות
    setTimeout(() => startMinecraftBot(userId), 10000);
  });

  bot.on('end', () => {
    activeBots.delete(userId);
    if (db.data.users[userId]) db.data.users[userId].status = 'stopped';
    db.write();
  });

  activeBots.set(userId, bot);
  return true;
}

function stopMinecraftBot(userId) {
  const bot = activeBots.get(userId);
  if (bot) {
    bot.end();
    activeBots.delete(userId);
    if (db.data.users[userId]) {
      db.data.users[userId].status = 'stopped';
      db.write();
    }
  }
}

// ====================== פאנל + כפתורים ======================
async function sendControlPanel(interaction) {
  const userId = interaction.user.id;
  const user = db.data.users[userId] || {};
  const isRunning = user.status === 'running';

  const embed = new EmbedBuilder()
    .setTitle("Crusty AFK Bot Control Panel")
    .setDescription("Manage your personal AFK bot")
    .addFields(
      { name: "System Status", value: "🟢 Online", inline: true },
      { name: "Active Bots", value: activeBots.size.toString(), inline: true },
      { name: "Available Slots", value: "1", inline: true } // תשנה ליותר אם תרצה
    )
    .setColor("#00ff88");

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('register').setLabel('Register').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('start').setLabel('Start Bot').setStyle(ButtonStyle.Primary).setDisabled(isRunning),
    new ButtonBuilder().setCustomId('stop').setLabel('Stop Bot').setStyle(ButtonStyle.Danger).setDisabled(!isRunning),
    new ButtonBuilder().setCustomId('status').setLabel('Status').setStyle(ButtonStyle.Secondary)
  );

  if (interaction.replied || interaction.deferred) {
    await interaction.editReply({ embeds: [embed], components: [row] });
  } else {
    await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
  }
}

// ====================== אינטראקציות ======================
discordClient.on(Events.InteractionCreate, async interaction => {
  const userId = interaction.user.id;

  // לחיצה על כפתור
  if (interaction.isButton()) {
    if (interaction.customId === 'register') {
      const modal = new ModalBuilder()
        .setCustomId('register_modal')
        .setTitle('Register Your AFK Bot');

      const usernameInput = new TextInputBuilder()
        .setCustomId('mcUsername').setLabel('Minecraft Username').setStyle(TextInputStyle.Short).setRequired(true);
      const ipInput = new TextInputBuilder()
        .setCustomId('serverIp').setLabel('Server IP').setStyle(TextInputStyle.Short).setRequired(true);
      const portInput = new TextInputBuilder()
        .setCustomId('serverPort').setLabel('Port (25565)').setStyle(TextInputStyle.Short).setRequired(false);
      const passInput = new TextInputBuilder()
        .setCustomId('loginPassword').setLabel('Login Password (if needed)').setStyle(TextInputStyle.Short).setRequired(false);

      modal.addComponents(
        new ActionRowBuilder().addComponents(usernameInput),
        new ActionRowBuilder().addComponents(ipInput),
        new ActionRowBuilder().addComponents(portInput),
        new ActionRowBuilder().addComponents(passInput)
      );

      await interaction.showModal(modal);
      return;
    }

    if (interaction.customId === 'start') {
      const success = await startMinecraftBot(userId);
      await interaction.reply({ content: success ? "✅ הבוט התחיל!" : "❌ כבר רץ או לא רשום", ephemeral: true });
      await sendControlPanel(interaction);
    }

    if (interaction.customId === 'stop') {
      stopMinecraftBot(userId);
      await interaction.reply({ content: "🛑 הבוט נעצר", ephemeral: true });
      await sendControlPanel(interaction);
    }

    if (interaction.customId === 'status') {
      const user = db.data.users[userId];
      await interaction.reply({
        content: `**סטטוס:** ${user?.status || 'לא רשום'}\n**משתמש:** ${user?.mcUsername || '—'}\n**שרת:** ${user?.serverIp || '—'}`,
        ephemeral: true
      });
    }
  }

  // הגשת מודל (Register)
  if (interaction.isModalSubmit() && interaction.customId === 'register_modal') {
    const mcUsername = interaction.fields.getTextInputValue('mcUsername');
    const serverIp = interaction.fields.getTextInputValue('serverIp');
    const serverPort = parseInt(interaction.fields.getTextInputValue('serverPort')) || 25565;
    const loginPassword = interaction.fields.getTextInputValue('loginPassword') || null;

    db.data.users[userId] = {
      mcUsername,
      serverIp,
      serverPort,
      loginPassword,        // שמור כ-plain (זה רק לבוט שלך)
      status: 'stopped'
    };
    await db.write();

    await interaction.reply({ content: `✅ נרשמת בהצלחה!\nשם: **${mcUsername}**\nשרת: **${serverIp}:${serverPort}**`, ephemeral: true });
  }
});

// ====================== הפעלה ======================
discordClient.once(Events.ClientReady, () => {
  console.log(`🚀 Crusty AFK Bot מחובר כ: ${discordClient.user.tag}`);
});

discordClient.login(process.env.DISCORD_TOKEN);
