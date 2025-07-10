require('dotenv').config();
const express = require('express');
const {
  Client,
  GatewayIntentBits,
  ChannelType,
  EmbedBuilder,
  PermissionsBitField,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events
} = require('discord.js');
const Airtable = require('airtable');

const app = express();
app.use(express.json());

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);
const PORT = process.env.PORT || 3000;
const VERIFY_CHANNEL_ID = '1392824220895019078';

client.once('ready', async () => {
  console.log(`🤖 Bot is online as ${client.user.tag}`);

  const channel = await client.channels.fetch(VERIFY_CHANNEL_ID);
  if (channel && channel.isTextBased()) {
    const embed = new EmbedBuilder()
      .setTitle('🔐 Verify Deal Access')
      .setDescription('Click the button below and enter your **Claim ID** to unlock access to your deal channel.')
      .setColor(0x5865F2);

    const button = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('verify_access')
        .setLabel('Verify Deal Access')
        .setStyle(ButtonStyle.Primary)
    );

    await channel.send({ embeds: [embed], components: [button] });
  }
});

client.on(Events.InteractionCreate, async interaction => {
  if (interaction.isButton() && interaction.customId === 'verify_access') {
    const modal = new ModalBuilder()
      .setCustomId('record_id_verify')
      .setTitle('Verify Deal Access - Claim ID');

    const input = new TextInputBuilder()
      .setCustomId('record_id')
      .setLabel('Paste your Claim ID (e.g. recXXXX)')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(input));
    await interaction.showModal(modal);
  }

  if (interaction.isModalSubmit() && interaction.customId === 'record_id_verify') {
    const recordId = interaction.fields.getTextInputValue('record_id').trim();

    try {
      const orderRecord = await base('Unfulfilled Orders Log').find(recordId);
      const orderNumber = orderRecord.get('Order Number');
      const dealChannelName = orderNumber; // no "deal-" prefix

      const guild = await client.guilds.fetch(process.env.GUILD_ID);
      const channels = await guild.channels.fetch();
      const dealChannel = channels.find(c => c.name === dealChannelName);

      if (!dealChannel) {
        return interaction.reply({ content: '❌ Deal channel not found.', ephemeral: true });
      }

      await dealChannel.permissionOverwrites.create(interaction.user.id, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true
      });

      return interaction.reply({
        content: `✅ Access granted to <#${dealChannel.id}>`,
        ephemeral: true
      });
    } catch (err) {
      console.error('❌ Error verifying access:', err);
      return interaction.reply({ content: '❌ Invalid Claim ID or error occurred.', ephemeral: true });
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
app.listen(PORT, () => {
  console.log(`🌐 Express server running on port ${PORT}`);
});
