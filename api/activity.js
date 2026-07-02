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
    .select('reported_by, event, created_at');

  if (since) lbQuery = lbQuery.gte('created_at', since);

  const { data: allEvents, error: lbError } = await lbQuery;
  if (lbError) return res.status(500).json({ error: lbError.message });

  // Extract the (username) from a reported_by string; fall back to the whole
  // string if there's no parenthesised username.
  function extractUsername(reportedBy) {
    if (!reportedBy) return '';
    const m = reportedBy.match(/\(([^)]+)\)\s*$/);
    return (m ? m[1] : reportedBy).trim().toLowerCase();
  }

  // Aggregate counts per USERNAME (not per display string), so display-name
  // changes don't split a member into multiple leaderboard rows.
  const memberMap = {};
  for (const ev of allEvents) {
    const uname = extractUsername(ev.reported_by);
    if (!uname) continue;
    if (!memberMap[uname]) {
      memberMap[uname] = {
        username: uname,
        member:   ev.reported_by,
        _latest:  ev.created_at,
        claimed: 0, lost: 0, contested: 0, total: 0,
      };
    }
    // Keep the display string from the most recent event for this username
    if (ev.created_at && ev.created_at > memberMap[uname]._latest) {
      memberMap[uname]._latest = ev.created_at;
      memberMap[uname].member  = ev.reported_by;
    }
    memberMap[uname][ev.event] = (memberMap[uname][ev.event] || 0) + 1;
    memberMap[uname].total++;
  }

  const leaderboard = Object.values(memberMap)
    .sort((a, b) => b.claimed - a.claimed || b.total - a.total);

  return res.status(200).json({ feed, leaderboard });
};
