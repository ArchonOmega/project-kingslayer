// api/hud-claim.js
// Called directly by the LSL HUD scripts via llHTTPRequest.
// Uses a shared HUD secret instead of a user session.
import { supabase } from './_supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' });

  // Simple shared secret so random people can't post to this endpoint
  const secret = req.headers['x-hud-secret'] || '';
  if (secret !== process.env.HUD_SECRET)
    return res.status(401).json({ error: 'Unauthorized' });

  const { event, land, region, link, reported_by } = req.body || {};

  if (!region) return res.status(400).json({ error: 'region required' });

  if (event === 'claimed') {
    // Upsert: insert if new, update status if existing
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
    await supabase.from('lands')
      .update({ status: 'unclaimed', claimed_by: '', updated_at: new Date().toISOString() })
      .eq('region', region);
    return res.status(200).json({ message: 'Land marked as lost.' });
  }

  if (event === 'contested') {
    // Just log it — don't change status
    return res.status(200).json({ message: 'Contested alert received.' });
  }

  return res.status(400).json({ error: 'Unknown event type' });
}
