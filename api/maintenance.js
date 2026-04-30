// api/maintenance.js
// GET  — check if maintenance mode is on (public, no auth)
// POST — toggle maintenance mode on/off (admin only)
const { supabase } = require('./_supabase');
const { requireAdmin } = require('./_auth');

module.exports = async function handler(req, res) {
  // GET — public check
  if (req.method === 'GET') {
    const { data } = await supabase
      .from('settings')
      .select('value')
      .eq('key', 'maintenance_mode')
      .single();

    const isOn = data ? data.value === 'true' : false;
    return res.status(200).json({ maintenance: isOn });
  }

  // POST — admin toggle
  if (req.method === 'POST') {
    const auth = await requireAdmin(req);
    if (auth.error) return res.status(auth.status).json({ error: auth.error });

    const { enabled, message } = req.body || {};

    // Upsert maintenance_mode setting
    const { error: e1 } = await supabase
      .from('settings')
      .upsert({ key: 'maintenance_mode', value: enabled ? 'true' : 'false' });

    // Optionally store a custom message
    if (message !== undefined) {
      await supabase
        .from('settings')
        .upsert({ key: 'maintenance_message', value: message || '' });
    }

    if (e1) return res.status(500).json({ error: e1.message });
    return res.status(200).json({ message: enabled ? 'Maintenance mode ON.' : 'Maintenance mode OFF.' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
