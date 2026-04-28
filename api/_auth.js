// api/_auth.js — session validation helper
import { supabase } from './_supabase.js';

/**
 * Validates the Bearer token from the Authorization header.
 * Returns { user } on success or { error, status } on failure.
 */
export async function requireAuth(req) {
  const header = req.headers['authorization'] || '';
  const token  = header.replace('Bearer ', '').trim();
  if (!token) return { error: 'No token', status: 401 };

  const { data: session } = await supabase
    .from('sessions')
    .select('user_id, expires_at')
    .eq('token', token)
    .single();

  if (!session) return { error: 'Invalid session', status: 401 };
  if (new Date(session.expires_at) < new Date())
    return { error: 'Session expired', status: 401 };

  const { data: user } = await supabase
    .from('users')
    .select('id, username, sl_username, is_admin, is_approved')
    .eq('id', session.user_id)
    .single();

  if (!user)           return { error: 'User not found', status: 401 };
  if (!user.is_approved) return { error: 'Account pending approval', status: 403 };

  return { user };
}

/**
 * Same as requireAuth but also checks is_admin.
 */
export async function requireAdmin(req) {
  const result = await requireAuth(req);
  if (result.error) return result;
  if (!result.user.is_admin) return { error: 'Admin only', status: 403 };
  return result;
}
