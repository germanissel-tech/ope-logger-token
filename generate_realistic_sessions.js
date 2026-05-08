const fetch = require('node-fetch');
const BASE_URL = 'http://localhost:3001'; // Cambia a https://engine-ai-backend.onrender.com cuando quieras usar el servidor remoto
const STORE = 'realistic_traffic';
const TARGET_SESSIONS = 400;

// Helper para generar números aleatorios
const rand = (min, max) => Math.random() * (max - min) + min;
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// Configuración de comportamiento
const SCROLL_PROFILES = {
  low: { mean: 0.2, std: 0.1 },
  medium: { mean: 0.5, std: 0.15 },
  high: { mean: 0.8, std: 0.1 }
};

const TIME_ON_PAGE = {
  bounce: { min: 5, max: 15 },
  browse: { min: 20, max: 60 },
  deep: { min: 60, max: 180 }
};

const CART_ADD_PROB = {
  low_intent: 0.1,
  medium_intent: 0.4,
  high_intent: 0.7
};

const CONVERSION_PROB = {
  low_intent: 0.02,
  medium_intent: 0.08,
  high_intent: 0.25
};

const RETURN_PROB_BY_CATEGORY = {
  fashion: 0.35,
  tech: 0.12,
  beauty: 0.08,
  home: 0.1,
  generic: 0.15
};

// Categorías y subtipos simulados
const CATEGORIES = ['fashion', 'tech', 'beauty', 'home', 'generic'];
const SUBTYPES = {
  fashion: ['jean', 'zapatilla', 'campera', 'remera', 'vestido'],
  tech: ['auricular', 'mouse', 'notebook', 'celular', 'smart_tv'],
  beauty: ['serum', 'protector_solar', 'shampoo', 'base'],
  home: ['mesa', 'silla', 'lampara', 'alfombra'],
  generic: ['producto']
};

// Función para generar un contexto de producto aleatorio
function randomProductContext() {
  const category = CATEGORIES[randInt(0, CATEGORIES.length - 1)];
  const subtypes = SUBTYPES[category];
  const subtype = subtypes[randInt(0, subtypes.length - 1)];
  const productName = `${subtype} ${randInt(100, 999)}`;
  return { category, productName, productId: `prod_${randInt(1000, 9999)}` };
}

