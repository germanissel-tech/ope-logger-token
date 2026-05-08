#!/usr/bin/env node
"use strict";

const fetch = require('node-fetch');
const args = require('minimist')(process.argv.slice(2));

// Configuración
const BASE_URL = args.api || process.env.API_URL || 'https://ope-logger-token.onrender.com';
const STORE = args.store || process.env.STORE || 'demo';
const API_KEY = args.apiKey || process.env.API_KEY || 'changeme';
const DRY_RUN = args.dryRun === 'true' || false;
const MIN_IMPRESSIONS = parseInt(args.minImpressions) || 5;   // Mínimo de impresiones para considerar un mensaje
const MIN_NET_PER_IMP = parseFloat(args.minNetPerImp) || 0.01; // Net revenue por impresión mínimo para conservar

// Obtener rendimiento de mensajes (con métricas de netPerImpression)
async function fetchMessagePerformance() {
  const url = `${BASE_URL}/metrics/messages/${STORE}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch message performance: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return data.messages || [];
}

// Obtener configuración actual (mensajes y pesos)
async function fetchCurrentConfig() {
  const url = `${BASE_URL}/config/${STORE}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`No se pudo obtener la configuración actual (HTTP ${res.status}), se usará objeto vacío.`);
    return { messages: {}, weights: {} };
  }
  return res.json();
}

// Actualizar configuración (mensajes y pesos) en el backend
async function updateConfig(messages, weights) {
  const url = `${BASE_URL}/config/${STORE}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY
    },
    body: JSON.stringify({ messages, weights })
  });
  if (!res.ok) throw new Error(`Failed to update config: ${res.status} ${res.statusText}`);
  return res.json();
}

// Optimizar mensajes: conservar solo aquellos con netPerImpression >= MIN_NET_PER_IMP y suficientes impresiones
function optimizeMessages(performanceMessages, currentMessages) {
  // Agrupar el rendimiento por clave de mensaje
  const performanceMap = new Map();
  for (const msg of performanceMessages) {
    const key = msg.messageId;
    if (!performanceMap.has(key) || parseFloat(msg.netPerImpression) > performanceMap.get(key).netPerImp) {
      performanceMap.set(key, {
        netPerImp: parseFloat(msg.netPerImpression),
        impressions: msg.impressions
      });
    }
  }

  // Filtrar los mensajes actuales: solo aquellos cuyo rendimiento es positivo
  const optimizedMessages = {};
  let kept = 0, removed = 0;

  for (const [key, text] of Object.entries(currentMessages)) {
    const perf = performanceMap.get(key);
    if (perf && perf.impressions >= MIN_IMPRESSIONS && perf.netPerImp >= MIN_NET_PER_IMP) {
      optimizedMessages[key] = text;
      kept++;
      console.log(`  ✓ Conservar: ${key} (net/imp: ${perf.netPerImp.toFixed(2)}, imp: ${perf.impressions})`);
    } else {
      if (perf) {
        console.log(`  ✗ Descartar: ${key} (net/imp: ${perf.netPerImp.toFixed(2)}, imp: ${perf.impressions})`);
      } else {
        console.log(`  ✗ Descartar: ${key} (sin datos de rendimiento)`);
      }
      removed++;
    }
  }

  console.log(`\nResumen mensajes: ${kept} conservados, ${removed} descartados.`);
  return optimizedMessages;
}

// Optimizar pesos de acciones basado en rendimiento promedio por acción
function optimizeWeights(performanceMessages, currentWeights) {
  // Agrupar por acción y calcular netPerImpression promedio ponderado
  const actionStats = {};

  for (const msg of performanceMessages) {
    const keyParts = msg.messageId.split('|');
    if (keyParts.length !== 4) continue;
    const action = keyParts[3]; // Último segmento = acción
    const netPerImp = parseFloat(msg.netPerImpression);
    const impressions = msg.impressions;

    if (!actionStats[action]) {
      actionStats[action] = { totalNet: 0, totalImp: 0 };
    }
    actionStats[action].totalNet += netPerImp * impressions;
    actionStats[action].totalImp += impressions;
  }

  // Calcular promedio por acción
  const actionAvg = {};
  for (const [action, stats] of Object.entries(actionStats)) {
    if (stats.totalImp > 0) {
      actionAvg[action] = stats.totalNet / stats.totalImp;
    }
  }

  if (Object.keys(actionAvg).length === 0) {
    console.warn('No hay suficientes datos para ajustar pesos. Se mantienen los actuales.');
    return currentWeights;
  }

  // Normalizar valores entre 0.1 y 1.0 (peso base)
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
    } else {
      if (!newWeights[action]) newWeights[action] = 0.2;
    }
  }

  // Re-normalizar para que la suma sea 1 (opcional, el frontend usa estos pesos directamente)
  const total = Object.values(newWeights).reduce((s, v) => s + v, 0);
  for (const action of Object.keys(newWeights)) {
    newWeights[action] = newWeights[action] / total;
  }

  return newWeights;
}

// Función principal
async function run() {
  console.log(`[AutoOptimizer] Iniciando optimización para store "${STORE}" en ${BASE_URL}`);
  if (DRY_RUN) console.log('[AutoOptimizer] Modo DRY RUN: no se enviarán cambios al servidor.');

  try {
    // 1. Obtener rendimiento de mensajes
    const messagesPerf = await fetchMessagePerformance();
    if (!messagesPerf.length) {
      console.log('[AutoOptimizer] No hay datos de rendimiento de mensajes aún.');
      return;
    }
    console.log(`[AutoOptimizer] Se encontraron ${messagesPerf.length} entradas de rendimiento.`);

    // 2. Obtener configuración actual
    const currentConfig = await fetchCurrentConfig();
    const currentMessages = currentConfig.messages || {};
    const currentWeights = currentConfig.weights || {
      ASSIST: 0.5,
      SOCIAL: 2.5,
      URGENCY: 0.05,
      CART_PUSH: 4.0,
      NO_OP: 0.2
    };

    console.log(`\n[Optimización de mensajes]`);
    const optimizedMessages = optimizeMessages(messagesPerf, currentMessages);

    console.log(`\n[Optimización de pesos]`);
    const newWeights = optimizeWeights(messagesPerf, currentWeights);
    console.log('Pesos actuales:', currentWeights);
    console.log('Nuevos pesos sugeridos:', newWeights);

    if (DRY_RUN) {
      console.log('\n[DRY RUN] No se enviaron cambios al servidor.');
      console.log('Los mensajes optimizados serían:', optimizedMessages);
      return;
    }

    // 3. Actualizar configuración en el backend
    console.log('\nEnviando nueva configuración al servidor...');
    await updateConfig(optimizedMessages, newWeights);
    console.log('✅ Configuración actualizada correctamente.');
    console.log(`Mensajes activos: ${Object.keys(optimizedMessages).length} (de ${Object.keys(currentMessages).length} originales).`);
    console.log(`Pesos actualizados:`, newWeights);

  } catch (err) {
    console.error('[AutoOptimizer] Error:', err.message);
    process.exit(1);
  }
}

run();