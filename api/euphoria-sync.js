// api/euphoria-sync.js
const { supabase } = require('./_supabase');
const { requireAdmin } = require('./_auth');

// Hardcoded fallback list (lowercase). Used as a safety net in case the
// dynamic lookup misses someone. The dynamic detection below is the
// primary source of truth.
const EVW_MEMBERS_FALLBACK = new Set([
  'theragnarok1', 'merukii', 'lucifer.seraphim',
  'kittie.doll', 'saltypotion', 'serena5579',
  'vaphnova.hexem', 'ghostiegrimm', 'thicc.snacc', 'laezimir'
]);

// Build the live set of known clan member usernames at sync time.
// Sources:
//   1. users.username (website login)
//   2. users.sl_username (SL username)
//   3. activity_log.reported_by — extract the username inside the parens
async function buildKnownMembers() {
  const known = new Set();

  // From users table
  const { data: users } = await supabase
    .from('users')
    .select('username, sl_username')
    .eq('is_approved', true);

  for (const u of users || []) {
    if (u.username)    known.add(u.username.toLowerCase().trim());
    if (u.sl_username) known.add(u.sl_username.toLowerCase().trim());
  }

  // From activity_log — anyone who has ever used the HUD is one of us
  const { data: logs } = await supabase
    .from('activity_log')
    .select('reported_by')
    .not('reported_by', 'is', null);

  for (const row of logs || []) {
    if (!row.reported_by) continue;
    // Format: "Display Name (username)" — extract the username from inside ()
    const m = row.reported_by.match(/\(([^)]+)\)\s*$/);
    if (m) known.add(m[1].toLowerCase().trim());
  }

  // Always include the fallback list too
  for (const name of EVW_MEMBERS_FALLBACK) known.add(name);

  return known;
}

function norm(s) { return (s || '').trim().toLowerCase(); }

function extractRegionFromSLURL(url) {
  if (!url) return null;
  const m = url.match(/secondlife[.:/]+([^/]+)\/\d+\/\d+\/\d+/i);
  if (!m) return null;
  return decodeURIComponent(m[1]).replace(/\+/g, ' ').trim();
}

function parseTimestamp(ts) {
  if (!ts) return null;
  return new Date(ts).toISOString();
}

