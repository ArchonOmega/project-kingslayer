// api/cron-reset-crystals.js
// Called by Vercel Cron at 12:00 AM PST (08:00 UTC) daily.
// Resets each member's crystals to their max (3 standard, 5 elite).
const { supabase } = require('./_supabase');

module.exports = async function handler(req, res) {
  // Vercel cron sends a GET with Authorization header
  const authHeader = req.headers['authorization'];
  if (authHeader !== 'Bearer ' + process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Reset standard members to 3
  const { error: e1 } = await supabase
    .from('users')
    .update({ crystals: 3 })
    .eq('is_elite', false)
    .eq('is_approved', true);

  // Reset elite members to 5
  const { error: e2 } = await supabase
    .from('users')
    .update({ crystals: 5 })
    .eq('is_elite', true)
    .eq('is_approved', true);

  if (e1 || e2) {
    console.error('Crystal reset errors:', e1, e2);
    return res.status(500).json({ error: 'Reset partially failed.' });
  }

  console.log('Crystal reset complete:', new Date().toISOString());
  return res.status(200).json({ message: 'Crystals reset successfully.' });
};
