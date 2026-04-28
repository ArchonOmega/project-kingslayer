// api/lands.js
import { supabase } from './_supabase.js';
import { requireAuth } from './_auth.js';

export default async function handler(req, res) {
  // All land endpoints require a logged-in, approved user
  const auth = await requireAuth(req);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });

  // GET /api/lands — fetch all lands
  if (req.method === 'GET') {
    const { status } = req.query;
    let query = supabase
      .from('lands')
      .select('*')
      .order('region', { ascending: true });

    if (status && status !== 'all') {
      query = query.eq('status', status);
    }

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ lands: data });
  }

  // PATCH /api/lands — update a land's status / claimed_by
  if (req.method === 'PATCH') {
    const { id, status, claimed_by } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });

    const updates = { updated_at: new Date().toISOString() };
    if (status)     updates.status     = status;
    if (claimed_by !== undefined) updates.claimed_by = claimed_by;
    if (status === 'claimed') updates.claimed_at = new Date().toISOString();
    if (status === 'unclaimed') { updates.claimed_by = ''; updates.claimed_at = null; }

    const { error } = await supabase.from('lands').update(updates).eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ message: 'Updated' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
