const fetch = require('node-fetch');
const https = require('https');
const http = require('http');
const args = require('minimist')(process.argv.slice(2));

// Configuración
const BASE_URL = args.api || process.env.API_URL || 'https://ope-logger-token.onrender.com';
const STORE = args.store || 'demo';
const TARGET_SESSIONS = parseInt(args.sessions) || 30;  // total deseado (mitad A, mitad B)

const rand = (min, max) => Math.random() * (max - min) + min;
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Agentes para deshabilitar keep-alive
const agentOptions = { keepAlive: false };
const httpAgent = new http.Agent(agentOptions);
const httpsAgent = new https.Agent(agentOptions);

// Función con reintentos para cualquier petición
async function api(endpoint, method = 'GET', body = null, retries = 3, delay = 2000) {
  const url = `${BASE_URL}${endpoint}`;
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' },
    agent: url.startsWith('https') ? httpsAgent : httpAgent
  };
  if (body) options.body = JSON.stringify(body);

  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, options);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (i === retries - 1) throw err;
      console.warn(`  ↻ Reintento ${i+1}/${retries} para ${endpoint} tras error: ${err.message}`);
      await sleep(delay);
    }
  }
}

// Generar contexto de producto aleatorio
const CATEGORIES = ['fashion', 'tech', 'beauty', 'home'];
const SUBTYPES = {
  fashion: ['jean', 'zapatilla', 'campera', 'remera', 'vestido'],
  tech: ['auricular', 'mouse', 'notebook', 'celular', 'smart_tv'],
  beauty: ['serum', 'protector_solar', 'shampoo', 'base'],
  home: ['mesa', 'silla', 'lampara', 'alfombra']
};
function randomProductContext() {
  const category = CATEGORIES[randInt(0, CATEGORIES.length - 1)];
  const subtype = SUBTYPES[category][randInt(0, SUBTYPES[category].length - 1)];
  return { category, productId: `prod_${randInt(1000, 9999)}`, productName: `${subtype} ${randInt(100, 999)}` };
}

// Crear sesión
async function createSession(userId) {
  return api('/session/start', 'POST', { storeId: STORE, userId, device: 'desktop', trafficSource: 'direct' });
}

// Registrar acción
async function logAction(sessionId, action, propensity, features, commercialMoment, context, mentalState, messageId = null) {
  return api('/action/log', 'POST', {
    sessionId, storeId: STORE, action, propensity, features,
    commercialMoment, context, mentalState, messageId
  });
}

// Registrar outcome
async function logOutcome(sessionId, converted, revenue, returned = false, returnCategory = null, abandonedCart = false) {
  return api('/outcome/log', 'POST', {
    sessionId, storeId: STORE, converted, revenue, returned, returnCategory, abandonedCart
  });
}

