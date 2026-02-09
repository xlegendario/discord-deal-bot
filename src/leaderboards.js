const {
  EmbedBuilder,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");

function registerLeaderboards(ctx) {
  const { client, base, env } = ctx;

  const {
    AFFILIATE_GUILD_ID,
    AIRTABLE_MEMBERS_TABLE = "Discord Members",
    AIRTABLE_INVITES_LOG_TABLE = "Invites Log",

    LEADERBOARD_CHANNEL_ID,
    WINNERS_CHANNEL_ID,
    INFO_CHANNEL_ID,
    INFO_PIN_MESSAGE = "true",

    LEADERBOARD_TOP_N = "10",
    REFERRAL_QUALIFIED_FIELD = "Referral Qualified",
    REFERRAL_FEE_EUR = "5",
    DISCORD_TOKEN,

    // Carryover config
    AFFILIATE_LAUNCH_AT, // e.g. 2026-01-28T00:00:00+01:00
    AFFILIATE_CARRYOVER_TO_MONTH, // e.g. 2026-02
  } = env;

  if (!LEADERBOARD_CHANNEL_ID || !WINNERS_CHANNEL_ID) {
    console.warn("⚠️ Leaderboards disabled: missing channel IDs.");
    return;
  }

  const membersTable = base(AIRTABLE_MEMBERS_TABLE);
  const invitesLogTable = base(AIRTABLE_INVITES_LOG_TABLE);

  const TOP_N = Math.max(3, Math.min(25, parseInt(LEADERBOARD_TOP_N, 10) || 10));
  const FEE = Number(REFERRAL_FEE_EUR) || 5;

  const nameCache = new Map();

  const escape = (v) => String(v || "").replace(/'/g, "\\'");
  const norm = (v) => String(v || "").trim();

  // YYYY-MM in Amsterdam time
  function monthKeyAmsterdam(date = new Date()) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Amsterdam",
      year: "numeric",
      month: "2-digit",
    }).format(date);
  }

  function prevMonthKey(yyyyMm) {
    const [y, m] = yyyyMm.split("-").map(Number);
    const d = new Date(Date.UTC(y, m - 1, 1));
    d.setUTCMonth(d.getUTCMonth() - 1);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  }

  function monthFilterFormula(monthKey) {
    let baseFormula = `{Month Key}='${escape(monthKey)}'`;

    if (
      AFFILIATE_CARRYOVER_TO_MONTH &&
      AFFILIATE_LAUNCH_AT &&
      monthKey === String(AFFILIATE_CARRYOVER_TO_MONTH).trim()
    ) {
      const prev = prevMonthKey(monthKey);
      baseFormula = `OR(
        {Month Key}='${escape(monthKey)}',
        AND(
          {Month Key}='${escape(prev)}',
          IS_AFTER({Joined At}, DATETIME_PARSE('${AFFILIATE_LAUNCH_AT}'))
        )
      )`;
    }

    return baseFormula;
  }

  async function getDiscordUsername(discordId) {
    const id = norm(discordId);
    if (!id) return "Unknown";
    if (nameCache.has(id)) return nameCache.get(id);

    const rows = await membersTable
      .select({
        maxRecords: 1,
        filterByFormula: `{Discord User ID}='${escape(id)}'`,
      })
      .firstPage()
      .catch(() => []);

    const name = rows?.[0]?.fields?.["Discord Username"] || `User ${id.slice(-4)}`;
    nameCache.set(id, name);
    return name;
  }

  // ---- table formatting ----
  function clampName(name, max = 18) {
    const s = String(name || "");
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
  }

  function formatTable(headers, rows, col1Width = 18) {
    const h1 = String(headers[0]).padEnd(col1Width);
    const h2 = String(headers[1]);
    const sep = "─".repeat(col1Width + h2.length);

    const body = rows.map(([a, b]) => {
      const c1 = clampName(a, col1Width).padEnd(col1Width);
      return c1 + String(b);
    });

    return "```" + [h1 + h2, sep, ...body].join("\n") + "```";
  }

  async function fetchInviteRowsForMonth(monthKey) {
    return (
      (await invitesLogTable
        .select({
          filterByFormula: monthFilterFormula(monthKey),
          fields: ["Inviter Discord User ID", REFERRAL_QUALIFIED_FIELD],
        })
        .all()
        .catch(() => [])) || []
    );
  }

  async function findOrCreatePinnedLeaderboardMessage(channel) {
    const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
    const existing = recent?.find(
      (m) => m.author?.id === client.user.id && m.embeds?.[0]?.title?.startsWith("🏆 LEADERBOARD —")
    );

    if (existing) {
      if (!existing.pinned) await existing.pin().catch(() => {});
      return existing;
    }

    const msg = await channel.send({ content: "🏆 Leaderboard initializing..." });
    await msg.pin().catch(() => {});
    return msg;
  }

  async function ensureLeaderboardInfoMessage() {
    if (!INFO_CHANNEL_ID) return;

    const ch = await client.channels.fetch(String(INFO_CHANNEL_ID)).catch(() => null);
    if (!ch || !ch.isTextBased()) {
      console.warn("⚠️ INFO_CHANNEL_ID is not a text channel.");
      return;
    }

    const SHOULD_PIN = String(INFO_PIN_MESSAGE).toLowerCase() === "true";
    const TITLE = "ℹ️ Leaderboards & Affiliate Rewards — How It Works";

    const embed = new EmbedBuilder()
      .setTitle(TITLE)
      .setColor(0xffd300)
      .setDescription(
        [
          "Two leaderboards are tracked each month:",
          "",
          "🔥 **Top Inviters**",
          "• Ranked by total invites into the server (via your personal invite link)",
          `• Top ${TOP_N} are displayed on the leaderboard`,
          "• **Top 3** receive prizes:",
          "",
          "🥇 - €100",
          "🥈 - €50",
          "🥉 - €25",
          "",
          "💰 **Top Affiliates**",
          "• Ranked by **qualified referrals** (invited members who complete their **first deal**)",
          `• Earnings = **€${FEE}** per qualified referral`,
          `• Top ${TOP_N} are displayed on the leaderboard`,
          "",
          "**How do I get my invite link?**",
          `• Go to <#${env.AFFILIATE_CHANNEL_ID}> and click **Get my Invite URL**`,
          "",
          "**When does a referral become qualified?**",
          "• When your invited member completes their **first deal**",
          "",
          "**When do I get paid?**",
          "• Earnings are calculated monthly",
          "• You receive a monthly DM summary after month end",
          "• Payouts are handled by admins",
          "",
          "**How do I see my stats if I'm not in the leaderboards?**",
          "• Use the **/mystats** command in any channel",
          "",
          ...(AFFILIATE_CARRYOVER_TO_MONTH && AFFILIATE_LAUNCH_AT
            ? [
                "**Launch carryover**",
                `• Invites after **${AFFILIATE_LAUNCH_AT}** will count towards **${AFFILIATE_CARRYOVER_TO_MONTH}**`,
                "",
              ]
            : []),
          "**Important**",
          "• Abuse/spam/fake accounts may result in removal from the program",
        ].join("\n")
      )
      .setFooter({ text: "Payout by Kickz Caviar" });

    const recent = await ch.messages.fetch({ limit: 25 }).catch(() => null);
    const existing = recent?.find((m) => m.author?.id === client.user.id && m.embeds?.[0]?.title === TITLE);

    if (existing) {
      await existing.edit({ embeds: [embed], content: null }).catch(() => {});
      if (SHOULD_PIN && !existing.pinned) await existing.pin().catch(() => {});
      return;
    }

    const msg = await ch.send({ embeds: [embed] }).catch(() => null);
    if (msg && SHOULD_PIN) await msg.pin().catch(() => {});
  }

  async function buildLeaderboardsForMonth(monthKey) {
    const rows = await fetchInviteRowsForMonth(monthKey);

    const inviteCounts = new Map();
    const qualifiedCounts = new Map();

    for (const r of rows) {
      const inviterId = norm(r.fields?.["Inviter Discord User ID"]);
      if (!inviterId) continue;

      inviteCounts.set(inviterId, (inviteCounts.get(inviterId) || 0) + 1);

      if (r.fields?.[REFERRAL_QUALIFIED_FIELD]) {
        qualifiedCounts.set(inviterId, (qualifiedCounts.get(inviterId) || 0) + 1);
      }
    }

    const topInvites = [...inviteCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_N);

    const topAffiliates = [...qualifiedCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_N);

    const inviteRows = [];
    for (const [id, c] of topInvites) inviteRows.push([await getDiscordUsername(id), String(c)]);

    const affiliateRows = [];
    for (const [id, q] of topAffiliates) affiliateRows.push([await getDiscordUsername(id), `€${q * FEE}`]);

    const inviteTable =
      inviteRows.length > 0 ? formatTable(["User", "Invites"], inviteRows) : "No invites yet this month.";

    const affiliateTable =
      affiliateRows.length > 0
        ? formatTable(["User", "Total Earnings"], affiliateRows)
        : "No qualified referrals yet.";

    return { inviteTable, affiliateTable };
  }

  async function sendMonthlyEarningsDMs(monthKey) {
    const rows = await invitesLogTable
      .select({
        filterByFormula: `AND(
          ${monthFilterFormula(monthKey)},
          {${escape(REFERRAL_QUALIFIED_FIELD)}}=TRUE()
        )`,
        fields: ["Inviter Discord User ID"],
      })
      .all()
      .catch(() => []);

    const counts = new Map();
    for (const r of rows) {
      const id = norm(r.fields?.["Inviter Discord User ID"]);
      if (!id) continue;
      counts.set(id, (counts.get(id) || 0) + 1);
    }

    for (const [inviterId, q] of counts.entries()) {
      const rec = (
        await membersTable
          .select({
            maxRecords: 1,
            filterByFormula: `{Discord User ID}='${escape(inviterId)}'`,
            fields: ["Last Earnings DM Month", "Discord Username"],
          })
          .firstPage()
          .catch(() => [])
      )?.[0];

      if (!rec || rec.fields?.["Last Earnings DM Month"] === monthKey) continue;

      const user = await client.users.fetch(inviterId).catch(() => null);
      if (!user) continue;

      const embed = new EmbedBuilder()
        .setTitle(`💰 Affiliate Summary — ${monthKey}`)
        .setColor(0x00c389)
        .setDescription(
          `You earned **€${q * FEE}** from **${q} qualified referrals**.\n\nThanks for helping grow Payout by Kickz Caviar 🤝`
        );

      const sent = await user.send({ embeds: [embed] }).then(() => true).catch(() => false);
      if (!sent) continue;

      await membersTable.update(rec.id, { "Last Earnings DM Month": monthKey }).catch(() => {});
    }
  }

  // ---- /mystats ----
  async function computeUserStats(userId, monthKey) {
    const id = norm(userId);

    const rows = await invitesLogTable
      .select({
        filterByFormula: monthFilterFormula(monthKey),
        fields: ["Inviter Discord User ID", REFERRAL_QUALIFIED_FIELD],
      })
      .all()
      .catch(() => []);

    let invites = 0;
    let qualified = 0;

    for (const r of rows) {
      const inviterId = norm(r.fields?.["Inviter Discord User ID"]);
      if (inviterId !== id) continue;
      invites++;
      if (r.fields?.[REFERRAL_QUALIFIED_FIELD]) qualified++;
    }

    return { invites, qualified, earned: qualified * FEE };
  }

  async function computeUserAllTime(userId) {
    const id = norm(userId);

    const rows = await invitesLogTable
      .select({
        filterByFormula: `{Inviter Discord User ID}='${escape(id)}'`,
        fields: [REFERRAL_QUALIFIED_FIELD],
      })
      .all()
      .catch(() => []);

    let invites = rows.length;
    let qualified = 0;
    for (const r of rows) if (r.fields?.[REFERRAL_QUALIFIED_FIELD]) qualified++;

    return { invites, qualified, earned: qualified * FEE };
  }

  async function registerMyStatsCommand() {
    if (!DISCORD_TOKEN) {
      console.warn("⚠️ /mystats not registered: DISCORD_TOKEN missing in env.");
      return;
    }
    if (!AFFILIATE_GUILD_ID) {
      console.warn("⚠️ /mystats not registered: AFFILIATE_GUILD_ID missing in env.");
      return;
    }

    const cmd = new SlashCommandBuilder()
      .setName("mystats")
      .setDescription("View your affiliate stats (this month / last month / all-time).");

    const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

    await rest.put(
      Routes.applicationGuildCommands(client.user.id, String(AFFILIATE_GUILD_ID)),
      { body: [cmd.toJSON()] }
    );

    console.log("✅ /mystats command registered");
  }

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "mystats") return;

    await interaction.deferReply({ ephemeral: true }).catch(() => {});

    const nowMonth = monthKeyAmsterdam();
    const lastMonth = prevMonthKey(nowMonth);

    const thisM = await computeUserStats(interaction.user.id, nowMonth);
    const lastM = await computeUserStats(interaction.user.id, lastMonth);
    const allT = await computeUserAllTime(interaction.user.id);

    const embed = new EmbedBuilder()
      .setTitle("📈 Your Affiliate Stats")
      .setColor(0xffd300)
      .addFields(
        {
          name: `This Month — ${nowMonth}`,
          value: `Invites: **${thisM.invites}**\nQualified: **${thisM.qualified}**\nEarned: **€${thisM.earned}**`,
          inline: false,
        },
        {
          name: `Last Month — ${lastMonth}`,
          value: `Invites: **${lastM.invites}**\nQualified: **${lastM.qualified}**\nEarned: **€${lastM.earned}**`,
          inline: false,
        },
        {
          name: "All-time",
          value: `Invites: **${allT.invites}**\nQualified: **${allT.qualified}**\nEarned: **€${allT.earned}**`,
          inline: false,
        }
      );

    await interaction.editReply({ embeds: [embed] }).catch(() => {});
  });

  let currentMonth = null;

  async function tick() {
    try {
      if (AFFILIATE_GUILD_ID && !client.guilds.cache.get(String(AFFILIATE_GUILD_ID))) return;

      const lbChannel = await client.channels.fetch(LEADERBOARD_CHANNEL_ID).catch(() => null);
      const winnersChannel = await client.channels.fetch(WINNERS_CHANNEL_ID).catch(() => null);
      if (!lbChannel?.isTextBased() || !winnersChannel?.isTextBased()) return;

      const nowMonth = monthKeyAmsterdam();

      if (currentMonth && currentMonth !== nowMonth) {
        const prev = prevMonthKey(nowMonth);
        const data = await buildLeaderboardsForMonth(prev);

        const finalEmbed = new EmbedBuilder()
          .setTitle(`🏁 FINAL RESULTS — ${prev}`)
          .addFields(
            { name: "🔥 Top Inviters", value: data.inviteTable },
            { name: "💰 Top Affiliates", value: data.affiliateTable }
          );

        const isEmptyMonth =
          data.inviteTable.includes("No invites yet") && data.affiliateTable.includes("No qualified");
        if (!isEmptyMonth) {
          await winnersChannel.send({ embeds: [finalEmbed] }).catch(() => {});
          await sendMonthlyEarningsDMs(prev);
        } else {
          console.log(`LB: ${prev} had no data, skipping winners post & DMs`);
        }
      }

      currentMonth = nowMonth;

      const data = await buildLeaderboardsForMonth(nowMonth);

      const embed = new EmbedBuilder()
        .setTitle(`🏆 LEADERBOARD — ${nowMonth}`)
        .addFields(
          { name: "🔥 Top Inviters", value: data.inviteTable },
          { name: "💰 Top Affiliates", value: data.affiliateTable }
        );

      const msg = await findOrCreatePinnedLeaderboardMessage(lbChannel);
      await msg.edit({ content: null, embeds: [embed] });
    } catch (e) {
      console.error("LB tick error:", e);
    }
  }

  client.once(Events.ClientReady, async () => {
    console.log("✅ Leaderboards module ready.");
    await registerMyStatsCommand().catch((e) => console.error("LB: command reg failed", e));
    await ensureLeaderboardInfoMessage();
    await tick();
    setInterval(tick, 10 * 60 * 1000);
  });
}

module.exports = { registerLeaderboards };
