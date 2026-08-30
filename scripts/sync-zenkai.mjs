// Synchronise l'API Zenkai (db.builtbyloris.dev) vers Supabase.
// Lancé toutes les 30 minutes par .github/workflows/sync-zenkai.yml
// (ou manuellement : node scripts/sync-zenkai.mjs)

const SUPABASE_URL = 'https://kqqvjcyymbhxkrhjjhqm.supabase.co/rest/v1';
const SUPABASE_KEY = 'sb_publishable_VnpnG8C2ASnQfDUKLIAfQA_Uk1PaSTN';
const API = 'https://db.builtbyloris.dev';

const sbHeaders = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
};

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} sur ${url} : ${await res.text()}`);
  // Prefer: return=minimal renvoie un corps vide avec un 201 (et non un 204) :
  // il faut lire le texte avant de tenter un parse, sinon res.json() échoue.
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function fetchAllCharacters() {
  const chars = [];
  let page = 1, pages = 1;
  do {
    const body = await fetchJson(`${API}/api/characters?hidden=all&limit=500&page=${page}`);
    if (!body.success) throw new Error('Réponse API non-success sur la page ' + page);
    chars.push(...body.data);
    pages = body.pages;
    page++;
  } while (page <= pages);
  return chars;
}

function toRow(c, syncedAt) {
  return {
    char_key: c.charKey,
    discord_id: c.discordId ?? null,
    name: c.name ?? null,
    rank: c.rank ?? null,
    rank_changed_at: c.rankChangedAt ?? null,
    last_played_at: c.lastPlayedAt ?? null,
    first_seen_at: c.firstSeenAt ?? null,
    updated_at: c.updatedAt ?? null,
    hidden: !!c.hidden,
    auto_hidden: !!c.autoHidden,
    divisions: c.divisions ?? [],
    synced_at: syncedAt,
  };
}

async function upsertBatch(rows) {
  await fetchJson(`${SUPABASE_URL}/zenkai_characters?on_conflict=char_key`, {
    method: 'POST',
    headers: { ...sbHeaders, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  });
}

// Grade Zenkai (division medicale) -> grade du site. "Chef"/valeurs
// inconnues sont ignorees (pas de mapping vers un grade du site).
const GRADE_MAP = { Stagiaire: 'stagiaire', Aspirant: 'aspirant', Adepte: 'adepte', Expert: 'expert' };

// Aligne automatiquement le grade (stagiaire/aspirant/adepte/expert) de
// tout compte lie sur son grade actuel dans la division medicale Zenkai
// - role (membre/co-gerant/gerant) et grade sont deux axes independants,
// donc les gerants/co-gerants sont concernes aussi. Seuls les
// observateurs (geres a la main par la gerance, pas lies a Zenkai) sont
// exclus.
async function syncMembreGrades(chars) {
  const bestMedical = {};
  for (const c of chars) {
    if (!c.discordId) continue;
    const medical = (c.divisions || []).find((d) => d && d.type === 'medical');
    if (!medical) continue;
    const prev = bestMedical[c.discordId];
    if (!prev || new Date(c.lastPlayedAt || 0) > new Date(prev.lastPlayedAt || 0)) {
      bestMedical[c.discordId] = { grade: medical.grade, lastPlayedAt: c.lastPlayedAt };
    }
  }

  const shinobis = await fetchJson(
    `${SUPABASE_URL}/shinobis?discord_id=not.is.null&grade=neq.observateur&select=id,discord_id,grade`,
    { headers: sbHeaders }
  );

  let updated = 0;
  for (const s of shinobis) {
    const entry = bestMedical[s.discord_id];
    const mapped = entry && GRADE_MAP[entry.grade];
    if (!mapped || mapped === s.grade) continue;
    await fetchJson(`${SUPABASE_URL}/shinobis?id=eq.${s.id}`, {
      method: 'PATCH',
      headers: { ...sbHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({ grade: mapped }),
    });
    updated++;
  }
  console.log(`${updated} grade(s) de membre aligne(s) sur Zenkai`);
}

async function logSync(count, stats, ok, error) {
  try {
    await fetchJson(`${SUPABASE_URL}/zenkai_sync_log`, {
      method: 'POST',
      headers: { ...sbHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify([{ characters_count: count, stats, ok, error }]),
    });
  } catch (e) {
    console.error('Impossible d\'écrire le log de synchro :', e.message);
  }
}

async function main() {
  const syncedAt = new Date().toISOString();
  try {
    const chars = await fetchAllCharacters();
    console.log(`${chars.length} personnages récupérés depuis l'API Zenkai`);

    const rows = chars.map((c) => toRow(c, syncedAt));
    for (let i = 0; i < rows.length; i += 500) {
      await upsertBatch(rows.slice(i, i + 500));
      console.log(`Upsert ${Math.min(i + 500, rows.length)} / ${rows.length}`);
    }

    // Purge des personnages disparus de l'API (non touchés par ce run)
    await fetchJson(`${SUPABASE_URL}/zenkai_characters?synced_at=lt.${encodeURIComponent(syncedAt)}`, {
      method: 'DELETE',
      headers: { ...sbHeaders, Prefer: 'return=minimal' },
    });

    await syncMembreGrades(chars);

    const statsBody = await fetchJson(`${API}/api/stats`);
    await logSync(rows.length, statsBody.data ?? null, true, null);
    console.log('Synchronisation terminée avec succès');
  } catch (e) {
    console.error('Échec de la synchronisation :', e.message);
    await logSync(null, null, false, String(e.message).slice(0, 1000));
    process.exit(1);
  }
}

main();
