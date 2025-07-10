require('dotenv').config();
const express = require('express');
const fs = require('fs');
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
  Events,
  AttachmentBuilder
} = require('discord.js');
const Airtable = require('airtable');

const app = express();
app.use(express.json());

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);
const PORT = process.env.PORT || 3000;
const VERIFY_CHANNEL_ID = process.env.VERIFY_CHANNEL_ID;
const TRANSCRIPTS_CHANNEL_ID = process.env.TRANSCRIPTS_CHANNEL_ID;
const ADMIN_ROLE_IDS = ['1100568786744119376', '1150412914696650786'];

const sellerMap = new Map();

client.once('ready', async () => {
  console.log(`🤖 Bot is online as ${client.user.tag}`);

  const channel = await client.channels.fetch(VERIFY_CHANNEL_ID);
  if (channel?.isTextBased()) {
    const embed = new EmbedBuilder()
      .setTitle('🔐 Verify Deal Access')
      .setDescription('Click the button below and enter your **Claim ID** to unlock access to your deal channel.')
      .setColor(0xFFED00);

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
  // Cancel Deal — Transcript + Airtable update + delete channel
  if (interaction.isButton() && interaction.customId === 'cancel_deal') {
    const channel = interaction.channel;

    // 1. Fetch and save transcript
    const messages = await channel.messages.fetch({ limit: 100 });
    const transcript = messages
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .map(m => `[${new Date(m.createdTimestamp).toISOString()}] ${m.author.tag}: ${m.content}`)
      .join('\n');

    const transcriptPath = `/tmp/transcript-${channel.id}.txt`;
    fs.writeFileSync(transcriptPath, transcript);
    const attachment = new AttachmentBuilder(transcriptPath);

    // 2. Send transcript to transcripts channel
    const transcriptsChannel = await client.channels.fetch(TRANSCRIPTS_CHANNEL_ID);
    await transcriptsChannel.send({ content: `📄 Transcript for #${channel.name}`, files: [attachment] });

    // 3. Update Airtable record
    let recordId = sellerMap.get(channel.id)?.recordId;
    if (!recordId) {
      const orderNumber = channel.name.toUpperCase();
      const records = await base('Unfulfilled Orders Log').select({
        filterByFormula: `{Order ID} = "${orderNumber}"`,
        maxRecords: 1
      }).firstPage();
      if (records.length > 0) recordId = records[0].id;
    }

    if (recordId) {
      await base('Unfulfilled Orders Log').update(recordId, {
        "Fulfillment Status": "Outsource",
        "Outsource Start Time": new Date().toISOString(),
        "Deal Invitation URL": ""
      });
    }

    // 4. Reply + delete channel
    await interaction.reply({ content: '✅ Deal cancelled and transcript saved.', flags: 0 });
    setTimeout(() => channel.delete().catch(console.error), 3000);
  }

  // Confirm Deal — Check for duplicate + Add to Inventory Units
  if (interaction.isButton() && interaction.customId === 'confirm_deal') {
    const memberRoles = interaction.member.roles.cache.map(role => role.id);
    const isAdmin = ADMIN_ROLE_IDS.some(roleId => memberRoles.includes(roleId));
    if (!isAdmin) return interaction.reply({ content: '❌ You are not authorized.', flags: 0 });

    const channel = interaction.channel;
    const messages = await channel.messages.fetch({ limit: 50 });

    const sellerData = sellerMap.get(channel.id);
    if (!sellerData || !sellerData.sellerId || !sellerData.recordId) {
      return interaction.reply({ content: '❌ Missing Seller ID or Claim ID.', flags: 0 });
    }

    const orderRecord = await base('Unfulfilled Orders Log').find(sellerData.recordId);
    const orderNumber = orderRecord.get('Order ID');

    // Check for duplicates in Inventory Units
    const existingUnits = await base('Inventory Units').select({
      filterByFormula: `{Ticket Number} = "${orderNumber}"`,
      maxRecords: 1
    }).firstPage();
    if (existingUnits.length > 0) {
      return interaction.reply({ content: '⚠️ This deal has already been confirmed.', flags: 0 });
    }

    // Check for picture message
    const imageMsg = messages.find(m => m.attachments.size > 0);
    if (!imageMsg) return interaction.reply({ content: '❌ No image found in channel.', flags: 0 });

    // Get deal details
    const dealMsg = messages.find(m => m.embeds.length > 0);
    const embed = dealMsg?.embeds?.[0];
    if (!embed || !embed.description) return interaction.reply({ content: '❌ Missing deal embed.', flags: 0 });

    const lines = embed.description.split('\n');
    const getValue = label => lines.find(line => line.includes(label))?.split(label)[1]?.trim() || '';

    const sku = getValue('**SKU:**');
    const size = getValue('**Size:**');
    const brand = getValue('**Brand:**');
    const payout = parseFloat(getValue('**Payout:**')?.replace('€', '') || 0);
    const productName = orderRecord.get('Product Name');

    const sellerRecords = await base('Sellers Database').select({
      filterByFormula: `{Seller ID} = "${sellerData.sellerId}"`,
      maxRecords: 1
    }).firstPage();

    if (!sellerRecords.length) {
      return interaction.reply({ content: '❌ Seller not found in Sellers Database.', flags: 0 });
    }

    // Create Inventory Unit
    await base('Inventory Units').create({
      'Product Name': productName,
      'SKU': sku,
      'Size': size,
      'Brand': brand,
      'Purchase Price': payout,
      'Shipping Deduction': 0,
      'Purchase Date': new Date().toISOString().split('T')[0],
      'Seller ID': [sellerRecords[0].id],
      'Ticket Number': orderNumber,
      'Type': 'Direct',
      'Verification Status': 'Verified',
      'Payment Status': 'To Pay',
      'Availability Status': 'Reserved',
      'Margin %': '10%',
      'Unfulfilled Orders Log': [sellerData.recordId]
    });

    await interaction.reply({ content: '✅ Deal confirmed and added to Inventory Units.', flags: 0 });
  }
});

client.login(process.env.DISCORD_TOKEN);
app.listen(PORT, () => {
  console.log(`🌐 Express server running on port ${PORT}`);
});
