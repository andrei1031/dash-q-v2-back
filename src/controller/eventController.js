const { supabase } = require("../database/supabase");

/**
 * ENDPOINT: Check for missed "Done" or "Cancelled" events
 * FIX: NOW PRESERVES HISTORY. Updates 'client_acknowledged' instead of deleting.
 */
exports.missed_events = async (req, res) => {
    const { userId } = req.params;
    if (!userId || userId === 'undefined') return res.status(400).json({ error: 'Valid User ID is required.' });

    try {
        // 1. Find unacknowledged events
        const { data: event, error: fetchError } = await supabase
            .from('queue_entries')
            .select('id, status')
            .eq('user_id', userId)
            .in('status', ['Done', 'Cancelled'])
            .eq('client_acknowledged', false) // Only get ones they haven't seen
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

        if (fetchError) throw fetchError;
        if (!event) return res.status(200).json({ event: null });

        console.log(`[Missed Event] Found '${event.status}' for user ${userId}.`);

        // 2. Mark as acknowledged (DO NOT DELETE)
        await supabase.from('queue_entries')
            .update({ client_acknowledged: true })
            .eq('id', event.id);

        res.status(200).json({ event: event.status });

    } catch (error) {
        console.error('[Missed Event] Error:', error.message);
        res.status(500).json({ error: 'Server error checking event.' });
    }
}