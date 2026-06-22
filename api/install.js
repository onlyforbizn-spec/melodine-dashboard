// api/install.js — point d'entrée OAuth unique pour obtenir un vrai token Admin API Shopify.
const SHOP = process.env.SHOPIFY_STORE;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const SCOPES = "read_orders,read_reports,read_analytics";
const REDIRECT = "https://melodine-dashboard.vercel.app/api/install";

module.exports = async (req, res) => {
  const code = req.query?.code;

  if (!code) {
    const url = `https://${SHOP}/admin/oauth/authorize`
      + `?client_id=${CLIENT_ID}`
      + `&scope=${encodeURIComponent(SCOPES)}`
      + `&redirect_uri=${encodeURIComponent(REDIRECT)}`
      + `&state=melodine`;
    res.writeHead(302, { Location: url });
    return res.end();
  }

  try {
    const r = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code })
    });
    const j = await r.json();
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (j.access_token) {
      res.status(200).end(
        `<div style="font-family:system-ui;max-width:680px;margin:60px auto;padding:0 20px">
          <h2 style="color:#00875A">Token Shopify obtenu ✅</h2>
          <p>Copie ce token et colle-le dans Vercel → variable <b>SHOPIFY_TOKEN</b> (remplace l'ancien), puis Redeploy :</p>
          <pre style="background:#F5F1EA;border:1px solid #ddd;border-radius:10px;padding:18px;font-size:16px;white-space:pre-wrap;word-break:break-all;user-select:all">${j.access_token}</pre>
          <p style="color:#666">Scopes accordés : ${j.scope || SCOPES}</p>
        </div>`
      );
    } else {
      res.status(500).end(`<pre style="font-family:system-ui;padding:30px">Échec de l'échange OAuth :\n\n${JSON.stringify(j, null, 2)}</pre>`);
    }
  } catch (e) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(500).end(`<pre style="font-family:system-ui;padding:30px">Erreur : ${e.message}</pre>`);
  }
};