function parseEuphoriaJSON(json) {
  const records = [];
  for (const msg of json.messages || []) {
    const ts     = parseTimestamp(msg.timestamp);
    const embeds = msg.embeds || [];
    const content = (msg.content || '').trim();

    for (const embed of embeds) {
      const title = (embed.title || '').trim();
      if (!title.includes('has placed a Realm Crystal!')) continue;

      let claimer = '';
      const m = title.match(/^(.+?) has placed a Realm Crystal!$/);
      if (m) {
        claimer = m[1].trim();
        if (/^[\ufdd0\uFFFD\s]+$/.test(claimer)) claimer = '';
      }

      let slurl = '', region = '';
      for (const field of embed.fields || []) {
        const fname = (field.name || '').toLowerCase();
        const fval  = (field.value || '').trim();
        if (fname.includes('location') || fval.includes('maps.secondlife.com')) slurl = fval;
        if (fname === 'region') region = fval;
      }
      if (!region && slurl) region = extractRegionFromSLURL(slurl) || '';
      if (!region) continue;

      records.push({ region, claimer, slurl, timestamp: ts });
    }

    if (!embeds.length && content.includes('maps.secondlife.com')) {
      const urlMatch = content.match(/https?:\/\/maps\.secondlife\.com\/secondlife\/[^\s]+/);
      if (urlMatch) {
        const region = extractRegionFromSLURL(urlMatch[0]) || '';
        if (region) records.push({ region, claimer: '', slurl: urlMatch[0], timestamp: ts });
      }
    }
  }
  return records;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireAdmin(req);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });

  const { json: euphoriaJSON, source } = req.body || {};
  if (!euphoriaJSON) return res.status(400).json({ error: 'No JSON data provided' });

  let parsed;
  try {
    parsed = typeof euphoriaJSON === 'string' ? JSON.parse(euphoriaJSON) : euphoriaJSON;
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON: ' + e.message });
  }

  const records = parseEuphoriaJSON(parsed);
  if (!records.length)
    return res.status(400).json({ error: 'No valid claim records found in file.' });

  // Deduplicate — keep latest per region
  const latestByRegion = {};
  for (const r of records) {
    const key = norm(r.region);
    if (!latestByRegion[key] || r.timestamp > latestByRegion[key].timestamp)
      latestByRegion[key] = r;
  }
  const deduped = Object.values(latestByRegion);

  // Build dynamic set of known clan members from users + activity_log
  const knownMembers = await buildKnownMembers();

  // Fetch all existing lands
  const { data: existingLands, error: fetchError } = await supabase
    .from('lands').select('id, region, status, enemy_claimer, updated_at, claimed_at');
  if (fetchError) return res.status(500).json({ error: 'DB fetch failed: ' + fetchError.message });

  const dbMap = {};
  for (const land of existingLands) dbMap[norm(land.region)] = land;

  const toInsert = [], toUpdate = [], skipped = [], evwOwned = [];
  const errors = [];

  for (const rec of deduped) {
    const key      = norm(rec.region);
    const isEVW    = knownMembers.has(norm(rec.claimer));
    const existing = dbMap[key];
    const claimerVal = isEVW ? '' : (rec.claimer || '');

    if (!existing) {
      toInsert.push({
        region:           rec.region,
        land_name:        '',
        slurl:            rec.slurl || '',
        status:           isEVW ? 'claimed' : 'unclaimed',
        claimed_by:       '',
        enemy_claimer:    claimerVal,
        enemy_claimed_at: !isEVW ? rec.timestamp : null,
        first_seen:       rec.timestamp,
        claimed_at:       isEVW ? rec.timestamp : null,
        updated_at:       rec.timestamp,
      });
    } else {
      const dbUpdatedAt  = existing.updated_at ? new Date(existing.updated_at) : new Date(0);
      const recTimestamp = rec.timestamp        ? new Date(rec.timestamp)       : new Date(0);
      const logIsNewer   = recTimestamp > dbUpdatedAt;

      if (existing.status === 'claimed' && !logIsNewer) {
        skipped.push(rec.region); continue;
      }
      if (existing.status === 'claimed' && logIsNewer && !isEVW) {
        toUpdate.push({ id: existing.id, status: 'unclaimed', enemy_claimer: claimerVal,
          claimed_by: '', claimed_at: null, enemy_claimed_at: rec.timestamp,
          updated_at: rec.timestamp,
          slurl: rec.slurl || existing.slurl || '' });
      } else if (existing.status === 'claimed' && logIsNewer && isEVW) {
        evwOwned.push(rec.region);
      } else if (existing.status === 'unclaimed') {
        if (logIsNewer && !isEVW) {
          toUpdate.push({ id: existing.id, enemy_claimer: claimerVal,
            enemy_claimed_at: rec.timestamp,
            slurl: rec.slurl || existing.slurl || '', updated_at: rec.timestamp });
        } else if (logIsNewer && isEVW) {
          toUpdate.push({ id: existing.id, status: 'claimed', claimed_at: rec.timestamp,
            updated_at: rec.timestamp, slurl: rec.slurl || existing.slurl || '' });
        } else { skipped.push(rec.region); }
      }
    }
  }

  let inserted = 0, updated = 0;

  if (toInsert.length) {
    const { error } = await supabase.from('lands').insert(toInsert);
    if (error) errors.push('Insert error: ' + error.message);
    else inserted = toInsert.length;
  }

  for (const upd of toUpdate) {
    const { id, ...fields } = upd;
    const { error } = await supabase.from('lands').update(fields).eq('id', id);
    if (error) errors.push('Update error: ' + error.message);
    else updated++;
  }

  // ── Log this sync run ────────────────────────────────────
  await supabase.from('sync_log').insert({
    ran_by:   auth.user.username,
    parsed:   deduped.length,
    inserted,
    updated,
    skipped:  skipped.length,
    errors:   errors.length ? errors.join('; ') : null,
    source:   source || 'manual',
  });

  return res.status(200).json({
    success: true,
    parsed:  deduped.length,
    inserted, updated,
    skipped: skipped.length,
    evwOwned: evwOwned.length,
    errors:  errors.length ? errors : undefined,
    details: {
      new_regions:     toInsert.map(r => r.region),
      updated_regions: toUpdate.map(r => existingLands.find(e => e.id === r.id)?.region || r.id),
      skipped_regions: skipped,
    }
  });
};
