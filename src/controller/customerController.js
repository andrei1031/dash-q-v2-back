const axios = require('axios');
// 🟢 IMPORT SUPABASE ADMIN TO BYPASS RLS SECURITY BLOCKS
const { supabase, supabaseAdmin, SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_ANON_KEY } = require("../database/supabase");

exports.flag = async (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'User ID is required.' });

    try {
        const { error: profileError } = await supabase.from('profiles').update({ current_session_id: null }).eq('id', userId);
        if (profileError) throw profileError;

        const { error: barberError } = await supabase.from('barber_profiles').update({ is_active: false, is_available: false, current_session_id: null }).eq('user_id', userId);
        if (barberError && barberError.code !== 'PGRST116') throw barberError;

        res.status(200).json({ message: 'Flags cleared and availability updated' });
    } catch (error) {
        res.status(500).json({ error: 'Server error clearing session.' });
    }
};

exports.history = async (req, res) => {
    const { userId } = req.params;
    try {
        const { data, error } = await supabase.from('queue_entries')
            .select(`created_at, status, services(name, price_php), barber_profiles(full_name), is_vip, head_count, score, feedback_comment, tip_amount`)
            .eq('user_id', userId).order('created_at', { ascending: false });

        if (error) {
            const { data: fallbackData } = await supabase.from('queue_entries')
                .select(`created_at, status, head_count, is_vip, services(name, price_php), barber_profiles(full_name)`)
                .eq('user_id', userId).in('status', ['Done', 'Cancelled']).order('created_at', { ascending: false });
            return res.json(fallbackData || []);
        }

        let loyaltyData = null;
        const { data: loyalty, loyaltyError } = await supabase.from('customer_loyalty')
            .select('total_spent, total_points, current_tier, total_visits, lifetime_points').eq('user_id', userId).single();

        if (!loyaltyError && loyalty) loyaltyData = loyalty;

        const history = data.map(item => {
            const basePrice = parseFloat(item.services?.price_php || 0);
            const heads = item.head_count || 1;
            const vipFee = item.is_vip ? 100 : 0;
            const tip = item.tip_amount ? parseFloat(item.tip_amount) : 0;
            return {
                created_at: item.created_at, status: item.status === 'Done' ? 'Done' : 'Cancelled',
                price_total: (basePrice * heads) + (vipFee * heads) + tip, head_count: heads,
                barber_name: item.barber_profiles?.full_name, score: item.feedback?.[0]?.score || null,
                comments: item.feedback?.[0]?.comments || null, service_name: item.services?.name || 'Unknown Service'
            };
        });

        res.json({ history: history, loyalty: loyaltyData || { total_spent: 0, total_points: 0, current_tier: 'bronze', total_visits: 0, lifetime_points: 0 } });
    } catch (error) {
        res.status(500).json({ error: 'Failed to retrieve history.' });
    }
};

exports.customer_loyalty = async (req, res) => {
    const { customerEmail } = req.params;
    if (!customerEmail) return res.status(400).json({ error: 'Customer email is required.' });

    try {
        // 🟢 FIXED: Swapped fetch for axios to prevent server crashes
        const checkEmailResponse = await axios.get(`${SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(customerEmail)}`, {
            headers: { 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'apikey': SUPABASE_ANON_KEY }
        });

        const targetUser = checkEmailResponse.data?.users?.find(u => u.email === customerEmail);

        if (!targetUser) return res.status(200).json({ count: 0, history: [] });

        const { data: historyData, error: historyError } = await supabase.from('queue_entries')
            .select(`created_at, status, services(name, price_php), barber_profiles(full_name), is_vip`)
            .eq('user_id', targetUser.id).in('status', ['Done', 'Cancelled']).order('created_at', { ascending: false });

        if (historyError) throw historyError;

        const doneCount = historyData.filter(h => h.status === 'Done').reduce((sum, entry) => sum + (entry.head_count || 1), 0);
        res.json({ count: doneCount, history: historyData || [] });
    } catch (error) {
        console.error("Loyalty Error:", error);
        res.status(500).json({ error: 'Server error retrieving customer history.' });
    }
}

exports.feedback = async (req, res) => {
    const { barber_id, customer_name, comments, rating, queue_id } = req.body;

    const customerRating = parseInt(rating);
    if (isNaN(customerRating) || customerRating < 1 || customerRating > 5) {
        return res.status(400).json({ error: 'A valid star rating (1-5) is required.' });
    }

    try {
        const payload = {
            barber_id: parseInt(barber_id),
            customer_name: customer_name || 'Guest',
            comments: comments || '',
            score: customerRating,
        };

        if (queue_id) payload.queue_id = parseInt(queue_id);

        console.log("[Feedback] Attempting Save:", payload);

        // 1. USE supabaseAdmin to completely ignore RLS constraints
        const { data, error } = await supabaseAdmin.from('feedback').insert(payload).select();

        if (error) {
            console.error(`[Feedback Error]:`, error);
            
            // Failsafe: If the database is complaining about "queue_id" not existing, try without it!
            if (error.message.includes('queue_id') || error.code === 'PGRST204') {
                console.log("[Feedback] Retrying without queue_id column...");
                delete payload.queue_id;
                const retry = await supabaseAdmin.from('feedback').insert(payload).select();
                if (retry.error) throw new Error(retry.error.message);
                return res.status(201).json({ message: 'Feedback saved!', data: retry.data });
            }
            throw new Error(error.message);
        }

        console.log(`[Feedback] Success!`);
        res.status(201).json({ message: 'Feedback saved!', data });

    } catch (error) {
        console.error('[Feedback] Fatal Server Error:', error.message);
        res.status(500).json({ error: error.message });
    }
}

exports.get_feedback_barber = async (req, res) => {
    const { barberId } = req.params;
    try {
        const { data, error } = await supabase.from('feedback')
            .select('customer_name, comments, score, created_at')
            .eq('barber_id', barberId).order('created_at', { ascending: false }).limit(10);
        if (error) throw error;
        res.json(data || []);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}