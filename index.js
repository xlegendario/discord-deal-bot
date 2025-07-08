require('dotenv').config();
const express = require('express');
const { Client, GatewayIntentBits, ChannelType, EmbedBuilder, PermissionsBitField, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, ButtonBuilder, ButtonStyle, Events } = require('discord.js');
const { google } = require('googleapis');
const Airtable = require('airtable');

const app = express();
app.use(express.json());

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);
const PORT = process.env.PORT || 3000;

// Google Sheets setup
const auth = new google.auth.JWT(
  process.env.GOOGLE_CLIENT_EMAIL,
  null,
  process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  ['https://www.googleapis.com/auth/spreadsheets']
);
const sheets = google.sheets({ version: 'v4', auth });

async function appendToSheet(data) {
  const request = {
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: 'Sheet1!A1',
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    resource: {
      values: [[
        data.productName,   // Model Name
        data.sku,           // SKU
        data.payout,        // Price
        data.sellerId,      // Seller ID
        data.orderNumber    // Ticket Number
      ]]
    }
  };
  await sheets.spreadsheets.values.append(request);
}

client.once('ready', () => {
  console.log(`🤖 Bot is online as ${client.user.tag}`);
});

app.post('/claim-deal', async (req, res) => {
  const { orderNumber, productName, sku, payout, recordId } = req.body;

  if (!orderNumber || !productName || !sku || !payout || !recordId) {
    return res.status(400).send("Missing required fields");
  }

  try {
    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    const category = await guild.channels.fetch(process.env.CATEGORY_ID);

    const channel = await guild.channels.create({
      name: `deal-${orderNumber}`,
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: [
        {
          id: guild.roles.everyone,
          deny: [PermissionsBitField.Flags.ViewChannel]
        }
      ]
    });

    const invite = await channel.createInvite({ maxUses: 1, unique: true });
    const inviteUrl = invite.url;

    const embed = new EmbedBuilder()
      .setTitle("💸 Deal Claim")
      .setDescription(`Welkom bij je deal!\n\n**Product:** ${productName}\n**SKU:** ${sku}\n**Payout:** €${payout}`)
      .setColor(0x00AE86);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('start_claim')
        .setLabel('Start Claim')
        .setStyle(ButtonStyle.Primary)
    );

    await channel.send({ embeds: [embed], components: [row] });

    await base('Unfulfilled Orders Log').update(recordId, {
      "Deal Invitation URL": inviteUrl
    });

    res.redirect(302, `https://kickzcaviar.preview.softr.app/success?recordId=${recordId}`);

  } catch (err) {
    console.error("❌ Error during claim:", err);
    res.status(500).send("Internal Server Error");
  }
});

client.on(Events.InteractionCreate, async interaction => {
  if (interaction.isButton() && interaction.customId === 'start_claim') {
    const modal = new ModalBuilder()
      .setCustomId('seller_id_modal')
      .setTitle('Voer je Seller ID in');

    const sellerInput = new TextInputBuilder()
      .setCustomId('seller_id')
      .setLabel("Seller ID")
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const row = new ActionRowBuilder().addComponents(sellerInput);
    modal.addComponents(row);

    await interaction.showModal(modal);
  }

  if (interaction.isModalSubmit() && interaction.customId === 'seller_id_modal') {
    const sellerId = interaction.fields.getTextInputValue('seller_id');

    await interaction.reply({
      content: `✅ Seller ID ontvangen: **${sellerId}**\nUpload nu een foto van het paar.`,
      ephemeral: true
    });

    const channel = interaction.channel;
    channel.sellerData = { sellerId };
  }

  if (interaction.isButton() && interaction.customId === 'confirm_deal') {
    const channel = interaction.channel;
    const messages = await channel.messages.fetch({ limit: 50 });

    const imageMsg = messages.find(msg => msg.attachments.size > 0);
    const imageUrl = imageMsg?.attachments.first()?.url;
    const sellerId = channel.sellerData?.sellerId;

    if (!imageMsg || !sellerId) {
      return interaction.reply({ content: '❌ Afbeelding of Seller ID ontbreekt.', ephemeral: true });
    }

    if (!interaction.message.embeds.length || !interaction.message.embeds[0].description) {
      return interaction.reply({ content: '❌ Embed met dealinformatie ontbreekt.', ephemeral: true });
    }

    const [productLine, skuLine, payoutLine] = interaction.message.embeds[0].description.split('\n');
    const productName = productLine.split('**')[1];
    const sku = skuLine.split('**')[1];
    const payout = payoutLine.split('**')[1];

    await appendToSheet({
      orderNumber: channel.name.split('-')[1],
      productName,
      sku,
      payout,
      sellerId
    });

    await interaction.reply({ content: '✅ Deal toegevoegd aan Google Sheets!', ephemeral: true });
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
