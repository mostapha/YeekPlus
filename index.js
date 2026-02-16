require('dotenv').config();
const { Client, GatewayIntentBits, ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionsBitField } = require('discord.js');
const Database = require('better-sqlite3');
const ms = require('ms');

// --- DATABASE SETUP ---
const db = new Database('giveaways.db');

// Main Giveaway Table
db.exec(`
  CREATE TABLE IF NOT EXISTS giveaways (
    message_id TEXT PRIMARY KEY,
    channel_id TEXT,
    thread_id TEXT,
    guild_id TEXT,
    organizer_id TEXT,
    prize TEXT,
    end_timestamp INTEGER,
    type TEXT,
    status TEXT DEFAULT 'active',
    data TEXT
  )
`);

// Participants Table (For Classic Giveaways)
db.exec(`
  CREATE TABLE IF NOT EXISTS participants (
    giveaway_id TEXT,
    user_id TEXT,
    joined_at INTEGER,
    PRIMARY KEY (giveaway_id, user_id)
  )
`);

// --- CLIENT SETUP ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// --- MEMORY CACHE ---
const activeGames = new Map(); // Key: THREAD_ID -> Value: Game Data
const cooldowns = new Map();   // Key: THREAD_ID_USER_ID -> Value: Timestamp
const pendingGiveaways = new Map(); // Temporary storage for modal creation

// Helper: Load active games on restart
function loadActiveGames() {
  const rows = db.prepare("SELECT * FROM giveaways WHERE status = 'active' AND type = 'guess'").all();
  rows.forEach(row => {
    const data = JSON.parse(row.data);
    activeGames.set(row.thread_id, {
      secret_number: data.secret_number,
      required_role_id: data.required_role_id,
      end_timestamp: row.end_timestamp,
      message_id: row.message_id,
      prize: row.prize,
      channel_id: row.channel_id // Parent Channel ID
    });
  });
  console.log(`Loaded ${activeGames.size} active guess games.`);
}

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  loadActiveGames();
    
  // Check for expired giveaways every 10 seconds
  setInterval(checkExpiredGiveaways, 10 * 1000);
  setInterval(cleanCooldowns, 10 * 60 * 1000);
});

// --- EVENT ROUTER ---
client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isChatInputCommand()) await handleCommand(interaction);
    else if (interaction.isModalSubmit()) await handleModal(interaction);
    else if (interaction.isButton()) await handleButton(interaction);
  } catch (error) {
    console.error('Interaction Error:', error);
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: 'There was an error executing this command!', ephemeral: true }).catch(() => {});
    } else {
      await interaction.reply({ content: 'There was an error executing this command!', ephemeral: true }).catch(() => {});
    }
  }
});

