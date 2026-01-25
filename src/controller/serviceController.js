const { supabase } = require("../database/supabase");

/**
 * ENDPOINT (NEW): Get Service Menu (Active Only)
 */
exports.services = async (req, res) => {
    console.log('GET /api/services - Fetching service menu');
    try {
        // FIX: Only select services where is_active is TRUE
        const { data, error } = await supabase
            .from('services')
            .select('*')
            .eq('is_active', true)
            .order('duration_minutes', { ascending: true });

        if (error) throw error;
        res.json(data || []);
    } catch (error) {
        console.error('Error fetching services:', error.message);
        res.status(500).json({ error: 'Failed to retrieve service menu.' });
    }
}