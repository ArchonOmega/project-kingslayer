// api/hud-claim.js
const { supabase } = require('./_supabase');

// Strip control characters and trim whitespace from region names
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


async function logActivity(event, region, land, slurl, reported_by, enemy_clan) {
  await supabase.from('activity_log').insert({
    event,
    region,
    land_name:   land       || '',
    slurl:       slurl      || '',
    reported_by: reported_by || 'Unknown',
    enemy_clan:  enemy_clan  || '',
  });
}

module.exports = async function handler(req, res) {
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
    const _b = req.body || {};
    const event       = sanitizeStr(_b.event);
    const land        = sanitizeStr(_b.land);
    const region      = sanitizeStr(_b.region);
    const link        = sanitizeStr(_b.link);
    const reported_by = sanitizeStr(_b.reported_by);
    const enemy_clan  = sanitizeStr(_b.enemy_clan);
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
          land_name:  land  || '',
          slurl:      link  || '',
          claimed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq('id', existing.id);
      } else {
        await supabase.from('lands').insert({
          region,
          land_name:     land  || '',
          slurl:         link  || '',
          status:        'claimed',
          claimed_by:    reported_by || '',
          enemy_claimer: '',
          first_seen:    new Date().toISOString(),
          claimed_at:    new Date().toISOString(),
        });
      }

      // Deduct a crystal from the reporting member
      if (reported_by) {
        // reported_by format is "Display Name (username)" — extract username
        const usernameMatch = reported_by.match(/\(([^)]+)\)\s*$/);
        const username = usernameMatch ? usernameMatch[1].trim() : reported_by;

        const { data: member } = await supabase
          .from('users')
          .select('id, crystals, is_elite')
          .eq('username', username.toLowerCase())
          .single();

        if (member) {
          const newCount = Math.max(0, (member.crystals || 0) - 1);
          await supabase
            .from('users')
            .update({ crystals: newCount })
            .eq('id', member.id);
        }
      }

      // Log activity
      await logActivity('claimed', region, land, link, reported_by, '');
      // Fetch updated crystal count to return to HUD
      let crystalCount = null;
      if (reported_by) {
        const usernameMatch = reported_by.match(/\(([^)]+)\)\s*$/);
        const username = usernameMatch ? usernameMatch[1].trim() : reported_by;
        const { data: updatedMember } = await supabase
          .from('users')
          .select('crystals, is_elite')
          .eq('username', username.toLowerCase())
          .single();
        if (updatedMember) {
          crystalCount = updatedMember.crystals;
        }
      }
      return res.status(200).json({
        message: 'Land claimed and recorded.',
        crystals_remaining: crystalCount,
      });
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
        await supabase.from('lands').insert({
          region,
          land_name:     land  || '',
          slurl:         link  || '',
          status:        'unclaimed',
          claimed_by:    '',
          enemy_claimer: enemy_clan || '',
          first_seen:    new Date().toISOString(),
          claimed_at:    null,
        });
      }

      // Log activity
      await logActivity('lost', region, land, link, reported_by, enemy_clan);
      return res.status(200).json({ message: 'Land marked as lost.' });
    }

    if (event === 'contested') {
      // Log activity even for contested
      await logActivity('contested', region, land, link, reported_by, '');
      return res.status(200).json({ message: 'Contested alert received.' });
    }

    return res.status(400).json({ error: 'Unknown event type' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
