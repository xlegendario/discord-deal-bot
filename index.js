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

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const ALLOWED_ORIGINS = [
  'https://kickzcaviar.preview.softr.app',
  'https://kickzcaviar.softr.app',
  'https://app.softr.io'
];

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // allow server-to-server / curl
      cb(null, ALLOWED_ORIGINS.includes(origin));
    },
    methods: ['POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Requested-With'],
  })
);

// handle preflight globally
app.options(/.*/, cors());

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers // <- REQUIRED for member.roles.fetch/cache
  ]
});

// --- crash guards ---
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});
client.on('error', (err) => {
  console.error('Client error:', err);
});
// --- end crash guards ---

const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);
const PORT = process.env.PORT || 3000;
const VERIFY_CHANNEL_ID = process.env.VERIFY_CHANNEL_ID;
const TRANSCRIPTS_CHANNEL_ID = process.env.TRANSCRIPTS_CHANNEL_ID;
const ADMIN_ROLE_IDS = ['942779423449579530', '1060615571118510191'];
const TRUSTED_SELLERS_ROLE_ID = process.env.TRUSTED_SELLERS_ROLE_ID; // put your trusted sellers role ID in .env

// 🔹 Quick Deals config
const QUICK_DEALS_TABLE =
  process.env.AIRTABLE_TABLE_QUICK_DEALS || 'Quick Deals';
const QUICK_DEAL_LINKED_ORDER_FIELD =
  process.env.AIRTABLE_FIELD_QD_LINKED_ORDER || 'Unfulfilled Orders Log';
const MAKE_QUICK_DEAL_WEBHOOK_URL =
  process.env.MAKE_QUICK_DEAL_WEBHOOK_URL || '';
// Fixed Quick Deals listing channel (for the embed with the Claim button)
const QUICK_DEALS_CHANNEL_ID =
  process.env.QUICK_DEALS_CHANNEL_ID || '';

const sellerMap = new Map();
const uploadedImagesMap = new Map();

