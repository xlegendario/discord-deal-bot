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

const sellerMap = new Map(); // 🧠 Stores sellerId by channel ID

client.once('ready', () => {
  console.log(`🤖 Bot is online as ${client.user.tag}`);
});

app.post('/claim-deal', async (req, res) => {
  const { orderNumber, productName, sku, size, brand, payout, recordId } = req.body;
  console.log("Received POST /claim-deal with body:", req.body);

  const normalizedSku = Array.isArray(sku) ? sku[0] : sku;

  if (!orderNumber || !productName || !normalizedSku || !size || !brand || !payout || !recordId) {
    return res.status(400).send("Missing required fields");
  }

  try {
    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    const category = await guild.channels.fetch(process.env.CATEGORY_ID);

    const channel = await guild.channels.create({
      name: `deal-${orderNumber}`,
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: [{
        id: guild.roles.everyone,
        deny: [PermissionsBitField.Flags.ViewChannel]
      }]
    });

    const invite = await channel.createInvite({ maxUses: 1, unique: true });

    const embed = new EmbedBuilder()
      .setTitle("💸 Deal Claim")
      .setDescription(`Welkom bij je deal!\n\n**Product:** ${productName}\n**SKU:** ${normalizedSku}\n**Size:** ${size}\n**Brand:** ${brand}\n**Payout:** €${payout}`)
      .setColor(0x00AE86);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('start_claim')
        .setLabel('Start Claim')
        .setStyle(ButtonStyle.Primary)
    );

    await channel.send({ embeds: [embed], components: [row] });

    await base('Unfulfilled Orders Log').update(recordId, {
      "Deal Invitation URL": invite.url
    });

    res.redirect(302, `https://kickzcaviar.preview.softr.app/success?recordId=${recordId}`);
  } catch (err) {
    console.error("❌ Error during claim creation:", err);
    res.status(500).send("Internal Server Error");
  }
});

client.on(Events.InteractionCreate, async interaction => {
  if (interaction.isButton() && interaction.customId === 'start_claim') {
    const modal = new ModalBuilder()
      .setCustomId('seller_id_modal')
      .setTitle('Voer je Seller ID in');

    const input = new TextInputBuilder()
      .setCustomId('seller_id')
      .setLabel("Seller ID (nummeriek, bijv. 00001)")
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(input));
    await interaction.showModal(modal);
  }

  if (interaction.isModalSubmit() && interaction.customId === 'seller_id_modal') {
    let sellerId = interaction.fields.getTextInputValue('seller_id').replace(/\D/g, '');
    sellerId = `SE-${sellerId.padStart(5, '0')}`;
    sellerMap.set(interaction.channel.id, sellerId);

    await interaction.reply({
      content: `✅ Seller ID ontvangen: **${sellerId}**\nUpload nu een foto van het paar.`,
      flags: 1 << 6
    });
  }

  if (interaction.isButton() && interaction.customId === 'confirm_deal') {
    const channel = interaction.channel;
    const messages = await channel.messages.fetch({ limit: 50 });

    const imageMsg = messages.find(m => m.attachments.size > 0);
    const sellerId = sellerMap.get(channel.id);

    if (!imageMsg || !sellerId) {
      return interaction.reply({ content: '❌ Afbeelding of Seller ID ontbreekt.', flags: 1 << 6 });
    }

    const sellerId = sellerMap.get(channel.id);

    if (!sellerId) {
      return interaction.reply({ content: '❌ Seller ID ontbreekt.', flags: 1 << 6 });
    }

    const imageMsg = messages.find(m =>
      m.attachments.some(att => att.contentType?.startsWith('image/'))
    );

    if (!imageMsg) {
      return interaction.reply({ content: '❌ Afbeelding ontbreekt.', flags: 1 << 6 });
    }


    // ✅ define `lines` to fix crash
    const lines = embed.description.split('\n');

    const getValueFromLine = (label) =>
      lines.find(line => line.includes(label))?.split(`${label}`)[1]?.trim() || '';

    const productName = getValueFromLine('**Product:**');
    const sku = getValueFromLine('**SKU:**');
    const size = getValueFromLine('**Size:**');
    const brand = getValueFromLine('**Brand:**');
    const payout = getValueFromLine('**Payout:**')?.replace('€', '');
    const orderNumber = channel.name.split('-')[1];

    try {
      const sellerRecords = await base('Sellers Database')
        .select({
          filterByFormula: `{Seller ID} = "${sellerId}"`,
          maxRecords: 1
        })
        .firstPage();

      if (!sellerRecords.length) {
        return interaction.reply({
          content: `❌ Seller with ID "${sellerId}" not found in Airtable.`,
          flags: 1 << 6
        });
      }

      const sellerRecordId = sellerRecords[0].id;

      await base('Inventory Units').create({
        'Product Name': productName,
        'SKU': sku,
        'Size': size,
        'Brand': brand,
        'Purchase Price': parseFloat(payout),
        'Shipping Deduction': 0,
        'Purchase Date': new Date().toISOString().split('T')[0],
        'Seller ID': [sellerRecordId],
        'Ticket Number': channel.name,
        'Type': 'Direct',
        'Verification Status': 'Verified',
        'Payment Status': 'To Pay',
        'Availability Status': 'Available',
        'Margin %': '10%'
      });

      await interaction.reply({ content: '✅ Deal succesvol toegevoegd aan Airtable!', flags: 1 << 6 });
    } catch (err) {
      console.error("❌ Airtable add error:", err);
      await interaction.reply({ content: '❌ Mislukt om deal toe te voegen aan Airtable.', flags: 1 << 6 });
    }
  }
});

client.on(Events.MessageCreate, async message => {
  if (message.channel.name.startsWith('deal-') && message.attachments.size > 0) {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('confirm_deal')
        .setLabel('Confirm Deal')
        .setStyle(ButtonStyle.Success)
    );

    await message.channel.send({ content: 'Admin: klik op de knop om de deal te bevestigen.', components: [row] });
  }
});

client.login(process.env.DISCORD_TOKEN);
app.listen(PORT, () => {
  console.log(`🌐 Express server running on port ${PORT}`);
});
