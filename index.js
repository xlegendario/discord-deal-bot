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

app.post('/claim-deal', async (req, res) => {
  const { orderNumber, productName, sku, skuSoft, size, brand, payout, recordId } = req.body;

  const orderRecord = await base('Unfulfilled Orders Log').find(recordId);
  const imageUrl = orderRecord.get('Picture')?.[0]?.url || null;
  const cleanProductName = orderRecord.get('Product Name');
  const orderId = orderRecord.get('Order ID');

  const finalSku = (Array.isArray(sku) ? sku[0] : sku || '').trim() ||
                   (Array.isArray(skuSoft) ? skuSoft[0] : skuSoft || '').trim();

  if (!orderId || !cleanProductName || !finalSku || !size || !brand || !payout || !recordId) {
    return res.status(400).send("Missing required fields");
  }

  try {
    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    const category = await guild.channels.fetch(process.env.CATEGORY_ID);

    const channel = await guild.channels.create({
      name: orderId.toLowerCase(),
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: [
        {
          id: guild.roles.everyone,
          deny: [PermissionsBitField.Flags.ViewChannel]
        }
      ]
    });

    const invite = await client.channels.fetch(VERIFY_CHANNEL_ID).then(ch => ch.createInvite({ maxUses: 1 }));

    const embed = new EmbedBuilder()
      .setTitle("💸 Deal Claimed")
      .setDescription(`**Order:** ${orderId}\n**Product:** ${cleanProductName}\n**SKU:** ${finalSku}\n**Size:** ${size}\n**Brand:** ${brand}\n**Payout:** €${payout.toFixed(2)}`)
      .setColor(0x00AE86);

    if (imageUrl) embed.setImage(imageUrl);

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
      .setTitle('Verify Deal Access')
      .addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('record_id')
          .setLabel('Paste your Claim ID (e.g. recXXXX)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      ));

    return interaction.showModal(modal);
  }

  if (interaction.isModalSubmit() && interaction.customId === 'record_id_verify') {
    const recordId = interaction.fields.getTextInputValue('record_id').trim();

    try {
      const orderRecord = await base('Unfulfilled Orders Log').find(recordId);
      const orderId = orderRecord.get('Order ID');
      const guild = await client.guilds.fetch(process.env.GUILD_ID);
      const channels = await guild.channels.fetch();
      const dealChannel = channels.find(c => c.name === orderId.toLowerCase());

      if (!dealChannel) {
        return interaction.reply({ content: '❌ Deal channel not found.', flags: 1 << 6 });
      }

      await dealChannel.permissionOverwrites.create(interaction.user.id, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true
      });

      return interaction.reply({ content: `✅ Access granted to <#${dealChannel.id}>`, flags: 1 << 6 });
    } catch (err) {
      console.error("❌ Access error:", err);
      return interaction.reply({ content: '❌ Invalid Claim ID.', flags: 1 << 6 });
    }
  }

  if (interaction.isButton() && interaction.customId === 'start_claim') {
    const modal = new ModalBuilder()
      .setCustomId('seller_id_modal')
      .setTitle('Enter Seller ID')
      .addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('seller_id')
          .setLabel("Seller ID (e.g. 00001)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      ));

    return interaction.showModal(modal);
  }

  if (interaction.isModalSubmit() && interaction.customId === 'seller_id_modal') {
    const sellerIdRaw = interaction.fields.getTextInputValue('seller_id').replace(/\D/g, '');
    const sellerId = `SE-${sellerIdRaw.padStart(5, '0')}`;
    const channelId = interaction.channel.id;

    sellerMap.set(channelId, {
      ...(sellerMap.get(channelId) || {}),
      sellerId
    });

    await interaction.reply({
      content: `✅ Seller ID received: **${sellerId}**\nPlease upload a picture of the pair to prove it's in-hand.`,
      flags: 1 << 6
    });
  }

  if (interaction.isButton() && interaction.customId === 'confirm_deal') {
    const isAdmin = ADMIN_ROLE_IDS.some(id => interaction.member.roles.cache.has(id));
    if (!isAdmin) return interaction.reply({ content: '❌ Not authorized.', flags: 1 << 6 });

    const channel = interaction.channel;
    const messages = await channel.messages.fetch({ limit: 50 });
    const imageMsg = messages.find(m => m.attachments.size > 0);

    if (!imageMsg) return interaction.reply({ content: '❌ No picture found.', flags: 1 << 6 });

    const data = sellerMap.get(channel.id);
    if (!data?.recordId || !data?.sellerId) return interaction.reply({ content: '❌ Missing Seller ID or Claim ID.', flags: 1 << 6 });

    const record = await base('Unfulfilled Orders Log').find(data.recordId);
    const sellerRecord = await base('Sellers Database').select({
      filterByFormula: `{Seller ID} = "${data.sellerId}"`,
      maxRecords: 1
    }).firstPage();

    if (!sellerRecord.length) {
      return interaction.reply({ content: `❌ Seller ${data.sellerId} not found.`, flags: 1 << 6 });
    }

    const embed = messages.find(m => m.embeds.length)?.embeds[0];
    const fields = embed.description.split('\n').reduce((acc, line) => {
      const match = /\*\*(.*?)\*\*:\s*(.*)/.exec(line);
      if (match) acc[match[1]] = match[2];
      return acc;
    }, {});

    await base('Inventory Units').create({
      'Product Name': record.get('Product Name'),
      'SKU': fields['SKU'],
      'Size': fields['Size'],
      'Brand': fields['Brand'],
      'Purchase Price': parseFloat(fields['Payout'].replace('€', '')),
      'Purchase Date': new Date().toISOString().split('T')[0],
      'Shipping Deduction': 0,
      'Seller ID': [sellerRecord[0].id],
      'Ticket Number': fields['Order'],
      'Type': 'Direct',
      'Verification Status': 'Verified',
      'Payment Status': 'To Pay',
      'Availability Status': 'Reserved',
      'Margin %': '10%',
      'Unfulfilled Orders Log': [data.recordId]
    });

    await interaction.reply({ content: '✅ Deal confirmed and saved to Airtable!', flags: 1 << 6 });
  }
});

client.on(Events.MessageCreate, async message => {
  if (message.channel.name.toLowerCase().startsWith('ord-') && message.attachments.size > 0) {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('confirm_deal')
        .setLabel('Confirm Deal')
        .setStyle(ButtonStyle.Success)
    );

    await message.channel.send({ content: 'Admin: click to confirm this deal.', components: [row] });
  }
});

client.login(process.env.DISCORD_TOKEN);
app.listen(PORT, () => {
  console.log(`🌐 Express server running on port ${PORT}`);
});
