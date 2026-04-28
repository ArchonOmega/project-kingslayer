const { supabase } = require('./_supabase');

module.exports = async function handler(req, res) {
  // Auth check
  const secret = req.headers['x-hud-secret'] || '';
  if (secret !== process.env.HUD_SECRET)
    return res.status(401).json({ error: 'Unauthorized' });

  // ── GET — check current status of a region ───────────────
  if (req.method === 'GET') {
    const { region } = req.query;
    if (!region) return res.status(400).json({ error: 'region required' });

    const { data, error } = await supabase
      .from('lands')
      .select('id, status, land_name, claimed_by')
      .eq('region', region)
      .single();

    if (error || !data)
      return res.status(200).json({ status: 'not_found' });

    return res.status(200).json({
      status:     data.status,
      land_name:  data.land_name,
      claimed_by: data.claimed_by,
    });
  }

  // ── POST — record a claim/lost/contested event ───────────
  if (req.method === 'POST') {
    const { event, land, region, link, reported_by, enemy_clan } = req.body || {};
    if (!region) return res.status(400).json({ error: 'region required' });

    if (event === 'claimed') {
      const { data: existing } = await supabase
        .from('lands')
        .select('id')
        .eq('region', region)
        .single();

      if (existing) {
        await supabase.from('lands').update({
          status:     'claimed',
          claimed_by: reported_by || '',
          land_name:  land || '',
          slurl:      link || '',
          claimed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq('id', existing.id);
      } else {
        await supabase.from('lands').insert({
          region,
          land_name:     land || '',
          slurl:         link || '',
          status:        'claimed',
          claimed_by:    reported_by || '',
          enemy_claimer: '',
          first_seen:    new Date().toISOString(),
          claimed_at:    new Date().toISOString(),
        });
      }
      return res.status(200).json({ message: 'Land claimed and recorded.' });
    }

    if (event === 'lost') {
      const { data: existing } = await supabase
        .from('lands')
        .select('id')
        .eq('region', region)
        .single();

      if (existing) {
        await supabase.from('lands').update({
          status:        'unclaimed',
          claimed_by:    '',
          claimed_at:    null,
          enemy_claimer: enemy_clan || '',
          updated_at:    new Date().toISOString(),
        }).eq('id', existing.id);
      } else {
        // Not in DB at all — add it as unclaimed
        await supabase.from('lands').insert({
          region,
          land_name:     land || '',
          slurl:         link || '',
          status:        'unclaimed',
          claimed_by:    '',
          enemy_claimer: enemy_clan || '',
          first_seen:    new Date().toISOString(),
          claimed_at:    null,
        });
      }
      return res.status(200).json({ message: 'Land marked as lost.' });
    }

    if (event === 'contested') {
      return res.status(200).json({ message: 'Contested alert received.' });
    }

    return res.status(400).json({ error: 'Unknown event type' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