// Función para simular una sesión completa
async function simulateSession(storeId, sessionIndex) {
  // Asignar perfil de intención (baja, media, alta) de forma aleatoria pero realista
  const intentRoll = Math.random();
  let intentProfile;
  if (intentRoll < 0.3) intentProfile = 'low_intent';
  else if (intentRoll < 0.7) intentProfile = 'medium_intent';
  else intentProfile = 'high_intent';

  // Características de scroll y tiempo según intención
  let scrollProfile, timeProfile, cartProb, convProb;
  if (intentProfile === 'low_intent') {
    scrollProfile = SCROLL_PROFILES.low;
    timeProfile = TIME_ON_PAGE.bounce;
    cartProb = CART_ADD_PROB.low_intent;
    convProb = CONVERSION_PROB.low_intent;
  } else if (intentProfile === 'medium_intent') {
    scrollProfile = SCROLL_PROFILES.medium;
    timeProfile = TIME_ON_PAGE.browse;
    cartProb = CART_ADD_PROB.medium_intent;
    convProb = CONVERSION_PROB.medium_intent;
  } else {
    scrollProfile = SCROLL_PROFILES.high;
    timeProfile = TIME_ON_PAGE.deep;
    cartProb = CART_ADD_PROB.high_intent;
    convProb = CONVERSION_PROB.high_intent;
  }

  // Iniciar sesión
  const sessionRes = await fetch(`${BASE_URL}/session/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ storeId, userId: `user_${randInt(1, 100)}`, device: 'desktop', trafficSource: 'direct' })
  });
  const { sessionId, variant } = await sessionRes.json();

  // Simular pasos (acciones) dentro de la sesión
  const steps = [];
  let totalTime = 0;
  let scroll = 0;
  let cartAdded = false;
  let rageClicks = 0;
  let variantChanges = 0;
  let sizeChanges = 0;
  let productContext = randomProductContext();

  // Número de acciones por sesión: entre 1 y 8
  const numActions = randInt(1, 8);
  for (let t = 0; t < numActions; t++) {
    // Avanzar tiempo y scroll
    const timeIncrement = randInt(5, 20);
    totalTime += timeIncrement;
    const scrollIncrement = Math.max(0, Math.min(1 - scroll, (rand(scrollProfile.mean - scrollProfile.std, scrollProfile.mean + scrollProfile.std) / 5)));
    scroll = Math.min(1, scroll + scrollIncrement);

    // Decidir si añade al carrito (solo una vez)
    if (!cartAdded && Math.random() < cartProb) {
      cartAdded = true;
    }

    // Cambios de talla / variante (simular indecisión)
    if (productContext.category === 'fashion' && Math.random() < 0.3) {
      variantChanges++;
      if (Math.random() < 0.5) sizeChanges++;
    }

    // Rage clicks ocasionales
    if (Math.random() < 0.05) rageClicks++;

    // Determinar momento comercial (simulado, pero coherente)
    let commercialMoment = 'EARLY_BROWSING';
    if (totalTime > 15 && scroll > 0.4) commercialMoment = 'PRODUCT_EVALUATION';
    if (cartAdded && totalTime > 25) commercialMoment = 'BASKET_HESITATION';
    if (sizeChanges > 1) commercialMoment = 'SIZE_DOUBT';
    if (rageClicks > 1) commercialMoment = 'FRUSTRATED';

    // Obtener acción real basada en política (simulación simplificada)
    // En un entorno real, el logger decidiría; aquí forzamos una acción aleatoria ponderada para variedad
    const actions = ['NO_OP', 'ASSIST', 'SOCIAL', 'URGENCY', 'CART_PUSH'];
    const actionWeights = { NO_OP: 0.4, ASSIST: 0.2, SOCIAL: 0.15, URGENCY: 0.15, CART_PUSH: 0.1 };
    if (commercialMoment === 'BASKET_HESITATION') actionWeights.CART_PUSH = 0.4;
    if (commercialMoment === 'SIZE_DOUBT') actionWeights.ASSIST = 0.6;
    let action = 'NO_OP';
    let randAction = Math.random();
    let acc = 0;
    for (let a of actions) {
      acc += actionWeights[a];
      if (randAction < acc) { action = a; break; }
    }

    // Propensity simulada (entre 0.1 y 0.6)
    const propensity = rand(0.1, 0.6);

    // Features
    const features = { scroll, cartAdded: cartAdded ? 1 : 0, time: totalTime, rage: rageClicks };

    // Registrar acción
    await fetch(`${BASE_URL}/action/log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        storeId,
        action,
        propensity,
        features,
        mentalState: 'BROWSING',
        context: productContext,
        returnRiskSignals: { variantChanges, sizeChanges, cartAddRemoveCycles: 0, hesitationScore: 0, lastAddTimestamp: null },
        commercialMoment,
        intentScore: intentProfile === 'high_intent' ? 0.7 : (intentProfile === 'medium_intent' ? 0.4 : 0.2)
      })
    });
  }

  // Determinar outcome (conversión y posible devolución)
  const converted = Math.random() < convProb;
  let revenue = 0;
  let returned = false;
  let returnCategory = null;
  if (converted) {
    revenue = randInt(30, 200);
    // Devolución basada en categoría
    const returnProb = RETURN_PROB_BY_CATEGORY[productContext.category] || 0.15;
    if (Math.random() < returnProb) {
      returned = true;
      returnCategory = productContext.category;
    }
  }

  await fetch(`${BASE_URL}/outcome/log`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, storeId, converted, revenue, returned, returnCategory })
  });

  console.log(`[${sessionIndex+1}/${TARGET_SESSIONS}] Sesión ${sessionId} (${variant}) | Conv:${converted} Rev:${revenue} Return:${returned}`);
}

async function run() {
  console.log(`🚀 Generando ${TARGET_SESSIONS} sesiones realistas en store "${STORE}"...`);
  for (let i = 0; i < TARGET_SESSIONS; i++) {
    await simulateSession(STORE, i);
    // Pequeña pausa para no saturar el servidor
    if (i % 20 === 0) await new Promise(r => setTimeout(r, 500));
  }
  console.log(`✅ Simulación completada.`);
  console.log(`📊 Ahora puedes analizar los datos con: node ope-evaluator.js --store=${STORE} --api=${BASE_URL}`);
}

run().catch(console.error);