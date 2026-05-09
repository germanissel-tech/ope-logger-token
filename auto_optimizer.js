#!/usr/bin/env node
"use strict";

const fetch = require('node-fetch');
const args = require('minimist')(process.argv.slice(2));

// Configuración
const BASE_URL = args.api || process.env.API_URL || 'https://ope-logger-token.onrender.com';
const STORE = args.store || process.env.STORE || 'demo';
const API_KEY = args.apiKey || process.env.API_KEY || 'changeme';
const DRY_RUN = args.dryRun === 'true' || false;
const MIN_IMPRESSIONS = parseInt(args.minImpressions) || 5;
const MIN_NET_PER_IMP = parseFloat(args.minNetPerImp) || 0.01;

async function fetchMessagePerformance() {
  const url = `${BASE_URL}/metrics/messages/${STORE}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch message performance: ${res.status}`);
  const data = await res.json();
  return data.messages || [];
}

async function fetchCurrentConfig() {
  const url = `${BASE_URL}/config/${STORE}`;
  const res = await fetch(url);
  if (!res.ok) return { messages: {}, weights: {} };
  return res.json();
}

async function updateConfig(messages, weights) {
  const url = `${BASE_URL}/config/${STORE}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
    body: JSON.stringify({ messages, weights })
  });
  if (!res.ok) throw new Error(`Failed to update config: ${res.status}`);
  return res.json();
}

// Extraer acción del messageId (formato sin barras: ...ACCION al final)
function extractAction(messageId) {
  const actions = ['ASSIST', 'SOCIAL', 'URGENCY', 'CART_PUSH', 'NO_OP'];
  for (const action of actions) {
    if (messageId.endsWith(action)) return action;
  }
  return 'NO_OP';
}

// Optimizar mensajes (compatible con claves con o sin barras)
function optimizeMessages(performanceMessages, currentMessages) {
  const perfMap = new Map();
  for (const msg of performanceMessages) {
    perfMap.set(msg.messageId, {
      netPerImp: parseFloat(msg.netPerImpression),
      impressions: msg.impressions
    });
  }

  const optimizedMessages = {};
  let kept = 0, removed = 0;

  for (const [key, text] of Object.entries(currentMessages)) {
    // Convertir la clave almacenada a un formato sin barras para buscar en perfMap
    let searchKey = key;
    if (searchKey.includes('|')) {
      searchKey = searchKey.replace(/\|/g, '');
    }
    const perf = perfMap.get(searchKey);
    if (perf && perf.impressions >= MIN_IMPRESSIONS && perf.netPerImp >= MIN_NET_PER_IMP) {
      optimizedMessages[key] = text;  // conservamos la clave original (con o sin barras)
      kept++;
      console.log(`  ✓ Conservar: ${key} (net/imp: ${perf.netPerImp.toFixed(2)}, imp: ${perf.impressions})`);
    } else {
      console.log(`  ✗ Descartar: ${key} (${perf ? `net/imp: ${perf.netPerImp.toFixed(2)}, imp: ${perf.impressions}` : 'sin datos'})`);
      removed++;
    }
  }
  console.log(`\nResumen mensajes: ${kept} conservados, ${removed} descartados.`);
  return optimizedMessages;
}

// Optimizar pesos extrayendo acción del messageId (sin depender de barras)
function optimizeWeights(performanceMessages, currentWeights) {
  const actionStats = {};
  for (const msg of performanceMessages) {
    const action = extractAction(msg.messageId);
    const netPerImp = parseFloat(msg.netPerImpression);
    const impressions = msg.impressions;
    if (!actionStats[action]) actionStats[action] = { totalNet: 0, totalImp: 0 };
    actionStats[action].totalNet += netPerImp * impressions;
    actionStats[action].totalImp += impressions;
  }

  const actionAvg = {};
  for (const [action, stats] of Object.entries(actionStats)) {
    if (stats.totalImp > 0) actionAvg[action] = stats.totalNet / stats.totalImp;
  }

  if (Object.keys(actionAvg).length === 0) {
    console.warn('No hay suficientes datos para ajustar pesos. Se mantienen los actuales.');
    return currentWeights;
  }

  const values = Object.values(actionAvg);
  const maxVal = Math.max(...values);
  const minVal = Math.min(...values);
  const range = maxVal - minVal;

  const newWeights = { ...currentWeights };
  for (const action of ['ASSIST', 'SOCIAL', 'URGENCY', 'CART_PUSH', 'NO_OP']) {
    if (actionAvg[action] !== undefined && range > 0) {
      let normalized = (actionAvg[action] - minVal) / range;
      normalized = Math.min(0.9, Math.max(0.1, normalized));
      newWeights[action] = normalized;
    } else if (!newWeights[action]) newWeights[action] = 0.2;
  }

  const total = Object.values(newWeights).reduce((s, v) => s + v, 0);
  for (const action of Object.keys(newWeights)) newWeights[action] /= total;
  return newWeights;
}

async function run() {
  console.log(`[AutoOptimizer] Iniciando para store "${STORE}" en ${BASE_URL}`);
  if (DRY_RUN) console.log('[DRY RUN] No se enviarán cambios.');

  try {
    const messagesPerf = await fetchMessagePerformance();
    if (!messagesPerf.length) {
      console.log('[AutoOptimizer] No hay datos de rendimiento aún.');
      return;
    }
    console.log(`[AutoOptimizer] ${messagesPerf.length} mensajes con datos.`);

    const currentConfig = await fetchCurrentConfig();
    const currentMessages = currentConfig.messages || {};
    const currentWeights = currentConfig.weights || {
      ASSIST: 0.5, SOCIAL: 2.5, URGENCY: 0.05, CART_PUSH: 4.0, NO_OP: 0.2
    };

    console.log('\n[Optimización de mensajes]');
    const optimizedMessages = optimizeMessages(messagesPerf, currentMessages);

    console.log('\n[Optimización de pesos]');
    const newWeights = optimizeWeights(messagesPerf, currentWeights);
    console.log('Pesos actuales:', currentWeights);
    console.log('Nuevos pesos sugeridos:', newWeights);

    if (DRY_RUN) {
      console.log('\n[DRY RUN] Sin cambios.');
      return;
    }

    console.log('\nEnviando nueva configuración...');
    await updateConfig(optimizedMessages, newWeights);
    console.log('✅ Configuración actualizada.');
    console.log(`Mensajes activos: ${Object.keys(optimizedMessages).length} (de ${Object.keys(currentMessages).length} originales).`);
    console.log(`Pesos actualizados:`, newWeights);
  } catch (err) {
    console.error('[AutoOptimizer] Error:', err.message);
    process.exit(1);
  }
}

run();