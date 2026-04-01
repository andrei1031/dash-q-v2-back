const { supabase } = require("../database/supabase");

exports.get_analytics = async (req, res) => {
    const { barberId } = req.params;
    if (!barberId) return res.status(400).json({ error: 'Barber ID required' });

    try {
        // Get current date in Philippines timezone
        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

        // 🟢 FIXED: Added 'vip_charge' to the select query to get real stored data
        const { data: cuts, error } = await supabase
            .from('queue_entries')
            .select('id, status, updated_at, created_at, is_vip, head_count, tip_amount, vip_charge, services(price_php)')
            .eq('barber_id', barberId)
            .in('status', ['Done', 'Completed', 'completed']); 

        if (error) throw error;

        let totalEarningsToday = 0;
        let totalCutsToday = 0;
        let totalEarningsWeek = 0;
        let totalCutsWeek = 0;

        const sevenDaysAgo = now.getTime() - (7 * 24 * 60 * 60 * 1000);

        cuts.forEach(cut => {
            // 🟢 FIXED MATH: (Base Price * Heads) + Stored VIP Charge + Tip
            const basePrice = parseFloat(cut.services?.price_php || 0);
            const heads = cut.head_count || 1;
            const vipFee = parseFloat(cut.vip_charge || 0); // Pulls the real 600 you mentioned
            const tip = parseFloat(cut.tip_amount || 0);
            
            const profit = (basePrice * heads) + vipFee + tip;

            const cutTime = new Date(cut.updated_at || cut.created_at).getTime();

            // Check if cut happened today
            if (cutTime >= startOfToday) {
                totalEarningsToday += profit;
                totalCutsToday += heads; 
            }

            // Check if cut happened in last 7 days
            if (cutTime >= sevenDaysAgo) {
                totalEarningsWeek += profit;
                totalCutsWeek += heads;
            }
        });

        res.json({
            totalEarningsToday,
            totalCutsToday,
            totalEarningsWeek,
            totalCutsWeek,
            totalCutsAllTime: cuts.reduce((sum, c) => sum + (c.head_count || 1), 0),
            carbonSavedToday: totalCutsToday * 150,
            carbonSavedTotal: cuts.reduce((sum, c) => sum + (c.head_count || 1), 0) * 150
        });

    } catch (err) {
        console.error("Analytics Error:", err);
        res.status(500).json({ error: "Failed to fetch analytics" });
    }
};