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
app.options('*', cors());


const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers // <- REQUIRED for member.roles.fetch/cache
  ]
});

// --- crash guards: add once, right after `const client = new Client(...)` ---
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


const sellerMap = new Map();
const uploadedImagesMap = new Map();

async function fetchUpTo(channel, max = 500) {
  const collected = [];
  let beforeId = undefined;

  while (collected.length < max) {
    const batchSize = Math.min(100, max - collected.length);
    const batch = await channel.messages.fetch({ limit: batchSize, ...(beforeId ? { before: beforeId } : {}) });
    if (batch.size === 0) break;

    // Push in chronological order (newest → oldest)
    for (const m of batch.values()) collected.push(m);

    // Prepare for next page (oldest id in this batch)
    const oldest = batch.last();
    beforeId = oldest?.id;
    if (!beforeId) break;
  }
  return collected;
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


app.post('/claim-deal', async (req, res) => {
  try {
    const src = req.body || {};
    const recordId = (src.recordId || '').trim();
    const sellerIdRaw = (src.sellerId || '').replace(/\D/g, ''); // digits only
    const sellerId = sellerIdRaw ? `SE-${sellerIdRaw.padStart(5, '0')}` : '';

    if (!recordId || !sellerId) {
      return res.status(400).send('Missing recordId or sellerId');
    }

    // 1) Pull ALL required fields from Airtable by recordId
    const orderRecord = await base('Unfulfilled Orders Log').find(recordId);
    if (!orderRecord) return res.status(404).send('Claim not found');
    const orderNumber  = String(orderRecord.get('Order ID') || '');
    const size         = orderRecord.get('Size') || '';
    const brand        = orderRecord.get('Brand') || '';
    // Try a few possible column names so you don't have to edit code later
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
    const sku          = orderRecord.get('SKU') || '';
    const skuSoft      = orderRecord.get('SKU (Soft)') || '';

    const pictureField = orderRecord.get('Picture');
    const imageUrl     = Array.isArray(pictureField) && pictureField.length > 0 ? pictureField[0].url : null;

    const finalSku = (sku && sku.trim()) || (skuSoft && skuSoft.trim()) || '';

    if (!orderNumber || !productName || !finalSku || !size || !brand || !Number.isFinite(payout)) {
      return res.status(400).send('Missing required order fields in Airtable');
    }

    // 2) Verify Seller exists
    const sellerRecords = await base('Sellers Database')
      .select({ filterByFormula: `{Seller ID} = "${sellerId}"`, maxRecords: 1 })
      .firstPage();
    if (sellerRecords.length === 0) {
      return res.status(400).send(`Seller ID ${sellerId} not found`);
    }
    const sellerRecord = sellerRecords[0];

    // 3) Create Discord channel + invite + embed
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
        `**Seller (form):** ${sellerId}`
      )
      .setColor(0xFFED00);
    if (imageUrl) embed.setImage(imageUrl);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('start_claim').setLabel('Process Claim').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('cancel_deal').setLabel('Cancel Deal').setStyle(ButtonStyle.Danger)
    );

    const dealMsg = await channel.send({ embeds: [embed], components: [row] });

    // Cache + persist who claimed
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
      : 'https://kickzcaviar.preview.softr.app'; // fallback for non-Softr callers
    const successUrl = `${redirectBase}/success?recordId=${recordId}`;



    if (req.headers['x-requested-with'] === 'fetch') {
      // Softr fetch() path → give JSON with redirect URL
      return res.status(200).json({ ok: true, redirect: successUrl });
    }
    // Browser form / direct hit → normal redirect
    return res.redirect(302, successUrl);

  } catch (err) {
    console.error('❌ Error during claim creation:', err);
    return res.status(500).send('Internal Server Error');
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

  
  if (interaction.isModalSubmit() && interaction.customId === 'record_id_verify') {
    const recordId = interaction.fields.getTextInputValue('record_id').trim();

    try {
      // 1. Fetch the record from Airtable
      const orderRecord = await base('Unfulfilled Orders Log').find(recordId);
      if (!orderRecord) {
        return interaction.reply({
          content: `❌ No deal found for Claim ID **${recordId}**.`,
          ephemeral: true
        });
      }

      // 2. Find the matching Discord channel
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
          } catch (e) {
            // ignore fetch error, will fall through to the error reply below
          }
        }
      }

      if (!dealChannel) {
        return interaction.reply({
          content: `❌ No channel found for order **${orderNumber}**.`,
          ephemeral: true
        });
      }

      // 3. Give the user access to the channel
      await dealChannel.permissionOverwrites.edit(interaction.user.id, {
        ViewChannel: true,
        SendMessages: true,
        AttachFiles: true // <- ensure they can post photos
      });

      // Store the seller's Discord ID for this channel
      const existing = sellerMap.get(dealChannel.id) || {};
      sellerMap.set(dealChannel.id, { ...existing, sellerDiscordId: interaction.user.id });

      // 4. Confirm success
      await interaction.reply({
        content: `✅ Access granted! You can now view <#${dealChannel.id}>.`,
        ephemeral: true
      });

    } catch (err) {
      console.error('❌ Error verifying deal access:', err);
      await interaction.reply({
        content: '❌ Something went wrong while verifying your access. Please try again later.',
        ephemeral: true
      });
    }
  }
  
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
      sellerRecordId: sellerRecord.id, // keep seller record separately
      confirmed: false,
      sellerDiscordId: interaction.user.id // <-- store the Discord ID
    });

    // Persist to Airtable so state survives restarts
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
    // ⚡ Acknowledge immediately to avoid 3s timeout -> "Unknown interaction"
    try {
      await interaction.deferUpdate();
    } catch (err) {
      if (err.code === 10062) {
        // Old buttons → re-post fresh ones
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
      // 1) Mark as confirmed in memory
      sellerMap.set(interaction.channel.id, { ...data, confirmed: true });

      // 2) Persist to Airtable (fallback hydration as you had)
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

      // 3) Edit the original message (we used deferUpdate, so use message.edit)
      try {
        await interaction.message.edit({
          content: '✅ Seller ID confirmed.\nPlease upload **6 different** pictures of the pair like shown below to prove it\'s in-hand and complete.',
          components: []
        });
        // Send the reference image as a new message (safer than editing with files)
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
    // Build the modal
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
      // Must happen quickly and without any prior defer/reply
      await interaction.showModal(modal);
    } catch (err) {
      // If the button is old, Discord returns "Unknown interaction" (10062)
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

      // Best-effort user feedback + fresh button
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
          // Try to acknowledge interaction to prevent "Interaction Failed"
          await interaction.deferReply({ ephemeral: true }); // private reply
      } catch (err) {
          if (err.code === 10062) { // Unknown interaction = expired button
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
              return; // stop here, don’t run old logic
          } else {
              throw err; // different error, let it bubble up
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

          // ✅ Update Unfulfilled Orders Log
          await base('Unfulfilled Orders Log').update(recordId, {
            "Fulfillment Status": "Outsource",
            "Outsource Start Time": new Date().toISOString(),
            "Deal Invitation URL": "",
            "Deal Channel ID": "",
            "Deal Embed Message ID": "",
            "Seller Discord ID": "",
            "Linked Seller": [],        // linked-record fields: use []
            "Seller Confirmed?": false, // reset the checkbox
            "Outsourced?": false
          });


          // ✅ Update Inventory Units if exists
          const orderNumber = channel.name.toUpperCase();
          const invRecords = await base('Inventory Units').select({
              filterByFormula: `{Ticket Number} = "${orderNumber}"`,
              maxRecords: 1
          }).firstPage();

          if (invRecords.length > 0) {
              await base('Inventory Units').update(invRecords[0].id, {
                  "Verification Status": "Cancelled",
                  "Selling Method": null,           // clear single select
                  "Unfulfilled Orders Log": [],     // clear linked record field
                  "Payment Status": null,           // clear single select
                  "Availability Status": null       // clear single select
              });
          }

          // ✅ Create transcript
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
      // no 'ephemeral: false' – just reply normally
      return interaction.reply({ content: '❌ You are not authorized to confirm the deal.' });
    }

    // Acknowledge ASAP; catch expired button (10062)
    try {
      // don't pass 'ephemeral' here; it's deprecated
      await interaction.deferReply(); 
    } catch (err) {
      if (err.code === 10062) { // Unknown interaction = expired click
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
          sellerRecordId: (rec.get('Linked Seller') || [])[0], // linked record id (recXXXX)
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

    // try the stored message id first
    const storedId = sellerMap.get(channel.id)?.dealEmbedId;
    if (storedId) {
      const m = await channel.messages.fetch(storedId).catch(() => null);
      embed = m?.embeds?.[0];
    }

    // fallback: search deeper (paginate up to 500 msgs)
    if (!embed) {
      const msgs = await fetchUpTo(channel, 500);
      const m = msgs.find(msg =>
        msg.author.id === client.user.id &&
        Array.isArray(msg.embeds) &&
        msg.embeds.some(e => e?.title === '💸 Deal Claimed' && e?.description)
      );
      embed = m?.embeds?.find(e => e?.title === '💸 Deal Claimed');
    }

    if (!embed?.description) {
      return interaction.editReply({ content: '❌ Missing deal embed.' });
    }

    const lines = embed.description.split('\n');
    const getValue = label => lines.find(line => line.includes(label))?.split(label)[1]?.trim() || '';

    const sku = getValue('**SKU:**');
    const size = getValue('**Size:**');
    const brand = getValue('**Brand:**');
    const payout = parseFloat(getValue('**Payout:**')?.replace('€', '') || 0);

    // --- Adjust payout if user does NOT have trusted role ---
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

    const orderNumber = getValue('**Order:**');
    const orderRecord = await base('Unfulfilled Orders Log').find(sellerData.orderRecordId);
    const productName = orderRecord.get('Product Name');

    let sellerRecord;
    try {
      sellerRecord = await base('Sellers Database').find(sellerData.sellerRecordId);
    } catch (e) {}
    if (!sellerRecord) {
      return interaction.editReply({ content: '❌ Linked Seller not found in our system.' });
    }

    const duplicate = await base('Inventory Units').select({
      filterByFormula: `{Ticket Number} = "${orderNumber}"`,
      maxRecords: 1
    }).firstPage();

    if (duplicate.length > 0) {
      return interaction.editReply({ content: '⚠️ This deal has already been confirmed before.' });
    }

    await base('Inventory Units').create({
      'Product Name': productName,
      'SKU': sku,
      'Size': size,
      'Brand': brand,
      'VAT Type':'Margin',
      'Purchase Price': finalPayout,
      'Shipping Deduction': shippingDeduction,
      'Purchase Date': new Date().toISOString().split('T')[0],
      'Seller ID': [sellerData.sellerRecordId],
      'Ticket Number': orderNumber,
      'Type': 'Direct',
      'Source': 'Outsourced',
      'Verification Status': 'Verified',
      'Payment Status': 'To Pay',
      'Availability Status': 'Reserved',
      'Margin %': '10%',
      'Payment Note': finalPayout.toFixed(2).replace('.', ','),
      'Selling Method': 'Plug & Play',
      'Unfulfilled Orders Log': [sellerData.orderRecordId]
    });

    sellerMap.set(channel.id, { ...sellerData, dealConfirmed: true });

    const recentMessages = await channel.messages.fetch({ limit: 10 });
    const buttonMessage = recentMessages.find(msg => msg.components.length > 0);
    if (buttonMessage) {
      await buttonMessage.edit({ components: [] });
    }

    await base('Unfulfilled Orders Log').update(sellerData.orderRecordId, {
      'Outsourced?': true
    });

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
      // hydrate from Airtable in case of restart
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
          confirmed: !!recs[0].get('Seller Confirmed?')  // <-- hydrate confirmation
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

  // ✅ This was outside before — move it inside
  if (message.content === '!finish' && message.channel.name.toLowerCase().startsWith('ord-')) {
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
    }, 3600000); // 1 hour in milliseconds
  }
});


client.login(process.env.DISCORD_TOKEN);
app.listen(PORT, () => {
  console.log(`🌐 Express server running on port ${PORT}`);
});
