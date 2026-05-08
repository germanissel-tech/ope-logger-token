#!/usr/bin/env node
"use strict";

const fetch = require('node-fetch');
const fs = require('fs');
const args = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith("--")).map(a => { let [k, v] = a.slice(2).split("="); return [k, v]; }));

const STORE = args.store;
const API = (args.api || "http://localhost:3001").replace(/\/$/, "");
const N_BOOT = parseInt(args.bootstrap) || 200;
const FORMAT = args.format || "table";
const SEED = parseInt(args.seed) || 42;
const FILE = args.file; // si se pasa, leer de archivo local

if (!STORE && !FILE) { console.error("❌ --store or --file required"); process.exit(1); }

const toTs = args.to ? new Date(args.to).getTime() : Date.now();
const fromTs = args.from ? new Date(args.from).getTime() : toTs - 30 * 86400000;
const COST_PER_RETURN = 12;
const CATEGORY_COSTS = { fashion: 15, tech: 25, beauty: 8, home: 20, generic: 12 };

async function fetchSessions() {
  if (FILE) {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return data.trajectories.map(t => ({
      id: t.sessionId,
      variant: t.variant,
      converted: t.converted,
      revenue: t.revenue,
      returned: t.returned,
      steps: t.steps,
      returnCategory: t.returnCategory
    }));
  }
  let allSessions = [];
  let offset = 0;
  const limit = 1000;
  while (true) {
    const url = `${API}/export?storeId=${STORE}&from=${fromTs}&to=${toTs}&limit=${limit}&offset=${offset}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Export failed: ${res.status}`);
    const data = await res.json();
    const trajectories = data.trajectories || [];
    if (trajectories.length === 0) break;
    for (const t of trajectories) {
      allSessions.push({
        id: t.sessionId,
        variant: t.variant,
        converted: t.converted,
        revenue: t.revenue,
        returned: t.returned,
        steps: t.steps,
        returnCategory: t.returnCategory
      });
    }
    offset += limit;
    if (trajectories.length < limit) break;
  }
  return allSessions;
}

function computeNetRevenue(s) {
  const cost = s.returnCategory ? (CATEGORY_COSTS[s.returnCategory] || COST_PER_RETURN) : COST_PER_RETURN;
  return (s.revenue || 0) - ((s.returned ? 1 : 0) * cost);
}

function computePointMetrics(sessions) {
  const a = sessions.filter(s => s.variant === 'A');
  const b = sessions.filter(s => s.variant === 'B');
  const sumNetA = a.reduce((acc, s) => acc + computeNetRevenue(s), 0);
  const sumNetB = b.reduce((acc, s) => acc + computeNetRevenue(s), 0);
  const sumRevA = a.reduce((acc, s) => acc + (s.revenue || 0), 0);
  const sumRevB = b.reduce((acc, s) => acc + (s.revenue || 0), 0);
  const returnsA = a.filter(s => s.returned).length;
  const returnsB = b.filter(s => s.returned).length;
  const convA = a.filter(s => s.converted).length;
  const convB = b.filter(s => s.converted).length;
  const lenA = a.length, lenB = b.length;

  const netPerA = lenA ? sumNetA / lenA : 0;
  const netPerB = lenB ? sumNetB / lenB : 0;
  const incremental = netPerB - netPerA;
  const uplift = netPerA !== 0 ? (incremental / netPerA) * 100 : 0;

  return {
    sessions: { A: lenA, B: lenB, total: lenA + lenB },
    netPerSession: { A: netPerA, B: netPerB },
    incrementalNet: incremental,
    uplift,
    revenueInfluenced: sumRevB,
    convRate: { A: lenA ? (convA / lenA) * 100 : 0, B: lenB ? (convB / lenB) * 100 : 0 },
    returnRate: { A: lenA ? (returnsA / lenA) * 100 : 0, B: lenB ? (returnsB / lenB) * 100 : 0 },
  };
}

