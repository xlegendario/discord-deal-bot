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

const QUICK_DEALS_AIRTABLE_URL =
  'https://airtable.com/invite/l?inviteId=invxw82cJp4JW5xGl&inviteToken=4b33dc79194fc583a1ebf24d84d38f92334304662e6ca9741b09132e6199adb3&utm_medium=email&utm_source=product_team&utm_content=transactional-alerts';

/* ---------------- EXPRESS SETUP ---------------- */

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
const DEAL_CATEGORY_ID = process.env.CATEGORY_ID;                  // category for ORD-xxxx channels
const QUICK_DEALS_CHANNEL_ID = process.env.QUICK_DEALS_CHANNEL_ID; // channel where Quick Deals listing embeds live
const TRANSCRIPTS_CHANNEL_ID = process.env.TRANSCRIPTS_CHANNEL_ID;

// Partner Quick Deals channels (comma-separated channel IDs)
const PARTNER_QUICK_DEALS_CHANNEL_IDS = (process.env.PARTNER_QUICK_DEALS_CHANNEL_IDS || '')
  .split(',')
  .map(id => id.trim())
  .filter(Boolean);

// Roles / permissions
const ADMIN_ROLE_IDS = ['942779423449579530', '1060615571118510191'];
const TRUSTED_SELLERS_ROLE_ID = process.env.TRUSTED_SELLERS_ROLE_ID;

// Webhook to Make (for Inventory Unit creation etc.)
const MAKE_QUICK_DEAL_WEBHOOK_URL = process.env.MAKE_QUICK_DEAL_WEBHOOK_URL || '';

/* ---------------- RUNTIME STATE ---------------- */

const sellerMap = new Map();         // channelId -> {orderRecordId, sellerRecordId, sellerId, ...}
const uploadedImagesMap = new Map(); // channelId -> [imageUrls...]

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
  if (PARTNER_QUICK_DEALS_CHANNEL_IDS.length) {
    console.log('📡 Partner Quick Deals channels:', PARTNER_QUICK_DEALS_CHANNEL_IDS.join(', '));
  }
});

/* =================================================
   QUICK DEALS – LISTING EMBED CREATION & UPDATES
   ================================================= */

/**
 * POST /quick-deal/create
 *
 * Main Quick Deal in your own server
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
      timeToMaxPayout,  // from {Payout Countdown} (string)
      imageUrl
    } = req.body || {};

    if (!QUICK_DEALS_CHANNEL_ID) {
      return res.status(400).send('Missing QUICK_DEALS_CHANNEL_ID env');
    }
    if (!GUILD_ID) {
      return res.status(400).send('Missing GUILD_ID env');
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
        `**${productName || '-'}**\n` +   // bold product name
        `${sku || '-'}\n` +              // SKU, no label
        `${size || '-'}\n` +             // size, no label
        `${brand || '-'}`                // brand, no label
      )
      .setColor(0xFFED00)
      .addFields(
        {
          name: 'Current Payout',
          value: currentPayout != null ? String(currentPayout) : '-',
          inline: true
        },
        {
          name: 'Max Payout',
          value: maxPayout != null ? String(maxPayout) : '-',
          inline: true
        },
        {
          name: 'Time to Max Payout',
          value: timeToMaxPayout != null && timeToMaxPayout !== ''
            ? String(timeToMaxPayout)
            : '-',
          inline: false          // own row under the payouts
        }
      );
    if (imageUrl) embed.setImage(imageUrl);

    const claimButton = new ButtonBuilder()
      .setCustomId(`quick_claim_${recordId}`)
      .setLabel('Claim Deal')
      .setStyle(ButtonStyle.Success);

    const seeAllButton = new ButtonBuilder()
      .setLabel('See All Quick Deals')
      .setStyle(ButtonStyle.Link)
      .setURL(QUICK_DEALS_AIRTABLE_URL);

    const row = new ActionRowBuilder().addComponents(claimButton, seeAllButton);

    const msg = await channel.send({ embeds: [embed], components: [row] });

    const messageUrl = `https://discord.com/channels/${GUILD_ID}/${QUICK_DEALS_CHANNEL_ID}/${msg.id}`;

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
 * POST /quick-deal/create-partners
 *
 * Mirror Quick Deal in partner servers (linking back to your Claim Message URL)
 *
 * Body:
 *  {
 *    recordId: "recXXXX",            // Unfulfilled Orders Log record ID
 *    orderNumber: "...",
 *    productName: "...",
 *    sku: "...",
 *    size: "...",
 *    brand: "...",
 *    currentPayout: "...",
 *    maxPayout: "...",
 *    timeToMaxPayout: "...",
 *    imageUrl: "https://...",
 *    claimMessageUrl: "https://discord.com/channels/..."
 *  }
 *
 * Stores partner messages in field:
 *  "Partner Quick Deals Messages" as: "channelId:messageId,channelId2:messageId2,..."
 */
