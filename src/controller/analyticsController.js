const { supabase } = require("../database/supabase");

exports.get_analytics = async (req, res) => {
    const { barberId } = req.params;
    if (!barberId) return res.status(400).json({ error: 'Barber ID required' });

    try {
        // Correct Philippines Timezone Offset (+8 Hours)
        const now = new Date();
        const phTime = new Date(now.getTime() + (8 * 60 * 60 * 1000));
        const startOfToday = new Date(phTime.getFullYear(), phTime.getMonth(), phTime.getDate()).getTime();
        const sevenDaysAgo = phTime.getTime() - (7 * 24 * 60 * 60 * 1000);

        // 1. Fetch cuts from queue_entries for head counts and carbon metrics
        const { data: cuts, error } = await supabase
            .from('queue_entries')
            .select('id, status, updated_at, created_at, head_count')
            .eq('barber_id', barberId)
            .in('status', ['Done']);

        if (error) throw error;

        // 2. Fetch financials from services_completed ledger for exact earnings
        // This guarantees Base + Tip + VIP is 100% accurate.
        const { data: financials, error: finError } = await supabase
            .from('services_completed')
            .select('price, created_at')
            .eq('barber_id', barberId);

        if (finError) throw finError;

        const safeCuts = cuts || [];
        const safeFinancials = financials || [];

        let totalEarningsToday = 0;
        let totalCutsToday = 0;
        let totalEarningsWeek = 0;
        let totalCutsWeek = 0;
        let daysMap = {};

        // Process Counts & Busiest Day (from queue_entries)
        safeCuts.forEach(cut => {
            const heads = cut.head_count || 1;
            const cutTimeUTC = new Date(cut.updated_at || cut.created_at).getTime();
            const cutTimePH = cutTimeUTC + (8 * 60 * 60 * 1000);

            if (cutTimePH >= startOfToday) {
                totalCutsToday += heads; 
            }

            if (cutTimePH >= sevenDaysAgo) {
                totalCutsWeek += heads;
                
                // Track busiest day
                const dayName = new Date(cutTimePH).toLocaleDateString('en-US', { weekday: 'long' });
                daysMap[dayName] = (daysMap[dayName] || 0) + heads;
            }
        });

        // Process Earnings strictly from services_completed
        safeFinancials.forEach(entry => {
            const profit = parseFloat(entry.price || 0); // Contains exact totalProfit saved during complete()
            const entryTimeUTC = new Date(entry.created_at).getTime();
            const entryTimePH = entryTimeUTC + (8 * 60 * 60 * 1000);

            if (entryTimePH >= startOfToday) {
                totalEarningsToday += profit;
            }
            if (entryTimePH >= sevenDaysAgo) {
                totalEarningsWeek += profit;
            }
        });

        // Determine Busiest Day
        let busiestDay = { name: 'N/A', count: 0 };
        for (const [day, count] of Object.entries(daysMap)) {
            if (count > busiestDay.count) {
                busiestDay = { name: day, count };
            }
        }

        const allTimeHeads = safeCuts.reduce((sum, c) => sum + (c.head_count || 1), 0);

        res.json({
            totalEarningsToday,
            totalCutsToday,
            totalEarningsWeek,
            totalCutsWeek,
            totalCutsAllTime: allTimeHeads,
            busiestDay, 
            carbonSavedToday: totalCutsToday * 150,
            carbonSavedTotal: allTimeHeads * 150
        });

    } catch (err) {
        console.error("Analytics Error:", err);
        res.status(500).json({ error: "Failed to fetch analytics" });
    }
};