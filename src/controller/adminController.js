const axios = require("axios");
const { createQueueHelpers } = require("../utils/queueLogic");
const { supabase, supabaseAdmin } = require("../database/supabase");
const { isAdmin } = require("../utils/admin");

// Use supabaseAdmin for admin queries to bypass RLS
const db = supabaseAdmin;

const { enforceQueueLogic } = createQueueHelpers(supabaseAdmin);

// POST /api/admin/next-customer
// Body: { barberId: 5 }
exports.next_customer = async (req, res) => {
    const { barberId } = req.body;

    try {
        // 1. Find the current customer in the chair (status: 'serving') and finish them
        await db.query(
            "UPDATE queue SET status = 'completed' WHERE barber_id = $1 AND status = 'serving'",
            [barberId]
        );

        // 2. Find the next person waiting
        const nextCustomer = await db.query(
            "SELECT * FROM queue WHERE barber_id = $1 AND status = 'waiting' ORDER BY id ASC LIMIT 1",
            [barberId]
        );

        if (nextCustomer.rows.length === 0) {
            return res.json({ message: "Queue is empty for this barber." });
        }

        // 3. Update the next person to 'serving'
        const customer = nextCustomer.rows[0];
        await db.query("UPDATE queue SET status = 'serving' WHERE id = $1", [customer.id]);

        // 4. TRIGGER N8N (Notify the customer)
        // Note: We use the logic you already have, just triggering it manually here
        await axios.post(process.env.N8N_WEBHOOK_URL, {
            type: 'up_next', // Ensure your Switch node handles this!
            email: customer.email,
            name: customer.name,
            barberName: `Admin for Barber ${barberId}` // Or fetch actual name
        });

        res.json({ success: true, message: `Moved ${customer.name} to chair.` });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
    }
};

/**
 * ENDPOINT: Add a New Service (With Validation)
 */
exports.add_admin_services = async (req, res) => {
    const { userId, name, duration_minutes, price_php, price_vip_php } = req.body;

    if (!await isAdmin(userId)) return res.status(403).json({ error: 'Unauthorized.' });

    // VALIDATION: Prevent bad data
    if (!name || name.trim() === "") return res.status(400).json({ error: 'Service name is required.' });
    if (duration_minutes < 5) return res.status(400).json({ error: 'Duration must be at least 5 minutes.' });
    if (price_php < 0) return res.status(400).json({ error: 'Price cannot be negative.' });
    if (price_vip_php !== undefined && price_vip_php < 0) return res.status(400).json({ error: 'VIP Price cannot be negative.' });

    try {
        const { data, error } = await supabase.from('services').insert({
            name,
            duration_minutes: parseInt(duration_minutes),
            price_php: parseFloat(price_php),
            price_vip_php: (price_vip_php !== undefined && price_vip_php !== "") ? parseFloat(price_vip_php) : null,
            is_active: true
        }).select().single();

        if (error) throw error;
        res.json({ message: 'Service added successfully', data });
    } catch (error) {
        console.error("Admin add service error:", error.message);
        res.status(500).json({ error: error.message });
    }
}

/**
 * ENDPOINT: Edit a Service (Fixed for "Cannot coerce" error)
 */
exports.update_admin_service = async (req, res) => {
    const { id } = req.params;
    const { userId, name, duration_minutes, price_php, price_vip_php } = req.body;

    // Check Admin rights (assuming isAdmin function exists or you skip it for dev)
    // if (!await isAdmin(userId)) return res.status(403).json({ error: 'Unauthorized.' });

    // VALIDATION
    if (!name || name.trim() === "") return res.status(400).json({ error: 'Service name is required.' });
    if (duration_minutes < 5) return res.status(400).json({ error: 'Duration must be at least 5 minutes.' });
    if (price_php < 0) return res.status(400).json({ error: 'Price cannot be negative.' });
    if (price_vip_php !== undefined && price_vip_php < 0) return res.status(400).json({ error: 'VIP Price cannot be negative.' });

    try {
        const { data, error } = await supabase.from('services')
            .update({ 
                name, 
                duration_minutes, 
                price_php,
                price_vip_php: (price_vip_php !== undefined && price_vip_php !== "") ? parseFloat(price_vip_php) : null
            })
            .eq('id', id)
            .select(); // <--- REMOVED .single() to prevent crash

        if (error) throw error;

        // Check if anything was actually updated
        if (!data || data.length === 0) {
            return res.status(404).json({ error: 'Service ID not found (it may have been deleted).' });
        }

        res.json({ message: 'Service updated successfully', data: data[0] });
    } catch (error) {
        console.error("Admin edit service error:", error.message);
        res.status(500).json({ error: error.message });
    }
}

