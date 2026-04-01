const { supabase } = require("../database/supabase");

exports.get_analytics = async (req, res) => {
    const { barberId } = req.params;
    if (!barberId) return res.status(400).json({ error: 'Barber ID required' });

    try {
        // 🟢 FIX 1: Correct Philippines Timezone Offset (+8 Hours)
        const now = new Date();
        const phTime = new Date(now.getTime() + (8 * 60 * 60 * 1000));
        const startOfToday = new Date(phTime.getFullYear(), phTime.getMonth(), phTime.getDate()).getTime();

        const { data: cuts, error } = await supabase
            .from('queue_entries')
            .select('id, status, updated_at, created_at, is_vip, head_count, tip_amount, vip_charge, services(price_php)')
            .eq('barber_id', barberId)
            .in('status', ['Done', 'Completed', 'completed']); 

        if (error) throw error;

        // 🟢 FIX 2: Prevent crash if cuts is null
        const safeCuts = cuts || [];

        let totalEarningsToday = 0;
        let totalCutsToday = 0;
        let totalEarningsWeek = 0;
        let totalCutsWeek = 0;

        const sevenDaysAgo = phTime.getTime() - (7 * 24 * 60 * 60 * 1000);

        safeCuts.forEach(cut => {
            const basePrice = parseFloat(cut.services?.price_php || 0);
            const heads = cut.head_count || 1;
            const vipFee = parseFloat(cut.vip_charge || 0); 
            const tip = parseFloat(cut.tip_amount || 0);
            const profit = (basePrice * heads) + vipFee + tip;

            // 🟢 FIX 3: Ensure comparison uses PH-adjusted timestamps
            const cutTimeUTC = new Date(cut.updated_at || cut.created_at).getTime();
            const cutTimePH = cutTimeUTC + (8 * 60 * 60 * 1000);

            if (cutTimePH >= startOfToday) {
                totalEarningsToday += profit;
                totalCutsToday += heads; 
            }

            if (cutTimePH >= sevenDaysAgo) {
                totalEarningsWeek += profit;
                totalCutsWeek += heads;
            }
        });

        // 🟢 FIX 4: Use safe reduction to prevent crashes
        const allTimeHeads = safeCuts.reduce((sum, c) => sum + (c.head_count || 1), 0);

        res.json({
            totalEarningsToday,
            totalCutsToday,
            totalEarningsWeek,
            totalCutsWeek,
            totalCutsAllTime: allTimeHeads,
            carbonSavedToday: totalCutsToday * 150,
            carbonSavedTotal: allTimeHeads * 150
        });

    } catch (err) {
        console.error("Analytics Error:", err);
        res.status(500).json({ error: "Failed to fetch analytics" });
    }
};