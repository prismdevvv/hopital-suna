// =====================================================================
// common.js — Fonctions partagées entre index.html (app.js) et
// admin.html (admin.js) : accès Supabase, hash du sceau, échappement
// HTML, gestion de session, thème clair/sombre.
//
// Regrouper ce code évite la duplication (il était identique dans les
// deux fichiers) et centralise les points sensibles pour la sécurité
// (session, échappement) pour que les corrections s'appliquent
// automatiquement partout.
// =====================================================================

const SUPABASE_URL = 'https://kqqvjcyymbhxkrhjjhqm.supabase.co/rest/v1';
const SUPABASE_KEY = 'sb_publishable_VnpnG8C2ASnQfDUKLIAfQA_Uk1PaSTN';

const SUPA_HEADERS = {
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  'Prefer': 'return=representation'
};

// --- Petit helper d'erreur qui ne fait jamais fuiter le corps brut
// d'une réponse Postgrest dans l'UI (juste dans la console, pour debug) ---
async function supaError(res) {
  let detail = '';
  try { detail = await res.text(); } catch (_) {}
  console.error(`Supabase ${res.status} ${res.statusText}:`, detail);
  const err = new Error(detail || `Erreur ${res.status}`);
  err.status = res.status;
  err.raw = detail;
  return err;
}

// `minimal`: quand true, demande à Postgrest de ne pas renvoyer la ligne
// modifiée (Prefer: return=minimal). Indispensable pour les écritures sur
// `shinobis` : la colonne `sceau` n'est plus lisible par la clé publique
// (voir 02_rls_et_rpc.sql), donc une réponse "return=representation" sur
// cette table échouerait puisque Postgrest tenterait de la relire.
function headersFor(minimal) {
  return minimal ? { ...SUPA_HEADERS, 'Prefer': 'return=minimal' } : SUPA_HEADERS;
}

async function supaGet(table, query = '') {
  const res = await fetch(`${SUPABASE_URL}/${table}?${query}`, { headers: SUPA_HEADERS });
  if (!res.ok) throw await supaError(res);
  return res.json();
}

async function supaPost(table, data, minimal = false) {
  const res = await fetch(`${SUPABASE_URL}/${table}`, {
    method: 'POST', headers: headersFor(minimal), body: JSON.stringify(data)
  });
  if (!res.ok) throw await supaError(res);
  return minimal ? null : res.json();
}

// `keepalive`: permet à la requête de survivre à la fermeture de la page
// (utilisé pour clôturer un poste sur pagehide, cf. app.js).
async function supaPatch(table, query, data, minimal = false, keepalive = false) {
  const res = await fetch(`${SUPABASE_URL}/${table}?${query}`, {
    method: 'PATCH', headers: headersFor(minimal), body: JSON.stringify(data), keepalive
  });
  if (!res.ok) throw await supaError(res);
  return minimal ? null : res.json();
}

// Toujours en mode minimal : aucun appelant n'utilise la ligne supprimée,
// et pour `shinobis` c'est requis (voir headersFor ci-dessus).
async function supaDelete(table, query) {
  const res = await fetch(`${SUPABASE_URL}/${table}?${query}`, { method: 'DELETE', headers: headersFor(true) });
  if (!res.ok) throw await supaError(res);
}

async function supaUpsert(table, data, query = '') {
  const res = await fetch(`${SUPABASE_URL}/${table}${query}`, {
    method: 'POST',
    headers: { ...SUPA_HEADERS, 'Prefer': 'return=representation,resolution=merge-duplicates' },
    body: JSON.stringify(data)
  });
  if (!res.ok) throw await supaError(res);
  return res.json();
}

// Appel d'une fonction Postgres exposée en RPC par Postgrest (ex:
// verifier_sceau, qui compare le sceau côté serveur sans jamais
// renvoyer sa valeur au navigateur).
async function supaRpc(fn, args = {}) {
  const res = await fetch(`${SUPABASE_URL}/rpc/${fn}`, {
    method: 'POST', headers: SUPA_HEADERS, body: JSON.stringify(args)
  });
  if (!res.ok) throw await supaError(res);
  // Une fonction qui renvoie void (ex. set_discord_id) répond 204 sans
  // corps : res.json() planterait dessus alors que l'appel a réussi.
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// --- Hash du "sceau" (mot de passe RP) ---
// IMPORTANT (voir SECURITY.md) : ce hash SHA-256 côté client protège
// contre la lecture "à l'œil nu" d'un mot de passe en clair, mais ne
// protège PAS contre quelqu'un qui lit directement la table `shinobis`
// via la clé publique Supabase (anon key) : il pourrait alors essayer
// de casser les hashs hors-ligne. La vraie protection vient des règles
// RLS côté Supabase — voir SECURITY.md.
async function hashSceau(sceau) {
  const data = new TextEncoder().encode(sceau);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// --- Échappement HTML (obligatoire avant toute insertion via innerHTML
// de texte qui vient d'un utilisateur ou d'une source externe) ---
function escapeHtml(text) {
  const d = document.createElement('div');
  d.textContent = text == null ? '' : String(text);
  return d.innerHTML;
}

// --- Session ---
// On ne stocke JAMAIS le hash du sceau dans localStorage : un script
// tiers (extension malveillante, XSS ailleurs sur le domaine, accès
// physique au poste) qui lirait le localStorage n'a alors accès à
// aucun secret réutilisable pour se faire passer pour l'utilisateur
// ailleurs.
function sanitizeUserForStorage(user) {
  if (!user) return null;
  const { sceau, ...safe } = user;
  return safe;
}

function saveSession(key, user) {
  localStorage.setItem(key, JSON.stringify(sanitizeUserForStorage(user)));
}

function loadSession(key) {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

function clearSession(key) {
  localStorage.removeItem(key);
}

// --- Génère un mot de passe temporaire lisible (pour la création de
// comptes "observateur" côté gérance, à la place d'un sceau vide) ---
function generateTempSceau() {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(36)).join('').slice(0, 10);
}

// --- Connexion Discord + vérification Zenkai (division Médical) ---
// Flux OAuth "implicite" (response_type=token) : Discord renvoie l'access
// token directement dans le fragment d'URL, sans jamais faire intervenir
// de client secret — indispensable puisque le site est 100% statique.
const DISCORD_CLIENT_ID = '1543006820904345651';
const ZENKAI_MEDICAL_DIVISION = 'medical';

function discordAuthUrl(redirectUri) {
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'token',
    scope: 'identify'
  });
  return `https://discord.com/api/oauth2/authorize?${params}`;
}

