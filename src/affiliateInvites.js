const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  MessageFlags,
} = require("discord.js");

/**
 * Affiliate Invites Module (CommonJS)
 *
 * Airtable tables expected:
 *
 * Discord Members fields:
 * - Discord User ID
 * - Discord Username
 * - Invite Code
 * - Invite URL
 * - Invite Created At (date)
 * - Joined At (date)
 * - Invited By Discord User ID
 * - Invite Code Used
 * - (optional) Invited By Member (LINK to Discord Members)
 *
 * Invites Log fields:
 * - Invitee Discord User ID
 * - Inviter Discord User ID
 * - Invite Code Used
 * - Joined At (date)
 * - Month Key (formula)
 * - (optional) Invitee (LINK to Discord Members)
 * - (optional) Inviter (LINK to Discord Members)
 */
function registerAffiliateInvites(ctx) {
  const { client, base, env } = ctx;

  const {
    AFFILIATE_CHANNEL_ID,
    AFFILIATE_GUILD_ID, // strongly recommended
    AIRTABLE_MEMBERS_TABLE = "Discord Members",
    AIRTABLE_INVITES_LOG_TABLE = "Invites Log",

    // Optional link field names (only used if they exist)
    AIRTABLE_MEMBERS_LINK_INVITED_BY = "Invited By Member",
    AIRTABLE_INVITES_LINK_INVITEE = "Invitee",
    AIRTABLE_INVITES_LINK_INVITER = "Inviter",
  } = env;

  if (!AFFILIATE_CHANNEL_ID) {
    console.warn("⚠️ Affiliate invites disabled: AFFILIATE_CHANNEL_ID missing.");
    return;
  }

  const membersTable = base(AIRTABLE_MEMBERS_TABLE);
  const invitesLogTable = base(AIRTABLE_INVITES_LOG_TABLE);

  const AI = { BTN_GET: "aff_get_invite" };

  // Map<guildId, Map<inviteCode, usesNumber>>
  const inviteCache = new Map();
  let AI_READY = false;

  // ---------- Helpers ----------
  function escapeAirtableValue(v) {
    return String(v || "").replace(/'/g, "\\'");
  }
  function normId(v) {
    return String(v || "").trim();
  }
  function guildAllowed(guildId) {
    if (!AFFILIATE_GUILD_ID) return true;
    return String(guildId) === String(AFFILIATE_GUILD_ID);
  }

  async function getAffiliateChannel(guild) {
    const ch = await guild.channels.fetch(String(AFFILIATE_CHANNEL_ID)).catch(() => null);
    if (!ch || !ch.isTextBased()) return null;
    return ch;
  }

  // ---------- Airtable helpers ----------
  async function findMemberRecordByDiscordId(discordId) {
    const id = normId(discordId);
    const rows = await membersTable
      .select({
        maxRecords: 1,
        filterByFormula: `{Discord User ID}='${escapeAirtableValue(id)}'`,
      })
      .firstPage()
      .catch((e) => {
        console.error("AI: Airtable select failed:", e);
        return [];
      });

    return rows?.[0] || null;
  }

  async function upsertMember(discordId, username, fields = {}) {
    const id = normId(discordId);
    const existing = await findMemberRecordByDiscordId(id);

    const payload = {
      "Discord User ID": id,
      "Discord Username": String(username || ""),
      ...fields,
    };

    if (existing) return await membersTable.update(existing.id, payload);
    return await membersTable.create(payload);
  }

  async function refreshInviteCacheForGuild(guild) {
    try {
      const invites = await guild.invites.fetch(); // Collection<code, Invite>
      const snapshot = new Map();
      for (const [code, inv] of invites) {
        snapshot.set(code, Number(inv.uses || 0));
      }
      inviteCache.set(guild.id, snapshot);
      console.log("AI: invite cache refreshed for guild", guild.id, "count:", snapshot.size);
      return true;
    } catch (e) {
      console.error("AI: invite fetch failed:", e);
      return false;
    }
  }

  async function findMemberRecordByInviteCode(inviteCode) {
    const code = String(inviteCode || "").trim();
    if (!code) return null;

    const rows = await membersTable
      .select({
        maxRecords: 1,
        filterByFormula: `{Invite Code}='${escapeAirtableValue(code)}'`,
      })
      .firstPage()
      .catch((e) => {
        console.error("AI: Airtable select by Invite Code failed:", e);
        return [];
      });

    return rows?.[0] || null;
  }

  // ---------- Affiliate message ----------
  async function ensureAffiliateMessage() {
    const ch = await client.channels.fetch(String(AFFILIATE_CHANNEL_ID)).catch(() => null);
    if (!ch || !ch.isTextBased()) return;

    const embed = new EmbedBuilder()
      .setTitle("🤝 Affiliate Program")
      .setDescription(
        [
          "Click below to get your **personal invite link**.",
          "",
          "• Monthly invite leaderboard",
          "• Earn **€5** per invited member that completes their **first deal**",
        ].join("\n")
      )
      .setColor(0xffd300);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(AI.BTN_GET)
        .setLabel("Get my Invite URL")
        .setStyle(ButtonStyle.Primary)
    );

    const recent = await ch.messages.fetch({ limit: 25 }).catch(() => null);
    const existing = recent?.find(
      (m) => m.author?.id === client.user.id && m.embeds?.[0]?.title === "🤝 Affiliate Program"
    );

    if (existing) await existing.edit({ embeds: [embed], components: [row] }).catch(() => {});
    else await ch.send({ embeds: [embed], components: [row] }).catch(() => {});
  }
  
  // ---------- Affiliate Info message ----------
  async function ensureAffiliateInfoMessage() {
    const {
      AFFILIATE_INFO_CHANNEL_ID,
      AFFILIATE_INFO_PIN_MESSAGE = "true",
    } = env;
  
    if (!AFFILIATE_INFO_CHANNEL_ID) return;
  
    const ch = await client.channels.fetch(String(AFFILIATE_INFO_CHANNEL_ID)).catch(() => null);
    if (!ch || !ch.isTextBased()) {
      console.warn("⚠️ AFFILIATE_INFO_CHANNEL_ID is not a text channel.");
      return;
    }
  
    const SHOULD_PIN = String(AFFILIATE_INFO_PIN_MESSAGE).toLowerCase() === "true";
    const TITLE = "🤝 Affiliate Program — What It Is & How It Works";
  
    const embed = new EmbedBuilder()
      .setTitle(TITLE)
      .setColor(0xffd300)
      .setDescription(
        [
          "**Community growth attracts more opportunities**",
          "An active and reliable seller base makes the platform more attractive to clients.",
          "That increased demand results in more Quick Deals and WTBs across the community.",
          "",
          "**Why this program exists**",
          "We reward members who help grow a strong, active community that increase the overall server portential.",
          "",
          "**How you earn**",
          "• Earn **€5** for each invited member who completes their **first deal**",
          "• Earn extra prizes by finishing among the **Top 3 Monthly Inviters**",
          "• Earnings are calculated monthly",
          "",
          "**How to join**",
          "1) Click **Get my Invite URL** in the affiliate channel",
          "2) Share your personal invite link with other sellers",
          "3) Invites are tracked automatically",
          "",
          "PRO TIP: If you help us secure a partnership with another server (e.g. cookgroups or WTB servers), we’ll use **your personal invite link** in the webhook posts — so all incoming members are credited to you! 👀",
          "",
          "**Important**",
          "• No spam or fake accounts",
          "• Abuse results in removal from the program",
        ].join("\n")
      )
      .setFooter({ text: "Payout by Kickz Caviar" });
  
    const recent = await ch.messages.fetch({ limit: 25 }).catch(() => null);
    const existing = recent?.find(
      (m) => m.author?.id === client.user.id && m.embeds?.[0]?.title === TITLE
    );
  
    if (existing) {
      await existing.edit({ embeds: [embed], content: null }).catch(() => {});
      if (SHOULD_PIN && !existing.pinned) await existing.pin().catch(() => {});
      return;
    }
  
    const msg = await ch.send({ embeds: [embed] }).catch(() => null);
    if (msg && SHOULD_PIN) await msg.pin().catch(() => {});
  }

  // ---------- Create or reuse personal invite ----------
  async function getOrCreatePersonalInvite(guild, user) {
    const existing = await findMemberRecordByDiscordId(user.id);
    const existingUrl = existing?.fields?.["Invite URL"];
    if (existingUrl) {
      await refreshInviteCacheForGuild(guild);
      return { url: existingUrl, code: existing?.fields?.["Invite Code"] || "" };
    }

    const ch = await getAffiliateChannel(guild);
    if (!ch) throw new Error("Affiliate channel not found / not text-based.");

    const invite = await ch.createInvite({
      maxAge: 0,
      maxUses: 0,
      unique: true,
      reason: `Affiliate personal invite for ${user.tag} (${user.id})`,
    });

    await upsertMember(user.id, user.tag, {
      "Invite Code": invite.code,
      "Invite URL": invite.url,
      "Invite Created At": new Date().toISOString(),
    });

    // Seed cache
    await refreshInviteCacheForGuild(guild);

    return { url: invite.url, code: invite.code };
  }

  // ---------- Ready ----------
  client.once(Events.ClientReady, async () => {
    try {
      await ensureAffiliateMessage();
      await ensureAffiliateInfoMessage(); // ✅ ADD THIS
  
      if (AFFILIATE_GUILD_ID) {
        const g = await client.guilds.fetch(String(AFFILIATE_GUILD_ID)).catch(() => null);
        if (g) await refreshInviteCacheForGuild(g);
      } else {
        for (const [, g] of client.guilds.cache) {
          await refreshInviteCacheForGuild(g);
        }
      }
  
      setInterval(async () => {
        try {
          if (!AFFILIATE_GUILD_ID) return;
          const g = client.guilds.cache.get(String(AFFILIATE_GUILD_ID));
          if (g) await refreshInviteCacheForGuild(g);
        } catch (e) {
          console.error("AI: periodic cache refresh failed:", e);
        }
      }, 60_000);
  
      AI_READY = true;
      console.log("✅ Affiliate Invites module ready.");
    } catch (e) {
      console.error("AI: ready failed:", e);
      AI_READY = true;
    }
  });

  // Keep cache correct if invites are created/deleted
  client.on(Events.InviteCreate, async (invite) => {
    try {
      if (!invite?.guild?.id) return;
      if (!guildAllowed(invite.guild.id)) return;
      await refreshInviteCacheForGuild(invite.guild);
    } catch (e) {
      console.error("AI: InviteCreate handler error:", e);
    }
  });

  client.on(Events.InviteDelete, async (invite) => {
    try {
      if (!invite?.guild?.id) return;
      if (!guildAllowed(invite.guild.id)) return;
      const guild = invite.guild;
      if (guild) await refreshInviteCacheForGuild(guild);
    } catch (e) {
      console.error("AI: InviteDelete handler error:", e);
    }
  });

  // ---------- Button handler ----------
  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (!interaction.isButton()) return;
      if (interaction.customId !== AI.BTN_GET) return;

      if (!AI_READY) {
        await interaction
          .reply({
            content: "⚠️ Bot is restarting. Try again in ~10 seconds.",
            flags: MessageFlags.Ephemeral,
          })
          .catch(() => {});
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
      const guild = interaction.guild;

      if (!guild) {
        await interaction.editReply("⛔ This button only works in a server.").catch(() => {});
        return;
      }
      if (!guildAllowed(guild.id)) {
        await interaction.editReply("⛔ Wrong server.").catch(() => {});
        return;
      }

      const { url } = await getOrCreatePersonalInvite(guild, interaction.user);

      await interaction.editReply(
        [
          "✅ **Your personal invite link:**",
          url,
          "",
          "Copy-paste message:",
          `Join Kickz Caviar: ${url}`,
        ].join("\n")
      );
    } catch (e) {
      console.error("AI: Interaction handler error:", e);
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply("❌ Could not create your invite link. Ask staff.").catch(() => {});
        }
      } catch {}
    }
  });

  // ---------- Member join → detect used invite → log to Airtable ----------
  client.on(Events.GuildMemberAdd, async (member) => {
    try {
      const guild = member.guild;
      if (!guildAllowed(guild.id)) return;

      console.log("AI JOIN: fired", member.user.id, member.user.tag, "guild", guild.id);

      // Always log member join in Members table
      const inviteeMemberRec = await upsertMember(member.user.id, member.user.tag, {
        "Joined At": new Date().toISOString(),
      }).catch((e) => {
        console.error("AI JOIN: upsertMember(join) failed:", e);
        return null;
      });

      // OLD snapshot
      const oldUses = inviteCache.get(guild.id);
      console.log("AI JOIN: old snapshot?", !!oldUses, "size:", oldUses?.size ?? null);

      // NEW fetch
      const newInvites = await guild.invites.fetch().catch((e) => {
        console.error("AI JOIN: guild.invites.fetch failed", e);
        return null;
      });
      console.log("AI JOIN: newInvites?", !!newInvites, "size:", newInvites?.size ?? null);
      if (!newInvites) return;

      // NEW snapshot
      const newUses = new Map();
      for (const [code, inv] of newInvites) {
        newUses.set(code, Number(inv.uses || 0));
      }
      inviteCache.set(guild.id, newUses);

      if (!oldUses) {
        console.log("AI JOIN: no baseline snapshot yet -> cannot attribute this join (next will work).");
        return;
      }

      // Find invite with highest delta
      let usedInvite = null;
      let bestDelta = 0;

      for (const [, inv] of newInvites) {
        const oldU = Number(oldUses.get(inv.code) || 0);
        const newU = Number(inv.uses || 0);
        const delta = newU - oldU;

        if (delta > bestDelta) {
          bestDelta = delta;
          usedInvite = inv;
        }
      }

      console.log(
        "AI JOIN: delta best",
        bestDelta,
        "usedInvite",
        usedInvite?.code ?? null,
        "inviter",
        usedInvite?.inviter?.id ?? null
      );

      if (!usedInvite || bestDelta <= 0) return;

      // Map invite code -> owner from Airtable
      const ownerRec = await findMemberRecordByInviteCode(usedInvite.code);

      if (!ownerRec) {
        console.log("AI JOIN: No owner found in Airtable for invite code", usedInvite.code, "-> skipping");
        return;
      }

      const inviterId = normId(ownerRec.fields?.["Discord User ID"]);
      if (!inviterId) {
        console.log("AI JOIN: Owner record missing Discord User ID for invite code", usedInvite.code);
        return;
      }
      const inviteeId = normId(member.user.id);

      const inviterMemberRec = ownerRec;

      // Update invitee fields ONLY if empty
      const inviteeRec = await findMemberRecordByDiscordId(inviteeId);
      const already = inviteeRec?.fields?.["Invited By Discord User ID"];
      if (inviteeRec && !already) {
        const updatePayload = {
          "Invited By Discord User ID": inviterId,
          "Invite Code Used": usedInvite.code,
        };

        if (inviterMemberRec?.id && AIRTABLE_MEMBERS_LINK_INVITED_BY) {
          updatePayload[AIRTABLE_MEMBERS_LINK_INVITED_BY] = [inviterMemberRec.id];
        }

        await membersTable.update(inviteeRec.id, updatePayload).catch((e) => {
          console.error("AI JOIN: update invitee inviter fields failed:", e);
        });
      }

      // Create Invites Log row
      const logPayload = {
        "Invitee Discord User ID": inviteeId,
        "Inviter Discord User ID": inviterId,
        "Invite Code Used": usedInvite.code,
        "Joined At": new Date().toISOString(),
      };

      if (inviteeMemberRec?.id && AIRTABLE_INVITES_LINK_INVITEE) {
        logPayload[AIRTABLE_INVITES_LINK_INVITEE] = [inviteeMemberRec.id];
      }
      if (inviterMemberRec?.id && AIRTABLE_INVITES_LINK_INVITER) {
        logPayload[AIRTABLE_INVITES_LINK_INVITER] = [inviterMemberRec.id];
      }

      await invitesLogTable.create(logPayload).catch((e) => {
        console.error("AI JOIN: Invites Log create failed:", e);
      });

      console.log("AI JOIN: ✅ logged invite -> Inviter:", inviterId, "Invitee:", inviteeId);
    } catch (e) {
      console.error("AI: GuildMemberAdd error:", e);
    }
  });
}

module.exports = { registerAffiliateInvites };
