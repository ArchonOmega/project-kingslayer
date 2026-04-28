const { supabase } = require('./_supabase');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' });

  const token = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  if (token) {
    await supabase.from('sessions').delete().eq('token', token);
  }
  return res.status(200).json({ message: 'Logged out' });
};
