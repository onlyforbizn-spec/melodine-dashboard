// api/kpis.js — Mélodine dashboard backend (Vercel serverless, Node 18+)
// Interroge Shopify (trafic, ventes, checkout) + Gmail (demandes d'extrait, matching)
// Aucune clé n'est dans ce fichier : tout vient des variables d'environnement Vercel.

const SHOP = process.env.SHOPIFY_STORE;            // ex: c4vfmv-0s.myshopify.com
const SHOP_TOKEN = process.env.SHOPIFY_TOKEN;      // Admin API access token
const G_ID = process.env.GOOGLE_CLIENT_ID;
const G_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const G_REFRESH = process.env.GOOGLE_REFRESH_TOKEN;
const API_VER = "2024-10";
const SUBJECT = 'subject:"Nouvelle demande extrait"';

// ---------- dates (Europe/Paris) ----------
function parisToday() {
  const p = new Intl.DateTimeFormat("fr-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  return p; // YYYY-MM-DD
}
function addDays(iso, n) {
  const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function rangeDates(range) {
  const today = parisToday();
  if (range === "today") return { start: today, end: today };
  if (range === "yesterday") { const y = addDays(today, -1); return { start: y, end: y }; }
  if (range === "7d") return { start: addDays(today, -6), end: today };
  return { start: addDays(today, -29), end: today }; // 30d
}
// Décalage (ms) d'un fuseau pour une date donnée
function tzOffsetMs(date, tz) {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const p = dtf.formatToParts(date).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - date.getTime();
}
// Epoch (secondes) de minuit, heure de Paris, pour une date YYYY-MM-DD
function parisDayStartEpoch(iso) {
  const base = new Date(iso + "T00:00:00Z");
  const off = tzOffsetMs(base, "Europe/Paris");
  return Math.floor((base.getTime() - off) / 1000);
}
// Exécute fn sur tous les items avec une concurrence limitée (parallélisme)
async function mapPool(items, concurrency, fn) {
  const ret = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) { const idx = i++; ret[idx] = await fn(items[idx], idx); }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length || 1) }, worker));
  return ret;
}

// ---------- Shopify ----------
async function shopifyql(q) {
  const r = await fetch(`https://${SHOP}/admin/api/${API_VER}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": SHOP_TOKEN },
    body: JSON.stringify({
      query: `query($q:String!){ shopifyqlQuery(query:$q){ parseErrors tableData { columns { name } rows } } }`,
      variables: { q }
    })
  });
  let j;
  try { j = await r.json(); } catch (e) { throw new Error(`HTTP ${r.status} (réponse non-JSON)`); }
  if (j.errors) {
    const msg = Array.isArray(j.errors) ? j.errors.map(e => e.message || JSON.stringify(e)).join("; ")
              : typeof j.errors === "string" ? j.errors
              : JSON.stringify(j.errors);
    throw new Error(`HTTP ${r.status} — ${msg}`);
  }
  const node = j?.data?.shopifyqlQuery;
  if (!node) throw new Error("data.shopifyqlQuery absent");
  if (node.parseErrors && node.parseErrors.length) throw new Error("ShopifyQL: " + node.parseErrors.join(" | "));
  if (!node.tableData) return [];
  return node.tableData.rows || []; // rows = tableau d'objets {colonne: valeur}
}

async function shopifyMetrics(start, end, errors) {
  const out = { visites: 0, reached_checkout: 0, completed_checkout: 0, ventes: 0, ca: 0, aov: null };
  try {
    const sales = await shopifyql(`FROM sales SHOW orders, total_sales, average_order_value SINCE ${start} UNTIL ${end}`);
    if (sales && sales[0]) {
      out.ventes = Math.round(+sales[0].orders || 0);
      out.ca = +(+sales[0].total_sales || 0).toFixed(2);
      out.aov = out.ventes ? +(out.ca / out.ventes).toFixed(2) : null;
    }
  } catch (e) { errors.push("shopify/sales: " + e.message); }
  try {
    const ses = await shopifyql(`FROM sessions SHOW sessions, sessions_that_reached_checkout, sessions_that_completed_checkout SINCE ${start} UNTIL ${end}`);
    if (ses && ses[0]) {
      out.visites = Math.round(+ses[0].sessions || 0);
      out.reached_checkout = Math.round(+ses[0].sessions_that_reached_checkout || 0);
      out.completed_checkout = Math.round(+ses[0].sessions_that_completed_checkout || 0);
    }
  } catch (e) { errors.push("shopify/sessions: " + e.message); }
  return out;
}

// Compte (sans lire d'email) les commandes payées d'un prospect dans la période
async function hasPaidOrder(email, start, end) {
  const q = `email:${email} financial_status:paid created_at:>=${start} created_at:<=${addDays(end, 1)}`;
  const r = await fetch(`https://${SHOP}/admin/api/${API_VER}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": SHOP_TOKEN },
    body: JSON.stringify({ query: `query($q:String!){ orders(first:1, query:$q){ edges { node { id } } } }`, variables: { q } })
  });
  const j = await r.json();
  return (j?.data?.orders?.edges?.length || 0) > 0;
}

