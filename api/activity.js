// api/activity.js — fetch activity log and leaderboard
const { supabase } = require('./_supabase');
const { requireAuth } = require('./_auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET')
    return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireAuth(req);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });

  const { period = 'alltime' } = req.query;

  // Build date filter
  let since = null;
  if (period === '30days') {
    since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  }

  // ── Recent feed (last 50 events) ────────────────────────
  let feedQuery = supabase
    .from('activity_log')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(50);

  if (since) feedQuery = feedQuery.gte('created_at', since);

  const { data: feed, error: feedError } = await feedQuery;
  if (feedError) return res.status(500).json({ error: feedError.message });

  // ── Leaderboard — aggregate per member ──────────────────
  let lbQuery = supabase
    .from('activity_log')
    .select('reported_by, event');

  if (since) lbQuery = lbQuery.gte('created_at', since);

  const { data: allEvents, error: lbError } = await lbQuery;
  if (lbError) return res.status(500).json({ error: lbError.message });

  // Aggregate counts per member
  const memberMap = {};
  for (const ev of allEvents) {
    const key = ev.reported_by;
    if (!memberMap[key]) {
      memberMap[key] = { member: key, claimed: 0, lost: 0, contested: 0, total: 0 };
    }
    memberMap[key][ev.event] = (memberMap[key][ev.event] || 0) + 1;
    memberMap[key].total++;
  }

  const leaderboard = Object.values(memberMap)
    .sort((a, b) => b.claimed - a.claimed || b.total - a.total);

  return res.status(200).json({ feed, leaderboard });
};