// Simular una sesión completa
async function simulateSession(variant, sessionId) {
  const intentProfile = Math.random();
  let intentScore, convBase;
  if (intentProfile < 0.3) {
    intentScore = 0.2; convBase = 0.02;
  } else if (intentProfile < 0.7) {
    intentScore = 0.5; convBase = 0.08;
  } else {
    intentScore = 0.8; convBase = 0.25;
  }

  const ctx = randomProductContext();
  let scroll = 0, cartAdded = false, time = 0, rage = 0;
  let sizeChanges = 0, cartAddRemoveCycles = 0, lastAddTime = null;

  const numActions = randInt(1, 4);
  let lastAction = null;

  for (let i = 0; i < numActions; i++) {
    time += randInt(5, 20);
    scroll = Math.min(1, scroll + rand(0.05, 0.25));
    if (!cartAdded && Math.random() < (intentScore > 0.5 ? 0.6 : 0.3)) {
      cartAdded = true;
      const now = Date.now();
      if (lastAddTime && (now - lastAddTime) < 10000) cartAddRemoveCycles++;
      lastAddTime = now;
    }
    if (Math.random() < 0.05) rage++;
    if (Math.random() < 0.2) sizeChanges++;

    let commercialMoment = 'EARLY_BROWSING';
    if (time > 15 && scroll > 0.4) commercialMoment = 'PRODUCT_EVALUATION';
    if (cartAdded && time > 25) commercialMoment = 'BASKET_HESITATION';
    if (sizeChanges > 1) commercialMoment = 'SIZE_DOUBT';
    if (rage > 1) commercialMoment = 'FRUSTRATED';

    let mentalState = 'BROWSING';
    if (time > 15 && scroll > 0.4) mentalState = 'EVALUATING';
    if (time > 30 && scroll > 0.7) mentalState = 'HESITATING';
    if (rage > 1) mentalState = 'FRUSTRATED';

    // Decisión de acción en la simulación
    const actionsList = ['NO_OP', 'ASSIST', 'SOCIAL', 'URGENCY', 'CART_PUSH'];
    let weights = { NO_OP: 0.4, ASSIST: 0.2, SOCIAL: 0.15, URGENCY: 0.15, CART_PUSH: 0.1 };
    if (commercialMoment === 'BASKET_HESITATION') weights.CART_PUSH = 0.4;
    if (commercialMoment === 'SIZE_DOUBT') weights.ASSIST = 0.6;

    let action = 'NO_OP';
    if (Math.random() < 0.3) {
      action = actionsList[randInt(0, actionsList.length - 1)];
    } else {
      let r = Math.random(), acc = 0;
      for (let a of actionsList) { acc += weights[a]; if (r < acc) { action = a; break; } }
    }

    const propensity = rand(0.15, 0.7);
    const features = { scroll, cartAdded: cartAdded ? 1 : 0, time, rage };
    let messageId = null;
    if (action !== 'NO_OP') {
      const subtype = 'general';
      messageId = `${ctx.category}|${subtype}|${commercialMoment}|${action}`;
    }

    await logAction(sessionId, action, propensity, features, commercialMoment, ctx, mentalState, messageId);
    lastAction = action;
    await sleep(randInt(100, 300));
  }

  // Determinar outcome
  const convProb = Math.min(0.5, convBase * (cartAdded ? 1.5 : 1.0));
  const converted = Math.random() < convProb;
  let revenue = 0, returned = false, returnCategory = null;
  if (converted) {
    revenue = randInt(30, 200);
    if (Math.random() < 0.18) {
      returned = true;
      returnCategory = ctx.category;
    }
  }
  const abandonedCart = cartAdded && !converted;
  await logOutcome(sessionId, converted, revenue, returned, returnCategory, abandonedCart);
}

// Generador principal
async function run() {
  console.log(`🚀 Generando ${TARGET_SESSIONS} sesiones (${TARGET_SESSIONS/2} A, ${TARGET_SESSIONS/2} B) en store "${STORE}"...`);
  console.log(`🔗 API: ${BASE_URL}`);

  const sessionsA = [];
  const sessionsB = [];
  let attempts = 0;
  const maxAttempts = 500;

  // Crear sesiones hasta alcanzar la mitad deseada para cada variante
  while ((sessionsA.length < TARGET_SESSIONS/2 || sessionsB.length < TARGET_SESSIONS/2) && attempts < maxAttempts) {
    const userId = `user_${randInt(1, 100000)}`;
    try {
      const { sessionId, variant } = await createSession(userId);
      if (variant === 'A' && sessionsA.length < TARGET_SESSIONS/2) {
        sessionsA.push(sessionId);
      } else if (variant === 'B' && sessionsB.length < TARGET_SESSIONS/2) {
        sessionsB.push(sessionId);
      } else {
        // Sesión no necesaria (porque ya se alcanzó el cupo de esa variante) -> no la simulamos
        continue;
      }
      console.log(`  Sesión creada: ${sessionId} (${variant}) → A:${sessionsA.length}/${TARGET_SESSIONS/2}  B:${sessionsB.length}/${TARGET_SESSIONS/2}`);
    } catch (err) {
      console.warn(`  ⚠️ Error creando sesión: ${err.message}`);
    }
    attempts++;
    await sleep(randInt(200, 500));
  }

  const allSessions = [...sessionsA, ...sessionsB];
  console.log(`\n✅ Sesiones creadas: A=${sessionsA.length}, B=${sessionsB.length}. Total=${allSessions.length}`);
  console.log(`🔄 Simulando comportamiento de usuario...\n`);

  for (let idx = 0; idx < allSessions.length; idx++) {
    const sessionId = allSessions[idx];
    const variant = sessionsA.includes(sessionId) ? 'A' : 'B';
    try {
      await simulateSession(variant, sessionId);
    } catch (err) {
      console.error(`  ✗ Error simulando sesión ${sessionId}: ${err.message}`);
    }
    if ((idx+1) % 5 === 0 || idx+1 === allSessions.length) {
      console.log(`  📊 Procesadas ${idx+1}/${allSessions.length} sesiones`);
    }
    await sleep(randInt(100, 300));
  }

  console.log(`\n🎉 Simulación completada. StoreId: ${STORE}`);
  console.log(`📊 Dashboard: ${BASE_URL}/client/${STORE}/dashboard`);
}

run().catch(console.error);