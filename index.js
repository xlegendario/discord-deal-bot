require('dotenv').config();
const express = require('express');
const { Client, GatewayIntentBits, ChannelType, EmbedBuilder, PermissionsBitField } = require('discord.js');
const Airtable = require('airtable');

const app = express();
app.use(express.json());

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);
const PORT = process.env.PORT || 3000;

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

    await channel.send({ embeds: [embed] });

    await base('Unfulfilled Orders Log').update(recordId, {
      "Deal Invitation URL": inviteUrl
    });

    console.log("✅ Airtable updated successfully");

    // 👉 Redirect to Softr success page with recordId in query
    const redirectUrl = `https://kickzcaviar.preview.softr.app/success?recordId=${recordId}`;
    res.redirect(302, redirectUrl);

  } catch (err) {
    console.error("❌ Error during claim:", err);
    res.status(500).send("Internal Server Error");
  }
});

client.login(process.env.DISCORD_TOKEN);

app.listen(PORT, () => {
  console.log(`🌐 Express server running on port ${PORT}`);
});
