// api/auth.js
// Handles: POST /api/auth?action=register
//          POST /api/auth?action=login
//          POST /api/auth?action=logout
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { supabase } = require('./_supabase');
const { requireAuth } = require('./_auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' });

  const action = req.query.action;

  // ── REGISTER ─────────────────────────────────────────────
  if (action === 'register') {
    const { username, password, sl_username } = req.body || {};
    if (!username || !password)
      return res.status(400).json({ error: 'Username and password are required' });
    if (username.length < 3)
      return res.status(400).json({ error: 'Username must be at least 3 characters' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const { data: existing } = await supabase
      .from('users').select('id').eq('username', username.toLowerCase()).single();
    if (existing)
      return res.status(409).json({ error: 'Username already taken' });

    const password_hash = await bcrypt.hash(password, 12);
    const { count } = await supabase
      .from('users').select('*', { count: 'exact', head: true });
    const isFirst = count === 0;

    const { error } = await supabase.from('users').insert({
      username:      username.toLowerCase(),
      sl_username:   sl_username || '',
      password_hash,
      is_admin:      isFirst,
      is_approved:   isFirst,
    });

    if (error)
      return res.status(500).json({ error: 'Failed to create account: ' + error.message });

    return res.status(201).json({
      message: isFirst
        ? 'Admin account created. You can log in immediately.'
        : 'Account created. Please wait for an admin to approve it.'
    });
  }

  // ── LOGIN ─────────────────────────────────────────────────
  if (action === 'login') {
    const { username, password } = req.body || {};
    if (!username || !password)
      return res.status(400).json({ error: 'Username and password required' });

    const { data: user } = await supabase
      .from('users').select('*').eq('username', username.toLowerCase()).single();
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
      user_id: user.id, token, expires_at: expiresAt,
    });

    return res.status(200).json({
      token,
      user: {
        id: user.id, username: user.username,
        sl_username: user.sl_username, is_admin: user.is_admin,
      }
    });
  }

  // ── LOGOUT ────────────────────────────────────────────────
  if (action === 'logout') {
    const token = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
    if (token) await supabase.from('sessions').delete().eq('token', token);
    return res.status(200).json({ message: 'Logged out' });
  }

  return res.status(400).json({ error: 'Unknown action. Use ?action=register|login|logout' });
};
