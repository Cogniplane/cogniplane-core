/**
 * seed-dev-data.ts
 *
 * Inserts realistic dummy token-usage data for local dashboard development.
 * Safe to re-run: every insert is idempotent (ON CONFLICT DO NOTHING or
 * WHERE NOT EXISTS).
 *
 * Creates:
 *   - 3 dummy users in local-dev-tenant
 *   - 1–2 sessions per user
 *   - ~90 days of assistant messages with token usage + cost spread across
 *     3 models, with plausible weekly / daily rhythms
 */

import { loadConfig } from "../config.js";
import { createDatabase } from "../lib/db.js";

const TENANT_ID = "local-dev-tenant";

const USERS = [
  { userId: "dev-user-alice", email: "alice@example.com", displayName: "Alice Dupont" },
  { userId: "dev-user-bob",   email: "bob@example.com",   displayName: "Bob Martin"  },
  { userId: "dev-user-charlie", email: "charlie@example.com", displayName: "Charlie Kim" }
];

const MODELS = [
  // name, input $/1M tok, output $/1M tok, typical turn size range [min,max]
  { name: "claude-sonnet-4-6",   inputRate: 3.0,  outputRate: 15.0, minIn: 800,  maxIn: 4000, minOut: 200, maxOut: 1200 },
  { name: "claude-opus-4-6",     inputRate: 15.0, outputRate: 75.0, minIn: 1200, maxIn: 6000, minOut: 400, maxOut: 2000 },
  { name: "claude-haiku-4-5",    inputRate: 0.8,  outputRate: 4.0,  minIn: 400,  maxIn: 2000, minOut: 100, maxOut: 600  }
];

// --- deterministic-ish pseudo-random (no external deps) ---

let seed = 0xdeadbeef;
function rand(): number {
  seed = (seed ^ (seed << 13)) >>> 0;
  seed = (seed ^ (seed >> 17)) >>> 0;
  seed = (seed ^ (seed << 5))  >>> 0;
  return seed / 0xffffffff;
}
function randInt(min: number, max: number): number {
  return Math.floor(rand() * (max - min + 1)) + min;
}
function calcCost(
  model: (typeof MODELS)[number],
  inputTokens: number,
  outputTokens: number
): number {
  return (inputTokens / 1_000_000) * model.inputRate +
         (outputTokens / 1_000_000) * model.outputRate;
}

const config = loadConfig();
// Seed inserts touch multiple tenants and bypass RLS — use the superuser
// connection exactly as migrate.ts does.
const seedConfig = process.env.MIGRATION_DATABASE_URL
  ? { ...config, DATABASE_URL: process.env.MIGRATION_DATABASE_URL }
  : config;
const db = createDatabase(seedConfig);

