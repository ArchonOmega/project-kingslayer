import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  const TARGETS_KEY = 'kingslayer_targets';
  const STATE_KEY   = 'kingslayer_state';

  // GET: Fetch both the target list and the claim statuses
  if (req.method === 'GET') {
    const [targets, state] = await Promise.all([
      kv.get(TARGETS_KEY),
      kv.get(STATE_KEY)
    ]);
    return res.status(200).json({ 
      targets: targets || [], 
      state: state || {} 
    });
  }

  // POST: Update either the list or the state
  if (req.method === 'POST') {
    const { type, data } = req.body;
    
    if (type === 'targets') {
      await kv.set(TARGETS_KEY, data);
      return res.status(200).json({ success: true, message: 'Target list updated' });
    }
    
    if (type === 'state') {
      await kv.set(STATE_KEY, data);
      return res.status(200).json({ success: true, message: 'Claim state updated' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}