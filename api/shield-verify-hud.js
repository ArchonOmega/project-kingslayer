// api/shield-verify-hud.js
// Called by the LSL HUD shield button.
// Looks up the land by region name and marks shield as verified.
// If the region isn't in the DB yet, auto-adds it as claimed.
const { supabase } = require('./_supabase');

function sanitizeStr(s) {
  if (!s) return '';
  // SL sometimes sends the actual carriage return char (0x0D) in region names
  s = s.replace(/\r/g, 'r');
  // jsonSafe() in LSL encodes \r as the literal two-char sequence backslash+r
  // so we also need to replace that
  s = s.replace(/\\r/g, 'r');
  // Strip remaining control characters
  s = s.replace(/[\n\t\x00-\x1F\x7F]/g, '').trim();
  // Also clean up any remaining backslash-letter escape sequences from jsonSafe
  s = s.replace(/\\n/g, ' ').replace(/\\t/g, ' ');
  return s;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' });

  const secret = req.headers['x-hud-secret'] || '';
  if (secret !== process.env.HUD_SECRET)
    return res.status(401).json({ error: 'Unauthorized' });

  const _b          = req.body || {};
  const region      = sanitizeStr(_b.region);
  const land        = sanitizeStr(_b.land);
  const link        = sanitizeStr(_b.link);
  const reported_by = sanitizeStr(_b.reported_by);
  if (!region) return res.status(400).json({ error: 'region required' });

  const now = new Date().toISOString();

  // Look up land by region name
  const { data: existing } = await supabase
    .from('lands')
    .select('id, region, land_name, slurl, status')
    .eq('region', region)
    .single();

  let landId   = existing ? existing.id : null;
  let landName = existing ? (existing.land_name || land || '') : (land || '');
  let slurl    = existing ? (existing.slurl || link || '')     : (link || '');

  if (!existing) {
    // Land not in DB — auto-add as claimed since member is verifying shield on it
    const { data: inserted, error: insertErr } = await supabase
      .from('lands')
      .insert({
        region,
        land_name:          landName,
        slurl,
        status:             'claimed',
        claimed_by:         reported_by || '',
        enemy_claimer:      '',
        first_seen:         now,
        claimed_at:         now,
        shield_verified_at: now,
        shield_verified_by: reported_by || 'Unknown',
        updated_at:         now,
      })
      .select('id')
      .single();

    if (insertErr)
      return res.status(500).json({ error: 'Failed to add region: ' + insertErr.message });

    landId = inserted.id;
  } else if (existing.status !== 'claimed') {
    // In DB but marked unclaimed — update to claimed since member is verifying shield
    await supabase
      .from('lands')
      .update({
        status:             'claimed',
        claimed_by:         reported_by || '',
        claimed_at:         now,
        shield_verified_at: now,
        shield_verified_by: reported_by || 'Unknown',
        updated_at:         now,
      })
      .eq('id', existing.id);
  } else {
    // Exists and is claimed — just update shield verification
    const { error } = await supabase
      .from('lands')
      .update({
        shield_verified_at: now,
        shield_verified_by: reported_by || 'Unknown',
        updated_at:         now,
      })
      .eq('id', existing.id);

    if (error) return res.status(500).json({ error: error.message });
  }

  // Log to activity
  await supabase.from('activity_log').insert({
    event:       'shield',
    region,
    land_name:   landName,
    slurl,
    reported_by: reported_by || 'Unknown',
    enemy_clan:  '',
  });

  return res.status(200).json({ message: 'Shield verified for ' + region });
};
