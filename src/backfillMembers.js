const { Events } = require("discord.js");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function escapeAirtableValue(v) {
  return String(v || "").replace(/'/g, "\\'");
}

function normId(v) {
  return String(v || "").trim();
}

/**
 * Backfill Discord Members table with all current members in a guild.
 *
 * Env required:
 * - AFFILIATE_GUILD_ID
 * - AIRTABLE_MEMBERS_TABLE (default: "Discord Members")
 * - AFFILIATE_BACKFILL_MEMBERS ("true" to run)
 *
 * Optional:
 * - BACKFILL_BATCH_SIZE (default 10)  // Airtable batch create/update (max 10)
 * - BACKFILL_DELAY_MS (default 250)   // delay between Airtable batches
 */
function registerMembersBackfill(ctx) {
  const { client, base, env } = ctx;

  const {
    AFFILIATE_GUILD_ID,
    AIRTABLE_MEMBERS_TABLE = "Discord Members",
    AFFILIATE_BACKFILL_MEMBERS = "false",
    BACKFILL_BATCH_SIZE = "10",
    BACKFILL_DELAY_MS = "250",
  } = env;

  if (String(AFFILIATE_BACKFILL_MEMBERS).toLowerCase() !== "true") {
    return; // disabled
  }
  if (!AFFILIATE_GUILD_ID) {
    console.warn("⚠️ Backfill disabled: AFFILIATE_GUILD_ID missing.");
    return;
  }

  const membersTable = base(AIRTABLE_MEMBERS_TABLE);

  async function findMemberRecordByDiscordId(discordId) {
    const id = normId(discordId);
    const rows = await membersTable
      .select({
        maxRecords: 1,
        filterByFormula: `{Discord User ID}='${escapeAirtableValue(id)}'`,
      })
      .firstPage()
      .catch(() => []);
    return rows?.[0] || null;
  }

  async function upsertBatch(payloads) {
    // Airtable API supports max 10 records per create/update call
    // We'll split into creates/updates with the record id known.
    const toCreate = [];
    const toUpdate = [];

    for (const p of payloads) {
      const existing = await findMemberRecordByDiscordId(p.fields["Discord User ID"]);
      if (existing) {
        toUpdate.push({ id: existing.id, fields: p.fields });
      } else {
        toCreate.push(p);
      }
    }

    // Create in chunks of 10
    for (let i = 0; i < toCreate.length; i += 10) {
      const chunk = toCreate.slice(i, i + 10);
      await membersTable.create(chunk).catch((e) => {
        console.error("Backfill: Airtable create chunk failed:", e);
      });
      await sleep(Number(BACKFILL_DELAY_MS) || 250);
    }

    // Update in chunks of 10
    for (let i = 0; i < toUpdate.length; i += 10) {
      const chunk = toUpdate.slice(i, i + 10);
      await membersTable.update(chunk).catch((e) => {
        console.error("Backfill: Airtable update chunk failed:", e);
      });
      await sleep(Number(BACKFILL_DELAY_MS) || 250);
    }
  }

  client.once(Events.ClientReady, async () => {
    try {
      const guild = await client.guilds.fetch(String(AFFILIATE_GUILD_ID)).catch(() => null);
      if (!guild) {
        console.warn("⚠️ Backfill: guild not found for AFFILIATE_GUILD_ID");
        return;
      }

      console.log("🧩 Backfill: fetching all members from guild…");

      // This requires Server Members Intent enabled in the Discord Developer Portal.
      // For large guilds this may take time but is the most reliable.
      await guild.members.fetch().catch((e) => {
        console.error("Backfill: guild.members.fetch failed (check Server Members Intent):", e);
        throw e;
      });

      const members = [...guild.members.cache.values()];
      console.log(`🧩 Backfill: fetched ${members.length} members. Writing to Airtable…`);

      const batchSize = Math.max(1, Math.min(10, parseInt(BACKFILL_BATCH_SIZE, 10) || 10));

      let processed = 0;

      for (let i = 0; i < members.length; i += batchSize) {
        const chunk = members.slice(i, i + batchSize);

        const payloads = chunk.map((m) => {
          const userId = m.user?.id;
          const tag = m.user?.tag || `${m.user?.username || ""}`; // tag may be undefined depending on discord.js version
          const displayName = m.displayName || "";

          return {
            fields: {
              "Discord User ID": String(userId),
              "Discord Username": String(tag),
              "Discord Display Name": String(displayName),
            },
          };
        });

        await upsertBatch(payloads);
        processed += chunk.length;

        if (processed % 100 === 0) {
          console.log(`🧩 Backfill progress: ${processed}/${members.length}`);
        }
      }

      console.log("✅ Backfill complete. IMPORTANT: set AFFILIATE_BACKFILL_MEMBERS=false in Render env.");
    } catch (e) {
      console.error("❌ Backfill failed:", e);
    }
  });
}

module.exports = { registerMembersBackfill };
