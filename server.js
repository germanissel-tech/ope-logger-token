// ... (todo igual hasta la línea del endpoint /api/client-metrics)
app.get("/api/client-metrics/:storeId", (req, res) => {
  if (rateLimit(req, res, 500)) return;
  const storeId = safe(req.params.storeId);
  if (!storeId) return res.status(400).json({ error: "storeId required" });
  
  let fromTs = parseInt(req.query.from) || null;
  let toTs = parseInt(req.query.to) || null;
  
  // Si no se pasan fechas, obtener el mínimo y máximo started_at de las sesiones de esa tienda
  if (!fromTs || !toTs) {
    const range = db.prepare("SELECT MIN(started_at) as min, MAX(started_at) as max FROM sessions WHERE store_id = ?").get(storeId);
    fromTs = range.min || (Date.now() - 30*86400000);
    toTs = range.max || Date.now();
  }
  
  const variants = db.prepare(`
    SELECT s.variant,
      COUNT(DISTINCT s.id) AS sessions,
      COALESCE(SUM(o.converted),0) AS conversions,
      COALESCE(SUM(o.revenue),0) AS revenue,
      COALESCE(SUM(o.returned),0) AS returns
    FROM sessions s LEFT JOIN outcomes o ON o.session_id = s.id
    WHERE s.store_id = ? AND s.started_at BETWEEN ? AND ? GROUP BY s.variant
  `).all(storeId, fromTs, toTs);
  // ... resto igual
});
// El resto del archivo no cambia.