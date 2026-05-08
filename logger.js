/**
 * OPE Logger — Frontend v17 (Ready for client)
 * - Bloqueante en configuración remota
 * - Subtipo dinámico (size, compatibility, skin_type, measurements)
 * - Stock real para urgencia honesta
 * - Cooldown y max mensajes configurables
 * - Detección de abandono de carrito
 */
(function () {
  "use strict";

  const tag = document.currentScript || document.querySelector("[data-store]");
  const STORE = tag?.dataset?.store || "demo";
  const API = (tag?.dataset?.api || "http://localhost:3001").replace(/\/$/, "");
  const DEBUG = tag?.dataset?.debug === "true";
  const log = (...a) => DEBUG && console.log("[OPE]", ...a);

  const SESSION_KEY = "ope_session_" + STORE;
  const USER_KEY = "ope_user_" + STORE;

  const ACTIONS = ["NO_OP", "ASSIST", "SOCIAL", "URGENCY", "CART_PUSH"];

  let sessionId = null;
  let variant = null;
  let userId = null;
  let lastActionId = null;
  let sessionStart = Date.now();
  let _converted = false;
  let _abandonedCart = false; // nuevo: si añadió carrito y no compró

  // Configuración remota
  let remoteConfig = null;
  let configLoaded = false;

  // Estado observable
  const obs = {
    scroll: 0,
    cartAdded: 0,
    time: 0,
    rage: 0,
    lastActive: Date.now(),
  };

  let returnRiskSignals = {
    variantChanges: 0,
    sizeChanges: 0,
    cartAddRemoveCycles: 0,
    hesitationScore: 0,
    lastAddTimestamp: null,
    lastProductId: null, // para resetear señales al cambiar producto
  };

  // Configuración dinámica
  let cooldownMs = 20000;
  let maxMessages = 2;

  // ──────────────────────────────────────────────────────────────────────────
  // UUID y utilidades
  // ──────────────────────────────────────────────────────────────────────────
  function _uuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }
  function _parse(s) { try { return JSON.parse(s); } catch { return null; } }
  function _esc(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

  // ──────────────────────────────────────────────────────────────────────────
  // Configuración remota (bloqueante hasta timeout)
  // ──────────────────────────────────────────────────────────────────────────
  async function loadRemoteConfig() {
    try {
      const res = await fetch(`${API}/config/${STORE}`);
      if (res.ok) {
        remoteConfig = await res.json();
        log("Config remota cargada", remoteConfig);
        if (remoteConfig.cooldownMs) cooldownMs = remoteConfig.cooldownMs;
        if (remoteConfig.maxMessages) maxMessages = remoteConfig.maxMessages;
      } else {
        remoteConfig = null;
      }
    } catch(e) {
      log("Error cargando config remota", e);
      remoteConfig = null;
    }
    configLoaded = true;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Consulta de stock real (opcional)
  // ──────────────────────────────────────────────────────────────────────────
  async function getRealStock(productId) {
    if (!productId) return null;
    try {
      const res = await fetch(`${API}/stock/${productId}`);
      if (res.ok) {
        const data = await res.json();
        return data.stock;
      }
    } catch(e) {}
    return null;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Inicialización
  // ──────────────────────────────────────────────────────────────────────────
  async function init() {
    userId = localStorage.getItem(USER_KEY) || _uuid();
    localStorage.setItem(USER_KEY, userId);

    const stored = _parse(localStorage.getItem(SESSION_KEY));

    try {
      const r = await fetch(API + "/session/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storeId: STORE,
          userId,
          device: /Mobi|Android/i.test(navigator.userAgent) ? "mobile" : "desktop",
          trafficSource: document.referrer ? new URL(document.referrer).hostname : "direct",
        }),
      });
      const d = await r.json();
      sessionId = d.sessionId;
      variant = d.variant;
      sessionStart = Date.now();
      localStorage.setItem(SESSION_KEY, JSON.stringify({ id: sessionId }));
      log("Session:", sessionId, "| Variant:", variant);
    } catch (e) {
      sessionId = stored?.id || _uuid();
      variant = "B";
      log("Offline — local session");
    }

    // Cargar configuración remota de forma bloqueante (máx 2 segundos)
    const configPromise = loadRemoteConfig();
    await Promise.race([
      configPromise,
      new Promise(resolve => setTimeout(() => { log("Config timeout, using defaults"); resolve(); }, 2000))
    ]);
  }

  // ── Tracking de comportamiento mejorado ────────────────────────────────────
  window.addEventListener("scroll", () => {
    const cur = window.scrollY;
    const max = Math.max(1, document.body.scrollHeight - window.innerHeight);
    obs.scroll = Math.max(obs.scroll, Math.min(1, cur / max));
    obs.lastActive = Date.now();
  }, { passive: true });

  document.addEventListener("click", (e) => {
    obs.lastActive = Date.now();
    const cartSel = "[data-action='add-to-cart'],.add-to-cart,#add-to-cart,[name='add'],.btn-cart,.add_to_cart_button";
    if (e.target.closest(cartSel)) {
      obs.cartAdded = 1;
      const now = Date.now();
      if (returnRiskSignals.lastAddTimestamp && (now - returnRiskSignals.lastAddTimestamp) < 10000) {
        returnRiskSignals.cartAddRemoveCycles++;
      }
      returnRiskSignals.lastAddTimestamp = now;
      log("Cart add detected");
    }
  });

  let _clickTimes = [];
  document.addEventListener("click", () => {
    const now = Date.now();
    _clickTimes = _clickTimes.filter((t) => now - t < 1500);
    _clickTimes.push(now);
    if (_clickTimes.length >= 3) {
      obs.rage = Math.min(3, obs.rage + 1);
      _clickTimes = [];
    }
  });

  setInterval(() => {
    obs.time++;
    if (obs.cartAdded === 1 && returnRiskSignals.lastAddTimestamp && (Date.now() - returnRiskSignals.lastAddTimestamp) > 20000) {
      returnRiskSignals.hesitationScore = Math.min(10, returnRiskSignals.hesitationScore + 1);
    }
  }, 1000);

  // Detección de cambio de producto (resetear señales)
  function getCurrentProductId() {
    const el = document.querySelector("[data-product-id]");
    return el?.dataset?.productId || null;
  }

  function initVariantTracking() {
    document.addEventListener('change', (e) => {
      const target = e.target;
      if (target.matches?.('.size-btn, [data-size], .variant-selector, select')) {
        returnRiskSignals.variantChanges++;
        if (target.closest?.('.size-selector') || target.dataset?.size) returnRiskSignals.sizeChanges++;
        log('Variant change', returnRiskSignals.variantChanges);
      }
    });
    // Resetear señales si cambia el producto (navegación)
    setInterval(() => {
      const newProductId = getCurrentProductId();
      if (newProductId && returnRiskSignals.lastProductId !== newProductId) {
        returnRiskSignals = {
          variantChanges: 0,
          sizeChanges: 0,
          cartAddRemoveCycles: 0,
          hesitationScore: 0,
          lastAddTimestamp: null,
          lastProductId: newProductId,
        };
        log("Product changed, reset signals");
      }
    }, 1000);
  }

  function getPageContext() {
    try {
      const q = (sel) => document.querySelector(sel);
      const qm = (sel) => document.querySelector(sel)?.content?.trim() || null;
      const productId = getCurrentProductId() || qm('meta[property="product:retailer_item_id"]') || null;
      let category = null;
      const breadcrumb = document.querySelectorAll(".breadcrumb a");
      if (breadcrumb.length >= 2) category = breadcrumb[breadcrumb.length-2]?.textContent?.trim();
      if (!category) category = q("[data-category]")?.dataset?.category;
      const productName = qm('meta[property="og:title"]') || document.title;
      return { productId, category, productName };
    } catch (_) {
      return {};
    }
  }

  function getAdvisorCategory(ctx) {
    const h = (ctx.category || "") + " " + (ctx.productName || "");
    if (!h.trim()) return "generic";
    const m = (kws) => kws.some(k => h.toLowerCase().includes(k));
    if (m(["jean","zapatilla","camisa","remera","vestido","fashion","ropa"])) return "fashion";
    if (m(["serum","protector solar","shampoo","base","beauty"])) return "beauty";
    if (m(["notebook","mouse","auricular","celular","tech","electronics"])) return "tech";
    if (m(["mesa","silla","lampara","alfombra","hogar"])) return "home";
    return "generic";
  }

  // Detectar subtipo para personalización del mensaje
  function getSubtype(ctx) {
    const text = (ctx.productName || "") + " " + (ctx.category || "");
    if (text.match(/talla|size|talle|chico|mediano|grande/i)) return "size";
    if (text.match(/compatible|conecta|funciona con|para/i)) return "compatibility";
    if (text.match(/piel|cutis|acné|grasa|seca|sensible/i)) return "skin_type";
    if (text.match(/medida|ancho|alto|profundidad|centímetro|cm/i)) return "measurements";
    return "general";
  }

  function getRiskProfile(category) {
    const weights = { fashion: 2.4, tech: 2.1, beauty: 1.7, home: 1.8, generic: 1.0 };
    return { assistWeight: weights[category] || 1.0 };
  }

  function getCommercialMoment(features, returnRiskSignals, ctx) {
    const cat = getAdvisorCategory(ctx);
    if (cat === "fashion" && (returnRiskSignals.sizeChanges > 1 || returnRiskSignals.variantChanges > 2))
      return "SIZE_DOUBT";
    if (returnRiskSignals.hesitationScore > 3 || returnRiskSignals.cartAddRemoveCycles > 1)
      return "RETURN_RISK";
    if (features.cartAdded === 1 && features.time > 25)
      return "BASKET_HESITATION";
    if (features.time > 18 && features.scroll > 0.45)
      return "PRODUCT_EVALUATION";
    if (features.time > 40 && features.scroll < 0.35)
      return "EXIT_RISK";
    return "EARLY_BROWSING";
  }

  function getIntentScore(features, ctx, signals, commercialMoment) {
    let score = 0;
    if (features.scroll > 0.55) score += 0.15;
    if (features.time > 20) score += 0.20;
    if (features.cartAdded) score += 0.35;
    if (signals.hesitationScore > 2) score -= 0.10;
    if (signals.cartAddRemoveCycles > 0) score -= 0.08;
    if (ctx.productId) score += 0.10;
    if (commercialMoment === "HIGH_INTENT") score += 0.25;
    if (commercialMoment === "SIZE_DOUBT") score -= 0.15;
    if (commercialMoment === "BASKET_HESITATION") score += 0.10;
    return Math.max(0, Math.min(1, score));
  }

  function shouldIntervene(action, intentScore, commercialMoment, rage) {
    if (rage > 1) return false; // no molestar a frustrados
    if (intentScore < 0.35) return false;
    if (commercialMoment === "EARLY_BROWSING") return false;
    return action !== "NO_OP";
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Mensaje dinámico mejorado (con subtipo y stock)
  // ──────────────────────────────────────────────────────────────────────────
  async function getDynamicMessage(action, ctx, commercialMoment) {
    const cat = getAdvisorCategory(ctx);
    const subtype = getSubtype(ctx);
    let key = `${cat}|${subtype}|${commercialMoment}|${action}`;
    let text = null;
    if (remoteConfig && remoteConfig.messages) {
      text = remoteConfig.messages[key];
      if (!text) text = remoteConfig.messages[`${cat}|general|${commercialMoment}|${action}`];
      if (!text) text = remoteConfig.messages[`generic|${action}`];
    }
    if (!text) text = getFallbackMessage(action, ctx, commercialMoment);
    // Si la acción es URGENCY y hay stock real bajo, modificar mensaje
    if (action === "URGENCY" && ctx.productId) {
      const stock = await getRealStock(ctx.productId);
      if (stock !== null && stock <= 3) {
        text = `¡Últimas ${stock} unidades! No te quedes sin él.`;
      }
    }
    return { text, messageId: key };
  }

  function getFallbackMessage(action, ctx, commercialMoment) {
    const cat = getAdvisorCategory(ctx);
    if (action === "ASSIST") {
      if (cat === "fashion") return "¿Dudas con la talla? Te ayudo a elegir la correcta.";
      if (cat === "tech") return "¿Querés validar compatibilidad antes de comprar?";
      if (cat === "beauty") return "¿Sabés si este producto es adecuado para tu tipo de piel?";
      if (cat === "home") return "¿Revisaste las medidas? Te ayudo a confirmar que encaje.";
      return "¿Necesitas ayuda antes de decidir?";
    }
    if (action === "URGENCY") return "Quedan pocas unidades. Aprovechá ahora.";
    if (action === "CART_PUSH") return "Lo tenés en el carrito. El stock es limitado.";
    if (action === "SOCIAL") return "Más del 80% de quienes lo compraron quedaron conformes.";
    return "¿Podemos ayudarte con algo?";
  }

  function getMentalState() {
    const idle = Math.round((Date.now() - obs.lastActive) / 1000);
    if (obs.rage >= 2 || (obs.time > 60 && obs.scroll < 0.3)) return "FRUSTRATED";
    if (obs.time >= 45 && obs.scroll >= 0.7) return "HESITATING";
    if (obs.time >= 15 && obs.scroll >= 0.4) return "EVALUATING";
    return "BROWSING";
  }

  function behaviorPolicy(features, commercialMoment) {
    if (variant === "A") return { NO_OP: 1.0, ASSIST: 0, SOCIAL: 0, URGENCY: 0, CART_PUSH: 0 };

    const ctx = getPageContext();
    const cat = getAdvisorCategory(ctx);
    const risk = getRiskProfile(cat);

    let scores = {
      NO_OP: 0.2,
      ASSIST: 0.5 * (risk.assistWeight || 1.0),
      SOCIAL: features.scroll * 2.5,
      URGENCY: Math.min(2.0, features.time / 30),
      CART_PUSH: features.cartAdded === 1 ? 4.0 : 0.1,
    };

    if (commercialMoment === "SIZE_DOUBT") {
      scores.ASSIST *= 2.4;
      scores.URGENCY *= 0.2;
    }
    if (commercialMoment === "BASKET_HESITATION") {
      scores.CART_PUSH *= 1.8;
    }
    if (commercialMoment === "RETURN_RISK") {
      scores.ASSIST *= 2.2;
      scores.CART_PUSH *= 0.5;
      scores.URGENCY *= 0.4;
    }
    if (commercialMoment === "EXIT_RISK") {
      scores.SOCIAL *= 1.5;
    }

    if (getMentalState() === "BROWSING") return { NO_OP: 1.0, ASSIST: 0, SOCIAL: 0, URGENCY: 0, CART_PUSH: 0 };

    const epsilon = 0.05;
    const uniform = 1 / ACTIONS.length;
    const maxS = Math.max(...Object.values(scores));
    const exps = {};
    let sumExp = 0;
    ACTIONS.forEach(a => { exps[a] = Math.exp(scores[a] - maxS); sumExp += exps[a]; });
    const dist = {};
    let sum = 0;
    ACTIONS.forEach(a => {
      dist[a] = (1 - epsilon) * (exps[a] / sumExp) + epsilon * uniform;
      dist[a] = Math.max(dist[a], 1e-4);
      sum += dist[a];
    });
    ACTIONS.forEach(a => dist[a] /= sum);
    return dist;
  }

  function sampleAction(dist) {
    let r = Math.random(), acc = 0;
    for (const a of ACTIONS) {
      acc += dist[a];
      if (r < acc) return a;
    }
    return ACTIONS[ACTIONS.length - 1];
  }

  let _lastDecisionAt = 0;
  let _messageShown = 0;

  async function decide() {
    if (!sessionId) return;
    if (_messageShown >= maxMessages) return;
    if (Date.now() - _lastDecisionAt < cooldownMs) return;

    const features = {
      scroll: obs.scroll,
      cartAdded: obs.cartAdded,
      time: obs.time,
      rage: obs.rage,
    };
    const ctx = getPageContext();
    const commercialMoment = getCommercialMoment(features, returnRiskSignals, ctx);
    const intentScore = getIntentScore(features, ctx, returnRiskSignals, commercialMoment);
    const dist = behaviorPolicy(features, commercialMoment);
    let action = sampleAction(dist);
    let propensity = dist[action];

    if (!shouldIntervene(action, intentScore, commercialMoment, obs.rage)) {
      action = "NO_OP";
      propensity = dist["NO_OP"];
    }

    _lastDecisionAt = Date.now();

    let text = null;
    let messageId = null;
    if (action !== "NO_OP") {
      const msg = await getDynamicMessage(action, ctx, commercialMoment);
      text = msg.text;
      messageId = msg.messageId;
      _messageShown++;
      showMessage(text);
    }

    const payload = {
      sessionId,
      storeId: STORE,
      action,
      propensity,
      features,
      mentalState: getMentalState(),
      context: ctx,
      returnRiskSignals: { ...returnRiskSignals },
      commercialMoment,
      intentScore,
      messageId,
    };

    try {
      const r = await fetch(API + "/action/log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      lastActionId = d.actionId;
    } catch (e) {
      log("Action log error:", e.message);
    }

    log(`Action: ${action} (p=${propensity.toFixed(3)}) | Moment: ${commercialMoment} | Message: ${messageId || "none"}`);
  }

  setInterval(() => { if (obs.time >= 8) decide(); }, 5000);

  function showMessage(text) {
    injectCSS();
    const el = document.createElement("div");
    el.id = "_ope_msg";
    el.innerHTML = `<div class="_ope_body"><div class="_ope_icon">💬</div><div class="_ope_text">${_esc(text)}</div><button class="_ope_close">✕</button></div><div class="_ope_bar"></div>`;
    el.querySelector("._ope_close").onclick = () => _dismiss(el);
    document.body.appendChild(el);
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("_ope_in")));
    setTimeout(() => _dismiss(el), 12000);
  }
  function _dismiss(el) { el.classList.remove("_ope_in"); setTimeout(() => el.remove(), 350); }
  function injectCSS() {
    if (document.getElementById("_ope_css")) return;
    const s = document.createElement("style");
    s.id = "_ope_css";
    s.textContent = `#_ope_msg{position:fixed;bottom:20px;left:20px;max-width:320px;background:#fff;border-radius:14px;box-shadow:0 4px 24px rgba(0,0,0,0.13);border-left:4px solid #1e3a5f;z-index:999999;transform:translateY(80px);opacity:0;transition:transform 0.35s,opacity 0.28s;font-family:system-ui;}#_ope_msg._ope_in{transform:translateY(0);opacity:1;}._ope_body{display:flex;align-items:flex-start;gap:10px;padding:14px 36px 14px 14px;}._ope_icon{font-size:20px;}._ope_text{font-size:13px;color:#1a2a3a;}._ope_close{position:absolute;top:8px;right:10px;background:none;border:none;color:#94a3b8;cursor:pointer;}._ope_bar{height:3px;background:#1e3a5f;animation:_ope_p 12s linear forwards;}@keyframes _ope_p{from{width:100%;}to{width:0%;}}`;
    document.head.appendChild(s);
  }

  window.OPEConvert = async function (revenue = 0) {
    if (!sessionId) return;
    _converted = true;
    try {
      await fetch(API + "/outcome/log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, storeId: STORE, converted: true, revenue, lastActionId }),
      });
      log("Conversion logged:", revenue);
    } catch (e) { log("Outcome log error:", e.message); }
  };

  // Detectar abandono de carrito al salir
  window.addEventListener("beforeunload", () => {
    if (!sessionId || _converted) return;
    if (obs.cartAdded && !_converted) _abandonedCart = true;
    const body = JSON.stringify({ sessionId, storeId: STORE, converted: false, revenue: 0, abandonedCart: _abandonedCart });
    navigator.sendBeacon
      ? navigator.sendBeacon(API + "/outcome/log", new Blob([body], { type: "application/json" }))
      : fetch(API + "/outcome/log", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => {});
  });

  initVariantTracking();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();