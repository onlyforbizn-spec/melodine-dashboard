# Mélodine — Dashboard live

Petite app web permanente : une page (`index.html`) + un serveur (`api/kpis.js`) qui interroge
Shopify et Gmail en direct. Tu la déploies une fois sur Vercel, tu bookmarkes l'URL, et c'est à jour
à chaque ouverture. Tes clés restent côté serveur (variables d'environnement) — jamais dans la page.

Il y a 3 choses à récupérer (Shopify, Google/Gmail, puis déploiement). Compte ~15-20 min la 1re fois.

---

## A. Clé Shopify (token Admin API)

1. Admin Shopify → **Paramètres → Applications et canaux de vente → Développer des applications**.
2. **Créer une application** → nomme-la « Dashboard ».
3. Onglet **Configuration → Admin API** → coche ces accès :
   - `read_orders`
   - `read_reports`
   - `read_analytics`
4. **Enregistrer** → **Installer l'application**.
5. Onglet **Identifiants API** → **Révéler le jeton** → copie le **Admin API access token**.

Tu auras besoin de :
- `SHOPIFY_STORE` = `c4vfmv-0s.myshopify.com`
- `SHOPIFY_TOKEN` = le jeton copié

---

## B. Accès Gmail (compte qui reçoit les demandes d'extrait)

But : autoriser l'app à **lire** (uniquement) les mails « Nouvelle demande extrait ».

1. **console.cloud.google.com** → crée un projet (ex. « Melodine »).
2. **APIs & Services → Library** → cherche **Gmail API** → **Enable**.
3. **APIs & Services → OAuth consent screen** → type **External** → renseigne le minimum →
   dans **Test users**, ajoute l'adresse Gmail qui reçoit les leads.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID** →
   type **Web application** → dans **Authorized redirect URIs** ajoute :
   `https://developers.google.com/oauthplayground`
   → crée → copie le **Client ID** et le **Client secret**.
5. Va sur **developers.google.com/oauthplayground** :
   - clique la roue ⚙️ (en haut à droite) → coche **Use your own OAuth credentials** →
     colle Client ID + Client secret.
   - dans le champ de gauche « Input your own scopes », mets :
     `https://www.googleapis.com/auth/gmail.readonly` → **Authorize APIs**.
   - **connecte-toi avec le compte Gmail des leads** et accepte.
   - clique **Exchange authorization code for tokens** → copie le **Refresh token**.

Tu auras besoin de :
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REFRESH_TOKEN` = le refresh token copié

---

## C. Déploiement sur Vercel

Option simple (terminal) :
1. Installe Node si besoin, puis : `npm i -g vercel`
2. Dans le dossier `melodine-app/` : `vercel` (suis les questions, accepte les défauts).
3. Ajoute les variables : `vercel env add` pour chacune, **ou** plus simple via le site :
   **vercel.com → ton projet → Settings → Environment Variables**, ajoute :
   - `SHOPIFY_STORE`
   - `SHOPIFY_TOKEN`
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `GOOGLE_REFRESH_TOKEN`
4. Redéploie : `vercel --prod` (ou bouton **Redeploy** sur le site).
5. Ouvre l'URL `…vercel.app` → **bookmarke-la**. C'est ton dashboard.

(Cloudflare Pages marche aussi, même principe ; dis-moi si tu préfères, je t'adapte.)

---

## Bon à savoir

- **Matching (taux extrait → vente)** : calculé en direct sur **Aujourd'hui** et **Hier**.
  Sur 7 et 30 jours, le volume de mails est trop gros pour le live — on ajoutera un petit calcul
  nocturne (cron Vercel) si tu veux ces fenêtres aussi.
- Si un chiffre reste vide après déploiement, ouvre l'URL `…vercel.app/api/kpis?range=yesterday`
  dans le navigateur : elle renvoie un JSON avec un champ `errors`. Copie-le-moi, je corrige direct.
- Rien de sensible n'est dans le code : les 5 clés vivent uniquement dans Vercel.