// URL de la page courante, normalisée pour toujours finir par le nom du
// fichier (ex. "/hopital-suna/index.html" et pas juste "/hopital-suna/",
// que GitHub Pages sert pourtant pareil) : Discord refuse un redirect_uri
// qui ne correspond pas EXACTEMENT à ce qui est enregistré côté appli.
function currentPageUrl() {
  let path = location.pathname;
  if (path.endsWith('/')) path += 'index.html';
  return location.origin + path;
}

// Lit le token dans le fragment renvoyé par Discord après connexion, puis
// nettoie immédiatement l'URL pour ne pas le laisser dans l'historique.
function parseDiscordFragment() {
  if (!location.hash) return null;
  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get('access_token');
  if (!token) return null;
  history.replaceState(null, '', location.pathname + location.search);
  return token;
}

async function discordFetchMe(token) {
  const res = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) throw new Error(`Discord ${res.status}`);
  return res.json();
}

// Renvoie les personnages Zenkai de ce discord_id qui sont dans la
// division Médical, ainsi que le nombre total de personnages (pour
// distinguer "aucun personnage" de "aucun en Médical").
async function findZenkaiMedicalCharacters(discordId) {
  const all = await supaGet('zenkai_characters', `discord_id=eq.${encodeURIComponent(discordId)}&select=char_key,name,divisions`);
  // `divisions` est un tableau d'objets {type, chief, grade, faction, ...},
  // pas un tableau de libellés ("medical", pas "Médical" comme affiché
  // dans les filtres de la page Patients).
  const medical = all.filter(c => Array.isArray(c.divisions) && c.divisions.some(d => d && d.type === ZENKAI_MEDICAL_DIVISION));
  return { total: all.length, medical };
}

// Le nom Zenkai est au format "Prénom Nom".
function splitZenkaiName(name) {
  const parts = String(name || '').trim().split(/\s+/);
  return { prenom: parts[0] || '', nom: parts.slice(1).join(' ') || '' };
}

// Retrouve (ou crée) la fiche shinobi correspondant à ce discord_id +
// personnage Zenkai retenu, et la renvoie (mêmes champs que verifier_sceau
// renvoyait auparavant).
async function resolveShinobiForCharacter(discordId, character) {
  const { prenom, nom } = splitZenkaiName(character.name);
  let users = await supaGet('shinobis', `discord_id=eq.${encodeURIComponent(discordId)}&select=id,nom,prenom,role,grade,absent,created_at`);
  if (users.length > 0) return users[0];

  // Compte créé avant ce changement (nom/prénom identiques, comparaison
  // insensible à la casse au cas où l'orthographe diffère légèrement sur
  // Zenkai) mais pas encore lié à un Discord : on le rattache plutôt que
  // d'en créer un second — ça préserve son grade, sa paye, ses postes,
  // etc. (tous liés à l'id du shinobi, jamais à son nom).
  users = await supaGet('shinobis', `nom=ilike.${encodeURIComponent(nom)}&prenom=ilike.${encodeURIComponent(prenom)}&select=id,nom,prenom,role,grade,absent,created_at`);
  if (users.length > 0) {
    await supaRpc('set_discord_id', { p_shinobi_id: users[0].id, p_discord_id: discordId });
    return users[0];
  }

  const created = await supaPost('shinobis', { nom, prenom, discord_id: discordId, grade: 'stagiaire' });
  return created[0];
}

// --- Thème clair / sombre (identique sur les deux pages) ---
function initThemeToggle() {
  if (localStorage.getItem('hopital_theme') === 'dark') document.body.classList.add('dark');
  const ICO_SUN = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5 5l1.6 1.6M17.4 17.4 19 19M19 5l-1.6 1.6M6.6 17.4 5 19"/></svg>';
  const ICO_MOON = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13.5A7.5 7.5 0 1 1 10.5 4 6 6 0 0 0 20 13.5Z"/></svg>';
  const tbtn = document.getElementById('theme-toggle');
  if (!tbtn) return;
  const sync = () => { tbtn.innerHTML = document.body.classList.contains('dark') ? ICO_SUN : ICO_MOON; };
  sync();
  tbtn.addEventListener('click', () => {
    document.body.classList.toggle('dark');
    localStorage.setItem('hopital_theme', document.body.classList.contains('dark') ? 'dark' : 'light');
    sync();
  });
}
