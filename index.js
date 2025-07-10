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
const VERIFY_CHANNEL_ID = process.env.VERIFY_CHANNEL_ID;
const ADMIN_ROLE_IDS = ['1100568786744119376', '1150412914696650786'];

const sellerMap = new Map();

client.once('ready', async () => {
  console.log(`🤖 Bot is online as ${client.user.tag}`);

  const channel = await client.channels.fetch(VERIFY_CHANNEL_ID);
  if (channel && channel.isTextBased()) {
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

app.post('/claim-deal', async (req, res) => {
  const { orderNumber, productName, sku, skuSoft, size, brand, payout, recordId } = req.body;
  console.log("📥 Received POST /claim-deal with body:", req.body);

  const orderRecord = await base('Unfulfilled Orders Log').find(recordId);
  const pictureField = orderRecord.get('Picture');
  const imageUrl = Array.isArray(pictureField) && pictureField.length > 0 ? pictureField[0].url : null;

  const rawSku = Array.isArray(sku) ? sku[0] : (typeof sku === 'string' ? sku : '');
  const rawSkuSoft = Array.isArray(skuSoft) ? skuSoft[0] : (typeof skuSoft === 'string' ? skuSoft : '');
  const finalSku = rawSku.trim() !== '' ? rawSku.trim() : rawSkuSoft.trim();

  const cleanProductName = orderRecord.get('Product Name');
  if (!orderNumber || !cleanProductName || !finalSku || !size || !brand || !payout || !recordId) {
    return res.status(400).send("Missing required fields");
  }

  try {
    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    const category = await guild.channels.fetch(process.env.CATEGORY_ID);

    const channel = await guild.channels.create({
      name: `${orderNumber.toLowerCase()}`,
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: [
        {
          id: guild.roles.everyone,
          deny: [PermissionsBitField.Flags.ViewChannel]
        }
      ]
    });

    const invite = await client.channels.fetch(VERIFY_CHANNEL_ID).then(ch => ch.createInvite({ maxUses: 1, unique: true }));

    const embed = new EmbedBuilder()
      .setTitle("💸 Deal Claimed")
      .setDescription(`**Order:** ${orderNumber}\n**Product:** ${cleanProductName}\n**SKU:** ${finalSku}\n**Size:** ${size}\n**Brand:** ${brand}\n**Payout:** €${payout.toFixed(2)}`)
      .setColor(0xFFED00);

    if (imageUrl) {
      embed.setImage(imageUrl);
    }

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('start_claim').setLabel('Process Claim').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('cancel_deal').setLabel('Cancel Deal').setStyle(ButtonStyle.Danger)
    );

    await channel.send({ embeds: [embed], components: [row] });
    sellerMap.set(channel.id, { sellerId: null, recordId });

    await base('Unfulfilled Orders Log').update(recordId, {
      "Deal Invitation URL": invite.url,
      "Fulfillment Status": "Claim Processing"
    });

    res.redirect(302, `https://kickzcaviar.preview.softr.app/success?recordId=${recordId}`);
  } catch (err) {
    console.error("❌ Error during claim creation:", err);
    res.status(500).send("Internal Server Error");
  }
});

client.on(Events.InteractionCreate, async interaction => {
  if (interaction.isButton() && interaction.customId === 'verify_access') {
    const modal = new ModalBuilder()
      .setCustomId('record_id_verify')
      .setTitle('Verify Deal Access');

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
      const orderId = orderRecord.get('Order ID');

      if (!orderId) {
        return interaction.reply({ content: '❌ Could not find Order ID for this Claim ID.', flags: 0 });
      }

      const guild = await client.guilds.fetch(process.env.GUILD_ID);
      const channels = await guild.channels.fetch();
      const dealChannel = channels.find(c => c.name.toLowerCase() === orderId.toLowerCase());

      if (!dealChannel) {
        return interaction.reply({ content: '❌ Deal channel not found.', flags: 0 });
      }

      await dealChannel.permissionOverwrites.create(interaction.user.id, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true
      });

      return interaction.reply({ content: `✅ Access granted to <#${dealChannel.id}>`, flags: 0 });
    } catch (err) {
      console.error('❌ Error verifying access:', err);
      return interaction.reply({ content: '❌ Invalid Claim ID or error occurred.', flags: 0 });
    }
  }

  if (interaction.isButton() && interaction.customId === 'start_claim') {
    const modal = new ModalBuilder()
      .setCustomId('seller_id_modal')
      .setTitle('Enter Seller ID');

    const input = new TextInputBuilder()
      .setCustomId('seller_id')
      .setLabel("Seller ID (e.g. 00001)")
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(input));
    await interaction.showModal(modal);
  }

  if (interaction.isModalSubmit() && interaction.customId === 'seller_id_modal') {
    const sellerIdRaw = interaction.fields.getTextInputValue('seller_id').replace(/\D/g, '');
    const sellerId = `SE-${sellerIdRaw.padStart(5, '0')}`;

    const channelId = interaction.channel.id;
    const existing = sellerMap.get(channelId);
    sellerMap.set(channelId, { ...(existing || {}), sellerId });

    await interaction.reply({
      content: `✅ Seller ID received: **${sellerId}**\nPlease upload a picture of the pair to prove it's in-hand.`,
      flags: 0
    });
  }

  if (interaction.isButton() && interaction.customId === 'cancel_deal') {
    const channel = interaction.channel;
    const data = sellerMap.get(channel.id);
    let recordId = data?.recordId;

    if (!recordId) {
      const orderNumber = channel.name.toUpperCase();
      const records = await base('Unfulfilled Orders Log').select({
        filterByFormula: `{Order ID} = "${orderNumber}"`,
        maxRecords: 1
      }).firstPage();
      if (records.length > 0) {
        recordId = records[0].id;
      }
    }

    if (!recordId) {
      return interaction.reply({ content: '❌ Record ID not found.', flags: 0 });
    }

    await base('Unfulfilled Orders Log').update(recordId, {
      "Fulfillment Status": "Outsource",
      "Outsource Start Time": new Date().toISOString(),
      "Deal Invitation URL": ""
    });

    await interaction.reply({ content: '✅ Deal has been cancelled.', flags: 0 });
  }

  if (interaction.isButton() && interaction.customId === 'confirm_deal') {
    const memberRoles = interaction.member.roles.cache.map(role => role.id);
    const isAdmin = ADMIN_ROLE_IDS.some(roleId => memberRoles.includes(roleId));
    if (!isAdmin) {
      return interaction.reply({ content: '❌ You are not authorized to confirm the deal.', flags: 0 });
    }

    const channel = interaction.channel;
    const messages = await channel.messages.fetch({ limit: 50 });

    const sellerData = sellerMap.get(channel.id);
    if (!sellerData || !sellerData.sellerId || !sellerData.recordId) {
      return interaction.reply({ content: '❌ Missing Seller ID or Claim ID.', flags: 0 });
    }

    const imageMsg = messages.find(m =>
      m.attachments.size > 0 && [...m.attachments.values()].some(att => att.contentType?.startsWith('image/'))
    );

    if (!imageMsg) {
      return interaction.reply({ content: '❌ No image found in recent messages.', flags: 0 });
    }

    const dealMsg = messages.find(m => m.embeds.length > 0);
    const embed = dealMsg?.embeds?.[0];
    if (!embed || !embed.description) {
      return interaction.reply({ content: '❌ Missing deal embed.', flags: 0 });
    }

    const lines = embed.description.split('\n');
    const getValue = label => lines.find(line => line.includes(label))?.split(label)[1]?.trim() || '';

    const sku = getValue('**SKU:**');
    const size = getValue('**Size:**');
    const brand = getValue('**Brand:**');
    const payout = parseFloat(getValue('**Payout:**')?.replace('€', '') || 0);
    const orderNumber = getValue('**Order:**');
    const orderRecord = await base('Unfulfilled Orders Log').find(sellerData.recordId);
    const productName = orderRecord.get('Product Name');

    const sellerRecords = await base('Sellers Database')
      .select({ filterByFormula: `{Seller ID} = "${sellerData.sellerId}"`, maxRecords: 1 })
      .firstPage();

    if (!sellerRecords.length) {
      return interaction.reply({ content: '❌ Seller ID not found in our system.', flags: 0 });
    }

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

    await interaction.reply({ content: '✅ Deal processed!', flags: 0 });
  }
});

client.on(Events.MessageCreate, async message => {
  if (
    message.channel.name.toUpperCase().startsWith('ORD-') &&
    message.attachments.size > 0
  ) {
    const data = sellerMap.get(message.channel.id);
    if (!data?.sellerId) return;

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('confirm_deal')
        .setLabel('Confirm Deal')
        .setStyle(ButtonStyle.Success)
    );

    await message.channel.send({
      content: 'Admin: click below to confirm the deal.',
      components: [row]
    });
  }
});

client.login(process.env.DISCORD_TOKEN);
app.listen(PORT, () => {
  console.log(`🌐 Express server running on port ${PORT}`);
});