async function fetchUpTo(channel, max = 500) {
  const collected = [];
  let beforeId = undefined;

  while (collected.length < max) {
    const batchSize = Math.min(100, max - collected.length);
    const batch = await channel.messages.fetch({ limit: batchSize, ...(beforeId ? { before: beforeId } : {}) });
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

client.once('ready', async () => {
  console.log(`🤖 Bot is online as ${client.user.tag}`);

  const channel = await client.channels.fetch(VERIFY_CHANNEL_ID);
  if (channel && channel.isTextBased()) {
    // Check last 5 messages to see if it's already posted
    const messages = await channel.messages.fetch({ limit: 5 });
    const alreadyExists = messages.some(m =>
      m.embeds.length > 0 &&
      m.embeds[0].title === '🔐 Verify Deal Access'
    );

    if (!alreadyExists) {
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
  }
});

//
// LEGACY: Softr /claim-deal entrypoint (still works if you need it)
//
app.post('/claim-deal', async (req, res) => {
  try {
    const src = req.body || {};
    const recordId = (src.recordId || '').trim();
    const sellerIdRaw = (src.sellerId || '').replace(/\D/g, ''); // digits only
    const sellerId = sellerIdRaw ? `SE-${sellerIdRaw.padStart(5, '0')}` : '';

    if (!recordId || !sellerId) {
      return res.status(400).send('Missing recordId or sellerId');
    }

    const orderRecord = await base('Unfulfilled Orders Log').find(recordId);
    if (!orderRecord) return res.status(404).send('Claim not found');
    const orderNumber  = String(orderRecord.get('Order ID') || '');
    const size         = orderRecord.get('Size') || '';
    const brand        = orderRecord.get('Brand') || '';
    const payout = Number(
      orderRecord.get('Outsource Buying Price') ??
      orderRecord.get('Outsource Payout') ??
      orderRecord.get('Outsource') ??
      0
    );
    const productName =
      orderRecord.get('Product Name') ??
      orderRecord.get('Shopify Product Name') ??
      '';

    const sku     = asText(orderRecord.get('SKU')).trim();
    const skuSoft = asText(orderRecord.get('SKU (Soft)')).trim();
    const finalSku = sku || skuSoft;

    const pictureField = orderRecord.get('Picture');
    const imageUrl     = Array.isArray(pictureField) && pictureField.length > 0 ? pictureField[0].url : null;

    if (!orderNumber || !productName || !finalSku || !size || !brand || !Number.isFinite(payout)) {
      return res.status(400).send('Missing required order fields in Airtable');
    }

    const sellerRecords = await base('Sellers Database')
      .select({ filterByFormula: `{Seller ID} = "${sellerId}"`, maxRecords: 1 })
      .firstPage();
    if (sellerRecords.length === 0) {
      return res.status(400).send(`Seller ID ${sellerId} not found`);
    }
    const sellerRecord = sellerRecords[0];

    const guild    = await client.guilds.fetch(process.env.GUILD_ID);
    const category = await guild.channels.fetch(process.env.CATEGORY_ID);

    const channel = await guild.channels.create({
      name: `${orderNumber.toLowerCase()}`,
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: [{ id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] }]
    });

    const invite = await client.channels.fetch(VERIFY_CHANNEL_ID)
      .then(ch => ch.createInvite({ maxUses: 1, unique: true }));

    const embed = new EmbedBuilder()
      .setTitle('💸 Deal Claimed')
      .setDescription(
        `**Order:** ${orderNumber}\n` +
        `**Product:** ${productName}\n` +
        `**SKU:** ${finalSku}\n` +
        `**Size:** ${size}\n` +
        `**Brand:** ${brand}\n` +
        `**Payout:** €${payout.toFixed(2)}\n` +
        `**Seller:** ${sellerId}`
      )
      .setColor(0xFFED00);
    if (imageUrl) embed.setImage(imageUrl);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('start_claim').setLabel('Process Claim').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('cancel_deal').setLabel('Cancel Deal').setStyle(ButtonStyle.Danger)
    );

    const dealMsg = await channel.send({ embeds: [embed], components: [row] });

    sellerMap.set(channel.id, {
      orderRecordId: recordId,
      dealEmbedId: dealMsg.id,
      sellerRecordId: sellerRecord.id,
      confirmed: false
    });

    await base('Unfulfilled Orders Log').update(recordId, {
      "Deal Invitation URL": invite.url,
      "Fulfillment Status": "Claim Processing",
      "Deal Channel ID": channel.id,
      "Deal Embed Message ID": dealMsg.id,
      "Linked Seller": [sellerRecord.id],
      "Seller Confirmed?": false
    });

    const origin = req.get('origin');
    const redirectBase = ALLOWED_ORIGINS.includes(origin)
      ? origin
      : 'https://kickzcaviar.preview.softr.app';
    const successUrl = `${redirectBase}/success?recordId=${recordId}`;

    if (req.headers['x-requested-with'] === 'fetch') {
      return res.status(200).json({ ok: true, redirect: successUrl });
    }
    return res.redirect(302, successUrl);

  } catch (err) {
    console.error('❌ Error during claim creation:', err);
    return res.status(500).send('Internal Server Error');
  }
});

//
// 🔹 QUICK DEAL: create initial embed + Claim button AND store IDs in Airtable
//
app.post('/quick-deal/create', async (req, res) => {
  try {
    const {
      recordId,           // Airtable Quick Deals recordId (recXXXX)
      orderNumber,        // e.g. "ORD-002695"
      productName,
      sku,
      size,
      brand,
      currentPayout,      // number
      maxPayout,          // number
      imageUrl            // optional
    } = req.body || {};

    const targetChannelId = QUICK_DEALS_CHANNEL_ID;

    if (!targetChannelId || !recordId) {
      return res.status(400).send('Missing QUICK_DEALS_CHANNEL_ID or recordId');
    }

    const channel = await client.channels.fetch(targetChannelId);
    if (!channel || !channel.isTextBased()) {
      return res.status(404).send('Channel not found or not text-based');
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
        .setCustomId(`quick_claim_${recordId}`) // 🔑 used later by the claim modal
        .setLabel('Claim Deal')
        .setStyle(ButtonStyle.Success)
    );

    const msg = await channel.send({ embeds: [embed], components: [row] });

    const guildId = process.env.GUILD_ID;
    const messageUrl = guildId
      ? `https://discord.com/channels/${guildId}/${targetChannelId}/${msg.id}`
      : null;

    // 🔹 Store everything directly in the Quick Deals record on Airtable
    try {
      await base(QUICK_DEALS_TABLE).update(recordId, {
        'Claim Channel ID': targetChannelId,
        'Claim Message ID': msg.id,
        'Claim Message URL': messageUrl
      });
    } catch (e) {
      console.warn('⚠️ Could not update Quick Deals record with Claim fields:', e.message);
    }

    // Still return it for Make if you want to log/use it
    return res.status(200).json({
      ok: true,
      channelId: targetChannelId,
      messageId: msg.id,
      messageUrl
    });
  } catch (err) {
    console.error('❌ Error creating Quick Deal embed:', err);
    return res.status(500).send('Internal Server Error');
  }
});

//
// 🔹 QUICK DEAL: dynamic embed updater (for the listing embed)
//
app.post('/quick-deal/update-embed', async (req, res) => {
  try {
    const { channelId, messageId, currentPayout, maxPayout } = req.body || {};

    if (!channelId || !messageId) {
      return res.status(400).send('Missing channelId or messageId');
    }

    const channel = await client.channels.fetch(channelId);
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

    if (currentPayout != null) setField('Current Payout', `€${Number(currentPayout).toFixed(2)}`);
    if (maxPayout != null) setField('Max Payout', `€${Number(maxPayout).toFixed(2)}`);

    newEmbed.setFields(fields);

    await msg.edit({ embeds: [newEmbed] });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('❌ Error updating Quick Deal embed:', err);
    return res.status(500).send('Internal Server Error');
  }
});

client.on(Events.InteractionCreate, async interaction => {
  // ✅ Ignore Partner bot interactions (same token, different script)
  if (
    (interaction.isButton() && interaction.customId.startsWith('partner_')) ||
    (interaction.isModalSubmit() && interaction.customId.startsWith('partner_'))
  ) {
    return;
  }

  //
  // 🔹 QUICK DEAL: Claim button → Seller ID + VAT Type modal
  //
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
          content: '⚠️ That Quick Deal button expired. Please use the new button if available.'
        });
        return;
      }
      console.error('quick_claim showModal failed:', err);
      try {
        await interaction.reply({
          content: '❌ Could not open the Quick Deal claim form. Please try again.',
          ephemeral: true
        });
      } catch {}
    }
    return;
  }

  //
  // Verify access button
  //
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

    try {
      await interaction.showModal(modal);
    } catch (err) {
      if (err.code === 10062) {
        await interaction.channel.send({
          content: '⚠️ That “Verify Deal Access” button expired. Please use the new button below.',
          components: [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId('verify_access')
                .setLabel('Verify Deal Access')
                .setStyle(ButtonStyle.Primary)
            )
          ]
        });
        return;
      }
      console.error('verify_access showModal failed:', err);
      try {
        await interaction.reply({
          content: '❌ Could not open the verification form. I posted a new button below—please click that.',
          ephemeral: true
        });
      } catch {}
      try {
        await interaction.channel.send({
          components: [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId('verify_access')
                .setLabel('Verify Deal Access')
                .setStyle(ButtonStyle.Primary)
            )
          ]
        });
      } catch {}
    }
  }

  //
  // Verify access modal submit
  //
  if (interaction.isModalSubmit() && interaction.customId === 'record_id_verify') {
    const recordId = interaction.fields.getTextInputValue('record_id').trim();

    try {
      const orderRecord = await base('Unfulfilled Orders Log').find(recordId);
      if (!orderRecord) {
        return interaction.reply({
          content: `❌ No deal found for Claim ID **${recordId}**.`,
          ephemeral: true
        });
      }

      const orderNumber = orderRecord.get('Order ID');
      const guild = await client.guilds.fetch(process.env.GUILD_ID);
      let dealChannel = guild.channels.cache.find(
        ch => ch.name.toLowerCase() === orderNumber.toLowerCase()
      );

      if (!dealChannel) {
        const dealChannelId = orderRecord.get('Deal Channel ID');
        if (dealChannelId) {
          try {
            dealChannel = await guild.channels.fetch(dealChannelId);
          } catch (e) {}
        }
      }

      if (!dealChannel) {
        return interaction.reply({
          content: `❌ No channel found for order **${orderNumber}**.`,
          ephemeral: true
        });
      }

      await dealChannel.permissionOverwrites.edit(interaction.user.id, {
        ViewChannel: true,
        SendMessages: true,
        AttachFiles: true
      });

      const existing = sellerMap.get(dealChannel.id) || {};
      sellerMap.set(dealChannel.id, { ...existing, sellerDiscordId: interaction.user.id });

      await interaction.reply({
        content: `✅ Access granted! You can now view <#${dealChannel.id}>.`,
        ephemeral: true
      });

    } catch (err) {
      console.error('❌ Error verifying deal access:', err);
      try {
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp({
            content: '❌ Something went wrong while verifying your access. Please try again later.',
            ephemeral: true
          });
        } else {
          await interaction.reply({
            content: '❌ Something went wrong while verifying your access. Please try again later.',
            ephemeral: true
          });
        }
      } catch (e) {
        console.error('❌ Failed to send verify_access error reply:', e);
      }
    }
  }

  //
  // 🔹 QUICK DEAL: modal submit (Seller ID + VAT type)
  //
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
      // 1) Validate Seller
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

      // 2) Fetch Quick Deal record
      const quickDealRecord = await base(QUICK_DEALS_TABLE).find(recordId);

      // 3) Get linked Unfulfilled Order record
      const linked = quickDealRecord.get(QUICK_DEAL_LINKED_ORDER_FIELD);
      let orderRecordId;
      if (Array.isArray(linked) && linked.length > 0) {
        orderRecordId = linked[0];
      } else if (typeof linked === 'string') {
        orderRecordId = linked;
      }

      if (!orderRecordId) {
        return interaction.reply({
          content: '❌ This Quick Deal is not linked to an order.',
          ephemeral: true
        });
      }

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

      // 4) Create Discord channel for this Quick Deal
      const guild    = await client.guilds.fetch(process.env.GUILD_ID);
      const category = await guild.channels.fetch(process.env.CATEGORY_ID);

      const channel = await guild.channels.create({
        name: `${orderNumber.toLowerCase()}`,
        type: ChannelType.GuildText,
        parent: category.id,
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
          `**Seller:** ${sellerId}`
        )
        .setColor(0xFFED00);

      if (imageUrl) embed.setImage(imageUrl);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('cancel_deal').setLabel('Cancel Deal').setStyle(ButtonStyle.Danger)
      );

      const dealMsg = await channel.send({ embeds: [embed], components: [row] });

      // 5) Cache + persist who claimed
      sellerMap.set(channel.id, {
        orderRecordId,
        dealEmbedId: dealMsg.id,
        sellerRecordId: sellerRecord.id,
        sellerDiscordId: interaction.user.id,
        vatType,
        payoutChosen: payout,
        isQuickDeal: true,
        quickDealRecordId: recordId,
        confirmed: true
      });

      await base('Unfulfilled Orders Log').update(orderRecordId, {
        "Fulfillment Status": "Claim Processing",
        "Deal Channel ID": channel.id,
        "Deal Embed Message ID": dealMsg.id,
        "Linked Seller": [sellerRecord.id],
        "Seller Discord ID": interaction.user.id,
        "Seller Confirmed?": true,
        "Seller VAT Type": vatType
      });

      // Optional: mark Quick Deal claimed (fields are safe to ignore if they don't exist)
      try {
        await base(QUICK_DEALS_TABLE).update(recordId, {
          "Status": "Claimed",
          "Claimed Seller ID": sellerId
        });
      } catch (e) {
        console.warn('⚠️ Could not update Quick Deal status:', e.message);
      }

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
  }

  //
  // Seller ID modal (legacy / Softr flow)
  //
  if (interaction.isModalSubmit() && interaction.customId === 'seller_id_modal') {
    const sellerIdRaw = interaction.fields.getTextInputValue('seller_id').replace(/\D/g, '');
    const sellerId = `SE-${sellerIdRaw.padStart(5, '0')}`;
    const channelId = interaction.channel.id;

    try {
      const sellerRecords = await base('Sellers Database')
        .select({ filterByFormula: `{Seller ID} = "${sellerId}"`, maxRecords: 1 })
        .firstPage();

      if (sellerRecords.length === 0) {
        return interaction.reply({
          content: `❌ Seller ID **${sellerId}** not found. Please double-check it or create a new one if your ID is from before **02/06/2025**.`,
        });
      }

      const sellerRecord = sellerRecords[0];
      const discordUsername = sellerRecord.get('Discord') || 'Unknown';

      sellerMap.set(channelId, {
        ...(sellerMap.get(channelId) || {}),
        sellerId,
        sellerRecordId: sellerRecord.id,
        confirmed: false,
        sellerDiscordId: interaction.user.id
      });

      let orderRecordId = (sellerMap.get(channelId) || {}).orderRecordId;
      if (!orderRecordId) {
        const orderNumber = interaction.channel.name.toUpperCase();
        const recs = await base('Unfulfilled Orders Log').select({
          filterByFormula: `{Order ID} = "${orderNumber}"`,
          maxRecords: 1
        }).firstPage();
        if (recs.length) orderRecordId = recs[0].id;
      }
      if (orderRecordId) {
        await base('Unfulfilled Orders Log').update(orderRecordId, {
          'Linked Seller': [sellerRecord.id],
          'Seller Discord ID': interaction.user.id,
          'Seller Confirmed?': false
        });
      }

      const confirmRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('confirm_seller').setLabel('✅ Yes, that is me').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('reject_seller').setLabel('❌ No, not me').setStyle(ButtonStyle.Danger)
      );

      await interaction.reply({
        content: `🔍 We found this Discord Username linked to Seller ID **${sellerId}**:\n**${discordUsername}**\n\nIs this you?`,
        components: [confirmRow],
      });
    } catch (err) {
      console.error('❌ Error verifying Seller ID:', err);
      return interaction.reply({ content: '❌ An error occurred while verifying the Seller ID.', ephemeral: true });
    }
  }

  if (interaction.isButton() && ['confirm_seller', 'reject_seller'].includes(interaction.customId)) {
    try {
      await interaction.deferUpdate();
    } catch (err) {
      if (err.code === 10062) {
        await interaction.channel.send({
          content: '⚠️ Those buttons expired. Please respond again:',
          components: [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId('confirm_seller').setLabel('✅ Yes, that is me').setStyle(ButtonStyle.Success),
              new ButtonBuilder().setCustomId('reject_seller').setLabel('❌ No, not me').setStyle(ButtonStyle.Danger)
            )
          ]
        });
        return;
      }
      throw err;
    }

    const data = sellerMap.get(interaction.channel.id) || {};

    if (interaction.customId === 'confirm_seller') {
      sellerMap.set(interaction.channel.id, { ...data, confirmed: true });

      try {
        let orderRecordId = (sellerMap.get(interaction.channel.id) || {}).orderRecordId;
        if (!orderRecordId) {
          const orderNumber = interaction.channel.name.toUpperCase();
          const recs = await base('Unfulfilled Orders Log').select({
            filterByFormula: `{Order ID} = "${orderNumber}"`,
            maxRecords: 1
          }).firstPage();
          if (recs.length) {
            orderRecordId = recs[0].id;
            sellerMap.set(interaction.channel.id, {
              ...(sellerMap.get(interaction.channel.id) || {}),
              orderRecordId,
              sellerRecordId: (recs[0].get('Linked Seller') || [])[0],
              sellerDiscordId: recs[0].get('Seller Discord ID'),
              dealEmbedId: recs[0].get('Deal Embed Message ID'),
              confirmed: true
            });
          }
        }
        if (orderRecordId) {
          await base('Unfulfilled Orders Log').update(orderRecordId, {
            'Seller Confirmed?': true
          });
        }
      } catch (e) {
        console.warn('Could not persist Seller Confirmed? to Airtable:', e);
      }

      try {
        await interaction.message.edit({
          content: '✅ Seller ID confirmed.\nPlease upload **6 different** pictures of the pair like shown below to prove it\'s in-hand and complete.',
          components: []
        });
        await interaction.channel.send({ files: ['https://i.imgur.com/JKaeeNz.png'] });
      } catch (e) {
        console.error('Failed to edit confirm_seller message:', e);
      }
    }

    if (interaction.customId === 'reject_seller') {
      try {
        await interaction.message.edit({
          content: '⚠️ Please check if the Seller ID was filled in correctly.\n\nIf you\'re using a Seller ID from before **02/06/2025**, it\'s no longer valid.\n\nPlease click **"Process Claim"** again to fill in your correct Seller ID.',
          components: []
        });
      } catch (e) {
        console.error('Failed to edit reject_seller message:', e);
      }
    }
  }

  if (interaction.isButton() && interaction.customId === 'start_claim') {
    const modal = new ModalBuilder()
      .setCustomId('seller_id_modal')
      .setTitle('Enter Seller ID');

    const input = new TextInputBuilder()
      .setCustomId('seller_id')
      .setLabel('Seller ID (e.g. 00001)')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(input));

    try {
      await interaction.showModal(modal);
    } catch (err) {
      if (err.code === 10062) {
        await interaction.channel.send({
          content: '⚠️ That “Process Claim” button expired. Please use the new button below.',
          components: [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId('start_claim')
                .setLabel('Process Claim')
                .setStyle(ButtonStyle.Primary)
            )
          ]
        });
        return;
      }

      console.error('showModal failed:', err);

      try {
        await interaction.reply({
          content: '❌ Could not open the form. I posted a new “Process Claim” button—please click that.',
          ephemeral: true
        });
      } catch {}
      try {
        await interaction.channel.send({
          components: [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId('start_claim')
                .setLabel('Process Claim')
                .setStyle(ButtonStyle.Primary)
            )
          ]
        });
      } catch {}
    }
  }

  if (interaction.isButton() && interaction.customId === 'cancel_deal') {
    console.log(`🛑 Cancel Deal clicked in ${interaction.channel.name}`);

    try {
      await interaction.deferReply({ ephemeral: true });
    } catch (err) {
      if (err.code === 10062) {
        console.warn(`⚠️ Expired Cancel Deal button clicked in ${interaction.channel.name}`);
        await interaction.channel.send({
          content: '⚠️ This Cancel Deal button has expired. Please use the new button below.',
          components: [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId('cancel_deal')
                .setLabel('Cancel Deal')
                .setStyle(ButtonStyle.Danger)
            )
          ]
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
        const records = await base('Unfulfilled Orders Log').select({
          filterByFormula: `{Order ID} = "${orderNumber}"`,
          maxRecords: 1
        }).firstPage();
        if (records.length > 0) {
          recordId = records[0].id;
        }
      }

      if (!recordId) {
        return await interaction.editReply('❌ Record ID not found.');
      }

      await base('Unfulfilled Orders Log').update(recordId, {
        "Fulfillment Status": "Outsource",
        "Outsource Start Time": new Date().toISOString(),
        "Deal Invitation URL": "",
        "Deal Channel ID": "",
        "Deal Embed Message ID": "",
        "Seller Discord ID": "",
        "Linked Seller": [],
        "Seller Confirmed?": false,
        "Outsourced?": false
      });

      const orderNumber = channel.name.toUpperCase();
      const invRecords = await base('Inventory Units').select({
        filterByFormula: `{Ticket Number} = "${orderNumber}"`,
        maxRecords: 1
      }).firstPage();

      if (invRecords.length > 0) {
        await base('Inventory Units').update(invRecords[0].id, {
          "Verification Status": "Cancelled",
          "Selling Method": null,
          "Unfulfilled Orders Log": [],
          "Payment Status": null,
          "Availability Status": null
        });
      }

      const transcriptFileName = `transcript-${channel.name}.html`;
      const transcript = await createTranscript(channel, { limit: -1, returnBuffer: false, fileName: transcriptFileName });
      const transcriptsChannel = await client.channels.fetch(TRANSCRIPTS_CHANNEL_ID);
      if (transcriptsChannel?.isTextBased()) {
        await transcriptsChannel.send({
          content: `🗒️ Transcript for cancelled deal channel **${channel.name}**`,
          files: [transcript]
        });
      }

      await interaction.editReply('✅ Deal has been finished or cancelled. Channel will be deleted shortly.');
      setTimeout(() => channel.delete().catch(console.error), 3000);

    } catch (err) {
      console.error('❌ Cancel Deal error:', err);
      await interaction.editReply('❌ Something went wrong while cancelling this deal.');
    }
  }

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
          content: '⚠️ This Confirm Deal button has expired. Please use the new button below.',
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
      const recs = await base('Unfulfilled Orders Log').select({
        filterByFormula: `{Order ID} = "${orderNumber}"`,
        maxRecords: 1
      }).firstPage();

      const rec = recs[0];
      if (rec) {
        sellerData = {
          sellerRecordId: (rec.get('Linked Seller') || [])[0],
          orderRecordId: rec.id,
          sellerDiscordId: rec.get('Seller Discord ID'),
          dealEmbedId: rec.get('Deal Embed Message ID')
        };
        sellerMap.set(channel.id, sellerData);
      }
    }

    if (sellerData?.dealConfirmed) {
      return interaction.editReply({ content: '⚠️ This deal has already been confirmed.' });
    }

    if (!sellerData || !sellerData.orderRecordId || !sellerData.sellerRecordId) {
      return interaction.editReply({ content: '❌ Missing linked Seller or Order Claim ID.' });
    }

    const imageMsg = messages.find(m =>
      m.attachments.size > 0 && [...m.attachments.values()].some(att => att.contentType?.startsWith('image/'))
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
          e?.title?.includes('Deal Claimed') &&
          e?.description?.includes('**Order:**') &&
          e?.description?.includes('**Payout:**')
        )
      );
      embed = m?.embeds?.find(e => e?.title?.includes('Deal Claimed') || e?.title?.includes('Quick Deal Claimed'));
    }

    if (!embed?.description) {
      return interaction.editReply({ content: '❌ Missing deal embed.' });
    }

    const lines = embed.description.split('\n');
    const getValue = label => lines.find(line => line.includes(label))?.split(label)[1]?.trim() || '';

    const sku = getValue('**SKU:**');
    const size = getValue('**Size:**');
    const brand = getValue('**Brand:**');
    const orderNumber = getValue('**Order:**');

    // payout + vatType from memory if available, otherwise from embed
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
          trustNote = '\n\n⚠️ Because you are not a Trusted Seller yet, we had to deduct €10 from the payout for the extra label and handling.';
        }
      }
    } catch (err) {
      console.warn('Could not check trusted role:', err);
    }

    const orderRecord = await base('Unfulfilled Orders Log').find(sellerData.orderRecordId);
    const productName = orderRecord.get('Product Name') || orderRecord.get('Shopify Product Name') || '';

    let sellerRecord;
    try {
      sellerRecord = await base('Sellers Database').find(sellerData.sellerRecordId);
    } catch (e) {}
    if (!sellerRecord) {
      return interaction.editReply({ content: '❌ Linked Seller not found in our system.' });
    }

    // 🔹 Send data to Make instead of creating Inventory Units here
    if (MAKE_QUICK_DEAL_WEBHOOK_URL) {
      try {
        await fetch(MAKE_QUICK_DEAL_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source: sellerData.isQuickDeal ? 'Quick Deal' : 'Claim Deal',
            orderRecordId: sellerData.orderRecordId,
            sellerRecordId: sellerData.sellerRecordId,
            quickDealRecordId: sellerData.quickDealRecordId || null,
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
  }
});

