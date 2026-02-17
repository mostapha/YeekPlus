require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  // 1. Guess Number Command
  new SlashCommandBuilder()
    .setName('guess_number')
    .setDescription('Start a "Guess the Number" giveaway')
    .addStringOption(option =>
      option.setName('reward')
        .setDescription('What will the user win?')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('duration')
        .setDescription('Duration (e.g., 1h, 30m, 2d)')
        .setRequired(true))
    .addBooleanOption(option =>
      option.setName('hints')
        .setDescription('Should the bot give hints (Higher/Lower)?')
        .setRequired(false))
    .addStringOption(option =>
      option.setName('cooldown')
        .setDescription('Guess cooldown (e.g., 10s, 1m). Min 15s. Default 1m.')
        .setRequired(false))
    .addRoleOption(option =>
      option.setName('required_role')
        .setDescription('Role required to participate (optional)')
        .setRequired(false))
    .addAttachmentOption(option =>
      option.setName('image')
        .setDescription('An image for the giveaway embed (optional)')
        .setRequired(false)),

  // 2. Classic Giveaway Command
  new SlashCommandBuilder()
    .setName('classic_giveaway')
    .setDescription('Start a standard button-based giveaway')
    .addStringOption(option =>
      option.setName('reward')
        .setDescription('What will the user win?')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('duration')
        .setDescription('Duration (e.g., 1h, 30m, 2d)')
        .setRequired(true))
    .addIntegerOption(option =>
      option.setName('winners')
        .setDescription('How many winners?')
        .setRequired(true))
    .addRoleOption(option =>
      option.setName('required_role')
        .setDescription('Role required to participate (optional)')
        .setRequired(false))
    .addAttachmentOption(option =>
      option.setName('image')
        .setDescription('An image for the giveaway embed (optional)')
        .setRequired(false)),

  // 3. Edit Giveaway Command
  new SlashCommandBuilder()
    .setName('edit_giveaway')
    .setDescription('Edit an active giveaway')
    .addStringOption(option =>
      option.setName('message_id')
        .setDescription('The Message ID of the giveaway embed')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('new_reward')
        .setDescription('New name for the prize (optional)')
        .setRequired(false))
    .addStringOption(option =>
      option.setName('new_duration')
        .setDescription('New duration from NOW (e.g., +1h, 30m) (optional)')
        .setRequired(false))
]
  .map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('Started refreshing application (/) commands.');
    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commands },
    );
    console.log('Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error(error);
  }
})();