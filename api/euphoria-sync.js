const { supabase } = require('./_supabase');
const { requireAdmin } = require('./_auth');

// ── Helpers ──────────────────────────────────────────────────
const EVW_MEMBERS = new Set([
  'theragnarok1 resident', 'merukii resident', 'lucifer seraphim',
  'kittie doll', 'saltypotion resident', 'serena5579 resident',
  'vaphnova hexem', 'ghostiegrimm resident', 'thicc snacc', 'laezimir resident'
]);

function norm(s) { return (s || '').trim().toLowerCase(); }

function extractRegionFromSLURL(url) {
  if (!url) return null;
  const m = url.match(/secondlife[.:/]+([^/]+)\/\d+\/\d+\/\d+/i);
  if (!m) return null;
  return decodeURIComponent(m[1]).replace(/\+/g, ' ').trim();
}

function parseTimestamp(ts) {
  if (!ts) return null;
  // Strip timezone offset and milliseconds, return ISO string
  return new Date(ts).toISOString();
}

function parseEuphoriaJSON(json) {
  const records = []; // { region, claimer, slurl, timestamp }

  for (const msg of json.messages || []) {
    const ts = parseTimestamp(msg.timestamp);
    const embeds = msg.embeds || [];
    const content = (msg.content || '').trim();

    // ── Parse embed messages (main format) ──────────────────
    for (const embed of embeds) {
      const title = (embed.title || '').trim();

      // Must match "X has placed a Realm Crystal!" or just "has placed a Realm Crystal!"
      if (!title.includes('has placed a Realm Crystal!') && title !== 'has placed a Realm Crystal!') continue;

      // Extract claimer from title
      let claimer = '';
      const m = title.match(/^(.+?) has placed a Realm Crystal!$/);
      if (m) {
        claimer = m[1].trim();
        // Filter out junk unicode-only names
        if (/^[\ufdd0\uFFFD\s]+$/.test(claimer)) claimer = '';
      }

      // Extract region and SLURL from fields
      let slurl = '';
      let region = '';
      for (const field of embed.fields || []) {
        const fname = (field.name || '').toLowerCase();
        const fval  = (field.value || '').trim();
        if (fname.includes('location') || fval.includes('maps.secondlife.com')) {
          slurl = fval;
        }
        if (fname === 'region') {
          region = fval;
        }
      }
      if (!region && slurl) region = extractRegionFromSLURL(slurl) || '';
      if (!region) continue;

      records.push({ region, claimer, slurl, timestamp: ts });
    }

    // ── Parse plain-text fallback messages ──────────────────
    // Format: "X places a realm crystal at https://maps.secondlife.com/..."
    if (!embeds.length && content.includes('maps.secondlife.com')) {
      const urlMatch = content.match(/https?:\/\/maps\.secondlife\.com\/secondlife\/[^\s]+/);
      if (urlMatch) {
        const slurl  = urlMatch[0];
        const region = extractRegionFromSLURL(slurl) || '';
        if (region) {
          records.push({ region, claimer: '', slurl, timestamp: ts });
        }
      }
    }
  }

  return records;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' });

  // Admin only
  const auth = await requireAdmin(req);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });

  const { json: euphoriaJSON } = req.body || {};
  if (!euphoriaJSON)
    return res.status(400).json({ error: 'No JSON data provided' });

  // ── Parse the uploaded Euphoria JSON ─────────────────────
  let parsed;
  try {
    parsed = typeof euphoriaJSON === 'string' ? JSON.parse(euphoriaJSON) : euphoriaJSON;
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON: ' + e.message });
  }

  const records = parseEuphoriaJSON(parsed);
  if (!records.length)
    return res.status(400).json({ error: 'No valid claim records found in file.' });

  // Deduplicate parsed records: keep latest timestamp per region
  const latestByRegion = {};
  for (const r of records) {
    const key = norm(r.region);
    if (!latestByRegion[key] || r.timestamp > latestByRegion[key].timestamp) {
      latestByRegion[key] = r;
    }
  }
  const deduped = Object.values(latestByRegion);

  // ── Fetch all existing lands from DB ─────────────────────
  const { data: existingLands, error: fetchError } = await supabase
    .from('lands')
    .select('id, region, status, enemy_claimer, updated_at, claimed_at');

  if (fetchError)
    return res.status(500).json({ error: 'DB fetch failed: ' + fetchError.message });

  // Build lookup map: norm(region) -> land record
  const dbMap = {};
  for (const land of existingLands) {
    dbMap[norm(land.region)] = land;
  }

  // ── Compare and build change set ─────────────────────────
  const toInsert = [];
  const toUpdate = [];
  const skipped  = [];
  const evwOwned = [];

  for (const rec of deduped) {
    const key        = norm(rec.region);
    const isEVW      = EVW_MEMBERS.has(norm(rec.claimer));
    const existing   = dbMap[key];
    const claimerVal = isEVW ? '' : (rec.claimer || '');

    if (!existing) {
      // ── New region not in DB at all ───────────────────────
      toInsert.push({
        region:        rec.region,
        land_name:     '',
        slurl:         rec.slurl || '',
        status:        isEVW ? 'claimed' : 'unclaimed',
        claimed_by:    '',
        enemy_claimer: claimerVal,
        first_seen:    rec.timestamp,
        claimed_at:    isEVW ? rec.timestamp : null,
        updated_at:    rec.timestamp,
      });
    } else {
      // ── Region already in DB ──────────────────────────────
      const dbUpdatedAt  = existing.updated_at ? new Date(existing.updated_at) : new Date(0);
      const recTimestamp = rec.timestamp       ? new Date(rec.timestamp)        : new Date(0);
      const logIsNewer   = recTimestamp > dbUpdatedAt;

      if (existing.status === 'claimed' && !logIsNewer) {
        // We own it and log entry is older than our last update — skip
        skipped.push(rec.region);
        continue;
      }

      if (existing.status === 'claimed' && logIsNewer && !isEVW) {
        // Log is newer AND claimer is an enemy — someone retook it after us
        toUpdate.push({
          id:            existing.id,
          status:        'unclaimed',
          enemy_claimer: claimerVal,
          claimed_by:    '',
          claimed_at:    null,
          updated_at:    rec.timestamp,
          slurl:         rec.slurl || existing.slurl || '',
        });
      } else if (existing.status === 'claimed' && logIsNewer && isEVW) {
        // Log is newer, claimer is EVW — update slurl/timestamp but keep claimed
        evwOwned.push(rec.region);
      } else if (existing.status === 'unclaimed') {
        // Currently unclaimed in DB — update enemy claimer info if log is newer
        if (logIsNewer && !isEVW) {
          toUpdate.push({
            id:            existing.id,
            enemy_claimer: claimerVal,
            slurl:         rec.slurl || existing.slurl || '',
            updated_at:    rec.timestamp,
          });
        } else if (logIsNewer && isEVW) {
          // EVW reclaimed it — mark as claimed
          toUpdate.push({
            id:         existing.id,
            status:     'claimed',
            claimed_at: rec.timestamp,
            updated_at: rec.timestamp,
            slurl:      rec.slurl || existing.slurl || '',
          });
        } else {
          skipped.push(rec.region);
        }
      }
    }
  }

  // ── Execute DB operations ─────────────────────────────────
  let inserted = 0;
  let updated  = 0;
  const errors = [];

  if (toInsert.length) {
    const { error } = await supabase.from('lands').insert(toInsert);
    if (error) errors.push('Insert error: ' + error.message);
    else inserted = toInsert.length;
  }

  for (const upd of toUpdate) {
    const { id, ...fields } = upd;
    const { error } = await supabase.from('lands').update(fields).eq('id', id);
    if (error) errors.push('Update error for ' + id + ': ' + error.message);
    else updated++;
  }

  return res.status(200).json({
    success:  true,
    parsed:   deduped.length,
    inserted,
    updated,
    skipped:  skipped.length,
    evwOwned: evwOwned.length,
    errors:   errors.length ? errors : undefined,
    details: {
      new_regions:     toInsert.map(r => r.region),
      updated_regions: toUpdate.map(r => {
        const rec = deduped.find(d => norm(d.region) === norm(
          existingLands.find(e => e.id === r.id)?.region || ''
        ));
        return existingLands.find(e => e.id === r.id)?.region || r.id;
      }),
      skipped_regions: skipped,
    }
  });
};
