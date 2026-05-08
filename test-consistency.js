const fetch = require('node-fetch');
const args = require('minimist')(process.argv.slice(2));

// La URL base se toma del argumento --api o de la variable de entorno API_URL, o por defecto la de Render
const BASE_URL = args.api || process.env.API_URL || 'https://ope-logger-token.onrender.com';

const STORE = args.store || 'demo';
const TARGET_SESSIONS = args.sessions || 30;

const rand = (min, max) => Math.random() * (max - min) + min;
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
  const productName = `${subtype} ${randInt(100, 999)}`;
  return { category, productName, productId: `prod_${randInt(1000, 9999)}` };
}

async function api(endpoint, method = 'GET', body = null, useAuth = false) {
  const options = { method, headers: { 'Content-Type': 'application/json' } };
  if (useAuth && process.env.API_KEY) options.headers['X-API-Key'] = process.env.API_KEY;
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(`${BASE_URL}${endpoint}`, options);
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${endpoint}`);
  return res.json();
}

async function createSession(storeId, userId) {
  return api('/session/start', 'POST', { storeId, userId, device: 'desktop', trafficSource: 'direct' });
}

async function logAction(sessionId, storeId, action, propensity, features, commercialMoment, context, mentalState, messageId = null) {
  return api('/action/log', 'POST', { sessionId, storeId, action, propensity, features, commercialMoment, context, mentalState, messageId });
}

async function logOutcome(sessionId, storeId, converted, revenue, returned = false, returnCategory = null, abandonedCart = false) {
  return api('/outcome/log', 'POST', { sessionId, storeId, converted, revenue, returned, returnCategory, abandonedCart });
}

async function initMessages(storeId) {
  // No es necesario crear mensajes manualmente; el backend ya tiene valores por defecto o se pueden añadir después.
  console.log(`[initMessages] Usando configuración remota de ${BASE_URL}`);
}

async function run() {
  console.log(`🚀 Generando ${TARGET_SESSIONS} sesiones (${TARGET_SESSIONS/2} A, ${TARGET_SESSIONS/2} B) en store "${STORE}"...`);
  await initMessages(STORE);
  let sessionsA = [], sessionsB = [];
  let attempts = 0;
  while (sessionsA.length < TARGET_SESSIONS/2 || sessionsB.length < TARGET_SESSIONS/2) {
    const { sessionId, variant } = await createSession(STORE, `user_${randInt(1, 10000)}`);
    await sleep(50);
    if (variant === 'A' && sessionsA.length < TARGET_SESSIONS/2) {
      sessionsA.push(sessionId);
    } else if (variant === 'B' && sessionsB.length < TARGET_SESSIONS/2) {
      sessionsB.push(sessionId);
    }
    attempts++;
    if (attempts > 500) break;
  }
  const sessions = [...sessionsA, ...sessionsB];
  console.log(`Sesiones creadas: A=${sessionsA.length}, B=${sessionsB.length}`);

  for (let idx = 0; idx < sessions.length; idx++) {
    const sessionId = sessions[idx];
    const variant = sessionsA.includes(sessionId) ? 'A' : 'B';
    const intentRoll = Math.random();
    let intentProfile, intentScore;
    if (intentRoll < 0.3) { intentProfile = 'low'; intentScore = 0.2; }
    else if (intentRoll < 0.7) { intentProfile = 'medium'; intentScore = 0.5; }
    else { intentProfile = 'high'; intentScore = 0.8; }
    const productContext = randomProductContext();
    
    let scroll = 0, cartAdded = false, time = 0, rage = 0, variantChanges = 0, sizeChanges = 0;
    const numActions = randInt(1, 4);
    for (let t = 0; t < numActions; t++) {
      time += randInt(5, 20);
      scroll = Math.min(1, scroll + rand(0.05, 0.25));
      if (!cartAdded && Math.random() < (intentProfile === 'high' ? 0.6 : 0.3)) cartAdded = true;
      if (Math.random() < 0.05) rage++;
      if (Math.random() < 0.2) variantChanges++;
      if (Math.random() < 0.15) sizeChanges++;
      
      let commercialMoment = 'EARLY_BROWSING';
      if (time > 15 && scroll > 0.4) commercialMoment = 'PRODUCT_EVALUATION';
      if (cartAdded && time > 25) commercialMoment = 'BASKET_HESITATION';
      if (sizeChanges > 1) commercialMoment = 'SIZE_DOUBT';
      if (rage > 1) commercialMoment = 'FRUSTRATED';
      
      let mentalState = 'BROWSING';
      if (time > 15 && scroll > 0.4) mentalState = 'EVALUATING';
      if (time > 30 && scroll > 0.7) mentalState = 'HESITATING';
      if (rage > 1) mentalState = 'FRUSTRATED';
      
      const epsilon = 0.3;
      const actions = ['NO_OP', 'ASSIST', 'SOCIAL', 'URGENCY', 'CART_PUSH'];
      let weights = { NO_OP: 0.4, ASSIST: 0.2, SOCIAL: 0.15, URGENCY: 0.15, CART_PUSH: 0.1 };
      if (commercialMoment === 'BASKET_HESITATION') weights.CART_PUSH = 0.4;
      if (commercialMoment === 'SIZE_DOUBT') weights.ASSIST = 0.6;
      let action = 'NO_OP';
      if (Math.random() < epsilon) {
        action = actions[randInt(0, actions.length - 1)];
      } else {
        let r = Math.random(), acc = 0;
        for (let a of actions) { acc += weights[a]; if (r < acc) { action = a; break; } }
      }
      const propensity = rand(0.15, 0.7);
      const features = { scroll, cartAdded: cartAdded ? 1 : 0, time, rage };
      let messageId = null;
      if (action !== 'NO_OP') {
        const subtype = 'general';
        messageId = `${productContext.category}|${subtype}|${commercialMoment}|${action}`;
      }
      await logAction(sessionId, STORE, action, propensity, features, commercialMoment, productContext, mentalState, messageId);
      await sleep(100);
    }
    
    const convProbBase = intentProfile === 'high' ? 0.25 : (intentProfile === 'medium' ? 0.08 : 0.02);
    const commercialMomentFinal = (time > 25 && cartAdded) ? 'BASKET_HESITATION' : (sizeChanges > 1 ? 'SIZE_DOUBT' : (time > 15 ? 'PRODUCT_EVALUATION' : 'EARLY_BROWSING'));
    let convProb = convProbBase;
    if (commercialMomentFinal === 'BASKET_HESITATION') convProb *= 1.5;
    if (commercialMomentFinal === 'SIZE_DOUBT') convProb *= 1.2;
    convProb = Math.min(0.5, convProb);
    const converted = Math.random() < convProb;
    let revenue = 0, returned = false, returnCategory = null;
    if (converted) {
      revenue = randInt(30, 200);
      if (Math.random() < 0.18) { returned = true; returnCategory = productContext.category; }
    }
    const abandonedCart = cartAdded && !converted;
    await logOutcome(sessionId, STORE, converted, revenue, returned, returnCategory, abandonedCart);
    await sleep(100);
    if ((idx+1) % 10 === 0) console.log(`✅ ${idx+1}/${sessions.length} sesiones procesadas`);
  }
  console.log(`🎉 Simulación completada. StoreId: ${STORE}`);
  console.log(`📊 Dashboard: ${BASE_URL}/client/${STORE}/dashboard`);
}

run().catch(console.error);