app.post('/quick-deal/create-partners', async (req, res) => {
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
      timeToMaxPayout,
      imageUrl,
      claimMessageUrl
    } = req.body || {};

    if (!recordId) {
      return res.status(400).send('Missing recordId');
    }
    if (!PARTNER_QUICK_DEALS_CHANNEL_IDS.length) {
      return res.status(400).send('No PARTNER_QUICK_DEALS_CHANNEL_IDS configured');
    }

    // If claimMessageUrl not provided, try to pull from Airtable
    let finalClaimUrl = claimMessageUrl;
    if (!finalClaimUrl) {
      try {
        const rec = await base('Unfulfilled Orders Log').find(recordId);
        finalClaimUrl = rec.get('Claim Message URL');
      } catch (e) {
        console.warn('⚠️ Could not fetch Claim Message URL from Airtable:', e.message);
      }
    }

    if (!finalClaimUrl) {
      return res.status(400).send('Missing claimMessageUrl and no Claim Message URL in Airtable');
    }

    const embed = new EmbedBuilder()
      .setTitle('⚡ Quick Deal')
      .setDescription(
        `**${productName || '-'}**\n` +
        `${sku || '-'}\n` +
        `${size || '-'}\n` +
        `${brand || '-'}`
      )
      .setColor(0xFFED00)
      .addFields(
        {
          name: 'Current Payout',
          value: currentPayout != null ? String(currentPayout) : '-',
          inline: true
        },
        {
          name: 'Max Payout',
          value: maxPayout != null ? String(maxPayout) : '-',
          inline: true
        },
        {
          name: 'Time to Max Payout',
          value: timeToMaxPayout != null && timeToMaxPayout !== ''
            ? String(timeToMaxPayout)
            : '-',
          inline: false
        }
      );
    if (imageUrl) embed.setImage(imageUrl);

    const claimLinkButton = new ButtonBuilder()
      .setLabel('Claim Deal')
      .setStyle(ButtonStyle.Link)     // link to your server
      .setURL(finalClaimUrl);

    const seeAllButton = new ButtonBuilder()
      .setLabel('See All Quick Deals')
      .setStyle(ButtonStyle.Link)
      .setURL(QUICK_DEALS_AIRTABLE_URL);

    const row = new ActionRowBuilder().addComponents(claimLinkButton, seeAllButton);

    const partnerRefs = [];

    for (const chId of PARTNER_QUICK_DEALS_CHANNEL_IDS) {
      try {
        const ch = await client.channels.fetch(chId).catch(() => null);
        if (!ch || !ch.isTextBased()) {
          console.warn(`⚠️ Partner Quick Deal channel ${chId} not found or not text-based`);
          continue;
        }
        const msg = await ch.send({ embeds: [embed], components: [row] });
        partnerRefs.push(`${chId}:${msg.id}`);
      } catch (e) {
        console.warn(`⚠️ Failed to send Quick Deal to partner channel ${chId}:`, e.message);
      }
    }

    // Store references in Airtable so /update-embed can sync partner messages
    if (partnerRefs.length) {
      try {
        await base('Unfulfilled Orders Log').update(recordId, {
          'Partner Quick Deals Message IDs': partnerRefs.join(',')
        });
      } catch (e) {
        console.warn('⚠️ Could not save Partner Quick Deals Message IDs:', e.message);
      }
    }

    return res.status(200).json({
      ok: true,
      partnerMessages: partnerRefs
    });
  } catch (err) {
    console.error('❌ Error creating partner Quick Deal embeds:', err);
    return res.status(500).send('Internal Server Error');
  }
});

