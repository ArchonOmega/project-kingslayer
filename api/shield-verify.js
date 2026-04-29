// api/shield-verify.js
// Any approved member can call this to mark a land's shield as verified.
const { supabase } = require('./_supabase');
const { requireAuth } = require('./_auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireAuth(req);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });

  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'Land id required' });

  // Only makes sense on claimed lands — but we don't hard-block it
  const now = new Date().toISOString();

  const { error } = await supabase
    .from('lands')
    .update({
      shield_verified_at: now,
      shield_verified_by: auth.user.username,
      updated_at:         now,
    })
    .eq('id', id);

  if (error) return res.status(500).json({ error: error.message });

  // Also log it to activity
  const { data: land } = await supabase
    .from('lands')
    .select('region, land_name, slurl')
    .eq('id', id)
    .single();

  if (land) {
    await supabase.from('activity_log').insert({
      event:       'shield',
      region:      land.region,
      land_name:   land.land_name || '',
      slurl:       land.slurl     || '',
      reported_by: auth.user.username,
      enemy_clan:  '',
    });
  }

  return res.status(200).json({
    message:            'Shield verified.',
    shield_verified_at: now,
    shield_verified_by: auth.user.username,
  });
};
