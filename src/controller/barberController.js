const { supabase } = require("../database/supabase");

/**
 * ENDPOINT: Get Barbers with Ratings & PRECISE Queue Size
 */
exports.barbers = async (req, res) => {
    try {
        // 1. Get Barbers
        const { data: barbers, error } = await supabase.rpc('get_available_barbers_with_ratings');
        if (error) throw error;

        // 2. Get ACTIVE Queue Counts
        // NOTE: We only count 'Waiting' and 'Up Next'. 
        // We DO NOT count 'In Progress' here, so users see how many are actually WAITING.
        const { data: queueCounts, error: qError } = await supabase
            .from('queue_entries')
            .select('barber_id, head_count')
            .in('status', ['Waiting', 'Up Next']); 

        if (qError) throw qError;

        // 3. Match them up (Strict Integer Comparison)
        const barbersWithCounts = barbers.map(b => {
            const bId = parseInt(b.id); // Ensure integer
            
            const barberEntries = queueCounts?.filter(q => parseInt(q.barber_id) === bId) || [];
            
            const totalHeads = barberEntries.reduce((sum, entry) => sum + (entry.head_count || 1), 0);
            
            return {
                ...b,
                queue_length: totalHeads 
            };
        });

        res.json(barbersWithCounts || []);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}

/**
 * ENDPOINT 1.5: Get barber profile by user_id
 */
exports.profile = async (req, res) => {
    const { userId } = req.params;
    console.log(`GET /api/barber/profile/${userId} - Fetching profile`);
    if (!userId || userId === 'undefined' || userId === 'null') return res.status(400).json({ error: 'Valid User ID is required.' });
    try {
        const { data, error } = await supabase.from('barber_profiles').select('id, user_id, full_name, is_available').eq('user_id', userId).single();
        if (error) { if (error.code === 'PGRST116') return res.status(404).json({ error: 'Barber profile not found.' }); throw error; }
        if (!data) return res.status(404).json({ error: 'Barber profile not found.' });
        console.log('Successfully fetched barber profile:', data); res.json(data);
    } catch (catchError) { console.error("Catch block error fetching profile:", catchError); res.status(500).json({ error: 'Server error fetching profile.' }); }
}

/**
 * ENDPOINT 1.7: Set barber availability
 */
exports.availability = async (req, res) => {
    const { barberId, isAvailable, userId } = req.body; const barberIdInt = parseInt(barberId);
    console.log(`PUT /api/barber/availability - Setting barber ${barberIdInt} avail: ${isAvailable} by user ${userId}`);
    if (isNaN(barberIdInt) || isAvailable === undefined || !userId) return res.status(400).json({ error: 'Valid IDs and status required.' });
    try {
        const { data: ownerCheck, error: ownerError } = await supabase.from('barber_profiles').select('user_id').eq('id', barberIdInt).single();
        if (ownerError || !ownerCheck || ownerCheck.user_id !== userId) {
            console.warn(`Authorization failed: User ${userId} attempted action on profile.`);
            return res.status(403).json({ error: 'You are not authorized to perform this action.' });
        }
        const { data, error } = await supabase.from('barber_profiles').update({ is_available: isAvailable }).eq('id', barberIdInt).select('id, is_available').single();
        if (error) throw error;
        if (isAvailable === false) {
            console.log(`Clearing session flag for user ${userId}`);
            const { error: clearFlagError } = await supabase.from('profiles').update({ current_session_id: null }).eq('id', userId);
            if (clearFlagError) { console.error("Failed to clear concurrency flag on logout:", clearFlagError); }
        }
        console.log('Updated availability:', data); res.json(data);
    } catch (catchError) { console.error("Catch block error updating avail:", catchError); res.status(500).json({ error: 'Server error updating availability.' }); }

}

/**
 * ENDPOINT (NEW): Set barber earnings visibility
 */
exports.earnings = async (req, res) => {
    const { barberId, showEarnings, userId } = req.body;
    const barberIdInt = parseInt(barberId);

    if (isNaN(barberIdInt) || showEarnings === undefined || !userId) {
        return res.status(400).json({ error: 'Valid barber ID, user ID, and visibility status are required.' });
    }
    try {
        const { data: ownerCheck, error: ownerError } = await supabase.from('barber_profiles').select('user_id').eq('id', barberIdInt).single();
        if (ownerError || !ownerCheck || ownerCheck.user_id !== userId) {
            return res.status(403).json({ error: 'You are not authorized to change these settings.' });
        }
        const { data, error } = await supabase.from('barber_profiles').update({ show_earnings_analytics: showEarnings }).eq('id', barberIdInt).select('id, show_earnings_analytics').single();
        if (error) {
            console.warn("Could not update earnings visibility (column might be missing):", error.message);
        }
        console.log('Updated earnings visibility setting:', data);
        res.json(data || { id: barberIdInt, show_earnings_analytics: showEarnings });
    } catch (catchError) {
        console.error("Catch block error updating earnings visibility:", catchError);
        res.status(500).json({ error: 'Server error updating settings.' });
    }
}

/**
 * ENDPOINT: Get All Barbers (For Staff Management)
 */
exports.get_all_barbers = async (req, res) => {
    // We assume the requester is admin, checked via frontend or subsequent action, 
    // but ideally, you pass userId in headers for strict checking. 
    // For now, we rely on the secure RLS policies or simplicity.
    try {
        const { data, error } = await supabase
            .from('barber_profiles')
            .select('*')
            .order('full_name', { ascending: true });

        if (error) throw error;
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}

/**
 * ENDPOINT: Toggle Barber Status (Ban/Unban)
 * UPDATED: Also clears 'is_banned' on the user profile when activating
 */
exports.barbers_status = async (req, res) => {
    const { id } = req.params;
    const { userId, is_active } = req.body; // userId is the admin's ID

    if (!await isAdmin(userId)) return res.status(403).json({ error: 'Unauthorized.' });

    try {
        // 1. Update Barber Profile (Active/Inactive)
        const { data: barber, error } = await supabase.from('barber_profiles')
            .update({
                is_active: is_active,
                current_session_id: is_active ? undefined : null
            })
            .eq('id', id)
            .select('user_id') // Get the linked user_id to unban the main profile
            .single();

        if (error) throw error;

        // 2. IMPORTANT: If activating, ensure the main User Profile is NOT banned
        if (is_active && barber.user_id) {
            await supabase.from('profiles')
                .update({ is_banned: false })
                .eq('id', barber.user_id);
        }

        res.json({ message: `Barber ${is_active ? 'activated & unbanned' : 'deactivated'}.` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}