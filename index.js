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
  console.log("📥 Received POST /claim-deal with body:", req.body);

  const orderRecord = await base('Unfulfilled Orders Log').find(recordId);
  const pictureField = orderRecord.get('Picture');
  const imageUrl = Array.isArray(pictureField) && pictureField.length > 0 ? pictureField[0].url : null;

  const rawSku = Array.isArray(sku) ? sku[0] : (typeof sku === 'string' ? sku : '');
  const rawSkuSoft = Array.isArray(skuSoft) ? skuSoft[0] : (typeof skuSoft === 'string' ? skuSoft : '');
  const finalSku = rawSku.trim() !== '' ? rawSku.trim() : rawSkuSoft.trim();

  const cleanProductName = orderRecord.get('Product Name');
  const orderId = orderRecord.get('Order ID');

  if (!orderId || !cleanProductName || !finalSku || !size || !brand || !payout || !recordId) {
    return res.status(400).send("Missing required fields");
  }

  try {
    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    const category = await guild.channels.fetch(process.env.CATEGORY_ID);

    const channel = await guild.channels.create({
      name: `${orderId.toLowerCase()}`,
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
      .setDescription(`**Order:** ${orderId}\n**Product:** ${cleanProductName}\n**SKU:** ${finalSku}\n**Size:** ${size}\n**Brand:** ${brand}\n**Payout:** €${payout.toFixed(2)}`)
      .setColor(0x00AE86);

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
        return interaction.reply({ content: '❌ Could not find Order ID for this Claim ID.', flags: 1 << 6 });
      }

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
      console.error('❌ Error verifying access:', err);
      return interaction.reply({ content: '❌ Invalid Claim ID or error occurred.', flags: 1 << 6 });
    }
  }

  if (interaction.isButton() && interaction.customId === 'start_claim') {
    const modal = new ModalBuilder()
      .setCustomId('seller_id_modal')
      .setTitle('Please fill in your Seller ID');

    const input = new TextInputBuilder()
      .setCustomId('seller_id')
      .setLabel("Seller ID (numerical, e.g. 00001)")
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(input));
    await interaction.showModal(modal);
  }

  if (interaction.isModalSubmit() && interaction.customId === 'seller_id_modal') {
    const sellerIdRaw = interaction.fields.getTextInputValue('seller_id').replace(/\D/g, '');
    const sellerId = `SE-${sellerIdRaw.padStart(5, '0')}`;

    sellerMap.set(interaction.channel.id, {
      ...(sellerMap.get(interaction.channel.id) || {}),
      sellerId
    });

    await interaction.reply({
      content: `✅ Seller ID received: **${sellerId}**\nPlease upload a picture of the pair to prove it's in-hand.`,
      flags: 1 << 6
    });
  }
});

client.login(process.env.DISCORD_TOKEN);
app.listen(PORT, () => {
  console.log(`🌐 Express server running on port ${PORT}`);
});
