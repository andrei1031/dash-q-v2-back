const { supabase } = require("../database/supabase");

exports.get_analytics = async (req, res) => {
    const { barberId } = req.params;
    if (!barberId) return res.status(400).json({ error: 'Barber ID required' });

    try {
        // Get current date in Philippines timezone
        const now = new Date();
        const nowPH = new Date(now.getTime() + (8 * 60 * 60 * 1000));
        const todayStr = nowPH.toISOString().split('T')[0];

        // Fetch ALL finished cuts for this barber
        const { data: cuts, error } = await supabase
            .from('queue_entries')
            .select('id, status, updated_at, created_at, is_vip, head_count, tip_amount, services(price_php)')
            .eq('barber_id', barberId)
            .in('status', ['Done', 'Completed', 'completed']); // 🟢 FIX: Matches our 'Done' status!

        if (error) throw error;

        let totalEarningsToday = 0;
        let totalCutsToday = 0;
        let totalEarningsWeek = 0;
        let totalCutsWeek = 0;
        let dailyMap = {};

        const sevenDaysAgo = new Date(nowPH);
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        cuts.forEach(cut => {
            // 🟢 FIX: Perfect Math Calculation (Base * Heads + VIP + Tip)
            const basePrice = parseFloat(cut.services?.price_php || 0);
            const heads = cut.head_count || 1;
            const vipFee = cut.is_vip ? (100 * heads) : 0; // Assuming 100 is VIP price
            const tip = parseFloat(cut.tip_amount || 0);
            const profit = (basePrice * heads) + vipFee + tip;

            // Determine date of cut in PH time
            const cutDate = new Date(cut.updated_at || cut.created_at);
            const cutDatePH = new Date(cutDate.getTime() + (8 * 60 * 60 * 1000));
            const dateString = cutDatePH.toISOString().split('T')[0];

            // Add to Today
            if (dateString === todayStr) {
                totalEarningsToday += profit;
                totalCutsToday += heads; 
            }

            // Add to Week
            if (cutDatePH >= sevenDaysAgo) {
                totalEarningsWeek += profit;
                totalCutsWeek += heads;

                if (!dailyMap[dateString]) dailyMap[dateString] = 0;
                dailyMap[dateString] += profit;
            }
        });

        // Format chart data
        let dailyData = [];
        let maxDay = { name: 'N/A', earnings: 0 };
        
        Object.keys(dailyMap).forEach(date => {
            dailyData.push({ day: date, daily_earnings: dailyMap[date] });
            if (dailyMap[date] > maxDay.earnings) {
                const d = new Date(date);
                maxDay = { name: d.toLocaleDateString('en-US', { weekday: 'long' }), earnings: dailyMap[date] };
            }
        });

        // Get current queue length
        const { count: queueCount } = await supabase
            .from('queue_entries')
            .select('id', { count: 'exact', head: true })
            .eq('barber_id', barberId)
            .in('status', ['Waiting', 'Up Next']);

        res.json({
            totalEarningsToday,
            totalCutsToday: totalCutsToday,
            totalEarningsWeek,
            totalCutsWeek: totalCutsWeek,
            totalCutsAllTime: cuts.length,
            dailyData: dailyData.sort((a,b) => new Date(a.day) - new Date(b.day)),
            busiestDay: maxDay,
            currentQueueSize: queueCount || 0,
            carbonSavedToday: totalCutsToday * 150,
            carbonSavedTotal: cuts.length * 150
        });

    } catch (err) {
        console.error("Analytics Error:", err);
        res.status(500).json({ error: "Failed to fetch analytics" });
    }
};