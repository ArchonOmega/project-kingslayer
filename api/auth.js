// api/auth.js
// Handles: POST /api/auth?action=register
//          POST /api/auth?action=login
//          POST /api/auth?action=logout
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { supabase } = require('./_supabase');
const { requireAuth, requireAdmin } = require('./_auth');

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

  // ── RESET PASSWORD (admin sets a member's password) ──────
  if (action === 'reset-password') {
    const auth = await requireAdmin(req);
    if (auth.error) return res.status(auth.status).json({ error: auth.error });

    const { user_id, new_password } = req.body || {};
    if (!user_id || !new_password)
      return res.status(400).json({ error: 'user_id and new_password are required' });
    if (new_password.length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const password_hash = await bcrypt.hash(new_password, 12);
    const { error } = await supabase
      .from('users')
      .update({ password_hash })
      .eq('id', user_id);

    if (error)
      return res.status(500).json({ error: 'Failed to reset password: ' + error.message });

    // Invalidate existing sessions so the old login can't persist
    await supabase.from('sessions').delete().eq('user_id', user_id);

    return res.status(200).json({ message: 'Password reset successfully.' });
  }

  // ── CHANGE PASSWORD (member changes their own) ───────────
  if (action === 'change-password') {
    const auth = await requireAuth(req);
    if (auth.error) return res.status(auth.status).json({ error: auth.error });

    const { current_password, new_password } = req.body || {};
    if (!current_password || !new_password)
      return res.status(400).json({ error: 'Current and new password are required' });
    if (new_password.length < 6)
      return res.status(400).json({ error: 'New password must be at least 6 characters' });

    const { data: user } = await supabase
      .from('users').select('password_hash').eq('id', auth.user.id).single();
    if (!user)
      return res.status(404).json({ error: 'User not found' });

    const valid = await bcrypt.compare(current_password, user.password_hash);
    if (!valid)
      return res.status(401).json({ error: 'Current password is incorrect' });

    const password_hash = await bcrypt.hash(new_password, 12);
    const { error } = await supabase
      .from('users')
      .update({ password_hash })
      .eq('id', auth.user.id);

    if (error)
      return res.status(500).json({ error: 'Failed to change password: ' + error.message });

    return res.status(200).json({ message: 'Password changed successfully.' });
  }

  // ── HUD AUTH CHECK (called by the HUD security core on attach) ──
  if (action === 'hud-check') {
    if ((req.headers['x-hud-secret'] || '') !== process.env.HUD_SECRET)
      return res.status(401).json({ error: 'Unauthorized' });

    // SL sometimes drops the letter 'r' from usernames — same corrections
    // map used by hud-claim.js and shield.js.
    const USERNAME_CORRECTIONS = {
      'seena5579':   'serena5579',
      'meukii':      'merukii',
      'theagnaok1':  'theragnarok1',
      'theagnarok1': 'theragnarok1',
      'theragnaok1': 'theragnarok1',
      'laezimi':     'laezimir',
    };
    // Tolerant comparison: lowercase, strip dots/spaces (matches My Stats logic)
    const norm = (s) => (s || '').toLowerCase().replace(/[.\s]+/g, '').trim();

    let username = ((req.body || {}).username || '').toLowerCase().trim();
    if (!username) return res.status(400).json({ error: 'username required' });
    if (USERNAME_CORRECTIONS[username]) username = USERNAME_CORRECTIONS[username];
    const display_name = ((req.body || {}).display_name || '').trim();

    const { data: rows } = await supabase.from('hud_auth').select('username, status');
    const match = (rows || []).find((r) => norm(r.username) === norm(username));
    if (match) return res.status(200).json({ status: match.status });

    // First-time attach — file a pending authorization request for admins
    await supabase.from('hud_auth').insert({ username, display_name, status: 'pending' });
    return res.status(200).json({ status: 'pending' });
  }

  // ── HUD AUTH LIST (admin — feeds the HUD Auth page) ──────
  if (action === 'hud-list') {
    const auth = await requireAdmin(req);
    if (auth.error) return res.status(auth.status).json({ error: auth.error });
    const { data, error } = await supabase
      .from('hud_auth').select('*')
      .order('requested_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ entries: data || [] });
  }

  // ── HUD AUTH MANAGE (admin — approve / deny / add / remove) ──
  if (action === 'hud-manage') {
    const auth = await requireAdmin(req);
    if (auth.error) return res.status(auth.status).json({ error: auth.error });

    const { username, op } = req.body || {};
    const uname = (username || '').toLowerCase().trim();
    if (!uname || !op)
      return res.status(400).json({ error: 'username and op required' });
    const decidedBy = (auth.user && auth.user.username) || 'admin';
    const now = new Date().toISOString();

    if (op === 'approve' || op === 'add') {
      const { error } = await supabase.from('hud_auth').upsert(
        { username: uname, status: 'approved', decided_at: now, decided_by: decidedBy },
        { onConflict: 'username' });
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ message: uname + ' authorized.' });
    }
    if (op === 'deny') {
      const { error } = await supabase.from('hud_auth').upsert(
        { username: uname, status: 'denied', decided_at: now, decided_by: decidedBy },
        { onConflict: 'username' });
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ message: uname + ' denied.' });
    }
    if (op === 'remove') {
      const { error } = await supabase.from('hud_auth').delete().eq('username', uname);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ message: uname + ' removed from the list.' });
    }
    return res.status(400).json({ error: 'Unknown op. Use approve|deny|add|remove' });
  }

  return res.status(400).json({ error: 'Unknown action. Use ?action=register|login|logout|reset-password|change-password|hud-check|hud-list|hud-manage' });
};
