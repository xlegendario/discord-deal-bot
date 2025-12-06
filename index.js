require('dotenv').config();
const express = require('express');
const cors = require('cors');
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
const { createTranscript } = require('discord-html-transcripts');
const fetch = require('node-fetch'); // for Make webhook

/* ---------------- EXPRESS SETUP ---------------- */

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// basic CORS so you can ping endpoints from Make, Airtable, etc.
app.use(
  cors({
    origin: (_origin, cb) => cb(null, true),
    methods: ['POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Requested-With'],
  })
);
app.options(/.*/, cors());

/* ---------------- DISCORD CLIENT ---------------- */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

// crash guards
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});
client.on('error', (err) => {
  console.error('Client error:', err);
});

/* ---------------- AIRTABLE + ENV ---------------- */

const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(
  process.env.AIRTABLE_BASE_ID
);

const PORT = process.env.PORT || 3000;

// Discord
const GUILD_ID = process.env.GUILD_ID;
const DEAL_CATEGORY_ID = process.env.CATEGORY_ID;        // category for ORD-xxxx channels
const QUICK_DEALS_CHANNEL_ID = process.env.QUICK_DEALS_CHANNEL_ID; // channel where Quick Deals listing embeds live
const TRANSCRIPTS_CHANNEL_ID = process.env.TRANSCRIPTS_CHANNEL_ID;

// Roles / permissions
const ADMIN_ROLE_IDS = ['942779423449579530', '1060615571118510191'];
const TRUSTED_SELLERS_ROLE_ID = process.env.TRUSTED_SELLERS_ROLE_ID;

// Webhook to Make (for Inventory Unit creation etc.)
const MAKE_QUICK_DEAL_WEBHOOK_URL = process.env.MAKE_QUICK_DEAL_WEBHOOK_URL || '';

/* ---------------- RUNTIME STATE ---------------- */

const sellerMap = new Map();        // channelId -> {orderRecordId, sellerRecordId, ...}
const uploadedImagesMap = new Map();// channelId -> [imageUrls...]

async function fetchUpTo(channel, max = 500) {
  const collected = [];
  let beforeId;

  while (collected.length < max) {
    const batchSize = Math.min(100, max - collected.length);
    const batch = await channel.messages.fetch({
      limit: batchSize,
      ...(beforeId ? { before: beforeId } : {})
    });
    if (batch.size === 0) break;

    for (const m of batch.values()) collected.push(m);

    const oldest = batch.last();
    beforeId = oldest?.id;
    if (!beforeId) break;
  }
  return collected;
}

function asText(v) {
  if (v == null) return '';
  if (Array.isArray(v)) {
    if (v.length === 0) return '';
    const first = v[0];
    if (first == null) return '';
    if (typeof first === 'object') {
      if (first.text != null)  return String(first.text);
      if (first.name != null)  return String(first.name);
      if (first.value != null) return String(first.value);
    }
    return String(first);
  }
  return String(v);
}

/* ---------------- DISCORD READY ---------------- */

client.once('ready', async () => {
  console.log(`🤖 Bot is online as ${client.user.tag}`);
});

/* =================================================
   QUICK DEALS – LISTING EMBED CREATION & UPDATES
   ================================================= */

/**
 * POST /quick-deal/create
 *
 * Called from Make (or anywhere) to post a Quick Deal listing embed
 * with a Claim button into the QUICK_DEALS_CHANNEL_ID.
 *
 * Body:
 *  {
 *    recordId: "recXXXX",            // Unfulfilled Orders Log record ID
 *    orderNumber: "ORD-002695",
 *    productName: "...",
 *    sku: "SKU123",
 *    size: "EU 42",
 *    brand: "Jordan",
 *    currentPayout: 185,
 *    maxPayout: 220,
 *    imageUrl: "https://..."        // optional
 *  }
 *
 * It will also update that Unfulfilled Orders Log record with:
 *  - Claim Message ID
 *  - Claim Message URL
 */
