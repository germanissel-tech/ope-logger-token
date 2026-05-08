"use strict";
require('dotenv').config();

const express = require("express");
const cors = require("cors");
const Database = require("better-sqlite3");
const { v4: uuid } = require("uuid");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const winston = require("winston");

const app = express(); // <--- DEFINICIÓN DE app

const PORT = process.env.PORT || 3001;
const API_KEY = process.env.API_KEY || "changeme";
const CACHE_TTL = parseInt(process.env.CACHE_TTL) || 300000;

// Logging
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.File({ filename: "logs/ope.log" }),
    new winston.transports.Console({ format: winston.format.simple() })
  ]
});

const DB_PATH = process.env.DB_PATH || (fs.existsSync("/data") ? "/data/ope.db" : path.join(__dirname, "ope.db"));
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

// Esquema completo (incluye todas las tablas)
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    user_id TEXT,
    variant TEXT NOT NULL DEFAULT 'A',
    started_at INTEGER NOT NULL,
    device TEXT DEFAULT 'unknown',
    traffic_source TEXT DEFAULT 'direct',
    user_return_risk TEXT DEFAULT 'low'
  );

  CREATE TABLE IF NOT EXISTS actions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    store_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    action TEXT NOT NULL,
    propensity REAL NOT NULL,
    features_scroll REAL NOT NULL,
    features_cart INTEGER NOT NULL,
    features_time INTEGER NOT NULL,
    features_rage INTEGER NOT NULL,
    mental_state TEXT NOT NULL,
    context_product_id TEXT,
    context_category TEXT,
    context_price REAL,
    context_page_type TEXT,
    context_position INTEGER,
    return_risk_signals TEXT,
    commercial_moment TEXT DEFAULT 'EARLY_BROWSING',
    intent_score REAL DEFAULT 0,
    message_id TEXT
  );

  CREATE TABLE IF NOT EXISTS outcomes (
    session_id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    converted INTEGER DEFAULT 0,
    conversion_step_index INTEGER,
    revenue REAL DEFAULT 0,
    last_action_id TEXT,
    time_to_convert INTEGER,
    recorded_at INTEGER NOT NULL,
    returned INTEGER DEFAULT 0,
    return_reason TEXT,
    return_category TEXT,
    return_timestamp INTEGER,
    abandoned_cart INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS returns (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    order_id TEXT,
    user_id TEXT,
    store_id TEXT NOT NULL,
    returned INTEGER DEFAULT 0,
    return_reason TEXT,
    return_category TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS message_templates (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    category TEXT,
    subtype TEXT,
    commercial_moment TEXT,
    action TEXT,
    message_text TEXT,
    version INTEGER DEFAULT 1,
    created_at INTEGER,
    active BOOLEAN DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS message_performance (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    action_id TEXT NOT NULL,
    reward_net REAL,
    converted INTEGER,
    returned INTEGER,
    recorded_at INTEGER,
    FOREIGN KEY (message_id) REFERENCES message_templates(id)
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_store ON sessions(store_id, started_at);
  CREATE INDEX IF NOT EXISTS idx_actions_session ON actions(session_id);
  CREATE INDEX IF NOT EXISTS idx_actions_store ON actions(store_id, ts);
  CREATE INDEX IF NOT EXISTS idx_outcomes_store ON outcomes(store_id, recorded_at);
  CREATE INDEX IF NOT EXISTS idx_returns_session ON returns(session_id);
  CREATE INDEX IF NOT EXISTS idx_actions_message ON actions(message_id);
  CREATE INDEX IF NOT EXISTS idx_actions_commercial ON actions(commercial_moment);
  CREATE INDEX IF NOT EXISTS idx_actions_intent ON actions(intent_score);
`);

// Migraciones
try { db.exec(`ALTER TABLE outcomes ADD COLUMN abandoned_cart INTEGER DEFAULT 0;`); } catch(_) {}
try { db.exec(`ALTER TABLE actions ADD COLUMN intent_score REAL DEFAULT 0;`); } catch(_) {}
try { db.exec(`ALTER TABLE actions ADD COLUMN commercial_moment TEXT DEFAULT 'EARLY_BROWSING';`); } catch(_) {}
try { db.exec(`ALTER TABLE outcomes ADD COLUMN conversion_step_index INTEGER;`); } catch(_) {}
try { db.exec(`ALTER TABLE actions ADD COLUMN message_id TEXT;`); } catch(_) {}

app.use(cors({ origin: "*", methods: ["GET","POST","OPTIONS"] }));
app.options("*", cors());
app.use(express.json({ limit: "50kb" }));

const now = () => Date.now();
const safe = (s, n = 128) => typeof s === "string" ? s.slice(0, n).replace(/[^\w\-_. ]/g, "") : "";
function escapeHtml(str) { return String(str).replace(/[&<>]/g, m => ({ '&':'&amp;','<':'&lt;','>':'&gt;' }[m])); }

// Rate limit simple
const rl = new Map();
function rateLimit(req, res, max = 5000, windowMs = 60000) {
  const ip = req.ip || "x";
  const n = Date.now();
  const e = rl.get(ip);
  if (!e || n > e.r) { rl.set(ip, { c: 1, r: n + windowMs }); return false; }
  if (++e.c > max) { res.status(429).json({ error: "Too many requests" }); return true; }
  return false;
}
setInterval(() => { const n = Date.now(); rl.forEach((v,k) => { if (n > v.r) rl.delete(k); }); }, 300000);

// Middleware de autenticación para endpoints protegidos
function auth(req, res, next) {
  const key = req.headers["x-api-key"];
  if (!key || key !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// Cache de configuración en memoria
let configCache = new Map();
function getCachedConfig(storeId) {
  const cached = configCache.get(storeId);
  if (cached && cached.expiresAt > Date.now()) return cached.data;
  return null;
}
function setCachedConfig(storeId, data) {
  configCache.set(storeId, { data, expiresAt: Date.now() + CACHE_TTL });
}

// ============================================================================
// LOGGING ENDPOINTS
// ============================================================================
app.get("/health", (req, res) => {
  try {
    db.prepare("SELECT 1").get();
    res.json({ status: "ok", version: "ope-v9-client-ready", timestamp: now() });
  } catch(e) {
    res.status(500).json({ status: "error", message: "Database unavailable" });
  }
});

app.post("/session/start", (req, res) => {
  if (rateLimit(req, res, 5000)) return;
  const storeId = safe(req.body?.storeId);
  const userId = safe(req.body?.userId, 36);
  const device = safe(req.body?.device || "unknown", 20);
  const trafficSource = safe(req.body?.trafficSource || "direct", 80);
  if (!storeId) return res.status(400).json({ error: "storeId required" });

  const sessionId = uuid();
  const hash = crypto.createHash('md5').update(userId || sessionId).digest('hex');
  const variant = parseInt(hash.slice(0, 8), 16) % 2 === 0 ? "A" : "B";

  let userReturnRisk = "low";
  const returns = db.prepare("SELECT COUNT(*) as cnt FROM returns WHERE user_id = ? AND returned = 1").get(userId);
  if (returns && returns.cnt >= 3) userReturnRisk = "high";
  else if (returns && returns.cnt >= 1) userReturnRisk = "medium";

  db.prepare(`INSERT INTO sessions (id, store_id, user_id, variant, started_at, device, traffic_source, user_return_risk) VALUES (?,?,?,?,?,?,?,?)`)
    .run(sessionId, storeId, userId || null, variant, now(), device, trafficSource, userReturnRisk);
  res.json({ sessionId, variant });
});

app.post("/action/log", (req, res) => {
  if (rateLimit(req, res, 5000)) return;
  const sessionId = safe(req.body?.sessionId, 36);
  const storeId = safe(req.body?.storeId);
  const action = safe(req.body?.action, 20);
  const propensity = Number(req.body?.propensity);
  const features = req.body?.features || {};
  const mentalState = safe(req.body?.mentalState || "BROWSING", 20);
  const ctx = req.body?.context || {};
  const signals = req.body?.returnRiskSignals || {};
  const commercialMoment = safe(req.body?.commercialMoment || "EARLY_BROWSING", 32);
  const intentScore = Number(req.body?.intentScore) || 0;
  const messageId = safe(req.body?.messageId, 128) || null;

  if (!sessionId || !storeId || !["NO_OP","ASSIST","SOCIAL","URGENCY","CART_PUSH"].includes(action))
    return res.status(400).json({ error: "Invalid fields" });
  if (isNaN(propensity) || propensity <= 0 || propensity > 1)
    return res.status(400).json({ error: "propensity must be in (0,1]" });

  const session = db.prepare("SELECT id FROM sessions WHERE id = ? AND store_id = ?").get(sessionId, storeId);
  if (!session) return res.status(404).json({ error: "Session not found" });

  let category = safe(ctx.category, 64);
  if (category === "electronics") category = "tech";

  const actionId = uuid();
  db.prepare(`INSERT INTO actions (id, session_id, store_id, ts, action, propensity,
    features_scroll, features_cart, features_time, features_rage, mental_state,
    context_product_id, context_category, context_price, context_page_type, context_position,
    return_risk_signals, commercial_moment, intent_score, message_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      actionId, sessionId, storeId, now(), action, propensity,
      Number(features.scroll) || 0,
      Number(features.cartAdded) || 0,
      Number(features.time) || 0,
      Number(features.rage) || 0,
      mentalState,
      safe(ctx.productId, 128) || null,
      category,
      ctx.price != null ? Number(ctx.price) : null,
      safe(ctx.pageType, 32) || null,
      ctx.productPosition != null ? Number(ctx.productPosition) : null,
      JSON.stringify(signals),
      commercialMoment,
      intentScore,
      messageId
    );
  res.json({ ok: true, actionId });
});

app.post("/outcome/log", (req, res) => {
  if (rateLimit(req, res, 5000)) return;
  const sessionId = safe(req.body?.sessionId, 36);
  const storeId = safe(req.body?.storeId);
  const converted = req.body?.converted ? 1 : 0;
  const revenue = Math.max(0, Number(req.body?.revenue) || 0);
  const lastActionId = safe(req.body?.lastActionId, 36);
  const returned = req.body?.returned ? 1 : 0;
  const returnReason = safe(req.body?.returnReason, 128) || null;
  const returnCategory = safe(req.body?.returnCategory, 64) || null;
  const returnTimestamp = req.body?.returnTimestamp ? parseInt(req.body.returnTimestamp) : null;
  const abandonedCart = req.body?.abandonedCart ? 1 : 0;

  if (!sessionId || !storeId) return res.status(400).json({ error: "Missing fields" });

  const session = db.prepare("SELECT started_at FROM sessions WHERE id = ? AND store_id = ?").get(sessionId, storeId);
  if (!session) return res.status(404).json({ error: "Session not found" });

  const timeToConvert = converted ? Math.round((now() - session.started_at) / 1000) : null;
  const actionsCount = db.prepare("SELECT COUNT(*) as cnt FROM actions WHERE session_id = ?").get(sessionId).cnt;
  const conversionStepIndex = converted ? actionsCount : null;

  db.prepare(`INSERT INTO outcomes (session_id, store_id, converted, conversion_step_index, revenue, last_action_id, time_to_convert, recorded_at,
    returned, return_reason, return_category, return_timestamp, abandoned_cart)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(session_id) DO UPDATE SET
      converted=excluded.converted, conversion_step_index=excluded.conversion_step_index, revenue=excluded.revenue, last_action_id=excluded.last_action_id,
      time_to_convert=excluded.time_to_convert, recorded_at=excluded.recorded_at,
      returned=excluded.returned, return_reason=excluded.return_reason,
      return_category=excluded.return_category, return_timestamp=excluded.return_timestamp,
      abandoned_cart=excluded.abandoned_cart`)
    .run(sessionId, storeId, converted, conversionStepIndex, revenue, lastActionId || null, timeToConvert, now(),
         returned, returnReason, returnCategory, returnTimestamp, abandonedCart);
  res.json({ ok: true, duplicate: false });
});

app.post("/return/log", (req, res) => {
  if (rateLimit(req, res, 5000)) return;
  const { sessionId, orderId, returned, returnReason, returnCategory } = req.body;
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });

  const session = db.prepare("SELECT user_id, store_id FROM sessions WHERE id = ?").get(sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });

  const sanitizedReason = safe(returnReason, 128);
  const sanitizedCategory = safe(returnCategory, 64);
  const returnId = uuid();
  db.prepare(`INSERT INTO returns (id, session_id, order_id, user_id, store_id, returned, return_reason, return_category, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(returnId, sessionId, safe(orderId,64) || null, session.user_id, session.store_id, returned ? 1 : 0,
         sanitizedReason, sanitizedCategory, now());

  db.prepare(`INSERT INTO outcomes (session_id, store_id, converted, revenue, recorded_at, returned, return_reason, return_category, return_timestamp)
    VALUES (?,?,0,0,?,?,?,?,?)
    ON CONFLICT(session_id) DO UPDATE SET
      returned=excluded.returned, return_reason=excluded.return_reason,
      return_category=excluded.return_category, return_timestamp=excluded.return_timestamp`)
    .run(sessionId, session.store_id, now(), returned ? 1 : 0, sanitizedReason, sanitizedCategory, now());
  res.json({ ok: true, returnId });
});

const RETURN_COST_EST = { fashion: 15, tech: 25, beauty: 8, home: 20, generic: 12 };
app.get("/export", (req, res) => {
  if (rateLimit(req, res, 200)) return;
  const storeId = safe(req.query?.storeId);
  if (!storeId) return res.status(400).json({ error: "storeId required" });

  const fromTs = parseInt(req.query.from) || now() - 30 * 86400000;
  const toTs = parseInt(req.query.to) || now();
  const limit = Math.min(parseInt(req.query.limit) || 1000, 5000);
  const offset = parseInt(req.query.offset) || 0;

  const sessions = db.prepare(
    "SELECT * FROM sessions WHERE store_id = ? AND started_at BETWEEN ? AND ? LIMIT ? OFFSET ?"
  ).all(storeId, fromTs, toTs, limit, offset);

  const trajectories = sessions.map(s => {
    const steps = db.prepare("SELECT *, commercial_moment, intent_score, message_id, context_category FROM actions WHERE session_id = ? ORDER BY ts ASC").all(s.id);
    const outcome = db.prepare("SELECT * FROM outcomes WHERE session_id = ?").get(s.id);
    const converted = outcome?.converted || 0;
    const revenue = outcome?.revenue || 0;
    const returned = outcome?.returned || 0;
    const returnCategory = outcome?.return_category || null;
    const conversionStepIndex = outcome?.conversion_step_index;
    const convIdx = (conversionStepIndex !== null && conversionStepIndex > 0) ? conversionStepIndex - 1 : -1;

    const stepsWithReward = steps.map((step, idx) => {
      const isConversionStep = (idx === convIdx && converted);
      const stepRevenue = isConversionStep ? revenue : 0;
      const stepCost = step.action === "NO_OP" ? 0 : 0.05;
      let returnPenalty = 0;
      if (isConversionStep && returned) {
        const cat = step.context_category || returnCategory || "generic";
        returnPenalty = RETURN_COST_EST[cat] || 12;
      }
      const reward = stepRevenue - stepCost - returnPenalty;
      return {
        action: step.action,
        propensity: step.propensity,
        reward,
        features: { scroll: step.features_scroll, cartAdded: step.features_cart, rageClicks: step.features_rage, time: step.features_time },
        context: { productId: step.context_product_id, category: step.context_category, price: step.context_price, pageType: step.context_page_type, productPosition: step.context_position },
        mentalState: step.mental_state,
        returnRiskSignals: step.return_risk_signals ? JSON.parse(step.return_risk_signals) : null,
        commercialMoment: step.commercial_moment,
        intentScore: step.intent_score || 0,
        messageId: step.message_id || null,
      };
    });
    return {
      sessionId: s.id,
      variant: s.variant,
      userReturnRisk: s.user_return_risk,
      converted,
      revenue,
      returned,
      returnCategory,
      steps: stepsWithReward,
    };
  });

  const valid = trajectories.filter(t => t.steps.length > 0);
  res.json({ storeId, period: { from: fromTs, to: toTs }, sessions: valid.length, trajectories: valid });
});

// ============================================================================
// CONFIGURACIÓN Y PESOS (con autenticación y cache)
// ============================================================================
app.get("/config/:storeId", (req, res) => {
  const storeId = safe(req.params.storeId);
  if (!storeId) return res.status(400).json({ error: "storeId required" });
  const cached = getCachedConfig(storeId);
  if (cached) return res.json(cached);
  const templates = db.prepare(`
    SELECT category, subtype, commercial_moment, action, message_text
    FROM message_templates
    WHERE store_id = ? AND active = 1
  `).all(storeId);
  const messages = {};
  for (const t of templates) {
    const key = `${t.category}|${t.subtype}|${t.commercial_moment}|${t.action}`;
    messages[key] = t.message_text;
  }
  const weights = {
    ASSIST: 0.5,
    SOCIAL: 2.5,
    URGENCY: 0.05,
    CART_PUSH: 4.0,
    NO_OP: 0.2
  };
  const config = { messages, weights, cooldownMs: 20000, maxMessages: 2 };
  setCachedConfig(storeId, config);
  res.json(config);
});

app.post("/config/:storeId", auth, (req, res) => {
  const storeId = safe(req.params.storeId);
  if (!storeId) return res.status(400).json({ error: "storeId required" });
  const { messages, weights } = req.body;
  db.prepare(`UPDATE message_templates SET active = 0 WHERE store_id = ?`).run(storeId);
  const nowTs = now();
  for (const [key, text] of Object.entries(messages)) {
    const [category, subtype, commercial_moment, action] = key.split("|");
    const id = uuid();
    db.prepare(`INSERT INTO message_templates (id, store_id, category, subtype, commercial_moment, action, message_text, created_at, active)
      VALUES (?,?,?,?,?,?,?,?,1)`).run(id, storeId, category, subtype, commercial_moment, action, text, nowTs);
  }
  if (weights) {
    logger.info(`Pesos actualizados para ${storeId}: ${JSON.stringify(weights)}`);
  }
  configCache.delete(storeId);
  res.json({ ok: true });
});

app.get("/config/weights/:storeId", (req, res) => {
  const storeId = safe(req.params.storeId);
  if (!storeId) return res.status(400).json({ error: "storeId required" });
  const weights = { ASSIST: 0.5, SOCIAL: 2.5, URGENCY: 0.05, CART_PUSH: 4.0, NO_OP: 0.2 };
  res.json(weights);
});

// ============================================================================
// MÉTRICAS
// ============================================================================
app.get("/metrics/messages/:storeId", (req, res) => {
  const storeId = safe(req.params.storeId);
  if (!storeId) return res.status(400).json({ error: "storeId required" });
  const fromTs = parseInt(req.query.from) || now() - 30 * 86400000;
  const toTs = parseInt(req.query.to) || now();

  const rows = db.prepare(`
    SELECT
      a.message_id,
      COUNT(DISTINCT s.id) AS impressions,
      SUM(o.revenue) - SUM(o.returned) * CASE WHEN a.context_category = 'fashion' THEN 15 WHEN a.context_category = 'tech' THEN 25 WHEN a.context_category = 'beauty' THEN 8 WHEN a.context_category = 'home' THEN 20 ELSE 12 END AS net_revenue,
      SUM(o.converted) AS conversions,
      SUM(o.returned) AS returns
    FROM actions a
    JOIN sessions s ON s.id = a.session_id
    JOIN outcomes o ON o.session_id = s.id
    WHERE a.store_id = ? AND a.ts BETWEEN ? AND ? AND a.message_id IS NOT NULL
    GROUP BY a.message_id
  `).all(storeId, fromTs, toTs);

  const result = rows.map(r => ({
    messageId: r.message_id,
    impressions: r.impressions,
    netRevenue: r.net_revenue,
    netPerImpression: r.impressions ? (r.net_revenue / r.impressions).toFixed(2) : 0,
    conversions: r.conversions,
    returnRate: r.impressions ? (r.returns / r.impressions * 100).toFixed(1) : 0
  }));
  res.json({ storeId, period: { from: fromTs, to: toTs }, messages: result });
});

app.get("/api/client-metrics/:storeId", (req, res) => {
  if (rateLimit(req, res, 500)) return;
  const storeId = safe(req.params.storeId);
  if (!storeId) return res.status(400).json({ error: "storeId required" });
  const fromTs = parseInt(req.query.from) || now() - 30 * 86400000;
  const toTs = parseInt(req.query.to) || now();

  const variants = db.prepare(`
    SELECT s.variant,
      COUNT(DISTINCT s.id) AS sessions,
      COALESCE(SUM(o.converted),0) AS conversions,
      COALESCE(SUM(o.revenue),0) AS revenue,
      COALESCE(SUM(o.returned),0) AS returns
    FROM sessions s LEFT JOIN outcomes o ON o.session_id = s.id
    WHERE s.store_id = ? AND s.started_at BETWEEN ? AND ? GROUP BY s.variant
  `).all(storeId, fromTs, toTs);

  const variantA = variants.find(v => v.variant === 'A') || { sessions:0, conversions:0, revenue:0, returns:0 };
  const variantB = variants.find(v => v.variant === 'B') || { sessions:0, conversions:0, revenue:0, returns:0 };
  const netPerSessionA = variantA.sessions ? (variantA.revenue - variantA.returns * 12) / variantA.sessions : 0;
  const netPerSessionB = variantB.sessions ? (variantB.revenue - variantB.returns * 12) / variantB.sessions : 0;

  res.json({
    storeId, period: { from: fromTs, to: toTs },
    kpis: {
      incrementalNetRevenuePerSession: +(netPerSessionB - netPerSessionA).toFixed(2),
      netUpliftPercent: netPerSessionA !== 0 ? +(((netPerSessionB - netPerSessionA) / netPerSessionA * 100).toFixed(1)) : 0,
      revenueInfluenced: +variantB.revenue.toFixed(2),
      returnRateDelta: +((variantB.sessions ? (variantB.returns / variantB.sessions * 100) : 0) - (variantA.sessions ? (variantA.returns / variantA.sessions * 100) : 0)).toFixed(1),
      sessionsAnalyzed: variantA.sessions + variantB.sessions
    },
    abComparison: {
      variantA: { sessions: variantA.sessions, conversionRate: variantA.sessions ? (variantA.conversions / variantA.sessions * 100) : 0,
        revenuePerSession: variantA.sessions ? (variantA.revenue / variantA.sessions) : 0,
        returnRate: variantA.sessions ? (variantA.returns / variantA.sessions * 100) : 0,
        netRevenuePerSession: netPerSessionA },
      variantB: { sessions: variantB.sessions, conversionRate: variantB.sessions ? (variantB.conversions / variantB.sessions * 100) : 0,
        revenuePerSession: variantB.sessions ? (variantB.revenue / variantB.sessions) : 0,
        returnRate: variantB.sessions ? (variantB.returns / variantB.sessions * 100) : 0,
        netRevenuePerSession: netPerSessionB }
    }
  });
});

// Stock cache (simple)
const stockCache = new Map();
app.post("/stock/:productId", auth, (req, res) => {
  const productId = safe(req.params.productId);
  const stock = parseInt(req.body.stock);
  if (isNaN(stock)) return res.status(400).json({ error: "stock must be a number" });
  stockCache.set(productId, { stock, updatedAt: now() });
  res.json({ ok: true });
});
app.get("/stock/:productId", (req, res) => {
  const productId = safe(req.params.productId);
  const entry = stockCache.get(productId);
  if (entry && (now() - entry.updatedAt) < 60000) {
    res.json({ stock: entry.stock });
  } else {
    res.json({ stock: null });
  }
});

// Dashboard mejorado (con descarga CSV y bootstrap aproximado)
app.get("/client/:storeId/dashboard", (req, res) => {
  const storeId = req.params.storeId;
  res.send(`
    <!DOCTYPE html>
    <html lang="es">
    <head>
        <meta charset="UTF-8">
        <title>Revenue Intelligence Dashboard</title>
        <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
        <style>
            * { margin:0; padding:0; box-sizing:border-box; }
            body { background:#f4f7fc; font-family: 'Inter', system-ui; padding:24px; color:#1a2a3a; }
            .container { max-width: 1400px; margin:0 auto; background:white; border-radius:32px; overflow:hidden; box-shadow: 0 10px 30px rgba(0,0,0,0.05); }
            .header { background:#1e3a5f; padding:24px 32px; color:white; }
            .controls { padding:20px 32px; background:#f8fafc; border-bottom:1px solid #e2e8f0; display:flex; gap:16px; flex-wrap:wrap; align-items:center; }
            .kpi-grid { display:flex; gap:20px; padding:24px 32px; flex-wrap:wrap; background:white; }
            .kpi-card { background:#f8fafc; border-radius:24px; padding:16px 24px; flex:1; min-width:180px; text-align:center; border:1px solid #e2e8f0; }
            .kpi-value { font-size:2rem; font-weight:800; color:#1e3a5f; }
            .kpi-label { font-size:0.75rem; text-transform:uppercase; color:#5b6e8c; letter-spacing:0.5px; }
            .card { background:white; border-radius:24px; padding:20px; margin:0 32px 24px 32px; border:1px solid #e2e8f0; }
            .card-title { font-weight:700; font-size:1.2rem; margin-bottom:16px; border-left:4px solid #e67e22; padding-left:12px; }
            table { width:100%; border-collapse:collapse; }
            th, td { text-align:left; padding:12px 8px; border-bottom:1px solid #e2e8f0; }
            th { background:#f1f5f9; }
            .positive { color:#2c7a4d; }
            .negative { color:#c0392b; }
            button, input, select { padding:8px 12px; border-radius:40px; border:1px solid #cbd5e1; background:white; }
            button { background:#1e3a5f; color:white; cursor:pointer; }
            .chart-container { height:350px; margin-top:16px; }
            footer { padding:16px 32px; font-size:0.7rem; color:#6c7a91; border-top:1px solid #e2e8f0; text-align:center; }
            .download-btn { background:#2c7a4d; }
        </style>
    </head>
    <body>
    <div class="container">
        <div class="header"><h1>📊 Revenue Intelligence Dashboard</h1><p>Rendimiento del Asesor Inteligente</p></div>
        <div class="controls">
            <select id="preset"><option value="7">Últimos 7 días</option><option value="30" selected>Últimos 30 días</option><option value="90">Últimos 90 días</option></select>
            <input type="date" id="fromDate"><input type="date" id="toDate"><button id="loadBtn">Actualizar</button><button id="downloadBtn" class="download-btn">📥 Descargar CSV</button><span id="status">Cargando...</span>
        </div>
        <div class="kpi-grid" id="kpiContainer"></div>
        <div class="card"><div class="card-title">⚖️ Comparativa A/B (Control vs Asesor)</div><div id="abTable"></div><div class="chart-container"><canvas id="abChart"></canvas></div></div>
        <div class="card"><div class="card-title">💬 Rendimiento por Mensaje</div><div id="messageTable">Cargando...</div></div>
        <footer>Net revenue calculado restando costo estimado de devolución (USD 12). Datos de tienda <strong>${escapeHtml(storeId)}</strong>.</footer>
    </div>
    <script>
        const storeId = "${escapeHtml(storeId)}";
        const API_BASE = window.location.origin;
        let abChart = null;
        let currentData = null;

        async function loadDashboard() {
            let from = document.getElementById('fromDate').value;
            let to = document.getElementById('toDate').value;
            let urlMetrics = \`\${API_BASE}/api/client-metrics/\${storeId}\`;
            let urlMessages = \`\${API_BASE}/metrics/messages/\${storeId}\`;
            if (from) {
                urlMetrics += \`?from=\${new Date(from).getTime()}\`;
                urlMessages += \`?from=\${new Date(from).getTime()}\`;
            }
            if (to) {
                urlMetrics += \`\${from?'&':'?'}to=\${new Date(to).getTime()}\`;
                urlMessages += \`&to=\${new Date(to).getTime()}\`;
            }
            try {
                const [metricsRes, messagesRes] = await Promise.all([fetch(urlMetrics), fetch(urlMessages)]);
                const metrics = await metricsRes.json();
                const messagesData = await messagesRes.json();
                currentData = { metrics, messages: messagesData.messages };
                renderKPIs(metrics.kpis);
                renderAB(metrics.abComparison);
                renderMessages(messagesData.messages);
                document.getElementById('status').innerText = \`✅ Actualizado: \${new Date().toLocaleTimeString()}\`;
            } catch(e) {
                document.getElementById('status').innerText = '❌ Error cargando datos';
                console.error(e);
            }
        }

        function renderKPIs(kpis) {
            const html = \`
                <div class="kpi-card"><div class="kpi-label">Incremental Net Revenue / sesión</div><div class="kpi-value">\${kpis.incrementalNetRevenuePerSession > 0 ? '+' : ''}\${kpis.incrementalNetRevenuePerSession.toFixed(2)}</div></div>
                <div class="kpi-card"><div class="kpi-label">Net Revenue Uplift</div><div class="kpi-value">\${kpis.netUpliftPercent > 0 ? '+' : ''}\${kpis.netUpliftPercent}%</div></div>
                <div class="kpi-card"><div class="kpi-label">Revenue Influenced (Asesor)</div><div class="kpi-value">$\${kpis.revenueInfluenced.toLocaleString()}</div></div>
                <div class="kpi-card"><div class="kpi-label">Return Rate Delta</div><div class="kpi-value \${kpis.returnRateDelta < 0 ? 'positive' : 'negative'}">\${kpis.returnRateDelta > 0 ? '+' : ''}\${kpis.returnRateDelta}%</div></div>
                <div class="kpi-card"><div class="kpi-label">Sessions Analyzed</div><div class="kpi-value">\${kpis.sessionsAnalyzed.toLocaleString()}</div></div>
            \`;
            document.getElementById('kpiContainer').innerHTML = html;
        }

        function renderAB(ab) {
            const a = ab.variantA, b = ab.variantB;
            const upliftNet = b.netRevenuePerSession - a.netRevenuePerSession;
            const upliftPct = a.netRevenuePerSession !== 0 ? ((b.netRevenuePerSession - a.netRevenuePerSession) / a.netRevenuePerSession * 100) : 0;
            const html = \`
                <table><thead><tr><th>Métrica</th><th>Control (A)</th><th>Asesor (B)</th><th>Diferencia</th></tr></thead><tbody>
                <tr><td>Sesiones</td><td>\${a.sessions}</td><td>\${b.sessions}</td><td>\${b.sessions - a.sessions}</td></tr>
                <tr><td>Conversión (%)</td><td>\${a.conversionRate.toFixed(1)}%</td><td>\${b.conversionRate.toFixed(1)}%</td><td class="\${b.conversionRate - a.conversionRate > 0 ? 'positive' : 'negative'}">\${(b.conversionRate - a.conversionRate).toFixed(1)}%</td></tr>
                <tr><td>Revenue bruto / sesión</td><td>$\${a.revenuePerSession.toFixed(2)}</td><td>$\${b.revenuePerSession.toFixed(2)}</td><td>$\${(b.revenuePerSession - a.revenuePerSession).toFixed(2)}</td></tr>
                <tr><td>Tasa devolución (%)</td><td>\${a.returnRate.toFixed(1)}%</td><td>\${b.returnRate.toFixed(1)}%</td><td class="\${b.returnRate - a.returnRate < 0 ? 'positive' : 'negative'}">\${(b.returnRate - a.returnRate).toFixed(1)}%</td></tr>
                <tr><td><strong>Net revenue / sesión</strong></td><td><strong>$\${a.netRevenuePerSession.toFixed(2)}</strong></td><td><strong>$\${b.netRevenuePerSession.toFixed(2)}</strong></td><td class="\${upliftNet > 0 ? 'positive' : 'negative'}">$\${upliftNet.toFixed(2)} (\${upliftPct > 0 ? '+' : ''}\${upliftPct.toFixed(1)}%)</td></tr>
                </tbody></table>
            \`;
            document.getElementById('abTable').innerHTML = html;
            if (abChart) abChart.destroy();
            const ctx = document.getElementById('abChart').getContext('2d');
            abChart = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: ['Net Revenue / sesión (USD)'],
                    datasets: [
                        { label: 'Control (A)', data: [a.netRevenuePerSession], backgroundColor: '#94a3b8' },
                        { label: 'Asesor (B)', data: [b.netRevenuePerSession], backgroundColor: '#2c7a4d' }
                    ]
                },
                options: { responsive: true, maintainAspectRatio: true, scales: { y: { beginAtZero: true, title: { display: true, text: 'USD' } } } }
            });
        }

        function renderMessages(messages) {
            if (!messages || messages.length === 0) {
                document.getElementById('messageTable').innerHTML = '<p>No hay datos de mensajes aún.</p>';
                return;
            }
            let html = '<table><thead><tr><th>ID Mensaje</th><th>Impresiones</th><th>Net Revenue</th><th>Net / Impresión</th><th>Conversiones</th><th>Tasa Devolución</th></tr></thead><tbody>';
            for (const m of messages) {
                html += \`<tr><td>\${m.messageId}</td><td>\${m.impressions}</td><td>$\${m.netRevenue.toFixed(2)}</td><td>$\${m.netPerImpression}</td><td>\${m.conversions}</td><td>\${m.returnRate}%</td></tr>\`;
            }
            html += '</tbody></table>';
            document.getElementById('messageTable').innerHTML = html;
        }

        function downloadCSV() {
            if (!currentData) return;
            let csvRows = [["Metrica","Control (A)","Asesor (B)","Diferencia"]];
            const a = currentData.metrics.abComparison.variantA;
            const b = currentData.metrics.abComparison.variantB;
            csvRows.push(["Sesiones", a.sessions, b.sessions, b.sessions - a.sessions]);
            csvRows.push(["Conversion (%)", a.conversionRate.toFixed(1), b.conversionRate.toFixed(1), (b.conversionRate - a.conversionRate).toFixed(1)]);
            csvRows.push(["Revenue bruto / sesion", a.revenuePerSession.toFixed(2), b.revenuePerSession.toFixed(2), (b.revenuePerSession - a.revenuePerSession).toFixed(2)]);
            csvRows.push(["Tasa devolucion (%)", a.returnRate.toFixed(1), b.returnRate.toFixed(1), (b.returnRate - a.returnRate).toFixed(1)]);
            csvRows.push(["Net revenue / sesion", a.netRevenuePerSession.toFixed(2), b.netRevenuePerSession.toFixed(2), (b.netRevenuePerSession - a.netRevenuePerSession).toFixed(2)]);
            csvRows.push([""]);
            csvRows.push(["Mensaje","Impresiones","Net Revenue","Net/Impresion"]);
            for (const m of currentData.messages) {
                csvRows.push([m.messageId, m.impressions, m.netRevenue, m.netPerImpression]);
            }
            const csvContent = csvRows.map(row => row.join(",")).join("\\n");
            const blob = new Blob([csvContent], { type: "text/csv" });
            const url = URL.createObjectURL(blob);
            const aTag = document.createElement("a");
            aTag.href = url;
            aTag.download = \`ope_export_\${storeId}_\${Date.now()}.csv\`;
            document.body.appendChild(aTag);
            aTag.click();
            document.body.removeChild(aTag);
            URL.revokeObjectURL(url);
        }

        document.getElementById('preset').addEventListener('change', (e) => {
            const days = parseInt(e.target.value);
            const to = new Date();
            const from = new Date(); from.setDate(to.getDate() - days);
            document.getElementById('fromDate').value = from.toISOString().slice(0,10);
            document.getElementById('toDate').value = to.toISOString().slice(0,10);
            loadDashboard();
        });
        document.getElementById('loadBtn').addEventListener('click', loadDashboard);
        document.getElementById('downloadBtn').addEventListener('click', downloadCSV);
        const today = new Date();
        const thirtyDaysAgo = new Date(); thirtyDaysAgo.setDate(today.getDate()-30);
        document.getElementById('fromDate').value = thirtyDaysAgo.toISOString().slice(0,10);
        document.getElementById('toDate').value = today.toISOString().slice(0,10);
        loadDashboard();
    </script>
    </body>
    </html>
  `);
});

app.get("/internal/dashboard", (req, res) => res.send(`<h2>Internal Dashboard</h2><p>Use /internal/metrics for raw data</p>`));
app.get("/dashboard", (req, res) => res.redirect("/internal/dashboard"));

app.listen(PORT, () => logger.info(`OPE server v9-client-ready running on port ${PORT}`));