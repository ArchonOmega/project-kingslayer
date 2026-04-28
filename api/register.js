// api/register.js
import bcrypt from 'bcryptjs';
import { supabase } from './_supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' });

  const { username, password, sl_username } = req.body || {};

  if (!username || !password)
    return res.status(400).json({ error: 'Username and password are required' });

  if (username.length < 3)
    return res.status(400).json({ error: 'Username must be at least 3 characters' });

  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });

  // Check if username taken
  const { data: existing } = await supabase
    .from('users')
    .select('id')
    .eq('username', username.toLowerCase())
    .single();

  if (existing)
    return res.status(409).json({ error: 'Username already taken' });

  const password_hash = await bcrypt.hash(password, 12);

  // Check if this is the very first user — make them admin + auto-approved
  const { count } = await supabase
    .from('users')
    .select('*', { count: 'exact', head: true });

  const isFirst = count === 0;

  const { error } = await supabase.from('users').insert({
    username:      username.toLowerCase(),
    sl_username:   sl_username || '',
    password_hash,
    is_admin:      isFirst,
    is_approved:   isFirst,
  });

  if (error)
    return res.status(500).json({ error: 'Failed to create account' });

  return res.status(201).json({
    message: isFirst
      ? 'Admin account created. You can log in immediately.'
      : 'Account created. Please wait for an admin to approve it.'
  });
}