app.post('/quick-deal/create', async (req, res) => {
  try {
    const {
      recordId,
      orderNumber,
      productName,
      sku,
      size,
      brand,
      currentPayout,
      maxPayout,
      imageUrl
    } = req.body || {};

    if (!QUICK_DEALS_CHANNEL_ID) {
      return res.status(400).send('Missing QUICK_DEALS_CHANNEL_ID env');
    }
    if (!recordId) {
      return res.status(400).send('Missing recordId');
    }

    const guild = await client.guilds.fetch(GUILD_ID);
    const channel = await guild.channels.fetch(QUICK_DEALS_CHANNEL_ID);

    if (!channel || !channel.isTextBased()) {
      return res.status(404).send('Quick Deals channel not found or not text-based');
    }

    const embed = new EmbedBuilder()
      .setTitle('⚡ Quick Deal')
      .setDescription(
        `**Order:** ${orderNumber || '-'}\n` +
        `**Product:** ${productName || '-'}\n` +
        `**SKU:** ${sku || '-'}\n` +
        `**Size:** ${size || '-'}\n` +
        `**Brand:** ${brand || '-'}`
      )
      .setColor(0xFFED00)
      .addFields(
        {
          name: 'Current Payout',
          value: currentPayout != null ? `€${Number(currentPayout).toFixed(2)}` : '-',
          inline: true
        },
        {
          name: 'Max Payout',
          value: maxPayout != null ? `€${Number(maxPayout).toFixed(2)}` : '-',
          inline: true
        }
      );

    if (imageUrl) embed.setImage(imageUrl);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`quick_claim_${recordId}`) // 🔑 Unfulfilled Orders Log record ID
        .setLabel('Claim Deal')
        .setStyle(ButtonStyle.Success)
    );

    const msg = await channel.send({ embeds: [embed], components: [row] });

    const messageUrl = GUILD_ID
      ? `https://discord.com/channels/${GUILD_ID}/${QUICK_DEALS_CHANNEL_ID}/${msg.id}`
      : null;

    // Store listing message data on the Unfulfilled Orders Log record
    try {
      await base('Unfulfilled Orders Log').update(recordId, {
        'Claim Message ID': msg.id,
        'Claim Message URL': messageUrl
      });
    } catch (e) {
      console.warn('⚠️ Could not update Unfulfilled Orders Log with Claim Message fields:', e.message);
    }

    return res.status(200).json({
      ok: true,
      channelId: QUICK_DEALS_CHANNEL_ID,
      messageId: msg.id,
      messageUrl
    });
  } catch (err) {
    console.error('❌ Error creating Quick Deal embed:', err);
    return res.status(500).send('Internal Server Error');
  }
});

/**
 * POST /quick-deal/update-embed
 *
 * Used to update the listing embed (Current Payout / Max Payout).
 * You said you’ll trigger this via Airtable Automations later.
 *
 * Body:
 *  {
 *    messageId: "1234567890",
 *    currentPayout: 195,
 *    maxPayout: 220
 *  }
 */
