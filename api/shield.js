// api/shield.js
// Handles: POST /api/shield?source=web  (called by website, uses session auth)
//          POST /api/shield?source=hud  (called by LSL HUD, uses x-hud-secret)
const { supabase } = require('./_supabase');
const { requireAuth } = require('./_auth');

function sanitizeStr(s) {
  if (!s) return '';
  s = s.replace(/[\x00-\x1F\x7F]/g, '').trim();
  return s;
}

async function logShield(region, landName, slurl, reportedBy) {
  await supabase.from('activity_log').insert({
    event:       'shield',
    region,
    land_name:   landName || '',
    slurl:       slurl    || '',
    reported_by: reportedBy || 'Unknown',
    enemy_clan:  '',
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' });

  const source = req.query.source || 'web';

  // ── WEB source — session auth ─────────────────────────────
  if (source === 'web') {
    const auth = await requireAuth(req);
    if (auth.error) return res.status(auth.status).json({ error: auth.error });

    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'Land id required' });

    const now = new Date().toISOString();
    const { error } = await supabase.from('lands').update({
      shield_verified_at: now,
      shield_verified_by: auth.user.username,
      updated_at:         now,
    }).eq('id', id);

    if (error) return res.status(500).json({ error: error.message });

    const { data: land } = await supabase
      .from('lands').select('region, land_name, slurl').eq('id', id).single();
    if (land) await logShield(land.region, land.land_name, land.slurl, auth.user.username);

    return res.status(200).json({
      message:            'Shield verified.',
      shield_verified_at: now,
      shield_verified_by: auth.user.username,
    });
  }

  // ── HUD source — secret auth ──────────────────────────────
  if (source === 'hud') {
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

    const { data: existing } = await supabase
      .from('lands').select('id, region, land_name, slurl, status')
      .eq('region', region).single();

    let landName = existing ? (existing.land_name || land || '') : (land || '');
    let slurl    = existing ? (existing.slurl || link || '')     : (link || '');

    if (!existing) {
      const { data: inserted, error: insertErr } = await supabase
        .from('lands').insert({
          region, land_name: landName, slurl,
          status: 'claimed', claimed_by: reported_by || '',
          enemy_claimer: '', first_seen: now, claimed_at: now,
          shield_verified_at: now, shield_verified_by: reported_by || 'Unknown',
          updated_at: now,
        }).select('id').single();
      if (insertErr)
        return res.status(500).json({ error: 'Failed to add region: ' + insertErr.message });
    } else if (existing.status !== 'claimed') {
      await supabase.from('lands').update({
        status: 'claimed', claimed_by: reported_by || '', claimed_at: now,
        shield_verified_at: now, shield_verified_by: reported_by || 'Unknown',
        updated_at: now,
      }).eq('id', existing.id);
    } else {
      const { error } = await supabase.from('lands').update({
        shield_verified_at: now,
        shield_verified_by: reported_by || 'Unknown',
        updated_at: now,
      }).eq('id', existing.id);
      if (error) return res.status(500).json({ error: error.message });
    }

    await logShield(region, landName, slurl, reported_by);
    return res.status(200).json({ message: 'Shield verified for ' + region });
  }

  return res.status(400).json({ error: 'Unknown source. Use ?source=web|hud' });
};
