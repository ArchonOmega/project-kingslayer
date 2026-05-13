// api/hud-claim.js
const { supabase } = require('./_supabase');

function sanitizeStr(s) {
  if (!s) return '';
  // SL's llGetRegionName/llGetUsername sometimes send \r in place of 'r'.
  s = s.replace(/\r/g, 'r');
  s = s.replace(/[\n\t\x00-\x0C\x0E-\x1F\x7F]/g, '');
  return s.trim();
}

// SL's llGetUsername() sometimes drops the letter 'r' entirely (not as \r, just missing).
// Map known corrupted usernames back to the correct ones for our clan members.
const USERNAME_CORRECTIONS = {
  'seena5579':   'serena5579',
  'meukii':      'merukii',
  'theagnaok1':  'theragnarok1',
  'theagnarok1': 'theragnarok1',
  'theragnaok1': 'theragnarok1',
  'laezimi':     'laezimir',
};

function correctUsername(name) {
  if (!name) return name;
  const lower = name.toLowerCase();
  return USERNAME_CORRECTIONS[lower] || name;
}

function correctReportedBy(reportedBy) {
  if (!reportedBy) return reportedBy;
  // reported_by format is "Display Name (username)"
  // Extract username, correct it, then rebuild the string
  return reportedBy.replace(/\(([^)]+)\)\s*$/, (match, username) => {
    const corrected = correctUsername(username.trim());
    return '(' + corrected + ')';
  });
}

async function logActivity(event, region, land, slurl, reported_by, enemy_clan) {
  await supabase.from('activity_log').insert({
    event,
    region,
    land_name:   land        || '',
    slurl:       slurl       || '',
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
    const region = sanitizeStr(req.query.region || '');
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
    const _b          = req.body || {};
    const event       = sanitizeStr(_b.event);
    const land        = sanitizeStr(_b.land);
    const region      = sanitizeStr(_b.region);
    const link        = sanitizeStr(_b.link);
    const reported_by = correctReportedBy(sanitizeStr(_b.reported_by));
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
          land_name:  land        || '',
          slurl:      link        || '',
          claimed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq('id', existing.id);
      } else {
        await supabase.from('lands').insert({
          region,
          land_name:     land        || '',
          slurl:         link        || '',
          status:        'claimed',
          claimed_by:    reported_by || '',
          enemy_claimer: '',
          first_seen:    new Date().toISOString(),
          claimed_at:    new Date().toISOString(),
        });
      }

      // Deduct a crystal — match by sl_username first, fall back to username
      if (reported_by) {
        const usernameMatch = reported_by.match(/\(([^)]+)\)\s*$/);
        const username = usernameMatch ? usernameMatch[1].trim() : reported_by;

        let { data: member } = await supabase
          .from('users')
          .select('id, crystals, is_elite')
          .eq('sl_username', username.toLowerCase())
          .single();

        if (!member) {
          const { data: fallback } = await supabase
            .from('users')
            .select('id, crystals, is_elite')
            .eq('username', username.toLowerCase())
            .single();
          member = fallback;
        }

        if (member) {
          await supabase
            .from('users')
            .update({ crystals: Math.max(0, (member.crystals || 0) - 1) })
            .eq('id', member.id);
        }
      }

      await logActivity('claimed', region, land, link, reported_by, '');

      // Return updated crystal count
      let crystalCount = null;
      if (reported_by) {
        const usernameMatch = reported_by.match(/\(([^)]+)\)\s*$/);
        const username = usernameMatch ? usernameMatch[1].trim() : reported_by;

        let { data: updated } = await supabase
          .from('users')
          .select('crystals')
          .eq('sl_username', username.toLowerCase())
          .single();

        if (!updated) {
          const { data: fallback } = await supabase
            .from('users')
            .select('crystals')
            .eq('username', username.toLowerCase())
            .single();
          updated = fallback;
        }

        if (updated) crystalCount = updated.crystals;
      }

      return res.status(200).json({
        message:            'Land claimed and recorded.',
        crystals_remaining: crystalCount,
      });
    }

    if (event === 'lost') {
      const { data: existing } = await supabase
        .from('lands')
        .select('id')
        .eq('region', region)
        .single();

      const lostNow = new Date().toISOString();
      if (existing) {
        await supabase.from('lands').update({
          status:           'unclaimed',
          claimed_by:       '',
          claimed_at:       null,
          enemy_claimer:    enemy_clan || '',
          enemy_claimed_at: lostNow,
          updated_at:       lostNow,
        }).eq('id', existing.id);
      } else {
        await supabase.from('lands').insert({
          region,
          land_name:        land        || '',
          slurl:            link        || '',
          status:           'unclaimed',
          claimed_by:       '',
          enemy_claimer:    enemy_clan  || '',
          enemy_claimed_at: lostNow,
          first_seen:       lostNow,
          claimed_at:       null,
        });
      }

      await logActivity('lost', region, land, link, reported_by, enemy_clan);
      return res.status(200).json({ message: 'Land marked as lost.' });
    }

    if (event === 'contested') {
      await logActivity('contested', region, land, link, reported_by, '');
      return res.status(200).json({ message: 'Contested alert received.' });
    }

    return res.status(400).json({ error: 'Unknown event type' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
