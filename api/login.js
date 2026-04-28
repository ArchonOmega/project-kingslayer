const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { supabase } = require('./_supabase');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' });

  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password required' });

  const { data: user } = await supabase
    .from('users')
    .select('*')
    .eq('username', username.toLowerCase())
    .single();

  if (!user)
    return res.status(401).json({ error: 'Invalid username or password' });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid)
    return res.status(401).json({ error: 'Invalid username or password' });

  if (!user.is_approved)
    return res.status(403).json({ error: 'Your account is pending admin approval.' });

  const token     = crypto.randomBytes(48).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  await supabase.from('sessions').insert({
    user_id:    user.id,
    token,
    expires_at: expiresAt,
  });

  return res.status(200).json({
    token,
    user: {
      id:          user.id,
      username:    user.username,
      sl_username: user.sl_username,
      is_admin:    user.is_admin,
    }
  });
};
