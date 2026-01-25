const { supabase } = require("../database/supabase");

/**
 * ENDPOINT 6: Get analytics for a barber (Fixed for Group Counts)
 */
exports.analytics_barber =  async (req, res) => {
    const { barberId } = req.params;
    
    try {
        // 1. Get visibility setting
        const { data: profile } = await supabase
            .from('barber_profiles')
            .select('show_earnings_analytics')
            .eq('id', barberId)
            .maybeSingle();
            
        // 2. Calculate Stats manually to ensure HEAD COUNT is used
        const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
        
        const { data: todayStats } = await supabase
            .from('services_completed')
            .select('price, head_count')
            .eq('barber_id', barberId)
            .gte('created_at', `${today}T00:00:00`);

        // Sum up heads and price
        const totalEarningsToday = todayStats?.reduce((sum, item) => sum + (item.price || 0), 0) || 0;
        const totalCutsToday = todayStats?.reduce((sum, item) => sum + (item.head_count || 1), 0) || 0;

        // 3. Queue Size (Count heads in Waiting/Up Next)
        const { data: queueData } = await supabase
            .from('queue_entries')
            .select('head_count')
            .eq('barber_id', barberId)
            .in('status', ['Waiting', 'Up Next']);
            
        const currentQueueSize = queueData?.reduce((sum, item) => sum + (item.head_count || 1), 0) || 0;

        // 4. Carbon (Dummy calculation for now)
        // NEW RULE: Flat +5g reward if at least 1 cut is done today.
        const carbonSavedToday = totalCutsToday > 0 ? 5 : 0;

        res.json({
            totalEarningsToday,
            totalCutsToday,
            currentQueueSize,
            carbonSavedToday,
            showEarningsAnalytics: profile?.show_earnings_analytics ?? true
        });

    } catch (error) {
        console.error('Error fetching analytics:', error.message);
        res.status(500).json({ error: 'Failed to fetch analytics.' });
    }
}