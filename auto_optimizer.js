#!/usr/bin/env node
"use strict";

const fetch = require('node-fetch');
const fs = require('fs');
const args = require('minimist')(process.argv.slice(2));
const BASE_URL = args.api || process.env.API_URL || "http://localhost:3001";
const STORE = args.store || process.env.STORE || "demo";
const API_KEY = args.apiKey || process.env.API_KEY || "changeme";
const DRY_RUN = args.dryRun === "true" || false;
const UPDATE_WEIGHTS = args.updateWeights !== "false";

async function fetchMessagePerformance() {
  const url = `${BASE_URL}/metrics/messages/${STORE}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch message performance: ${res.status}`);
  const data = await res.json();
  return data.messages;
}

async function fetchCurrentConfig() {
  const url = `${BASE_URL}/config/${STORE}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json();
}

async function updateConfig(messages, weights = null) {
  const url = `${BASE_URL}/config/${STORE}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
    body: JSON.stringify({ messages, weights })
  });
  if (!res.ok) throw new Error(`Failed to update config: ${res.status}`);
  return res.json();
}

async function updateWeights(weights) {
  // No hay endpoint específico para pesos, se puede guardar en una tabla aparte.
  // Por ahora, solo se loguea.
  console.log("[AutoOptimizer] Nuevos pesos sugeridos:", weights);
  // Opcional: guardar en base de datos o archivo.
}

async function run() {
  console.log(`[AutoOptimizer] Iniciando optimización para store ${STORE}`);
  try {
    const messagesPerf = await fetchMessagePerformance();
    if (!messagesPerf || messagesPerf.length === 0) {
      console.log("[AutoOptimizer] No hay datos de rendimiento de mensajes aún.");
      return;
    }
    // Agrupar por clave (category|subtype|commercial_moment|action)
    const bestPerKey = new Map();
    for (const m of messagesPerf) {
      const key = m.messageId;
      if (!bestPerKey.has(key) || m.netPerImpression > bestPerKey.get(key).netPerImpression) {
        bestPerKey.set(key, { messageId: m.messageId, netPerImpression: m.netPerImpression });
      }
    }
    // Para actualizar, necesitamos obtener la configuración actual y reemplazar los mensajes de cada clave por el mejor.
    const currentConfig = await fetchCurrentConfig();
    if (!currentConfig) {
      console.log("[AutoOptimizer] No se pudo obtener la configuración actual.");
      return;
    }
    const newMessages = { ...currentConfig.messages };
    for (const [key, best] of bestPerKey.entries()) {
      // En una implementación real, aquí deberíamos obtener el texto del mejor mensaje.
      // Como solo tenemos el messageId, necesitaríamos tener almacenado el texto.
      // Para este ejemplo, asumimos que el messageId es la clave y el texto ya está en la BD.
      // Simplemente activamos ese mensaje (ya lo está). En producción, se puede mantener.
      console.log(`[AutoOptimizer] Mejor mensaje para ${key}: ${best.messageId} (net/imp: ${best.netPerImpression})`);
      // No modificamos el texto, solo nos aseguramos de que esté activo.
    }
    // Optimización de pesos basada en rendimiento por categoría y acción
    if (UPDATE_WEIGHTS) {
      // Calcular nuevos pesos: por ejemplo, aumentar ASSIST si su netPerImpression es alto
      const assistMessages = messagesPerf.filter(m => m.messageId.includes('|ASSIST'));
      const avgAssistNet = assistMessages.reduce((acc, m) => acc + parseFloat(m.netPerImpression), 0) / (assistMessages.length || 1);
      const allAvg = messagesPerf.reduce((acc, m) => acc + parseFloat(m.netPerImpression), 0) / (messagesPerf.length || 1);
      const factor = avgAssistNet / allAvg;
      const newWeights = {
        ASSIST: Math.min(1.5, 0.5 * factor),
        SOCIAL: 2.5,
        URGENCY: 0.05,
        CART_PUSH: 4.0,
        NO_OP: 0.2
      };
      console.log("[AutoOptimizer] Nuevos pesos sugeridos:", newWeights);
      if (!DRY_RUN) await updateWeights(newWeights);
    }
    if (!DRY_RUN) {
      // No actualizamos mensajes porque no tenemos el texto original; en un entorno real se haría.
      console.log("[AutoOptimizer] Optimización completada (sin cambios automáticos de mensajes por falta de textos)");
    } else {
      console.log("[AutoOptimizer] Modo DRY RUN, no se realizaron cambios.");
    }
  } catch (err) {
    console.error("[AutoOptimizer] Error:", err);
  }
}

run();