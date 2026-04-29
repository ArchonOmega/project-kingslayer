// api/shield-verify-hud.js
// Called by the LSL HUD shield button.
// Looks up the land by region name and marks shield as verified.
const { supabase } = require('./_supabase');

// Strip control characters and trim whitespace from region names
function sanitizeStr(s) {
  if (!s) return '';
  // Remove carriage returns, newlines, tabs and other control chars
  return s.replace(/[\r\n\t\x00-\x1F\x7F]/g, '').trim();
}


module.exports = async function handler(req, res) {
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' });

  const secret = req.headers['x-hud-secret'] || '';
  if (secret !== process.env.HUD_SECRET)
    return res.status(401).json({ error: 'Unauthorized' });

  const _b = req.body || {};
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

  if (!existing) {
    // Land not in DB at all — can't verify what we don't track
    return res.status(404).json({ error: 'Region not found in database: ' + region });
  }

  if (existing.status !== 'claimed') {
    return res.status(400).json({ error: 'Land is not currently claimed by EVW.' });
  }

  // Update shield verification
  const { error } = await supabase
    .from('lands')
    .update({
      shield_verified_at: now,
      shield_verified_by: reported_by || 'Unknown',
      updated_at:         now,
    })
    .eq('id', existing.id);

  if (error) return res.status(500).json({ error: error.message });

  // Log to activity
  await supabase.from('activity_log').insert({
    event:       'shield',
    region:      existing.region,
    land_name:   existing.land_name || land || '',
    slurl:       existing.slurl     || link || '',
    reported_by: reported_by || 'Unknown',
    enemy_clan:  '',
  });

  return res.status(200).json({ message: 'Shield verified for ' + region });
};