app.post('/quick-deal/update-embed', async (req, res) => {
  try {
    const { channelId, messageId, currentPayout, maxPayout } = req.body || {};

    const targetChannelId = channelId || QUICK_DEALS_CHANNEL_ID;

    if (!targetChannelId || !messageId) {
      return res.status(400).send('Missing QUICK_DEALS_CHANNEL_ID or messageId');
    }

    const guild = await client.guilds.fetch(GUILD_ID);
    const channel = await guild.channels.fetch(targetChannelId);

    if (!channel || !channel.isTextBased()) {
      return res.status(404).send('Channel not found or not text-based');
    }

    const msg = await channel.messages.fetch(messageId);
    if (!msg || !msg.embeds || msg.embeds.length === 0) {
      return res.status(404).send('Message or embed not found');
    }

    const oldEmbed = msg.embeds[0];
    const newEmbed = EmbedBuilder.from(oldEmbed);
    const fields = [...(oldEmbed.fields || [])];

    const setField = (name, value) => {
      const idx = fields.findIndex(f => f.name === name);
      const val = value != null ? String(value) : '';
      if (idx >= 0) {
        fields[idx] = { ...fields[idx], value: val };
      } else {
        fields.push({ name, value: val, inline: true });
      }
    };

    if (currentPayout != null) {
      setField('Current Payout', `€${Number(currentPayout).toFixed(2)}`);
    }
    if (maxPayout != null) {
      setField('Max Payout', `€${Number(maxPayout).toFixed(2)}`);
    }

    newEmbed.setFields(fields);
    await msg.edit({ embeds: [newEmbed] });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('❌ Error updating Quick Deal embed:', err);
    return res.status(500).send('Internal Server Error');
  }
});

/* =================================================
   DISCORD INTERACTIONS – QUICK DEAL CLAIM & FLOW
   ================================================= */

