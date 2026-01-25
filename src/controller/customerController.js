const fetch = require('node-fetch');
const { supabase, SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_ANON_KEY } = require("../database/supabase");

/**
 * ENDPOINT (NEW): Clear session flag on customer logout
 */
exports.flag = async (req, res) => {
    const { userId } = req.body;

    console.log(`PUT /api/logout/flag - Clearing session flag for user ${userId}`);

    if (!userId) return res.status(400).json({ error: 'User ID is required.' });

    try {
        // 1. Clear session flag in 'profiles' (Required for login concurrency)
        const { error: profileError } = await supabase.from('profiles')
            .update({ current_session_id: null })
            .eq('id', userId);
        if (profileError) throw profileError;

        // 2. Set barber to INACTIVE and UNAVAILABLE in 'barber_profiles'
        const { error: barberError } = await supabase.from('barber_profiles')
            .update({ is_active: false, is_available: false, current_session_id: null })
            .eq('user_id', userId);

        if (barberError && barberError.code !== 'PGRST116') {
            throw barberError;
        }

        res.status(200).json({ message: 'Flags cleared and availability updated' });
    } catch (error) {
        console.error("Error clearing customer session flag during logout:", error.message);
        res.status(500).json({ error: 'Server error clearing session.' });
    }
};

/**
 * ENDPOINT: Fetch Customer Loyalty History (Fixed for Stars & Groups)
 */
exports.history = async (req, res) => {
    const { userId } = req.params;

    try {
        const { data, error } = await supabase.from('queue_entries')
            .select(`
                created_at, 
                status, 
                services(name, price_php), 
                barber_profiles(full_name),
                is_vip,
                head_count,
                score,
                feedback_comment,
                tip_amount  
            `) // <--- ADDED tip_amount HERE
            .eq('user_id', userId)
            .order('created_at', { ascending: false });

        // If services_completed doesn't have user_id yet, fallback to queue_entries
        if (error) {
            const { data: fallbackData } = await supabase
                .from('queue_entries')
                .select(`
                    created_at, status, head_count, is_vip,
                    services(name, price_php),
                    barber_profiles(full_name)
                `)
                .eq('user_id', userId)
                .in('status', ['Done', 'Cancelled'])
                .order('created_at', { ascending: false });
            return res.json(fallbackData || []);
        }

        // Format the data
        const history = data.map(item => ({
            created_at: item.created_at,
            status: 'Done',
            price_total: item.price,
            head_count: item.head_count || 1,
            barber_name: item.barber_profiles?.full_name,
            score: item.feedback?.[0]?.score || null, // Get star rating
            comments: item.feedback?.[0]?.comments || null
        }));

        res.json(history);

    } catch (error) {
        console.error("Error fetching history:", error.message);
        res.status(500).json({ error: 'Failed to retrieve history.' });
    }
};

/**
 * ENDPOINT (NEW): Fetch Customer Loyalty History (For Barber/Admin Use)
 * Securely finds the customer's ID and fetches their Done/Cancelled history.
 */
exports.customer_loyalty = async (req, res) => {
    const { customerEmail } = req.params;
    console.log(`GET /api/barber/customer-loyalty/${customerEmail} - Loyalty check`);

    if (!customerEmail) {
        return res.status(400).json({ error: 'Customer email is required.' });
    }

    try {
        // Step 1: Find the User ID associated with the email via the Auth Admin API
        const checkEmailResponse = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(customerEmail)}`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'apikey': SUPABASE_ANON_KEY }
        });

        if (!checkEmailResponse.ok) {
            // Treat 404 (Not Found) as a non-registered customer
            if (checkEmailResponse.status === 404) {
                return res.status(200).json({ count: 0, history: [] });
            }
            const body = await checkEmailResponse.text();
            throw new Error(`Auth lookup failed: ${checkEmailResponse.status} ${body}`);
        }

        const data = await checkEmailResponse.json();
        const targetUser = data?.users?.find(u => u.email === customerEmail);

        if (!targetUser) {
            // Email is valid but user might be unconfirmed or not found
            return res.status(200).json({ count: 0, history: [] });
        }

        const customerUserId = targetUser.id;

        // Step 2: Fetch completed/cancelled entries using the found user_id
        const { data: historyData, error: historyError } = await supabase.from('queue_entries')
            .select(`
                created_at, 
                status, 
                services(name, price_php), 
                barber_profiles(full_name),
                is_vip
            `)
            .eq('user_id', customerUserId)
            .in('status', ['Done', 'Cancelled'])
            .order('created_at', { ascending: false });

        if (historyError) throw historyError;

        const doneCount = historyData
            .filter(h => h.status === 'Done')
            .reduce((sum, entry) => sum + (entry.head_count || 1), 0);

        // Step 3: Return the count and history
        res.json({ count: doneCount, history: historyData || [] });

    } catch (error) {
        console.error("Error fetching customer loyalty history for barber:", error.message);
        res.status(500).json({ error: 'Server error retrieving customer history.' });
    }
}

/**
 * ENDPOINT 9 (MODIFIED): Analyze and save customer feedback
 * Now accepts a star rating (1-5) and comment.
 */
exports.feedback = async (req, res) => {
    // Destructure the numeric 'rating' field sent from the client
    const { barber_id, customer_name, comments, rating } = req.body;

    // 1. Validation: Ensure the rating is a valid integer between 1 and 5
    const customerRating = parseInt(rating);
    if (isNaN(customerRating) || customerRating < 1 || customerRating > 5) {
        return res.status(400).json({ error: 'A valid star rating (1-5) is required.' });
    }
    if (!comments || comments.trim().length === 0) {
        return res.status(400).json({ error: 'Feedback comments cannot be empty.' });
    }

    try {
        const scoreToSave = customerRating; // scoreToSave will be 2 (or 3, 4, etc.)

        // 2. CRITICAL WRITE: Insert the correct numeric rating into the 'score' column
        const { error } = await supabase.from('feedback').insert({
            barber_id: parseInt(barber_id),
            customer_name: customer_name,
            comments: comments,
            score: scoreToSave, // <--- This must write the numeric value (2)
        });

        if (error) {
            // If this error block is executed, the issue is database schema/RLS.
            console.error(`[CRITICAL DB ERROR] Supabase insert failed: ${error.code} - ${error.message}`);
            // Throwing the error will allow you to see the database reason in the server logs.
            throw new Error(`Database Error: ${error.message}`);
        }

        console.log(`[Feedback] Successfully saved rating ${scoreToSave} for barber ${barber_id}.`);
        res.status(201).json({ message: 'Feedback saved!', score: scoreToSave });

    } catch (error) {
        console.error('[Feedback] Error saving feedback (General Catch):', error.message);
        res.status(500).json({ error: 'Server error saving feedback. Final code fix applied. Please check Supabase schema/policies.' });
    }
}

/**
 * ENDPOINT 10 (MODIFIED): Get feedback for a specific barber
 */
exports.get_feedback_barber = async (req, res) => {
    const { barberId } = req.params;
    console.log(`[Feedback] Fetching feedback for barber ${barberId}`);

    try {
        // Now selecting 'score' which represents the star rating
        const { data, error } = await supabase
            .from('feedback')
            .select('customer_name, comments, score, created_at')
            .eq('barber_id', barberId)
            .order('created_at', { ascending: false })
            .limit(10);

        if (error) { throw error; }

        res.json(data || []);

    } catch (error) {
        console.error('[Feedback] Error fetching feedback:', error.message);
        res.status(500).json({ error: error.message || 'Server error fetching feedback.' });
    }
}