#!/usr/bin/env node
"use strict";

const fetch = require('node-fetch');
const args = require('minimist')(process.argv.slice(2));

// Configuración
const BASE_URL = args.api || process.env.API_URL || 'https://ope-logger-token.onrender.com';
const STORE = args.store || process.env.STORE || 'demo';
const API_KEY = args.apiKey || process.env.API_KEY || 'changeme';
const DRY_RUN = args.dryRun === 'true' || false;
const MIN_IMPRESSIONS = parseInt(args.minImpressions) || 10;  // Mínimo de impresiones para considerar un mensaje

// Función para obtener rendimiento de mensajes
async function fetchMessagePerformance() {
  const url = `${BASE_URL}/metrics/messages/${STORE}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch message performance: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return data.messages || [];
}

// Función para obtener configuración actual
async function fetchCurrentConfig() {
  const url = `${BASE_URL}/config/${STORE}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`No se pudo obtener la configuración actual (HTTP ${res.status}), se usará un objeto vacío.`);
    return { messages: {}, weights: {} };
  }
  return res.json();
}

// Función para actualizar configuración en el backend
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

// Función para optimizar los mensajes: solo mantener aquellos con netPerImpression positivo y con suficientes impresiones
function optimizeMessages(performanceMessages) {
  const optimized = {};
  for (const msg of performanceMessages) {
    const netPerImp = parseFloat(msg.netPerImpression);
    const impressions = msg.impressions;
    if (impressions >= MIN_IMPRESSIONS && netPerImp > 0) {
      // Para mantener el mensaje, necesitamos su texto original. Sin embargo, el endpoint /config solo espera el mapa de mensajes (clave->texto).
      // Pero no tenemos el texto aquí. La optimización real requiere conocer el texto del mensaje, que proviene de la configuración actual.
      // Por lo tanto, este optimizador está incompleto sin almacenar los textos. Por ahora, solo registramos sugerencias.
      // En una implementación completa, deberíamos obtener los textos de la configuración actual.
      console.log(`  ✓ Mantener mensaje: ${msg.messageId} (net/imp: ${netPerImp}, impresiones: ${impressions})`);
      // En lugar de modificar, solo sugerimos. Para realmente actualizar, necesitaríamos preservar el texto.
      // No modificamos la configuración automáticamente porque no tenemos el texto original.
    } else {
      console.log(`  ✗ Descartar mensaje: ${msg.messageId} (net/imp: ${netPerImp}, impresiones: ${impressions})`);
    }
  }
  // Como no podemos obtener el texto, no actualizamos mensajes automáticamente en esta versión.
  // Se necesita una extensión para almacenar textos o usar la configuración actual.
  return null; // Indica que no se actualizan mensajes
}

// Función para ajustar pesos de acciones basado en rendimiento
function optimizeWeights(performanceMessages, currentWeights) {
  // Agrupar por acción y calcular netPerImpression promedio
  const actionStats = {};
  for (const msg of performanceMessages) {
    const keyParts = msg.messageId.split('|');
    if (keyParts.length !== 4) continue;
    const action = keyParts[3]; // Último segmento es la acción
    const netPerImp = parseFloat(msg.netPerImpression);
    const impressions = msg.impressions;
    if (!actionStats[action]) {
      actionStats[action] = { totalNet: 0, totalImp: 0 };
    }
    actionStats[action].totalNet += netPerImp * impressions;
    actionStats[action].totalImp += impressions;
  }
  // Calcular promedio ponderado por acción
  const actionAvg = {};
  for (const [action, stats] of Object.entries(actionStats)) {
    if (stats.totalImp > 0) {
      actionAvg[action] = stats.totalNet / stats.totalImp;
    }
  }
  // Si no hay datos, mantener pesos actuales
  if (Object.keys(actionAvg).length === 0) {
    console.warn('No hay suficientes datos para ajustar pesos.');
    return currentWeights;
  }
  // Encontrar el mejor y peor rendimiento para normalizar
  const values = Object.values(actionAvg);
  const maxVal = Math.max(...values);
  const minVal = Math.min(...values);
  const range = maxVal - minVal;
  // Nuevos pesos: asignar mayor peso a acciones con mejor netPerImpression
  const newWeights = { ...currentWeights };
  for (const action of ['ASSIST', 'SOCIAL', 'URGENCY', 'CART_PUSH', 'NO_OP']) {
    if (actionAvg[action] !== undefined && range > 0) {
      // Normalización lineal entre 0.1 y 1.0
      let normalized = (actionAvg[action] - minVal) / range;
      normalized = Math.min(0.9, Math.max(0.1, normalized));
      newWeights[action] = normalized;
    } else {
      // Si no hay datos, mantener peso existente o poner valor por defecto
      if (!newWeights[action]) newWeights[action] = 0.2;
    }
  }
  // Re-normalizar para que sumen 1 (excepto NO_OP que debería tener peso bajo)
  const sum = newWeights.ASSIST + newWeights.SOCIAL + newWeights.URGENCY + newWeights.CART_PUSH + newWeights.NO_OP;
  for (const action of Object.keys(newWeights)) {
    newWeights[action] = newWeights[action] / sum;
  }
  return newWeights;
}

// Ejecución principal
async function run() {
  console.log(`[AutoOptimizer] Iniciando optimización para store ${STORE} en ${BASE_URL}`);
  if (DRY_RUN) console.log('[AutoOptimizer] Modo DRY RUN: no se enviarán cambios al servidor.');

  try {
    // Obtener rendimiento de mensajes
    const messagesPerf = await fetchMessagePerformance();
    if (!messagesPerf.length) {
      console.log('[AutoOptimizer] No hay datos de rendimiento de mensajes aún.');
      return;
    }
    console.log(`[AutoOptimizer] Se encontraron ${messagesPerf.length} mensajes con datos.`);

    // Obtener configuración actual
    const currentConfig = await fetchCurrentConfig();
    const currentMessages = currentConfig.messages || {};
    const currentWeights = currentConfig.weights || {
      ASSIST: 0.5,
      SOCIAL: 2.5,
      URGENCY: 0.05,
      CART_PUSH: 4.0,
      NO_OP: 0.2
    };

    // Optimizar mensajes (solo sugerencia, no actualiza por falta de textos)
    console.log('\n[Optimización de mensajes]');
    const optimizedMessages = optimizeMessages(messagesPerf);
    if (optimizedMessages && !DRY_RUN) {
      console.log('Actualizando mensajes...');
      // No se implementa por ahora
    }

    // Optimizar pesos
    console.log('\n[Optimización de pesos]');
    const newWeights = optimizeWeights(messagesPerf, currentWeights);
    console.log('Pesos actuales:', currentWeights);
    console.log('Nuevos pesos sugeridos:', newWeights);

    if (!DRY_RUN) {
      // Actualizar solo los pesos (sin modificar los mensajes)
      console.log('Enviando nuevos pesos al servidor...');
      await updateConfig(currentMessages, newWeights);
      console.log('✅ Pesos actualizados correctamente.');
    } else {
      console.log('[DRY RUN] No se enviaron cambios.');
    }

    console.log('[AutoOptimizer] Proceso completado.');
  } catch (err) {
    console.error('[AutoOptimizer] Error:', err.message);
    process.exit(1);
  }
}

run();