async function run() {
  // 1. Ensure users exist
  for (const user of USERS) {
    await db.query(
      `INSERT INTO users (user_id, email, display_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO NOTHING`,
      [user.userId, user.email, user.displayName]
    );
    await db.query(
      `INSERT INTO tenant_memberships (tenant_id, user_id, role)
       VALUES ($1, $2, 'member')
       ON CONFLICT (tenant_id, user_id) DO NOTHING`,
      [TENANT_ID, user.userId]
    );
  }
  console.log(`Ensured ${USERS.length} users.`);

  // 2. Create 1–2 sessions per user
  const sessions: Array<{ sessionId: string; userId: string }> = [];
  for (const user of USERS) {
    const count = user.userId === "dev-user-alice" ? 2 : 1;
    for (let i = 0; i < count; i++) {
      const sessionId = `dev-session-${user.userId.slice(9)}-${i}`;
      await db.query(
        `INSERT INTO sessions (session_id, tenant_id, user_id, session_name, status)
         VALUES ($1, $2, $3, $4, 'active')
         ON CONFLICT (session_id) DO NOTHING`,
        [sessionId, TENANT_ID, user.userId, `Dev session ${i + 1}`]
      );
      sessions.push({ sessionId, userId: user.userId });
    }
  }
  console.log(`Ensured ${sessions.length} sessions.`);

  // 3. Generate messages spanning 90 days
  const now = new Date();
  const DAYS = 90;

  // Per-user, per-day activity probability weights (0–1).
  // Alice is heavy, Bob medium, Charlie lighter but spiky.
  const activityWeight: Record<string, number> = {
    "dev-user-alice":   0.85,
    "dev-user-bob":     0.55,
    "dev-user-charlie": 0.40
  };

  // Model preference weights per user (index into MODELS)
  const modelPref: Record<string, number[]> = {
    "dev-user-alice":   [0.5, 0.35, 0.15],  // mostly sonnet, some opus
    "dev-user-bob":     [0.3, 0.1, 0.6],    // heavy haiku user
    "dev-user-charlie": [0.4, 0.5, 0.1]     // mostly opus
  };

  let inserted = 0;

  for (let day = DAYS - 1; day >= 0; day--) {
    const dayDate = new Date(now);
    dayDate.setDate(dayDate.getDate() - day);
    const dayOfWeek = dayDate.getDay(); // 0=Sun, 6=Sat
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

    for (const session of sessions) {
      const { userId, sessionId } = session;
      const baseWeight = activityWeight[userId] ?? 0.5;
      // Weekends are quieter
      const weight = isWeekend ? baseWeight * 0.3 : baseWeight;

      // Number of turns this day (0 if inactive)
      if (rand() > weight) continue;
      const turns = randInt(1, isWeekend ? 3 : 8);

      const prefs = modelPref[userId] ?? [0.33, 0.33, 0.34];

      for (let t = 0; t < turns; t++) {
        // Pick model via weighted random
        const r = rand();
        let modelIdx = 0;
        let cumulative = 0;
        for (let m = 0; m < MODELS.length; m++) {
          cumulative += prefs[m];
          if (r < cumulative) { modelIdx = m; break; }
        }
        const model = MODELS[modelIdx];

        const inputTokens  = randInt(model.minIn,  model.maxIn);
        const outputTokens = randInt(model.minOut, model.maxOut);
        const cachedInput  = randInt(0, Math.floor(inputTokens * 0.3));
        const totalTokens  = inputTokens + outputTokens;
        const costUsd      = calcCost(model, inputTokens, outputTokens);

        // Spread turns through the working day (8am–10pm UTC)
        const hourOffset = randInt(8, 22);
        const minOffset  = randInt(0, 59);
        const msgDate    = new Date(dayDate);
        msgDate.setUTCHours(hourOffset, minOffset, randInt(0, 59), 0);

        const messageId = `dev-msg-${day}-${userId.slice(-4)}-${t}-${modelIdx}`;

        // Insert user turn (no tokens)
        const userMsgId = `dev-usr-${day}-${userId.slice(-4)}-${t}-${modelIdx}`;
        await db.query(
          `INSERT INTO messages
             (message_id, tenant_id, session_id, user_id, role, status, content_text, created_at, updated_at)
           VALUES ($1,$2,$3,$4,'user','completed','What can you help me with today?',$5,$5)
           ON CONFLICT (message_id) DO NOTHING`,
          [userMsgId, TENANT_ID, sessionId, userId, msgDate.toISOString()]
        );

        // Insert assistant turn with token data. ~30% of turns carry a
        // feedback rating (mostly positive) so the message-feedback dashboard
        // renders populated. feedback_given_at is set whenever a rating is.
        const ratingRoll = rand();
        const feedbackRating =
          ratingRoll < 0.22 ? "thumbs_up" : ratingRoll < 0.3 ? "thumbs_down" : null;
        const feedbackNotes =
          feedbackRating === "thumbs_down" ? "Response missed the point of my question." : null;
        const asstDate = new Date(msgDate.getTime() + randInt(2000, 15000));
        const feedbackGivenAt = feedbackRating
          ? new Date(asstDate.getTime() + randInt(20_000, 600_000)).toISOString()
          : null;
        await db.query(
          `INSERT INTO messages
             (message_id, tenant_id, session_id, user_id, role, status, content_text,
              input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens,
              model_name, cost_usd,
              feedback_rating, feedback_notes, feedback_given_at,
              created_at, updated_at)
           VALUES ($1,$2,$3,$4,'assistant','completed','Here is my response.',
                   $5,$6,$7,$8,$9,$10,$11,$13,$14,$15,$12,$12)
           ON CONFLICT (message_id) DO NOTHING`,
          [
            messageId, TENANT_ID, sessionId, userId,
            inputTokens, cachedInput, outputTokens, 0, totalTokens,
            model.name, costUsd,
            asstDate.toISOString(),
            feedbackRating, feedbackNotes, feedbackGivenAt
          ]
        );

        inserted++;
      }
    }
  }

  console.log(`Inserted up to ${inserted} assistant messages (skipped existing).`);

  // 4. PII scan runs — populate the PII activity dashboard (donut breakdowns,
  //    stacked time-series, top offenders, recent activity). Concentrated in
  //    the last 30 days so the default 7d/30d ranges render data. Each run
  //    carries findings_json with entityType + confidence so the "by entity"
  //    and "by confidence" charts populate.
  const PII_ENTITIES = ["email", "phone", "ssn", "credit_card", "ip_address", "person_name"];
  const PII_CONFIDENCES = ["high", "medium", "low"] as const;
  // action_taken drives the time-series + action breakdown. Weighted toward
  // allow/report (the common case), with a realistic minority of block/transform.
  const PII_ACTIONS: Array<{ action: string; status: string; weight: number }> = [
    { action: "allow",     status: "completed",   weight: 0.5 },
    { action: "report",    status: "completed",   weight: 0.25 },
    { action: "block",     status: "blocked",     weight: 0.1 },
    { action: "transform", status: "transformed", weight: 0.1 },
    { action: "failed",    status: "failed",      weight: 0.05 } // action_taken NULL when failed
  ];

  let piiInserted = 0;
  const PII_DAYS = 30;
  for (let day = PII_DAYS - 1; day >= 0; day--) {
    const dayDate = new Date(now);
    dayDate.setDate(dayDate.getDate() - day);
    const dayOfWeek = dayDate.getDay();
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    // A few scans per active day; quieter on weekends.
    const scans = isWeekend ? randInt(0, 2) : randInt(1, 5);

    for (let s = 0; s < scans; s++) {
      const session = sessions[randInt(0, sessions.length - 1)];
      const { userId, sessionId } = session;

      // Weighted action pick.
      const r = rand();
      let cumulative = 0;
      let picked = PII_ACTIONS[0];
      for (const a of PII_ACTIONS) {
        cumulative += a.weight;
        if (r < cumulative) { picked = a; break; }
      }
      const isFailed = picked.action === "failed";
      const subjectType = rand() < 0.8 ? "message" : "artifact";

      // Build 0–3 findings (failed scans have none).
      const findingCount = isFailed ? 0 : randInt(picked.action === "allow" ? 0 : 1, 3);
      const findings = Array.from({ length: findingCount }, () => ({
        entityType: PII_ENTITIES[randInt(0, PII_ENTITIES.length - 1)],
        confidence: PII_CONFIDENCES[randInt(0, PII_CONFIDENCES.length - 1)],
        excerpt: "[redacted]"
      }));

      const hourOffset = randInt(8, 22);
      const scanDate = new Date(dayDate);
      scanDate.setUTCHours(hourOffset, randInt(0, 59), randInt(0, 59), 0);
      const scanRunId = `dev-pii-${day}-${s}-${userId.slice(-4)}`;

      await db.query(
        `INSERT INTO pii_scan_runs
           (tenant_id, scan_run_id, subject_type, subject_id, source_session_id, source_user_id,
            mode, provider_type, provider_model, status, findings_json, action_taken,
            summary_text, error_message, created_at, updated_at, completed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'rule-based','dev-seed',$8,$9::jsonb,$10,$11,$12,$13,$13,$14)
         ON CONFLICT (scan_run_id) DO NOTHING`,
        [
          TENANT_ID,
          scanRunId,
          subjectType,
          `${subjectType}-${scanRunId}`,
          sessionId,
          userId,
          // mode column: map action to scan mode (failed -> detect attempt).
          picked.action === "block" ? "block" : picked.action === "transform" ? "transform" : "detect",
          picked.status,
          JSON.stringify(findings),
          isFailed ? null : picked.action,
          isFailed ? null : `${findingCount} finding(s) detected`,
          isFailed ? "provider timeout" : null,
          scanDate.toISOString(),
          isFailed ? null : new Date(scanDate.getTime() + randInt(200, 3000)).toISOString()
        ]
      );
      piiInserted++;
    }
  }
  console.log(`Inserted up to ${piiInserted} PII scan runs (skipped existing).`);
  console.log("Done. Run the token-usage / message-feedback / PII dashboards to see results.");
}

try {
  await run();
} finally {
  await db.end();
}