client.on(Events.InteractionCreate, async interaction => {
  // Ignore other bots / partner-prefixed things if needed later
  if (
    (interaction.isButton() && interaction.customId.startsWith('partner_')) ||
    (interaction.isModalSubmit() && interaction.customId.startsWith('partner_'))
  ) {
    return;
  }

  /* ---------- QUICK DEAL: Claim button → modal ---------- */

  if (interaction.isButton() && interaction.customId.startsWith('quick_claim_')) {
    const recordId = interaction.customId.replace('quick_claim_', '').trim(); // Unfulfilled Orders Log recId

    const modal = new ModalBuilder()
      .setCustomId(`quick_claim_modal_${recordId}`)
      .setTitle('Claim Quick Deal');

    const sellerInput = new TextInputBuilder()
      .setCustomId('seller_id')
      .setLabel('Seller ID (e.g. 00001)')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const vatInput = new TextInputBuilder()
      .setCustomId('vat_type')
      .setLabel('VAT Type (Margin / VAT21 / VAT0)')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    modal.addComponents(
      new ActionRowBuilder().addComponents(sellerInput),
      new ActionRowBuilder().addComponents(vatInput)
    );

    try {
      await interaction.showModal(modal);
    } catch (err) {
      if (err.code === 10062) {
        await interaction.channel.send({
          content: '⚠️ That Quick Deal button expired. Please use a fresh one if available.'
        });
        return;
      }
      console.error('quick_claim showModal failed:', err);
      try {
        await interaction.reply({
          content: '❌ Could not open the Quick Deal claim form. Please try again.',
          ephemeral: true
        });
      } catch (_) {}
    }
    return;
  }

  /* ---------- QUICK DEAL: modal submit (Seller ID + VAT) ---------- */

  if (interaction.isModalSubmit() && interaction.customId.startsWith('quick_claim_modal_')) {
    const recordId = interaction.customId.replace('quick_claim_modal_', '').trim(); // Unfulfilled Orders Log recId
    const sellerIdRaw = interaction.fields.getTextInputValue('seller_id').replace(/\D/g, '');
    const vatRaw = interaction.fields.getTextInputValue('vat_type').trim().toLowerCase();

    const sellerId = `SE-${sellerIdRaw.padStart(5, '0')}`;

    let vatType;
    if (vatRaw === 'margin') vatType = 'Margin';
    else if (vatRaw === 'vat21' || vatRaw === '21' || vatRaw === '21%') vatType = 'VAT21';
    else if (vatRaw === 'vat0' || vatRaw === '0' || vatRaw === '0%') vatType = 'VAT0';
    else {
      return interaction.reply({
        content: '❌ Invalid VAT Type. Please use **Margin**, **VAT21** or **VAT0**.',
        ephemeral: true
      });
    }

    try {
      // 1) Validate Seller in Sellers Database
      const sellerRecords = await base('Sellers Database')
        .select({ filterByFormula: `{Seller ID} = "${sellerId}"`, maxRecords: 1 })
        .firstPage();

      if (sellerRecords.length === 0) {
        return interaction.reply({
          content: `❌ Seller ID **${sellerId}** not found.`,
          ephemeral: true
        });
      }
      const sellerRecord = sellerRecords[0];

      // 2) Fetch the order directly from Unfulfilled Orders Log
      const orderRecord = await base('Unfulfilled Orders Log').find(recordId);

      const orderNumber = String(orderRecord.get('Order ID') || '');
      const size        = orderRecord.get('Size') || '';
      const brand       = orderRecord.get('Brand') || '';
      const productName =
        orderRecord.get('Product Name') ??
        orderRecord.get('Shopify Product Name') ??
        '';

      const sku     = asText(orderRecord.get('SKU')).trim();
      const skuSoft = asText(orderRecord.get('SKU (Soft)')).trim();
      const finalSku = sku || skuSoft;

      const payoutMargin = Number(orderRecord.get('Outsource Buying Price') || 0);
      const payoutVat0   = Number(orderRecord.get('Outsource Buying Price (VAT 0%)') || 0);

      const payout = (vatType === 'VAT0') ? payoutVat0 : payoutMargin;

      const pictureField = orderRecord.get('Picture');
      const imageUrl =
        Array.isArray(pictureField) && pictureField.length > 0
          ? pictureField[0].url
          : null;

      if (!orderNumber || !productName || !finalSku || !size || !brand || !Number.isFinite(payout) || payout <= 0) {
        return interaction.reply({
          content: '❌ Missing or invalid order fields for this Quick Deal.',
          ephemeral: true
        });
      }

      // 3) Create Discord ORD-xxxx channel for this claim
      const guild = await client.guilds.fetch(GUILD_ID);
      const category = await guild.channels.fetch(DEAL_CATEGORY_ID);

      const channel = await guild.channels.create({
        name: `${orderNumber.toLowerCase()}`,
        type: ChannelType.GuildText,
        parent: category?.id,
        permissionOverwrites: [
          {
            id: guild.roles.everyone,
            deny: [PermissionsBitField.Flags.ViewChannel]
          },
          {
            id: interaction.user.id,
            allow: [
              PermissionsBitField.Flags.ViewChannel,
              PermissionsBitField.Flags.SendMessages,
              PermissionsBitField.Flags.AttachFiles
            ]
          }
        ]
      });

      // 4) Send claimed embed in that channel
      const embed = new EmbedBuilder()
        .setTitle('💸 Quick Deal Claimed')
        .setDescription(
          `**Order:** ${orderNumber}\n` +
          `**Product:** ${productName}\n` +
          `**SKU:** ${finalSku}\n` +
          `**Size:** ${size}\n` +
          `**Brand:** ${brand}\n` +
          `**Payout:** €${payout.toFixed(2)}\n` +
          `**VAT Type:** ${vatType}\n` +
          `**Seller:** ${sellerId}`
        )
        .setColor(0xFFED00);

      if (imageUrl) embed.setImage(imageUrl);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('cancel_deal')
          .setLabel('Cancel Deal')
          .setStyle(ButtonStyle.Danger)
      );

      const dealMsg = await channel.send({
        content:
          '👋 Thanks for claiming this Quick Deal!\n\n' +
          '📸 Please upload **6 clear pictures** of the pair (like shown below) to prove it is in-hand and complete.\n' +
          'Once all 6 are uploaded, an admin can confirm the deal.',
        embeds: [embed],
        components: [row]
      });

      // guide image
      await channel.send({ files: ['https://i.imgur.com/JKaeeNz.png'] });

      // 5) Cache + persist who claimed
      sellerMap.set(channel.id, {
        orderRecordId: recordId,
        dealEmbedId: dealMsg.id,
        sellerRecordId: sellerRecord.id,
        sellerDiscordId: interaction.user.id,
        vatType,
        payoutChosen: payout,
        isQuickDeal: true,
        confirmed: false
      });

      await base('Unfulfilled Orders Log').update(recordId, {
        'Claimed Channel ID': channel.id,
        'Claimed Message ID': dealMsg.id,
        'Claimed Seller ID': [sellerRecord.id],
        'Claimed Seller Discord ID': interaction.user.id,
        'Claimed Seller Confirmed?': false,
        'Claimed Seller VAT Type': vatType,
        'Fulfillment Status': 'Claim Processing'
      });

      await interaction.reply({
        content: `✅ Quick Deal claimed! Your deal channel is <#${channel.id}>.\nPlease upload **6 pictures** of the pair as requested in the channel.`,
        ephemeral: true
      });
    } catch (err) {
      console.error('❌ Error processing Quick Deal claim:', err);
      return interaction.reply({
        content: '❌ Something went wrong while claiming this Quick Deal. Please try again.',
        ephemeral: true
      });
    }
    return;
  }

  /* ---------- CANCEL DEAL BUTTON (Quick Deals + legacy) ---------- */

  if (interaction.isButton() && interaction.customId === 'cancel_deal') {
    console.log(`🛑 Cancel Deal clicked in ${interaction.channel.name}`);

    try {
      await interaction.deferReply({ ephemeral: true });
    } catch (err) {
      if (err.code === 10062) {
        console.warn(`⚠️ Expired Cancel Deal button clicked in ${interaction.channel.name}`);
        await interaction.channel.send({
          content: '⚠️ This Cancel Deal button has expired. Please use a new one if available.'
        });
        return;
      } else {
        throw err;
      }
    }

    try {
      const channel = interaction.channel;
      const data = sellerMap.get(channel.id);
      let recordId = data?.orderRecordId;

      if (!recordId) {
        const orderNumber = channel.name.toUpperCase();
        const records = await base('Unfulfilled Orders Log')
          .select({
            filterByFormula: `{Order ID} = "${orderNumber}"`,
            maxRecords: 1
          })
          .firstPage();
        if (records.length > 0) {
          recordId = records[0].id;
        }
      }

      if (!recordId) {
        return await interaction.editReply('❌ Record ID not found.');
      }

      // reset claimed fields & status
      await base('Unfulfilled Orders Log').update(recordId, {
        'Fulfillment Status': 'Outsource',
        'Outsource Start Time': new Date().toISOString(),
        'Claim Message ID': '',
        'Claim Message URL': '',
        'Claimed Channel ID': '',
        'Claimed Message ID': '',
        'Claimed Seller ID': [],
        'Claimed Seller Discord ID': '',
        'Claimed Seller Confirmed?': false,
        'Claimed Seller VAT Type': null
      });

      // If you still use Inventory Units as temp link to this order, you can reset it here
      const orderNumber = channel.name.toUpperCase();
      const invRecords = await base('Inventory Units')
        .select({
          filterByFormula: `{Ticket Number} = "${orderNumber}"`,
          maxRecords: 1
        })
        .firstPage();

      if (invRecords.length > 0) {
        await base('Inventory Units').update(invRecords[0].id, {
          'Verification Status': 'Cancelled',
          'Selling Method': null,
          'Unfulfilled Orders Log': [],
          'Payment Status': null,
          'Availability Status': null
        });
      }

      // transcript of the cancelled channel
      const transcriptFileName = `transcript-${channel.name}.html`;
      const transcript = await createTranscript(channel, {
        limit: -1,
        returnBuffer: false,
        fileName: transcriptFileName
      });
      const transcriptsChannel = await client.channels.fetch(TRANSCRIPTS_CHANNEL_ID);
      if (transcriptsChannel?.isTextBased()) {
        await transcriptsChannel.send({
          content: `🗒️ Transcript for cancelled deal channel **${channel.name}**`,
          files: [transcript]
        });
      }

      await interaction.editReply('✅ Deal has been cancelled. Channel will be deleted shortly.');
      setTimeout(() => channel.delete().catch(console.error), 3000);
    } catch (err) {
      console.error('❌ Cancel Deal error:', err);
      await interaction.editReply('❌ Something went wrong while cancelling this deal.');
    }
    return;
  }

  /* ---------- CONFIRM DEAL BUTTON (ADMIN) ---------- */

  if (interaction.isButton() && interaction.customId === 'confirm_deal') {
    const memberRoles = interaction.member.roles.cache.map(role => role.id);
    const isAdmin = ADMIN_ROLE_IDS.some(roleId => memberRoles.includes(roleId));
    if (!isAdmin) {
      return interaction.reply({ content: '❌ You are not authorized to confirm the deal.' });
    }

    try {
      await interaction.deferReply();
    } catch (err) {
      if (err.code === 10062) {
        await interaction.channel.send({
          content: '⚠️ This Confirm Deal button has expired. Please use a new one if available.',
          components: [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId('confirm_deal')
                .setLabel('Confirm Deal')
                .setStyle(ButtonStyle.Success)
            )
          ]
        });
        return;
      }
      throw err;
    }

    const channel = interaction.channel;
    const messages = await channel.messages.fetch({ limit: 50 });

    let sellerData = sellerMap.get(channel.id);
    if (!sellerData) {
      const orderNumber = channel.name.toUpperCase();
      const recs = await base('Unfulfilled Orders Log')
        .select({
          filterByFormula: `{Order ID} = "${orderNumber}"`,
          maxRecords: 1
        })
        .firstPage();

      const rec = recs[0];
      if (rec) {
        sellerData = {
          sellerRecordId: (rec.get('Claimed Seller ID') || [])[0],
          orderRecordId: rec.id,
          sellerDiscordId: rec.get('Claimed Seller Discord ID'),
          dealEmbedId: rec.get('Claimed Message ID'),
          vatType: rec.get('Claimed Seller VAT Type')
        };
        sellerMap.set(channel.id, sellerData);
      }
    }

    if (sellerData?.dealConfirmed) {
      return interaction.editReply({ content: '⚠️ This deal has already been confirmed.' });
    }

    if (!sellerData || !sellerData.orderRecordId || !sellerData.sellerRecordId) {
      return interaction.editReply({ content: '❌ Missing claimed Seller or Order ID.' });
    }

    const imageMsg = messages.find(m =>
      m.attachments.size > 0 &&
      [...m.attachments.values()].some(att => att.contentType?.startsWith('image/'))
    );

    if (!imageMsg) {
      return interaction.editReply({ content: '❌ No image found in recent messages.' });
    }

    // find the claimed embed
    let embed;
    const storedId = sellerMap.get(channel.id)?.dealEmbedId;
    if (storedId) {
      const m = await channel.messages.fetch(storedId).catch(() => null);
      embed = m?.embeds?.[0];
    }

    if (!embed) {
      const msgs = await fetchUpTo(channel, 500);
      const m = msgs.find(msg =>
        msg.author.id === client.user.id &&
        Array.isArray(msg.embeds) &&
        msg.embeds.some(e =>
          (e?.title?.includes('Deal Claimed') || e?.title?.includes('Quick Deal Claimed')) &&
          e?.description?.includes('**Order:**') &&
          e?.description?.includes('**Payout:**')
        )
      );
      embed = m?.embeds?.find(e =>
        e?.title?.includes('Deal Claimed') || e?.title?.includes('Quick Deal Claimed')
      );
    }

    if (!embed?.description) {
      return interaction.editReply({ content: '❌ Missing deal embed.' });
    }

    const lines = embed.description.split('\n');
    const getValue = label =>
      lines.find(line => line.includes(label))?.split(label)[1]?.trim() || '';

    const sku = getValue('**SKU:**');
    const size = getValue('**Size:**');
    const brand = getValue('**Brand:**');
    const orderNumber = getValue('**Order:**');

    // payout + vatType from memory if available, otherwise parse embed
    let payout = sellerData?.payoutChosen;
    if (payout == null) {
      const payoutStr = getValue('**Payout:**')?.replace('€', '').replace(',', '.');
      payout = parseFloat(payoutStr || '0');
    }
    let vatType = sellerData?.vatType || getValue('**VAT Type:**') || 'Margin';

    let finalPayout = payout;
    let shippingDeduction = 0;
    let trustNote = '';

    try {
      const sellerDiscordId = sellerData?.sellerDiscordId;
      if (sellerDiscordId) {
        const member = await interaction.guild.members.fetch(sellerDiscordId);
        const trustedRoleId = TRUSTED_SELLERS_ROLE_ID;
        let isTrusted = false;
        if (trustedRoleId) {
          isTrusted = member.roles.cache.has(trustedRoleId);
        }
        if (trustedRoleId && !isTrusted) {
          finalPayout = Math.max(0, payout - 10);
          shippingDeduction = 10;
          trustNote =
            '\n\n⚠️ Because you are not a Trusted Seller yet, we had to deduct €10 from the payout for the extra label and handling.';
        }
      }
    } catch (err) {
      console.warn('Could not check trusted role:', err);
    }

    const orderRecord = await base('Unfulfilled Orders Log').find(sellerData.orderRecordId);
    const productName =
      orderRecord.get('Product Name') || orderRecord.get('Shopify Product Name') || '';

    let sellerRecord;
    try {
      sellerRecord = await base('Sellers Database').find(sellerData.sellerRecordId);
    } catch (_) {}
    if (!sellerRecord) {
      return interaction.editReply({ content: '❌ Linked Seller not found in our system.' });
    }

    // Send data to Make instead of creating Inventory Units here
    if (MAKE_QUICK_DEAL_WEBHOOK_URL) {
      try {
        await fetch(MAKE_QUICK_DEAL_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source: sellerData.isQuickDeal ? 'Quick Deal' : 'Claim Deal',
            orderRecordId: sellerData.orderRecordId,
            sellerRecordId: sellerData.sellerRecordId,
            orderNumber,
            productName,
            sku,
            size,
            brand,
            payout: finalPayout,
            rawPayout: payout,
            shippingDeduction,
            vatType,
            isTrustedSeller: shippingDeduction === 0,
            sellerDiscordId: sellerData.sellerDiscordId,
            channelId: channel.id
          })
        });
      } catch (e) {
        console.error('❌ Error sending data to Make webhook:', e);
      }
    } else {
      console.warn('⚠️ MAKE_QUICK_DEAL_WEBHOOK_URL is not set; skipping webhook call.');
    }

    // mark as confirmed in memory & Airtable
    sellerMap.set(channel.id, { ...sellerData, dealConfirmed: true });

    try {
      await base('Unfulfilled Orders Log').update(sellerData.orderRecordId, {
        'Claimed Seller Confirmed?': true
      });
    } catch (e) {
      console.warn('⚠️ Could not update Claimed Seller Confirmed? in Airtable:', e.message);
    }

    const recentMessages = await channel.messages.fetch({ limit: 10 });
    const buttonMessage = recentMessages.find(msg => msg.components.length > 0);
    if (buttonMessage) {
      await buttonMessage.edit({ components: [] });
    }

    await interaction.editReply({
      content:
        `✅ Deal processed!\n\n` +
        `💶 Final payout: €${finalPayout.toFixed(2)}${trustNote}\n\n` +
        `📦 The shipping label will be sent shortly.\n\n` +
        `📬 Please prepare the package and ensure it is packed in a clean, unbranded box with no unnecessary stickers or markings.\n\n` +
        `❌ Do not include anything inside the box, as this is not a standard deal.\n\n` +
        `📸 Please pack it as professionally as possible. If you're unsure, feel free to take a photo of the package and share it here before shipping.`
    });

    return;
  }
});