/**
 * POST /quick-deal/update-embed
 *
 * Updates main Quick Deal + all partner Quick Deal messages
 */
app.post('/quick-deal/update-embed', async (req, res) => {
  try {
    const {
      channelId,
      messageId,
      currentPayout,
      maxPayout,
      recordId,
      timeToMaxPayout
    } = req.body || {};

    const targetChannelId = channelId || QUICK_DEALS_CHANNEL_ID;

    if (!targetChannelId || !messageId) {
      return res.status(400).send('Missing QUICK_DEALS_CHANNEL_ID or messageId');
    }

    // Optionally refresh Time to Max from Airtable
    let finalTimeToMax = timeToMaxPayout;
    if (recordId && !finalTimeToMax) {
      try {
        const rec = await base('Unfulfilled Orders Log').find(recordId);
        if (rec) {
          finalTimeToMax = rec.get('Payout Countdown');
        }
      } catch (e) {
        console.warn('⚠️ Could not fetch Payout Countdown:', e.message);
      }
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

    const setField = (name, value, inline = true) => {
      const idx = fields.findIndex(f => f.name === name);
      const val = value != null ? String(value) : '';
      if (idx >= 0) {
        fields[idx] = { ...fields[idx], value: val };
      } else {
        fields.push({ name, value: val, inline });
      }
    };

    if (currentPayout != null) setField('Current Payout', currentPayout, true);
    if (maxPayout != null) setField('Max Payout', maxPayout, true);

    if (finalTimeToMax != null && finalTimeToMax !== '') {
      setField('Time to Max Payout', finalTimeToMax, false);
    } else {
      setField('Time to Max Payout', '-', false);
    }

    newEmbed.setFields(fields);

    // Update main Quick Deal embed
    await msg.edit({ embeds: [newEmbed] });

    // Also update partner messages if we know them
    if (recordId) {
      try {
        const rec = await base('Unfulfilled Orders Log').find(recordId);
        const refsRaw = rec.get('Partner Quick Deals Message IDs');
        if (refsRaw) {
          const refs = String(refsRaw).split(',').map(s => s.trim()).filter(Boolean);
          for (const ref of refs) {
            const [chId, mid] = ref.split(':');
            if (!chId || !mid) continue;
            try {
              const ch = await client.channels.fetch(chId).catch(() => null);
              if (!ch || !ch.isTextBased()) continue;
              const partnerMsg = await ch.messages.fetch(mid).catch(() => null);
              if (!partnerMsg) continue;

              await partnerMsg.edit({ embeds: [newEmbed] });
            } catch (e) {
              console.warn('⚠️ Could not update partner Quick Deal message:', e.message);
            }
          }
        }
      } catch (e) {
        console.warn('⚠️ Could not load Partner Quick Deals Messages for update:', e.message);
      }
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('❌ Error updating Quick Deal embed:', err);
    return res.status(500).send('Internal Server Error');
  }
});

/**
 * POST /quick-deal/disable
 *
 * Disables Claim button on main Quick Deal (your server).
 * Partner messages stay as links to your server.
 */
app.post('/quick-deal/disable', async (req, res) => {
  try {
    const { recordId } = req.body || {};

    if (!recordId) {
      return res.status(400).send('Missing recordId');
    }
    if (!QUICK_DEALS_CHANNEL_ID) {
      return res.status(400).send('Missing QUICK_DEALS_CHANNEL_ID env');
    }

    const orderRecord = await base('Unfulfilled Orders Log').find(recordId);
    const claimMessageId = orderRecord.get('Claim Message ID');
    if (!claimMessageId) {
      return res
        .status(404)
        .send('No Claim Message ID stored on this Unfulfilled Orders Log record');
    }

    const guild = await client.guilds.fetch(GUILD_ID);
    const dealsChannel = await guild.channels.fetch(QUICK_DEALS_CHANNEL_ID);

    if (!dealsChannel || !dealsChannel.isTextBased()) {
      return res.status(404).send('Quick Deals channel not found or not text-based');
    }

    const listingMsg = await dealsChannel.messages.fetch(claimMessageId).catch(() => null);
    if (!listingMsg) {
      return res.status(404).send('Listing message not found');
    }

    const disabledClaim = new ButtonBuilder()
      .setCustomId(`quick_claim_${recordId}`)
      .setLabel('Claim Deal')
      .setStyle(ButtonStyle.Secondary)  // grey
      .setDisabled(true);

    const seeAllButton = new ButtonBuilder()
      .setLabel('See All Quick Deals')
      .setStyle(ButtonStyle.Link)
      .setURL(QUICK_DEALS_AIRTABLE_URL);

    const disabledRow = new ActionRowBuilder().addComponents(
      disabledClaim,
      seeAllButton
    );

    await listingMsg.edit({ components: [disabledRow] });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('❌ Error disabling Quick Deal button:', err);
    return res.status(500).send('Internal Server Error');
  }
});


/* =================================================
   DISCORD INTERACTIONS – QUICK DEAL CLAIM & FLOW
   ================================================= */

client.on(Events.InteractionCreate, async interaction => {
  if (
    (interaction.isButton() && interaction.customId.startsWith('partner_')) ||
    (interaction.isModalSubmit() && interaction.customId.startsWith('partner_'))
  ) {
    return;
  }

  /* ---------- QUICK DEAL: Claim button → modal ---------- */

  if (interaction.isButton() && interaction.customId.startsWith('quick_claim_')) {
    const recordId = interaction.customId.replace('quick_claim_', '').trim();

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
      .setRequired(true)
      .setPlaceholder('Exactly: "Margin", "VAT21" or "VAT0"');

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
    const recordId = interaction.customId.replace('quick_claim_modal_', '').trim();
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

      const orderRecordId = recordId;
      const orderRecord = await base('Unfulfilled Orders Log').find(orderRecordId);

      const orderNumber  = String(orderRecord.get('Order ID') || '');
      const size         = orderRecord.get('Size') || '';
      const brand        = orderRecord.get('Brand') || '';
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
      const imageUrl     = Array.isArray(pictureField) && pictureField.length > 0 ? pictureField[0].url : null;

      if (!orderNumber || !productName || !finalSku || !size || !brand || !Number.isFinite(payout) || payout <= 0) {
        return interaction.reply({
          content: '❌ Missing or invalid order fields for this Quick Deal.',
          ephemeral: true
        });
      }

      const guild    = await client.guilds.fetch(GUILD_ID);
      const category = await guild.channels.fetch(DEAL_CATEGORY_ID);

      const channel = await guild.channels.create({
        name: `${orderNumber.toLowerCase()}`,
        type: ChannelType.GuildText,
        parent: category?.id,
        permissionOverwrites: [
          { id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
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
          `**Seller (claimed with):** ${sellerId}`
        )
        .setColor(0xFFED00);

      if (imageUrl) embed.setImage(imageUrl);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('start_claim')
          .setLabel('Process Claim')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('cancel_deal')
          .setLabel('Cancel Deal')
          .setStyle(ButtonStyle.Danger)
      );

      const dealMsg = await channel.send({ embeds: [embed], components: [row] });

      sellerMap.set(channel.id, {
        orderRecordId,
        dealEmbedId: dealMsg.id,
        sellerRecordId: sellerRecord.id,
        sellerDiscordId: interaction.user.id,
        sellerId,
        vatType,
        payoutChosen: payout,
        isQuickDeal: true,
        quickDealRecordId: recordId,
        confirmed: false
      });

      await base('Unfulfilled Orders Log').update(orderRecordId, {
        'Fulfillment Status': 'Claim Processing',
        'Claimed Channel ID': channel.id,
        'Claimed Message ID': dealMsg.id,
        'Claimed Seller ID': [sellerRecord.id],
        'Claimed Seller Discord ID': interaction.user.id,
        'Claimed Seller Confirmed?': false,
        'Claimed Seller VAT Type': vatType
      });

      // disable Claim button on MAIN listing (partner messages are links)
      try {
        const claimMessageId = orderRecord.get('Claim Message ID');
        if (claimMessageId && QUICK_DEALS_CHANNEL_ID) {
          const dealsChannel = await client.channels.fetch(QUICK_DEALS_CHANNEL_ID);
          if (dealsChannel && dealsChannel.isTextBased()) {
            const listingMsg = await dealsChannel.messages.fetch(claimMessageId).catch(() => null);
            if (listingMsg) {
              const disabledClaim = new ButtonBuilder()
                .setCustomId(`quick_claim_${recordId}`)
                .setLabel('Claim Deal')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(true);

              const seeAllButton = new ButtonBuilder()
                .setLabel('See All Quick Deals')
                .setStyle(ButtonStyle.Link)
                .setURL(QUICK_DEALS_AIRTABLE_URL);

              const disabledRow = new ActionRowBuilder().addComponents(
                disabledClaim,
                seeAllButton
              );

              await listingMsg.edit({ components: [disabledRow] });
            }
          }
        }
      } catch (e) {
        console.warn('⚠️ Could not disable Claim Deal button:', e.message);
      }

      await interaction.reply({
        content: `✅ Quick Deal claimed! Your deal channel is <#${channel.id}>.\nPlease click **"Process Claim"** in that channel to verify your Seller ID and start the photo upload.`,
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

  /* ---------- START CLAIM → “Is this you?” ---------- */

  if (interaction.isButton() && interaction.customId === 'start_claim') {
    const channelId = interaction.channel.id;
    let data = sellerMap.get(channelId);

    try {
      if (!data || !data.orderRecordId || !data.sellerRecordId) {
        const orderNumber = interaction.channel.name.toUpperCase();
        const recs = await base('Unfulfilled Orders Log')
          .select({
            filterByFormula: `{Order ID} = "${orderNumber}"`,
            maxRecords: 1
          })
          .firstPage();

        if (recs.length) {
          const rec = recs[0];
          data = {
            ...(data || {}),
            orderRecordId: rec.id,
            sellerRecordId: (rec.get('Claimed Seller ID') || [])[0],
            sellerDiscordId: rec.get('Claimed Seller Discord ID'),
            vatType: rec.get('Claimed Seller VAT Type'),
            confirmed: !!rec.get('Claimed Seller Confirmed?')
          };
          sellerMap.set(channelId, data);
        }
      }

      if (!data?.sellerRecordId) {
        return interaction.reply({
          content: '❌ No claimed Seller found for this deal. Please cancel and reclaim the deal.',
          ephemeral: true
        });
      }

      const sellerRecord = await base('Sellers Database').find(data.sellerRecordId);
      const sellerIdField = sellerRecord.get('Seller ID') || data.sellerId || 'Unknown ID';
      const discordUsername = sellerRecord.get('Discord') || 'Unknown';

      const confirmRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('confirm_seller')
          .setLabel('✅ Yes, that is me')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('reject_seller')
          .setLabel('❌ No, not me')
          .setStyle(ButtonStyle.Danger)
      );

      await interaction.reply({
        content: `🔍 We found this Discord Username linked to Seller ID **${sellerIdField}**:\n**${discordUsername}**\n\nIs this you?`,
        components: [confirmRow]
      });
    } catch (err) {
      console.error('❌ Error starting claim verification:', err);
      try {
        await interaction.reply({
          content: '❌ Something went wrong while verifying your Seller ID. Please try again or contact support.',
          ephemeral: true
        });
      } catch (_) {}
    }
    return;
  }

  /* ---------- CONFIRM / REJECT SELLER ---------- */

  if (interaction.isButton() && ['confirm_seller', 'reject_seller'].includes(interaction.customId)) {
    const channelId = interaction.channel.id;
    let data = sellerMap.get(channelId) || {};

    try {
      await interaction.deferUpdate();
    } catch (err) {
      if (err.code === 10062) {
        await interaction.channel.send({
          content: '⚠️ Those buttons expired. Please click **"Process Claim"** again.'
        });
        return;
      }
      throw err;
    }

    if (interaction.customId === 'confirm_seller') {
      sellerMap.set(channelId, { ...data, confirmed: true });

      try {
        let orderRecordId = data.orderRecordId;
        if (!orderRecordId) {
          const orderNumber = interaction.channel.name.toUpperCase();
          const recs = await base('Unfulfilled Orders Log')
            .select({
              filterByFormula: `{Order ID} = "${orderNumber}"`,
              maxRecords: 1
            })
            .firstPage();
          if (recs.length) {
            orderRecordId = recs[0].id;
            sellerMap.set(channelId, {
              ...sellerMap.get(channelId),
              orderRecordId
            });
          }
        }
        if (orderRecordId) {
          await base('Unfulfilled Orders Log').update(orderRecordId, {
            'Claimed Seller Confirmed?': true
          });
        }
      } catch (e) {
        console.warn('Could not persist Claimed Seller Confirmed? to Airtable:', e);
      }

      try {
        await interaction.message.edit({
          content:
            '✅ Seller ID confirmed.\nPlease upload **6 different** pictures of the pair like shown below to prove it is in-hand and complete.',
          components: []
        });
        await interaction.channel.send({ files: ['https://i.imgur.com/JKaeeNz.png'] });
      } catch (e) {
        console.error('Failed to edit confirm_seller message:', e);
      }
      return;
    }

    if (interaction.customId === 'reject_seller') {
      try {
        await interaction.message.edit({
          content:
            '⚠️ Please check if the Seller ID was filled in correctly.\n\nIf it is wrong, cancel this deal and claim it again with the correct Seller ID.',
          components: []
        });
      } catch (e) {
        console.error('Failed to edit reject_seller message:', e);
      }
      return;
    }
  }

  /* ---------- CANCEL DEAL BUTTON ---------- */

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

      // re-enable Claim button on MAIN listing (partner messages remain links)
      try {
        if (data?.isQuickDeal) {
          const orderRecord = await base('Unfulfilled Orders Log').find(recordId);
          const claimMessageId = orderRecord.get('Claim Message ID');

          if (claimMessageId && QUICK_DEALS_CHANNEL_ID) {
            const dealsChannel = await client.channels.fetch(QUICK_DEALS_CHANNEL_ID);
            if (dealsChannel && dealsChannel.isTextBased()) {
              const listingMsg = await dealsChannel.messages.fetch(claimMessageId).catch(() => null);
              if (listingMsg) {
                const enabledClaim = new ButtonBuilder()
                  .setCustomId(`quick_claim_${recordId}`)
                  .setLabel('Claim Deal')
                  .setStyle(ButtonStyle.Success)
                  .setDisabled(false);

                const seeAllButton = new ButtonBuilder()
                  .setLabel('See All Quick Deals')
                  .setStyle(ButtonStyle.Link)
                  .setURL(QUICK_DEALS_AIRTABLE_URL);

                const enabledRow = new ActionRowBuilder().addComponents(
                  enabledClaim,
                  seeAllButton
                );

                await listingMsg.edit({ components: [enabledRow] });
              }
            }
          }
        }
      } catch (e) {
        console.warn('⚠️ Could not re-enable Claim Deal button:', e.message);
      }

      await base('Unfulfilled Orders Log').update(recordId, {
        'Fulfillment Status': 'Outsource',
        'Outsource Start Time': new Date().toISOString(),
        'Claimed Channel ID': '',
        'Claimed Message ID': '',
        'Claimed Seller ID': [],
        'Claimed Seller Discord ID': '',
        'Claimed Seller Confirmed?': false,
        'Claimed Seller VAT Type': null
      });

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
    const isAdmin = ADMIN_ROLE_IDS.some(roleId => roleId && memberRoles.includes(roleId));
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
          vatType: rec.get('Claimed Seller VAT Type'),
          isQuickDeal: true
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

  if (
    message.content === '!finish' &&
    message.channel.name.toLowerCase().startsWith('ord-')
  ) {
    const memberRoles = message.member.roles.cache.map(r => r.id);
    const isAdmin = ADMIN_ROLE_IDS.some(id => id && memberRoles.includes(id));
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
    }, 3600000);
  }
});

/* ---------------- START BOT + SERVER ---------------- */

client.login(process.env.DISCORD_TOKEN);
app.listen(PORT, () => {
  console.log(`🌐 Express server running on port ${PORT}`);
});