// ---------- Gmail ----------
async function gmailToken() {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: G_ID, client_secret: G_SECRET, refresh_token: G_REFRESH, grant_type: "refresh_token" })
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("Gmail auth: " + (j.error_description || j.error || "token refusé"));
  return j.access_token;
}
async function gListIds(token, q) {
  let ids = [], pageToken = null;
  do {
    const u = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    u.searchParams.set("q", q); u.searchParams.set("maxResults", "100");
    if (pageToken) u.searchParams.set("pageToken", pageToken);
    const r = await fetch(u, { headers: { Authorization: "Bearer " + token } });
    const j = await r.json();
    if (j.error) throw new Error("Gmail list: " + j.error.message);
    (j.messages || []).forEach(m => ids.push(m.id));
    pageToken = j.nextPageToken || null;
  } while (pageToken);
  return ids;
}
async function gExtractEmail(token, id) {
  const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, { headers: { Authorization: "Bearer " + token } });
  const j = await r.json();
  let text = j?.snippet || "";
  const parts = j?.payload?.parts || (j?.payload?.body ? [j.payload.body] : []);
  for (const p of parts) { if (p?.body?.data) { try { text += " " + Buffer.from(p.body.data, "base64").toString("utf8"); } catch (e) {} } }
  const m = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g);
  if (!m) return null;
  const bad = /noreply|no-reply|web3forms|melodine|gmail-noreply/i;
  return (m.find(e => !bad.test(e)) || null)?.toLowerCase() || null;
}

// ---------- handler ----------
module.exports = async (req, res) => {
  const range = (req.query?.range || "yesterday").toString();
  const { start, end } = rangeDates(range);
  const days = Math.round((new Date(end) - new Date(start)) / 86400000) + 1;
  const result = { range, start, end, errors: [], partial: {} };

  // Shopify (toutes fenêtres)
  try {
    Object.assign(result, await shopifyMetrics(start, end, result.errors));
  } catch (e) { result.errors.push("shopify: " + e.message); }

  // Gmail : nombre de demandes (toutes fenêtres)
  let token = null;
  try {
    token = await gmailToken();
    const startEp = parisDayStartEpoch(start);
    const endEp = parisDayStartEpoch(addDays(end, 1)); // minuit Paris du lendemain
    const ids = await gListIds(token, `${SUBJECT} after:${startEp} before:${endEp}`);
    result.demandes_brut = ids.length;

    // Matching exact : seulement sur fenêtres courtes (sinon trop long en live → prévoir un cron)
    if (days <= 2 && ids.length <= 600) {
      const extracted = await mapPool(ids, 15, id => gExtractEmail(token, id).catch(() => null));
      const emails = new Set(extracted.filter(Boolean));
      result.demandes_uniques = emails.size;
      const uniq = [...emails];
      const flags = await mapPool(uniq, 10, e => hasPaidOrder(e, start, end).catch(() => false));
      result.matched_ventes = flags.filter(Boolean).length;
    } else {
      result.matched_ventes = null;
      result.partial.matching = "fenêtre trop large pour le matching live";
    }
  } catch (e) {
    result.errors.push("gmail: " + e.message);
    if (result.demandes_brut == null) result.demandes_brut = null;
  }

  res.setHeader("Cache-Control", "no-store");
  res.status(200).json(result);
};