client.on(Events.MessageCreate, async message => {
  if (
    message.channel.name.toUpperCase().startsWith('ORD-') &&
    message.attachments.size > 0
  ) {
    let data = sellerMap.get(message.channel.id);
    if (!data?.sellerRecordId) {
      const orderNumber = message.channel.name.toUpperCase();
      const recs = await base('Unfulfilled Orders Log').select({
        filterByFormula: `{Order ID} = "${orderNumber}"`,
        maxRecords: 1
      }).firstPage();

      if (recs.length) {
        data = {
          ...(data || {}),
          orderRecordId: recs[0].id,
          sellerRecordId: (recs[0].get('Linked Seller') || [])[0],
          sellerDiscordId: recs[0].get('Seller Discord ID'),
          dealEmbedId: recs[0].get('Deal Embed Message ID'),
          confirmed: !!recs[0].get('Seller Confirmed?')
        };
        sellerMap.set(message.channel.id, data);
      }

    }
    if (!data?.sellerRecordId || !data?.confirmed) return;

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

  if (message.content === '!finish' && message.channel.name.toLowerCase().startsWith('ord-')) {
    const memberRoles = message.member.roles.cache.map(r => r.id);
    const isAdmin = ADMIN_ROLE_IDS.some(roleId => memberRoles.includes(roleId));
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
          limit: -1, returnBuffer: false, fileName: transcriptFileName
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

client.login(process.env.DISCORD_TOKEN);
app.listen(PORT, () => {
  console.log(`🌐 Express server running on port ${PORT}`);
});
