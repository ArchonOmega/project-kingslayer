// api/crystals.js
// GET  — fetch all members' crystal counts (for the tracker widget)
// PATCH — update a member's crystal count or elite status
const { supabase } = require('./_supabase');
const { requireAuth } = require('./_auth');

module.exports = async function handler(req, res) {
  const auth = await requireAuth(req);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });

  // ── GET — return all approved members with crystal info ──
  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('users')
      .select('id, username, sl_username, crystals, is_elite, is_admin')
      .eq('is_approved', true)
      .order('username', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ members: data });
  }

  // ── PATCH — update crystals or elite status ──────────────
  if (req.method === 'PATCH') {
    const { id, crystals, is_elite } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });

    // Members can only edit their own crystals
    // Admins can edit anyone's crystals and toggle elite
    const isSelf  = id === auth.user.id;
    const isAdmin = auth.user.is_admin;

    if (!isSelf && !isAdmin)
      return res.status(403).json({ error: 'You can only edit your own crystal count.' });

    if (is_elite !== undefined && !isAdmin)
      return res.status(403).json({ error: 'Only admins can change Elite status.' });

    const updates = {};

    if (crystals !== undefined) {
      const count = parseInt(crystals, 10);
      if (isNaN(count) || count < 0)
        return res.status(400).json({ error: 'Invalid crystal count.' });

      // Enforce max based on elite status
      // Fetch target user's elite status if editing someone else
      let targetElite = auth.user.is_elite;
      if (!isSelf) {
        const { data: target } = await supabase
          .from('users')
          .select('is_elite')
          .eq('id', id)
          .single();
        if (target) targetElite = target.is_elite;
      }
      const max = targetElite ? 5 : 3;
      updates.crystals = Math.min(count, max);
    }

    if (is_elite !== undefined) {
      updates.is_elite = is_elite;
      // When toggling elite on/off, adjust crystals to new max if over limit
      if (!is_elite) {
        // Downgrading — cap at 3
        const { data: target } = await supabase
          .from('users').select('crystals').eq('id', id).single();
        if (target && target.crystals > 3) updates.crystals = 3;
      }
    }

    const { error } = await supabase.from('users').update(updates).eq('id', id);
    if (error) return res.status(500).json({ error: error.message });

    return res.status(200).json({ message: 'Updated.', updates });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