/**
 * ENDPOINT: Admin Get All Services (Active AND Archived)
 */
exports.all_services = async (req, res) => {
   // Note: Real-world apps should verify Admin ID here
    try {
        const { data, error } = await supabase
            .from('services')
            .select('*')
            .order('is_active', { ascending: false }) // Active first
            .order('name', { ascending: true });

        if (error) throw error;
        res.json(data || []);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}

/**
 * ENDPOINT: Admin Restore Service (Undo Delete)
 */
exports.restore_admin_service = async (req, res) => {
    const { id } = req.params;
    const { userId } = req.body;
    if (!await isAdmin(userId)) return res.status(403).json({ error: 'Unauthorized.' });

    try {
        const { error } = await supabase.rpc('restore_service', { p_service_id: parseInt(id) });
        if (error) throw error;
        res.json({ message: 'Service restored successfully.' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}

/**
 * ENDPOINT: Soft Delete a Service (Archive)
 * Prevents database crashes by hiding the service instead of deleting history.
 */
exports.remove_admin_service = async (req, res) => {
    const { id } = req.params;
    const { userId } = req.body;
    console.log(`DELETE /api/admin/services/${id} - Archive request by ${userId}`);

    if (!await isAdmin(userId)) return res.status(403).json({ error: 'Unauthorized.' });

    try {
        // Update is_active to false (Soft Delete)
        const { error } = await supabase
            .from('services')
            .update({ is_active: false })
            .eq('id', id);

        if (error) throw error;
        res.json({ message: 'Service archived successfully.' });
    } catch (error) {
        console.error("Admin delete service error:", error.message);
        res.status(500).json({ error: error.message });
    }
}

/**
 * ENDPOINT: Get Shop-Wide Analytics
 */
exports.get_admin_stats = async (req, res) => {
    try {
        // 1. Total Revenue (Sum of services_completed)
        const { data: revenueData, error: revError } = await supabase
            .from('services_completed')
            .select('price, head_count');
        if (revError) throw revError;
        // 2. Calculate Total Revenue (Same as before)
        const totalRevenue = revenueData.reduce((sum, item) => sum + (item.price || 0), 0);

        // 3. FIX: Calculate Total Cuts by summing head_count
        // OLD: const totalCuts = revenueData.length;
        const totalCuts = revenueData.reduce((sum, item) => sum + (item.head_count || 1), 0);

        // 3. Total Active Barbers
        const { count: barberCount, error: barberError } = await supabase.from('barber_profiles')
            .select('*', { count: 'exact', head: true })
            .eq('is_active', true);

        res.json({ totalRevenue, totalCuts, activeBarbers: barberCount || 0 });
    } catch (error) {
        console.error("Admin stats error:", error);
        res.status(500).json({ error: "Failed to load stats" });
    }
}

/**
 * ENDPOINT: Transfer Queue Entry (Admin)
 */
exports.queue_transfer = async (req, res) => {
    const { userId, queueId, targetBarberId } = req.body;
    console.log(`PUT /api/admin/transfer - Moving Queue #${queueId} to Barber ${targetBarberId}`);

    if (!await isAdmin(userId)) return res.status(403).json({ error: 'Unauthorized.' });

    try {
        // Use the RPC we created
        const { error } = await supabase.rpc('transfer_queue_item', {
            p_queue_id: parseInt(queueId),
            p_target_barber_id: parseInt(targetBarberId)
        });

        if (error) throw error;
        res.json({ message: 'Customer transferred successfully.' });
    } catch (error) {
        console.error("Transfer error:", error);
        res.status(500).json({ error: error.message });
    }
}

/**
 * ENDPOINT: Super Detailed Admin Analytics
 */
exports.get_admin_analytics = async (req, res) => {
    try {
        // IMPORTANT: Must call 'get_detailed_admin_analytics'
        const { data, error } = await supabase.rpc('get_detailed_admin_analytics');

        if (error) throw error;
        res.json(data);
    } catch (error) {
        console.error("Advanced analytics error:", error);
        res.status(500).json({ error: "Failed to load analytics." });
    }
}

/**
 * ENDPOINT: Analytics with Date Filtering (Daily, Weekly, Monthly, Yearly)
 */
exports.get_analytics_with_filter = async (req, res) => {
    const { period } = req.query; // 'daily', 'weekly', 'monthly', 'yearly', 'all'
    
    console.log("Analytics requested for period:", period);
    
    let startDate = null;
    const today = new Date();
    today.setHours(23, 59, 59, 999);
    
    switch (period) {
        case 'daily':
            startDate = new Date(today);
            startDate.setHours(0, 0, 0, 0);
            break;
        case 'weekly':
            startDate = new Date(today);
            startDate.setDate(today.getDate() - 7);
            break;
        case 'monthly':
            startDate = new Date(today);
            startDate.setMonth(today.getMonth() - 1);
            break;
        case 'yearly':
            startDate = new Date(today);
            startDate.setFullYear(today.getFullYear() - 1);
            break;
        default:
            startDate = null; // All time
    }

    try {
        // Build query based on date filter - WITHOUT joins since relationship may not exist
        let query = supabase
            .from('services_completed')
            .select('*')
            .order('created_at', { ascending: false });

        if (startDate) {
            query = query.gte('created_at', startDate.toISOString());
        }

        const { data: completedServices, error } = await query;

        if (error) {
            console.error("Supabase error fetching analytics:", error);
            throw new Error(error.message);
        }

        // Calculate totals
        const totalRevenue = completedServices ? completedServices.reduce((sum, item) => sum + (item.price || 0), 0) : 0;
        const totalCuts = completedServices ? completedServices.reduce((sum, item) => sum + (item.head_count || 1), 0) : 0;
        
        // Group by barber for performance matrix
        const barberMap = {};
        if (completedServices) {
            completedServices.forEach(item => {
                const barberId = item.barber_id;
                const barberName = 'Unknown Barber'; // Will need separate query if needed
                
                if (!barberMap[barberId]) {
                    barberMap[barberId] = {
                        barber_id: barberId,
                        full_name: barberName,
                        cuts: 0,
                        revenue: 0
                    };
                }
                barberMap[barberId].cuts += (item.head_count || 1);
                barberMap[barberId].revenue += (item.price || 0);
            });
        }

        // Try to get barber names if we have any
        const barberIds = Object.keys(barberMap);
        if (barberIds.length > 0) {
            const { data: barberProfiles } = await supabase
                .from('barber_profiles')
                .select('id, full_name')
                .in('id', barberIds);
            
            if (barberProfiles) {
                barberProfiles.forEach(bp => {
                    if (barberMap[bp.id]) {
                        barberMap[bp.id].full_name = bp.full_name;
                    }
                });
            }
        }

        const barberStats = Object.values(barberMap).sort((a, b) => b.revenue - a.revenue);

        // Get daily trend data
        const dailyMap = {};
        if (completedServices) {
            completedServices.forEach(item => {
                const date = new Date(item.created_at).toISOString().split('T')[0];
                if (!dailyMap[date]) {
                    dailyMap[date] = { day: date, daily_total: 0, cuts: 0 };
                }
                dailyMap[date].daily_total += (item.price || 0);
                dailyMap[date].cuts += (item.head_count || 1);
            });
        }

        const dailyTrend = Object.values(dailyMap).sort((a, b) => a.day.localeCompare(b.day));

        res.json({
            totals: {
                revenue: totalRevenue,
                cuts: totalCuts,
                period: period || 'all'
            },
            dailyTrend,
            barberStats,
            period_label: period === 'daily' ? 'Today' : 
                          period === 'weekly' ? 'Last 7 Days' : 
                          period === 'monthly' ? 'Last 30 Days' : 
                          period === 'yearly' ? 'Last 12 Months' : 'All Time'
        });
    } catch (error) {
        console.error("Filtered analytics error:", error);
        res.status(500).json({ error: "Failed to load filtered analytics: " + error.message });
    }
}

/**
 * ENDPOINT: Customer Database with Pagination
 */
exports.get_customers_database = async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const search = req.query.search || '';
    const offset = (page - 1) * limit;

    console.log("=== FETCHING CUSTOMERS ===");
    console.log("Page:", page, "Search:", search);

    try {
        // Try to get users from Supabase Auth API directly (most reliable)
        console.log("Fetching users from Auth API...");
        
        // First try: Get all users using Admin API
        const { data: authUsers, error: authError } = await supabaseAdmin.auth.admin.listUsers();
        
        if (authError) {
            console.error("Auth API error:", authError);
        }
        
        console.log("Auth users found:", authUsers?.users?.length || 0);
        
        // Get barber user IDs from barber_profiles table
        const { data: barberProfiles } = await db.from('barber_profiles').select('user_id');
        const barberUserIds = new Set((barberProfiles || []).map(b => b.user_id));
        
        console.log("Barber user IDs:", barberUserIds);
        
        // Filter out barbers (by checking barber_profiles) and admins
        let filteredUsers = (authUsers?.users || []).filter(u => {
            // Skip if user is in barber_profiles
            if (barberUserIds.has(u.id)) return false;
            // Skip if user has admin role in metadata
            const role = u.user_metadata?.role || u.role;
            if (role === 'admin') return false;
            return true;
        });
        
        // Filter by search if provided
        if (search && search.trim() !== '') {
            const searchLower = search.trim().toLowerCase();
            filteredUsers = filteredUsers.filter(u => 
                (u.email && u.email.toLowerCase().includes(searchLower)) ||
                (u.user_metadata?.full_name && u.user_metadata.full_name.toLowerCase().includes(searchLower))
            );
        }
        
        const totalCount = filteredUsers.length;
        const paginatedUsers = filteredUsers.slice(offset, offset + limit);
        
        // Transform to customer format
        const customers = paginatedUsers.map(user => ({
            id: user.id,
            full_name: user.user_metadata?.full_name || user.email?.split('@')[0] || 'Unknown',
            email: user.email,
            role: 'customer',
            created_at: user.created_at,
            visits: 0,
            totalSpent: 0
        }));

        console.log("Returning customers:", customers.length);

        res.json({
            customers: customers,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: totalCount || 0,
                totalPages: Math.ceil((totalCount || 0) / limit)
            }
        });
        
    } catch (error) {
        console.error("Customer database error:", error);
        res.status(500).json({ error: "Failed to load customer database: " + error.message });
    }
}

/**
 * ENDPOINT: Export Analytics as CSV
 */
exports.export_analytics_csv = async (req, res) => {
    const { period } = req.query;
    
    let startDate = null;
    const today = new Date();
    today.setHours(23, 59, 59, 999);
    
    switch (period) {
        case 'daily':
            startDate = new Date(today);
            startDate.setHours(0, 0, 0, 0);
            break;
        case 'weekly':
            startDate = new Date(today);
            startDate.setDate(today.getDate() - 7);
            break;
        case 'monthly':
            startDate = new Date(today);
            startDate.setMonth(today.getMonth() - 1);
            break;
        case 'yearly':
            startDate = new Date(today);
            startDate.setFullYear(today.getFullYear() - 1);
            break;
        default:
            startDate = null;
    }

    try {
        let query = supabase
            .from('services_completed')
            .select(`
                created_at,
                price,
                head_count,
                barber_profiles(full_name),
                services(name)
            `)
            .order('created_at', { ascending: false });

        if (startDate) {
            query = query.gte('created_at', startDate.toISOString());
        }

        const { data, error } = await query;
        if (error) throw error;

        // Convert to CSV
        const headers = ['Date', 'Time', 'Customer Name', 'Service', 'Barber', 'Heads', 'Price'];
        const rows = data.map(item => [
            new Date(item.created_at).toLocaleDateString(),
            new Date(item.created_at).toLocaleTimeString(),
            item.customer_name || 'Guest',
            item.services?.name || 'Unknown',
            item.barber_profiles?.full_name || 'Unknown',
            item.head_count || 1,
            item.price || 0
        ]);

        const csvContent = [
            headers.join(','),
            ...rows.map(row => row.join(','))
        ].join('\n');

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=analytics_${period || 'all'}_${new Date().toISOString().split('T')[0]}.csv`);
        res.send(csvContent);
    } catch (error) {
        console.error("CSV export error:", error);
        res.status(500).json({ error: "Failed to export CSV." });
    }
}

/**
 * ENDPOINT: Get All Users (Robust Version)
 */
exports.get_all_users = async (req, res) => {
    try {
        console.log("GET /api/admin/users - Fetching profiles...");

        // FIX: Select ALL columns (*) to avoid errors if specific columns are missing
        // We also remove the .order() temporarily to rule out sorting errors
        const { data, error } = await supabase
            .from('profiles')
            .select('*');

        if (error) {
            console.error("Supabase Error fetching profiles:", error.message);
            throw error;
        }

        console.log(`Found ${data.length} profiles.`);
        res.json(data);
    } catch (error) {
        console.error("Error fetching users:", error.message);
        res.status(500).json({ error: "Failed to load users: " + error.message });
    }
}


/**
 * ENDPOINT: Delete User Account (Safely)
 */
exports.remove_user = async (req, res) => {
    const { targetId } = req.params;
    const { userId } = req.body;

    if (!await isAdmin(userId)) return res.status(403).json({ error: 'Unauthorized.' });

    try {
        console.log(`Admin ${userId} deleting user ${targetId}`);

        // 1. Try to delete from Auth (Supabase handles most cascades, but not all)
        const { error } = await supabaseAdmin.auth.admin.deleteUser(targetId);
        if (error) throw error;

        // 2. Manually clean up the profile just in case
        await supabase.from('profiles').delete().eq('id', targetId);

        res.json({ message: 'User account deleted.' });
    } catch (error) {
        console.error("Delete user error:", error);
        // Return a helpful error if it fails due to database links
        if (error.message.includes('foreign key constraint')) {
            return res.status(409).json({ error: 'Cannot delete user: They have active records (History/Queue). Ask them to cancel appointments first.' });
        }
        res.status(500).json({ error: "Delete failed: " + error.message });
    }
}

/**
 * FEATURE 1: Admin "Force Next"
 * Automatically finds the next person for a specific barber and moves them to "In Progress".
 */
exports.force_next = async (req, res) => {
     const { userId, barberId } = req.body; // userId is Admin's ID

    if (!await isAdmin(userId)) return res.status(403).json({ error: 'Unauthorized.' });

    try {
        // 1. Check if chair is occupied
        const { data: inChair } = await supabase
            .from('queue_entries')
            .select('id, customer_name')
            .eq('barber_id', barberId)
            .eq('status', 'In Progress')
            .maybeSingle();

        if (inChair) {
            return res.status(400).json({ error: `Chair is currently occupied by ${inChair.customer_name}. Finish them first.` });
        }

        // 2. Find the next candidate (Up Next OR Top Waiting)
        // Priority: Up Next -> VIP Waiting -> Regular Waiting
        let nextCustomer = null;

        // A. Check Up Next
        const { data: upNext } = await supabase
            .from('queue_entries')
            .select('*')
            .eq('barber_id', barberId)
            .eq('status', 'Up Next')
            .maybeSingle();
        
        nextCustomer = upNext;

        // B. If no Up Next, check Waiting
        if (!nextCustomer) {
            const { data: waiting } = await supabase
                .from('queue_entries')
                .select('*')
                .eq('barber_id', barberId)
                .eq('status', 'Waiting')
                .order('is_vip', { ascending: false })
                .order('created_at', { ascending: true })
                .limit(1)
                .maybeSingle();
            nextCustomer = waiting;
        }

        if (!nextCustomer) {
            return res.status(400).json({ error: 'Queue is empty for this barber.' });
        }

        console.log(`[Admin Force] Moving Customer #${nextCustomer.id} for Barber ${barberId}`);

        // 3. EXECUTE MOVE (Re-using RPC Logic)
        const { error: rpcError } = await supabase.rpc('call_next_customer', {
            p_barber_id: parseInt(barberId),
            p_queue_id: nextCustomer.id
        });

        if (rpcError) throw rpcError;

        // 4. TRIGGER AUTO-FILL (Atomic logic)
        await enforceQueueLogic(parseInt(barberId));

        // 5. NOTIFY (Standard Logic)
        // We trigger the notification logic just like the standard endpoint
        // (Simplified here: The standard /api/queue/next does this, but since we called RPC directly,
        // we rely on the client or the fact that 'call_next_customer' sets status to 'In Progress')

        res.json({ message: `Successfully moved ${nextCustomer.customer_name} to chair.`, customer: nextCustomer });

    } catch (error) {
        console.error("Force Next Error:", error);
        res.status(500).json({ error: error.message });
    }
}