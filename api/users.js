const { supabase } = require('../_supabase');
const { requireAdmin } = require('../_auth');

module.exports = async function handler(req, res) {
  const auth = await requireAdmin(req);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });

  if (req.method === 'GET') {
    const { data: users, error } = await supabase
      .from('users')
      .select('id, username, sl_username, is_admin, is_approved, created_at')
      .order('created_at', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ users });
  }

  if (req.method === 'PATCH') {
    const { id, action } = req.body || {};
    if (!id || !action) return res.status(400).json({ error: 'id and action required' });

    if (id === auth.user.id)
      return res.status(400).json({ error: 'Cannot modify your own account here.' });

    if (action === 'approve') {
      const { error } = await supabase
        .from('users').update({ is_approved: true }).eq('id', id);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ message: 'User approved.' });
    }

    if (action === 'reject' || action === 'remove') {
      await supabase.from('sessions').delete().eq('user_id', id);
      const { error } = await supabase.from('users').delete().eq('id', id);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ message: 'User removed.' });
    }

    return res.status(400).json({ error: 'Unknown action' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