// --- 1. HANDLE SLASH COMMANDS ---
async function handleCommand(interaction) {
  const { commandName } = interaction;
    
  // COMMON ARGUMENTS
  const reward = interaction.options.getString('reward');
  const durationRaw = interaction.options.getString('duration');
  const role = interaction.options.getRole('required_role');
  const image = interaction.options.getAttachment('image');

  const durationMs = ms(durationRaw);
  if (!durationMs) return interaction.reply({ content: `Invalid duration: "${durationRaw}"`, ephemeral: true });

  // MINIMUM DURATION CHECK (3 Minutes)
  if (durationMs < 3 * 60 * 1000) {
    return interaction.reply({ content: `⚠️ Duration must be at least **3 minutes**.`, ephemeral: true });
  }

  // A. GUESS NUMBER LOGIC
  if (commandName === 'guess_number') {
    const modal = new ModalBuilder().setCustomId('modal_guess_secret').setTitle('Set Secret Number');
    const numberInput = new TextInputBuilder().setCustomId('secret_number').setLabel('Winning Number').setStyle(TextInputStyle.Short).setRequired(true);
    modal.addComponents(new ActionRowBuilder().addComponents(numberInput));

    pendingGiveaways.set(interaction.user.id, { reward, durationMs, roleId: role?.id, imageUrl: image?.url, type: 'guess' });
    await interaction.showModal(modal);
  }

  // B. CLASSIC GIVEAWAY LOGIC
  if (commandName === 'classic_giveaway') {
    const winnersCount = interaction.options.getInteger('winners');
    const endTimestamp = Date.now() + durationMs;
    const endUnix = Math.floor(endTimestamp / 1000);

    const embed = new EmbedBuilder()
      .setTitle(`🎉 **GIVEAWAY: ${reward}**`)
      .setDescription(`Click the button below to enter!\n\n**Winners:** ${winnersCount}\n**Ends:** <t:${endUnix}:R>\n**Required Role:** ${role ? `<@&${role.id}>` : 'None'}\n\n**Participants:** 0`)
      .setColor('#0099FF')
      .setFooter({ text: `Ends at` })
      .setTimestamp(endTimestamp);

    if (image) embed.setImage(image.url);

    const joinBtn = new ButtonBuilder()
      .setCustomId('join_giveaway')
      .setLabel('🎉 Join Giveaway')
      .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder().addComponents(joinBtn);

    await interaction.reply({ embeds: [embed], components: [row] });
    const msg = await interaction.fetchReply();

    // Save Classic to DB
    const stmt = db.prepare(`INSERT INTO giveaways (message_id, channel_id, guild_id, organizer_id, prize, end_timestamp, type, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
        
    stmt.run(msg.id, interaction.channelId, interaction.guildId, interaction.user.id, reward, endTimestamp, 'classic', JSON.stringify({
      required_role_id: role?.id,
      winner_count: winnersCount
    }));
  }
}

// --- 2. HANDLE MODALS ---
async function handleModal(interaction) {
  if (interaction.customId !== 'modal_guess_secret') return;

  const secretNumber = parseInt(interaction.fields.getTextInputValue('secret_number'), 10);
  if (isNaN(secretNumber)) return interaction.reply({ content: 'Invalid number.', ephemeral: true });

  const pending = pendingGiveaways.get(interaction.user.id);
  if (!pending) return;

  await interaction.deferReply();
  const endTimestamp = Date.now() + pending.durationMs;
  const endUnix = Math.floor(endTimestamp / 1000);

  const embed = new EmbedBuilder()
    .setTitle(`🔢 **Guess the Number: ${pending.reward}**`)
    .setDescription(`Guess the secret number in the thread!\n\n**Ends:** <t:${endUnix}:R>\n**Required Role:** ${pending.roleId ? `<@&${pending.roleId}>` : 'None'}`)
    .setColor('#FFD700');
    
  if (pending.imageUrl) embed.setImage(pending.imageUrl);

  const msg = await interaction.editReply({ embeds: [embed] });
  const thread = await msg.startThread({ name: `Guess: ${pending.reward}`, autoArchiveDuration: 60 });
    
  // Save Guess Game to DB
  db.prepare(`INSERT INTO giveaways (message_id, channel_id, thread_id, guild_id, organizer_id, prize, end_timestamp, type, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(msg.id, interaction.channelId, thread.id, interaction.guildId, interaction.user.id, pending.reward, endTimestamp, 'guess', JSON.stringify({
      secret_number: secretNumber,
      required_role_id: pending.roleId
    }));

  activeGames.set(thread.id, {
    secret_number: secretNumber,
    required_role_id: pending.roleId,
    end_timestamp: endTimestamp,
    message_id: msg.id,
    prize: pending.reward,
    channel_id: interaction.channelId
  });
    
  pendingGiveaways.delete(interaction.user.id);
    
  await thread.send(`**Start Guessing!**\nCooldown: 1m.`);
}

// --- 3. HANDLE BUTTONS ---
async function handleButton(interaction) {
  if (interaction.customId !== 'join_giveaway') return;

  const giveaway = db.prepare('SELECT * FROM giveaways WHERE message_id = ?').get(interaction.message.id);
    
  if (!giveaway || giveaway.status !== 'active') {
    return interaction.reply({ content: 'This giveaway has ended.', ephemeral: true });
  }

  const data = JSON.parse(giveaway.data);

  if (data.required_role_id && !interaction.member.roles.cache.has(data.required_role_id)) {
    return interaction.reply({ content: `You need the <@&${data.required_role_id}> role to join.`, ephemeral: true });
  }

  try {
    // Insert participant
    db.prepare('INSERT INTO participants (giveaway_id, user_id, joined_at) VALUES (?, ?, ?)').run(giveaway.message_id, interaction.user.id, Date.now());
        
    // --- LIVE COUNT UPDATE ---
    // 1. Get new count
    const countResult = db.prepare('SELECT COUNT(*) as count FROM participants WHERE giveaway_id = ?').get(giveaway.message_id);
    const newCount = countResult.count;

    // 2. Rebuild Embed with new count
    const originalEmbed = interaction.message.embeds[0];
    const newEmbed = EmbedBuilder.from(originalEmbed);
        
    // We use Regex to safely replace the "Participants: X" line without breaking other parts
    // Or we can just reconstruct the description if we know the format perfectly.
    // Let's use replacement for safety.
    let newDesc = originalEmbed.description;
    if (newDesc.includes('**Participants:**')) {
      newDesc = newDesc.replace(/\*\*Participants:\*\* \d+/, `**Participants:** ${newCount}`);
    } else {
      newDesc += `\n\n**Participants:** ${newCount}`;
    }
    newEmbed.setDescription(newDesc);

    // 3. Update Message (We don't await this to keep the reply fast, or we can)
    await interaction.message.edit({ embeds: [newEmbed] });

    return interaction.reply({ content: '✅ You have joined the giveaway!', ephemeral: true });

  } catch (err) {
    // Error usually means Primary Key violation (already joined)
    if (err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
      return interaction.reply({ content: 'You are already in this giveaway.', ephemeral: true });
    }
    console.error(err);
    return interaction.reply({ content: 'Error joining giveaway.', ephemeral: true });
  }
}

// --- GUESS GAME MESSAGE LOGIC ---
client.on('messageCreate', async message => {
  if (message.author.bot || !message.channel.isThread()) return;
    
  // Check if this thread is an active game
  const game = activeGames.get(message.channel.id);
  if (!game) return;

  // Strict Number Check
  if (!/^-?\d+$/.test(message.content.trim())) return;
  const guess = parseInt(message.content.trim(), 10);

  // Role Check
  if (game.required_role_id && !message.member.roles.cache.has(game.required_role_id)) return;

  // --- COOLDOWN CHECK ---
  const key = `${message.channel.id}_${message.author.id}`;
  if (cooldowns.has(key)) {
    const warning = await message.reply('⏳ Please wait 1 minute.');
    setTimeout(() => warning.delete().catch(() => {}), 3000);
    return;
  }
  cooldowns.set(key, Date.now());
  setTimeout(() => cooldowns.delete(key), 60000);


  // --- GAME LOGIC ---
  if (guess === game.secret_number) {
    await endGuessGame(message.channel.id, game, message.author);
  } else {
    await message.react('❌');
  }
});

async function endGuessGame(threadId, game, winner) {
  console.log(`Ending Game in thread: ${threadId} (Winner: ${winner.tag})`);
    
  db.prepare("UPDATE giveaways SET status = 'ended' WHERE thread_id = ?").run(threadId);
  activeGames.delete(threadId);

  try {
    const parentChannel = await client.channels.fetch(game.channel_id);
    const originalMsg = await parentChannel.messages.fetch(game.message_id);
        
    const winEmbed = new EmbedBuilder(originalMsg.embeds[0].data)
      .setColor('#00FF00')
      .setDescription(`**WINNER:** ${winner}\n**Prize:** ${game.prize}\n**Number:** ${game.secret_number}`)
      .setFooter({ text: 'Giveaway Ended' });
        
    await originalMsg.edit({ embeds: [winEmbed] });
        
    const thread = await parentChannel.threads.fetch(threadId);
    await thread.send(`🎉 **WINNER:** ${winner} guessed ${game.secret_number}!`);
    await thread.setArchived(true);
  } catch(e) { 
    console.error('Error updating UI after win:', e); 
  }
}

// --- GLOBAL EXPIRATION CHECKER ---
async function checkExpiredGiveaways() {
  const now = Date.now();
  const expired = db.prepare("SELECT * FROM giveaways WHERE status = 'active' AND end_timestamp <= ?").all(now);

  for (const giveaway of expired) {
    // Mark ended in DB
    db.prepare("UPDATE giveaways SET status = 'ended' WHERE message_id = ?").run(giveaway.message_id);

    const data = JSON.parse(giveaway.data);
    const channel = await client.channels.fetch(giveaway.channel_id).catch(() => null);
    if (!channel) continue;
    const message = await channel.messages.fetch(giveaway.message_id).catch(() => null);
    if (!message) continue;

    // --- HANDLE GUESS TYPE ---
    if (giveaway.type === 'guess') {
      activeGames.delete(giveaway.thread_id);

      const embed = new EmbedBuilder(message.embeds[0].data)
        .setColor('#FF0000')
        .setDescription(`❌ **Expired:** No one guessed the number (${data.secret_number}).`);
      await message.edit({ embeds: [embed] });
            
      const thread = await channel.threads.fetch(giveaway.thread_id).catch(() => null);
      if (thread) {
        await thread.send(`⏰ Time up! The number was ${data.secret_number}.`);
        await thread.setArchived(true);
      }
    }

    // --- HANDLE CLASSIC TYPE ---
    if (giveaway.type === 'classic') {
      const participants = db.prepare('SELECT user_id FROM participants WHERE giveaway_id = ?').all(giveaway.message_id);
            
      let resultText = '';
            
      if (participants.length === 0) {
        resultText = '❌ No one joined the giveaway.';
      } else {
        const winnerCount = data.winner_count || 1;
        const winners = [];
        for (let i = 0; i < winnerCount && participants.length > 0; i++) {
          const randomIndex = Math.floor(Math.random() * participants.length);
          winners.push(participants[randomIndex].user_id);
          participants.splice(randomIndex, 1);
        }
        resultText = `🎉 **WINNERS:** ${winners.map(id => `<@${id}>`).join(', ')}`;
        await channel.send(`Congratulations ${winners.map(id => `<@${id}>`).join(', ')}! You won **${giveaway.prize}**!`);
      }

      const embed = new EmbedBuilder(message.embeds[0].data)
        .setColor(participants.length === 0 ? '#FF0000' : '#00FF00')
        .setDescription(`${resultText}\n\n**Prize:** ${giveaway.prize}`)
        .setFooter({ text: 'Giveaway Ended' });
            
      await message.edit({ embeds: [embed], components: [] });
    }
  }
}

function cleanCooldowns() {
  const now = Date.now();
  for (const [key, timestamp] of cooldowns.entries()) {
    if ((now - timestamp) > 60000) {
      cooldowns.delete(key);
    }
  }
}

client.login(process.env.DISCORD_TOKEN);