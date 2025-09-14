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
const { createTranscript } = require('discord-html-transcripts');

const app = express();
app.use(express.json());

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);
const PORT = process.env.PORT || 3000;
const VERIFY_CHANNEL_ID = process.env.VERIFY_CHANNEL_ID;
const TRANSCRIPTS_CHANNEL_ID = process.env.TRANSCRIPTS_CHANNEL_ID;
const ADMIN_ROLE_IDS = ['942779423449579530', '1060615571118510191'];
const TRUSTED_SELLERS_ROLE_ID = process.env.TRUSTED_SELLERS_ROLE_ID; // put your trusted sellers role ID in .env


const sellerMap = new Map();
const uploadedImagesMap = new Map();


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
  const { orderNumber, productName, sku, skuSoft, size, brand, payout, recordId } = req.body;
  console.log("📥 Received POST /claim-deal with body:", req.body);

  const orderRecord = await base('Unfulfilled Orders Log').find(recordId);
  const pictureField = orderRecord.get('Picture');
  const imageUrl = Array.isArray(pictureField) && pictureField.length > 0 ? pictureField[0].url : null;

  const rawSku = Array.isArray(sku) ? sku[0] : (typeof sku === 'string' ? sku : '');
  const rawSkuSoft = Array.isArray(skuSoft) ? skuSoft[0] : (typeof skuSoft === 'string' ? skuSoft : '');
  const finalSku = rawSku.trim() !== '' ? rawSku.trim() : rawSkuSoft.trim();

  const cleanProductName = orderRecord.get('Product Name');
  if (!orderNumber || !cleanProductName || !finalSku || !size || !brand || !payout || !recordId) {
    return res.status(400).send("Missing required fields");
  }

  try {
    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    const category = await guild.channels.fetch(process.env.CATEGORY_ID);

    const channel = await guild.channels.create({
      name: `${orderNumber.toLowerCase()}`,
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
      .setDescription(`**Order:** ${orderNumber}\n**Product:** ${cleanProductName}\n**SKU:** ${finalSku}\n**Size:** ${size}\n**Brand:** ${brand}\n**Payout:** €${payout.toFixed(2)}`)
      .setColor(0xFFED00);

    if (imageUrl) {
      embed.setImage(imageUrl);
    }

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('start_claim').setLabel('Process Claim').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('cancel_deal').setLabel('Cancel Deal').setStyle(ButtonStyle.Danger)
    );

    await channel.send({ embeds: [embed], components: [row] });
    sellerMap.set(channel.id, { sellerId: null, orderRecordId: recordId });

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
      const dealChannel = guild.channels.cache.find(
        ch => ch.name.toLowerCase() === orderNumber.toLowerCase()
      );

      if (!dealChannel) {
        return interaction.reply({
          content: `❌ No channel found for order **${orderNumber}**.`,
          ephemeral: true
        });
      }

      // 3. Give the user access to the channel
      await dealChannel.permissionOverwrites.edit(interaction.user.id, {
        ViewChannel: true,
        SendMessages: true
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
  const data = sellerMap.get(interaction.channel.id);

  if (interaction.customId === 'confirm_seller') {
    sellerMap.set(interaction.channel.id, { ...data, confirmed: true });

    await interaction.update({
      content: `✅ Seller ID confirmed.\nPlease upload **6 different** pictures of the pair like shown below to prove it's in-hand and complete.`,
      components: [],
      files: ['https://i.imgur.com/JKaeeNz.png']
    });
  }

  if (interaction.customId === 'reject_seller') {
    await interaction.update({
      content: `⚠️ Please check if the Seller ID was filled in correctly.\n\nIf you're using a Seller ID from before **02/06/2025**, it's no longer valid.\n\nPlease click **"Process Claim"** again to fill in your correct Seller ID.`,
      components: []
    });
  }
}

  if (interaction.isButton() && interaction.customId === 'start_claim') {
    const modal = new ModalBuilder()
      .setCustomId('seller_id_modal')
      .setTitle('Enter Seller ID');

    const input = new TextInputBuilder()
      .setCustomId('seller_id')
      .setLabel("Seller ID (e.g. 00001)")
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(input));
    await interaction.showModal(modal);
  }

  if (interaction.isButton() && interaction.customId === 'cancel_deal') {
      console.log(`🛑 Cancel Deal clicked in ${interaction.channel.name}`);
  
      try {
          // Try to acknowledge interaction to prevent "Interaction Failed"
          await interaction.deferReply({ flags: 64 }); // private reply
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
              "Deal Invitation URL": ""
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
      return interaction.reply({ content: '❌ You are not authorized to confirm the deal.', ephemeral: false });
    }

    await interaction.deferReply({ ephemeral: false });

    const channel = interaction.channel;
    const messages = await channel.messages.fetch({ limit: 50 });

    const sellerData = sellerMap.get(channel.id);
    if (sellerData?.dealConfirmed) {
      return interaction.editReply({ content: '⚠️ This deal has already been confirmed.' });
    }

    if (!sellerData || !sellerData.sellerId || !sellerData.orderRecordId || !sellerData.sellerRecordId) {
      return interaction.editReply({ content: '❌ Missing Seller ID or Order Claim ID.' });
    }

    const imageMsg = messages.find(m =>
      m.attachments.size > 0 && [...m.attachments.values()].some(att => att.contentType?.startsWith('image/'))
    );

    if (!imageMsg) {
      return interaction.editReply({ content: '❌ No image found in recent messages.' });
    }

    const dealMsg = messages.find(m => m.embeds.length > 0);
    const embed = dealMsg?.embeds?.[0];
    if (!embed || !embed.description) {
      return interaction.editReply({ content: '❌ Missing deal embed.' });
    }

    const lines = embed.description.split('\n');
    const getValue = label => lines.find(line => line.includes(label))?.split(label)[1]?.trim() || '';

    const sku = getValue('**SKU:**');
    const size = getValue('**Size:**');
    const brand = getValue('**Brand:**');
    const payout = parseFloat(getValue('**Payout:**')?.replace('€', '') || 0);
    // --- Adjust payout if user does NOT have trusted role ---
    let finalPayout = payout;   // amount you actually transfer
    let shippingDeduction = 0;  // new variable
    let trustNote = '';

    try {
      const sellerDiscordId = sellerData?.sellerDiscordId;
      if (sellerDiscordId) {
        const member = await interaction.guild.members.fetch(sellerDiscordId);
        const isTrusted = member.roles.cache.has(TRUSTED_SELLERS_ROLE_ID);
        if (!isTrusted) {
          finalPayout = Math.max(0, payout - 10); 
          shippingDeduction = 10;  // <--- set the deduction
          trustNote = '\n\n⚠️ Because you are not a Trusted Seller yet, we had to deduct €10 from the payout for the extra label and handling.';
        }
      }
    } catch (err) {
      console.warn('Could not check trusted role:', err);
    }


    const orderNumber = getValue('**Order:**');
    const orderRecord = await base('Unfulfilled Orders Log').find(sellerData.orderRecordId);
    const productName = orderRecord.get('Product Name');

    const sellerRecords = await base('Sellers Database')
      .select({ filterByFormula: `{Seller ID} = "${sellerData.sellerId}"`, maxRecords: 1 })
      .firstPage();

    if (!sellerRecords.length) {
      return interaction.editReply({ content: '❌ Seller ID not found in our system.' });
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
      'Purchase Price': payout,
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
    const data = sellerMap.get(message.channel.id);
    if (!data?.sellerId || !data?.confirmed) return;

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
