require('dotenv').config();
const express = require('express');
const { Client, GatewayIntentBits, ChannelType, EmbedBuilder, PermissionsBitField, ActionRowBuilder, ButtonBuilder, ButtonStyle, Events } = require('discord.js');
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
  process.env.GOOGLE_PRIVATE_KEY.replace(/\n/g, '\n'),
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
        data.orderNumber,
        data.productName,
        data.sku,
        data.payout,
        data.sellerId,
        data.imageUrl,
        new Date().toLocaleString()
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

  console.log('📥 Incoming request body:', req.body);

  if (!orderNumber || !productName || !sku || !payout || !recordId) {
    console.warn('⚠️ Missing fields:', { orderNumber, productName, sku, payout, recordId });
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
    console.log(`🔗 Created invite: ${inviteUrl}`);

    const embed = new EmbedBuilder()
      .setTitle("💸 Deal Claim")
      .setDescription(`Welkom bij je deal!\n\n**Product:** ${productName}\n**SKU:** ${sku}\n**Payout:** €${payout}\n\nVoer hieronder je Seller ID in om te starten.`)
      .setColor(0x00AE86);

    const confirmBtn = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('confirm_deal')
        .setLabel('Confirm Deal')
        .setStyle(ButtonStyle.Success)
    );

    await channel.send({ embeds: [embed] });
    await channel.send({ content: 'Admin: klik op de knop hieronder om de deal te bevestigen.', components: [confirmBtn] });

    await base('Unfulfilled Orders Log').update(recordId, {
      "Deal Invitation URL": inviteUrl
    });

    console.log("✅ Airtable updated successfully");

    const redirectUrl = `https://kickzcaviar.preview.softr.app/success?recordId=${recordId}`;
    res.redirect(302, redirectUrl);

  } catch (err) {
    console.error("❌ Error during claim:", err);
    res.status(500).send("Internal Server Error");
  }
});

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isButton()) return;

  if (interaction.customId === 'confirm_deal') {
    const messages = await interaction.channel.messages.fetch({ limit: 20 });
    const sellerIdMsg = messages.find(m => !m.author.bot && m.content);
    const imageMsg = messages.find(m => m.attachments.size > 0);

    if (!sellerIdMsg || !imageMsg) {
      await interaction.reply({ content: '❌ Seller ID of afbeelding ontbreekt.', ephemeral: true });
      return;
    }

    const [_, productLine] = interaction.message.embeds[0].description.split('\n');
    const productName = productLine.split('**')[1];

    await appendToSheet({
      orderNumber: interaction.channel.name.split('-')[1],
      productName,
      sku: 'unknown',
      payout: 'unknown',
      sellerId: sellerIdMsg.content,
      imageUrl: imageMsg.attachments.first().url
    });

    await interaction.reply({ content: '✅ Deal bevestigd en toegevoegd aan Google Sheet!', ephemeral: true });
  }
});

client.login(process.env.DISCORD_TOKEN);

app.listen(PORT, () => {
  console.log(`🌐 Express server running on port ${PORT}`);
});