/* =================================================
   MESSAGE HANDLER – PICTURE COUNT + !finish
   ================================================= */

client.on(Events.MessageCreate, async message => {
  // Only work in ORD-... channels with attachments
  if (
    message.channel.name.toUpperCase().startsWith('ORD-') &&
    message.attachments.size > 0
  ) {
    let data = sellerMap.get(message.channel.id);
    if (!data?.sellerRecordId) {
      const orderNumber = message.channel.name.toUpperCase();
      const recs = await base('Unfulfilled Orders Log')
        .select({
          filterByFormula: `{Order ID} = "${orderNumber}"`,
          maxRecords: 1
        })
        .firstPage();

      if (recs.length) {
        data = {
          ...(data || {}),
          orderRecordId: recs[0].id,
          sellerRecordId: (recs[0].get('Claimed Seller ID') || [])[0],
          sellerDiscordId: recs[0].get('Claimed Seller Discord ID'),
          dealEmbedId: recs[0].get('Claimed Message ID'),
          confirmed: !!recs[0].get('Claimed Seller Confirmed?')
        };
        sellerMap.set(message.channel.id, data);
      }
    }
    if (!data?.sellerRecordId || !data?.confirmed === false) {
      // we still allow picture uploads before 'confirmed', so don't early return for !confirmed
    }

    const currentUploads = uploadedImagesMap.get(message.channel.id) || [];

    const imageUrls = [...message.attachments.values()]
      .filter(att => att.contentType?.startsWith('image/'))
      .map(att => att.url);

    if (imageUrls.length > 0) {
      currentUploads.push(...imageUrls);
      uploadedImagesMap.set(message.channel.id, currentUploads);
    }

    const uploadedCount = currentUploads.length;

    if (!message.author.bot && uploadedCount < 6) {
      await message.channel.send(`📸 You've uploaded ${uploadedCount}/6 required pictures.`);
    }

    if (uploadedCount >= 6 && !data?.confirmSent) {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('confirm_deal')
          .setLabel('Confirm Deal')
          .setStyle(ButtonStyle.Success)
      );

      await message.channel.send({
        content: '✅ All 6 pictures received. Admin can now confirm the deal.',
        components: [row]
      });

      sellerMap.set(message.channel.id, { ...data, confirmSent: true });
    }
  }

  // Manual finish command (optional safety)
  if (
    message.content === '!finish' &&
    message.channel.name.toLowerCase().startsWith('ord-')
  ) {
    const memberRoles = message.member.roles.cache.map(r => r.id);
    const isAdmin = ADMIN_ROLE_IDS.some(id => memberRoles.includes(id));
    if (!isAdmin) {
      return message.reply('❌ You are not authorized to use this command.');
    }

    await message.channel.send(
      '✅ This deal is now finished. Thank you for this deal — we look forward to dealing with you again!\n🕒 This ticket will automatically close in 1 hour.'
    );

    setTimeout(async () => {
      try {
        const transcriptFileName = `transcript-${message.channel.name}.html`;
        const transcript = await createTranscript(message.channel, {
          limit: -1,
          returnBuffer: false,
          fileName: transcriptFileName
        });

        const transcriptsChannel = await client.channels.fetch(TRANSCRIPTS_CHANNEL_ID);
        if (transcriptsChannel && transcriptsChannel.isTextBased()) {
          await transcriptsChannel.send({
            content: `🗒️ Final transcript for finished deal **${message.channel.name}**`,
            files: [transcript]
          });
        }

        await message.channel.delete();
      } catch (err) {
        console.error(`❌ Error finishing deal ${message.channel.name}:`, err);
      }
    }, 3600000); // 1 hour
  }
});

/* ---------------- START BOT + SERVER ---------------- */

client.login(process.env.DISCORD_TOKEN);
app.listen(PORT, () => {
  console.log(`🌐 Express server running on port ${PORT}`);
});