async function bootstrapDiff(sessions, nBoot = N_BOOT, seed = SEED) {
  // Semilla reproducible
  let rng = (function(seed) {
    return function() {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
  })(seed);
  const diffs = [];
  const n = sessions.length;
  for (let i = 0; i < nBoot; i++) {
    const boot = [];
    for (let j = 0; j < n; j++) {
      const idx = Math.floor(rng() * n);
      boot.push(sessions[idx]);
    }
    const metrics = computePointMetrics(boot);
    diffs.push(metrics.incrementalNet);
  }
  diffs.sort((a,b) => a - b);
  const mean = diffs.reduce((a,b) => a + b,0) / diffs.length;
  const se = Math.sqrt(diffs.map(v => Math.pow(v - mean,2)).reduce((a,b) => a + b,0) / diffs.length);
  const ciLow = diffs[Math.floor(0.025 * diffs.length)];
  const ciHigh = diffs[Math.floor(0.975 * diffs.length)];
  const pVal = 2 * Math.min(diffs.filter(d => d > 0).length, diffs.filter(d => d < 0).length) / diffs.length;
  return { mean, se, ciLow, ciHigh, pVal };
}

async function categoryBreakdown(sessions) {
  const cats = new Set();
  for (const s of sessions) {
    for (const step of s.steps) {
      if (step.context?.category) cats.add(step.context.category);
    }
  }
  const result = {};
  for (const cat of cats) {
    const filtered = sessions.filter(s => s.steps.some(step => step.context?.category === cat));
    const metrics = computePointMetrics(filtered);
    result[cat] = {
      sessions: metrics.sessions.total,
      incrementalNet: metrics.incrementalNet,
      uplift: metrics.uplift
    };
  }
  return result;
}

async function messagePerformance(sessions) {
  const msgMap = new Map();
  for (const traj of sessions) {
    for (const step of traj.steps) {
      const msgId = step.messageId;
      if (!msgId) continue;
      // Para calcular net revenue asociado a ese mensaje, necesitamos el reward del step (ya incluye devolución)
      const net = step.reward || 0;
      const entry = msgMap.get(msgId) || { netSum: 0, count: 0 };
      entry.netSum += net;
      entry.count++;
      msgMap.set(msgId, entry);
    }
  }
  const results = [];
  for (const [msgId, data] of msgMap.entries()) {
    results.push({
      messageId: msgId,
      impressions: data.count,
      netRevenue: data.netSum,
      netPerImpression: data.count ? (data.netSum / data.count).toFixed(2) : 0,
    });
  }
  results.sort((a,b) => b.netPerImpression - a.netPerImpression);
  return results;
}

async function main() {
  console.error(`[OPE] Fetching session data...`);
  const sessions = await fetchSessions();
  console.error(`[OPE] Total sessions: ${sessions.length}`);
  if (sessions.length === 0) throw new Error("No sessions found");
  const point = computePointMetrics(sessions);
  const boot = await bootstrapDiff(sessions, N_BOOT, SEED);
  const msgPerf = await messagePerformance(sessions);
  const catBreak = await categoryBreakdown(sessions);
  const roi = (point.incrementalNet * point.sessions.total) / 5000; // supuesto coste desarrollo 5000 USD

  if (FORMAT === "json") {
    console.log(JSON.stringify({
      storeId: STORE,
      period: { from: fromTs, to: toTs },
      sessions: point.sessions,
      kpis: {
        incrementalNetRevenuePerSession: point.incrementalNet,
        netUpliftPercent: point.uplift,
        revenueInfluenced: point.revenueInfluenced,
        returnRateDelta: point.returnRate.B - point.returnRate.A,
        sessionsAnalyzed: point.sessions.total,
        estimatedROI: roi
      },
      bootstrap: {
        mean: boot.mean,
        se: boot.se,
        ci_low: boot.ciLow,
        ci_high: boot.ciHigh,
        p_value: boot.pVal
      },
      categoryBreakdown: catBreak,
      messagePerformance: msgPerf.slice(0, 20)
    }, null, 2));
  } else {
    console.log("\n" + "═".repeat(70));
    console.log("  📊 INFORME DE RENDIMIENTO (Comparación Directa)");
    console.log("═".repeat(70));
    console.log(`  Store:          ${STORE || "archivo local"}`);
    console.log(`  Período:        ${new Date(fromTs).toISOString().slice(0,10)} → ${new Date(toTs).toISOString().slice(0,10)}`);
    console.log(`  Sesiones:       ${point.sessions.total} (A:${point.sessions.A}, B:${point.sessions.B})`);
    console.log("─".repeat(70));
    console.log(`  Incremental Net Revenue / sesión:  ${point.incrementalNet > 0 ? '+' : ''}${point.incrementalNet.toFixed(2)} USD`);
    console.log(`  Net Revenue Uplift:                 ${point.uplift > 0 ? '+' : ''}${point.uplift.toFixed(1)}%`);
    console.log(`  Revenue Influenced:                $${point.revenueInfluenced.toFixed(0)}`);
    console.log(`  Return Rate Delta:                 ${(point.returnRate.B - point.returnRate.A).toFixed(1)}%`);
    console.log(`  ROI Estimado (vs desarrollo $5k):  ${roi > 0 ? '+' : ''}${roi.toFixed(2)}x`);
    console.log("─".repeat(70));
    console.log(`  Bootstrap (${N_BOOT} repeticiones): media = ${boot.mean.toFixed(2)} USD`);
    console.log(`  Error estándar:                    ±${boot.se.toFixed(2)}`);
    console.log(`  IC 95%:                           [${boot.ciLow.toFixed(2)}, ${boot.ciHigh.toFixed(2)}]`);
    console.log(`  p‑valor (sign test):               ${boot.pVal < 0.05 ? (boot.pVal < 0.01 ? `✅ ${boot.pVal.toFixed(4)} (significativo)` : `⚠️ ${boot.pVal.toFixed(4)} (marginal)`) : `❌ ${boot.pVal.toFixed(4)} (no significativo)`}`);
    console.log("─".repeat(70));
    console.log("  📂 Desglose por categoría:");
    for (const [cat, data] of Object.entries(catBreak)) {
      console.log(`    ${cat}: net incr = ${data.incrementalNet > 0 ? '+' : ''}${data.incrementalNet.toFixed(2)} USD (${data.sessions} sesiones)`);
    }
    console.log("─".repeat(70));
    console.log("  🏆 TOP RENDIMIENTO POR MENSAJE");
    console.log("  ID Mensaje | Impresiones | Net Revenue | Net / Impresión");
    for (const m of msgPerf.slice(0, 10)) {
      console.log(`  ${m.messageId.substring(0, 40)}... | ${m.impressions} | $${m.netRevenue.toFixed(2)} | $${m.netPerImpression}`);
    }
    console.log("═".repeat(70));
  }
}

main().catch(e => { console.error(e); process.exit(1); });