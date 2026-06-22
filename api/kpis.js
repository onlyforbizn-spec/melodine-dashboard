// api/kpis.js — Mélodine dashboard backend (Vercel serverless, Node 18+)
// Interroge Shopify (trafic, ventes, checkout) + Gmail (demandes d'extrait, matching)
// Aucune clé n'est dans ce fichier : tout vient des variables d'environnement Vercel.

const SHOP = process.env.SHOPIFY_STORE;
const SHOP_TOKEN = process.env.SHOPIFY_TOKEN;
const G_ID = process.env.GOOGLE_CLIENT_ID;
const G_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const G_REFRESH = process.env.GOOGLE_REFRESH_TOKEN;
const API_VER = "2024-10";
const SUBJECT = 'subject:"Nouvelle demande extrait"';

function parisToday() {
  const p = new Intl.DateTimeFormat("fr-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  return p;
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
  return { start: addDays(today, -29), end: today };
}
const slash = iso => iso.replace(/-/g, "/");

async function shopifyql(q) {
  const r = await fetch(`https://${SHOP}/admin/api/${API_VER}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": SHOP_TOKEN },
    body: JSON.stringify({
      query: `query($q:String!){ shopifyqlQuery(query:$q){ __typename ... on TableResponse { tableData { rowData columns { name } } } ... on PolarisVizResponse { __typename } parseErrors { code message } } }`,
      variables: { q }
    })
  });
  const j = await r.json();
  const node = j?.data?.shopifyqlQuery;
  if (!node || node.__typename !== "TableResponse") return null;
  const cols = node.tableData.columns.map(c => c.name);
  return node.tableData.rowData.map(row => Object.fromEntries(row.map((v, i) => [cols[i], v])));
}

async function shopifyMetrics(start, end) {
  const out = { visites: 0, reached_checkout: 0, completed_checkout: 0, ventes: 0, ca: 0, aov: null };
  try {
    const sales = await shopifyql(`FROM sales SHOW orders, total_sales, average_order_value SINCE '${start}' UNTIL '${end}'`);
    if (sales && sales[0]) {
      out.ventes = Math.round(+sales[0].orders || 0);
      out.ca = +(+sales[0].total_sales || 0).toFixed(2);
      out.aov = out.ventes ? +(out.ca / out.ventes).toFixed(2) : null;
    }
  } catch (e) {}
  try {
    const ses = await shopifyql(`FROM sessions SHOW sessions, sessions_that_reached_checkout, sessions_that_completed_checkout SINCE '${start}' UNTIL '${end}'`);
    if (ses && ses[0]) {
      out.visites = Math.round(+ses[0].sessions || 0);
      out.reached_checkout = Math.round(+ses[0].sessions_that_reached_checkout || 0);
      out.completed_checkout = Math.round(+ses[0].sessions_that_completed_checkout || 0);
    }
  } catch (e) {}
  return out;
}

async function hasPaidOrder(email, start, end) {
  const q = `email:${email} financial_status:paid created_at:>=${start} created_at:<=${end}`;
  const r = await fetch(`https://${SHOP}/admin/api/${API_VER}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": SHOP_TOKEN },
    body: JSON.stringify({ query: `query($q:String!){ orders(first:1, query:$q){ edges { node { id } } } }`, variables: { q } })
  });
  const j = await r.json();
  return (j?.data?.orders?.edges?.length || 0) > 0;
}

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

module.exports = async (req, res) => {
  const range = (req.query?.range || "yesterday").toString();
  const { start, end } = rangeDates(range);
  const days = Math.round((new Date(end) - new Date(start)) / 86400000) + 1;
  const result = { range, start, end, errors: [], partial: {} };

  try {
    Object.assign(result, await shopifyMetrics(start, end));
  } catch (e) { result.errors.push("shopify: " + e.message); }

  let token = null;
  try {
    token = await gmailToken();
    const ids = await gListIds(token, `${SUBJECT} after:${slash(start)} before:${slash(addDays(end, 1))}`);
    result.demandes_brut = ids.length;

    if (days <= 2 && ids.length <= 400) {
      const emails = new Set();
      for (const id of ids) { const e = await gExtractEmail(token, id); if (e) emails.add(e); }
      result.demandes_uniques = emails.size;
      let matched = 0;
      for (const e of emails) { try { if (await hasPaidOrder(e, start, end)) matched++; } catch (err) {} }
      result.matched_ventes = matched;
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
