import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  const STORAGE_KEY = 'kingslayer_v1_state';

  if (req.method === 'GET') {
    // Retrieve the entire state from the cloud
    const state = await kv.get(STORAGE_KEY);
    return res.status(200).json(state || {});
  }

  if (req.method === 'POST') {
    // Update the state with the new claim data
    const newState = req.body;
    await kv.set(STORAGE_KEY, newState);
    return res.status(200).json({ success: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}