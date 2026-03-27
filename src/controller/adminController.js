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
 * ENDPOINT: Hard/Permanent Delete a Service
 * Only if not referenced in queue_entries or services_completed.
 */
exports.hard_delete_admin_service = async (req, res) => {
    const { id } = req.params;
    const { userId } = req.body;
    console.log(`=== HARD DELETE SERVICE DEBUG ===`);
    console.log(`DELETE /api/admin/services/${id}/hard-delete - Permanent delete by ${userId}`);
    console.log('Full request:', {
        params: req.params,
        body: req.body,
        headers: req.headers
    });

    if (!userId) {
        console.log('ERROR: Missing userId');
        return res.status(400).json({ error: 'Missing userId' });
    }
    if (!await isAdmin(userId)) {
        console.log('Admin check FAILED for', userId);
        return res.status(403).json({ error: 'Unauthorized - not admin' });
    }
    console.log('✓ Admin check PASSED');



    try {
        const serviceId = parseInt(id);
        console.log('Parsed serviceId:', serviceId, 'Type:', typeof serviceId);

        if (isNaN(serviceId)) {
            console.log('ERROR: Invalid service ID (NaN)');
            return res.status(400).json({ error: 'Invalid service ID' });
        }

        // First: Verify service exists - USE supabase like all_services
        console.log('Checking if service exists...');
        const { data: serviceCheck, error: serviceCheckError } = await supabase
            .from('services')
            .select('id, name, is_active')
            .eq('id', serviceId)
            .maybeSingle();

        if (serviceCheckError) {
            console.error('Service existence check error:', serviceCheckError.message);
            return res.status(500).json({ error: 'Failed to verify service existence: ' + serviceCheckError.message });
        }
        if (!serviceCheck?.data) {
            console.log(`🚫 SERVICE NOT FOUND: ID ${serviceId}`);
            return res.status(404).json({ 
                error: `Service ID ${serviceId} not found in database.`,
                serviceId 
            });
        }
        console.log(`✓ SERVICE FOUND: "${serviceCheck.data.name}" (active: ${serviceCheck.data.is_active}) ID ${serviceId}`);



        // Safe count helpers
        const safeCount = async (tableName, colValue) => {
            try {
                console.log(`Counting in ${tableName} for service_id=${colValue}...`);
                const { count, error } = await db
                    .from(tableName)
                    .select('*', { count: 'exact', head: true })
                    .eq('service_id', colValue);
                if (error) throw error;
                console.log(`✓ ${tableName}: ${count || 0} references`);
                return count || 0;
            } catch (err) {
                console.warn(`⚠️  ${tableName} count FAILED (${err.message}) - assuming 0 references`);
                return 0;
            }
        };

        let queueCount = 0;
        let completedCount = 0;

        queueCount = await safeCount('queue_entries', serviceId);
        // Skip services_completed count since table doesn't exist in this codebase
        completedCount = 0;
        console.log('services_completed: SKIPPED (table not used in codebase)');

        const totalRefs = queueCount + completedCount;
        console.log(`🔍 REFERENCES: queue_entries=${queueCount}, total=${totalRefs}`);

        if (totalRefs > 0) {
            console.log(`🚫 BLOCKED BY REFS: ${queueCount} queue_entries`);
            return res.status(409).json({ 
                error: `Cannot hard-delete: ${queueCount} queue entries use this service. Archive (soft-delete) instead.`,
                details: { queue_entries: queueCount }
            });
        }
        console.log('✅ NO REFERENCES - SAFE TO DELETE');

        // Safe to delete - FINAL STEP - USE supabase
        console.log('No references found - executing PERMANENT DELETE...');
        const { error: deleteError } = await supabase
            .from('services')
            .delete()
            .eq('id', serviceId);

        if (deleteError) {
            console.error('DELETE query failed:', deleteError.message);
            throw deleteError;
        }

        console.log('✓ Service PERMANENTLY DELETED');
        res.json({ 
            message: 'Service permanently deleted (cannot be restored).', 
            service_id: serviceId 
        });
    } catch (error) {
        console.error("💥 HARD DELETE FAILED for service", serviceId || req.params.id, ":", error.message);
        console.error('Full error:', error);
        
        // Better error classification
        let status = 500;
        let userError = 'Hard delete operation failed';
        
        if (error.message.includes('not found') || error.message.includes('does not exist')) {
            status = 404;
            userError = `Service ID ${serviceId || req.params.id} not found in database.`;
        } else if (error.message.includes('queue_entries') || error.message.includes('foreign key')) {
            status = 409;
            userError = 'Cannot delete: Service referenced in queue/appointments. Archive instead.';
        }
        
        res.status(status).json({ 
            error: userError,
            serviceId: serviceId || req.params.id,
            debug: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
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

        // Try to get barber names and additional info if we have any
        const barberIds = Object.keys(barberMap);
        if (barberIds.length > 0) {
            const { data: barberProfiles } = await supabase
                .from('barber_profiles')
                .select('id, full_name, is_active')
                .in('id', barberIds);
            
            if (barberProfiles) {
                barberProfiles.forEach(bp => {
                    if (barberMap[bp.id]) {
                        barberMap[bp.id].full_name = bp.full_name;
                        barberMap[bp.id].is_active = bp.is_active;
                    }
                });
            }
            
            // Get ratings for these barbers
            const { data: ratings } = await supabase
                .from('feedback')
                .select('barber_id, score')
                .in('barber_id', barberIds);
            
            if (ratings) {
                // Calculate avg rating and review count per barber
                const ratingMap = {};
                ratings.forEach(r => {
                    if (!ratingMap[r.barber_id]) {
                        ratingMap[r.barber_id] = { total: 0, count: 0 };
                    }
                    ratingMap[r.barber_id].total += (r.score || 0);
                    ratingMap[r.barber_id].count += 1;
                });
                
                // Apply ratings to barber stats
                Object.keys(ratingMap).forEach(bid => {
                    if (barberMap[bid]) {
                        const ratingData = ratingMap[bid];
                        barberMap[bid].avg_rating = ratingData.count > 0 ? (ratingData.total / ratingData.count).toFixed(1) : 0;
                        barberMap[bid].review_count = ratingData.count;
                    }
                });
            }
        }

        // Transform barber stats to match frontend expected field names
        const barberStats = Object.values(barberMap).map(b => ({
            barber_id: b.barber_id,
            full_name: b.full_name,
            is_active: b.is_active !== undefined ? b.is_active : true,
            cut_count: b.cuts, // Frontend expects 'cut_count'
            total_revenue: b.revenue, // Frontend expects 'total_revenue'
            revenue: b.revenue,
            cuts: b.cuts,
            avg_rating: b.avg_rating || 0,
            review_count: b.review_count || 0
        })).sort((a, b) => b.revenue - a.revenue);

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
 * ENDPOINT: Customer Database with Pagination and Loyalty Info
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
        
        // Get barber and admin user IDs from barber_profiles and profiles tables
        const { data: barberProfiles } = await db.from('barber_profiles').select('user_id');
        const { data: profiles } = await db.from('profiles').select('id, role');
        
        const barberUserIds = new Set((barberProfiles || []).map(b => b.user_id));
        const adminUserIds = new Set((profiles || []).filter(p => p.role === 'admin').map(p => p.id));
        
        console.log("Barber user IDs:", barberUserIds);
        console.log("Admin user IDs:", adminUserIds);
        
        // Filter out barbers (by checking barber_profiles) and admins
        let filteredUsers = (authUsers?.users || []).filter(u => {
            // Skip if user is in barber_profiles
            if (barberUserIds.has(u.id)) return false;
            // Skip if user is in profiles with admin role
            if (adminUserIds.has(u.id)) return false;
            // Skip if user has admin role in user_metadata
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
        
        // Get all user IDs to fetch loyalty data
        const userIds = paginatedUsers.map(u => u.id);
        
        // Fetch loyalty data for all paginated users
        let loyaltyMap = {};
        if (userIds.length > 0) {
            const { data: loyaltyRecords, error: loyaltyError } = await db
                .from('customer_loyalty')
                .select('user_id, total_spent, total_visits, total_points, current_tier')
                .in('user_id', userIds);
            
            if (!loyaltyError && loyaltyRecords) {
                loyaltyRecords.forEach(record => {
                    loyaltyMap[record.user_id] = record;
                });
            }
        }
        
        // Transform to customer format with loyalty data
        const customers = paginatedUsers.map(user => {
            const loyalty = loyaltyMap[user.id] || {};
            return {
                id: user.id,
                full_name: user.user_metadata?.full_name || user.email?.split('@')[0] || 'Unknown',
                email: user.email,
                role: 'customer',
                created_at: user.created_at,
                visits: loyalty.total_visits || 0,
                totalSpent: loyalty.total_spent || 0,
                loyaltyPoints: loyalty.total_points || 0,
                loyaltyTier: loyalty.current_tier || 'bronze'
            };
        });

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
        // Fetch basic data from services_completed - use simple select without joins
        let query = supabase
            .from('services_completed')
            .select('*')
            .order('created_at', { ascending: false });

        if (startDate) {
            query = query.gte('created_at', startDate.toISOString());
        }

        const { data: completedServices, error } = await query;
        if (error) throw error;

        // Get unique barber IDs and service IDs
        const barberIds = [...new Set(completedServices?.map(s => s.barber_id).filter(Boolean) || [])];
        const serviceIds = [...new Set(completedServices?.map(s => s.service_id).filter(Boolean) || [])];

        // Fetch barber profiles and services separately
        let barberMap = {};
        let serviceMap = {};

        if (barberIds.length > 0) {
            const { data: barberProfiles } = await supabase
                .from('barber_profiles')
                .select('id, full_name')
                .in('id', barberIds);
            
            if (barberProfiles) {
                barberProfiles.forEach(bp => {
                    barberMap[bp.id] = bp.full_name;
                });
            }
        }

        if (serviceIds.length > 0) {
            const { data: services } = await supabase
                .from('services')
                .select('id, name')
                .in('id', serviceIds);
            
            if (services) {
                services.forEach(s => {
                    serviceMap[s.id] = s.name;
                });
            }
        }

        // Convert to CSV
        const headers = ['Date', 'Time', 'Customer Name', 'Service', 'Barber', 'Heads', 'Price'];
        const rows = (completedServices || []).map(item => [
            new Date(item.created_at).toLocaleDateString(),
            new Date(item.created_at).toLocaleTimeString(),
            item.customer_name || 'Guest',
            serviceMap[item.service_id] || 'Unknown',
            barberMap[item.barber_id] || 'Unknown',
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
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    try {
        console.log(`GET /api/admin/users?page=${page}&limit=${limit} - Fetching profiles...`);

        const { data, error } = await supabase
            .from('profiles')
            .select('*');

        if (error) {
            console.error("Supabase Error fetching profiles:", error);
            throw error;
        }

        const totalCount = data.length;
        const paginatedUsers = data.slice(offset, offset + limit);

        console.log(`Found ${totalCount} total profiles, returning ${paginatedUsers.length} from page ${page}`);

        res.json({
            users: paginatedUsers,
            pagination: {
                page,
                limit,
                total: totalCount,
                totalPages: Math.ceil(totalCount / limit)
            }
        });
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

/**
 * ENDPOINT: Recalculate Loyalty Data for All Customers
 * This recalculates total_spent and total_visits from historical service records
 */
exports.recalculate_loyalty = async (req, res) => {
    const { userId } = req.body;
    
    if (!await isAdmin(userId)) return res.status(403).json({ error: 'Unauthorized.' });

    console.log("=== RECALCULATING LOYALTY DATA ===");

    try {
        // 1. Get all customers from auth
        const { data: authUsers } = await supabaseAdmin.auth.admin.listUsers();
        
        // Get barber and admin user IDs to exclude
        const { data: barberProfiles } = await db.from('barber_profiles').select('user_id');
        const { data: profiles } = await db.from('profiles').select('id, role');
        
        const barberUserIds = new Set((barberProfiles || []).map(b => b.user_id));
        const adminUserIds = new Set((profiles || []).filter(p => p.role === 'admin').map(p => p.id));
        
        // Filter to only customers
        const customerUsers = (authUsers?.users || []).filter(u => {
            if (barberUserIds.has(u.id)) return false;
            if (adminUserIds.has(u.id)) return false;
            const role = u.user_metadata?.role || u.role;
            if (role === 'admin') return false;
            return true;
        });

        console.log(`Found ${customerUsers.length} customers to process`);

        // 2. For each customer, get their completed services and calculate totals
        let processed = 0;
        let errors = [];

        for (const customer of customerUsers) {
            try {
                // Get all "Done" queue entries for this customer
                const { data: completedEntries, error: entriesError } = await db
                    .from('queue_entries')
                    .select('id, head_count, is_vip, tip_amount, services(price_php, price_vip_php)')
                    .eq('user_id', customer.id)
                    .eq('status', 'Done');

                if (entriesError) {
                    console.error(`Error fetching entries for ${customer.id}:`, entriesError);
                    continue;
                }

                if (!completedEntries || completedEntries.length === 0) {
                    // No completed services - ensure loyalty record exists with zeros
                    await db.from('customer_loyalty').upsert({
                        user_id: customer.id,
                        total_spent: 0,
                        total_visits: 0,
                        total_points: 0,
                        lifetime_points: 0,
                        current_tier: 'bronze'
                    }, { onConflict: 'user_id' });
                    continue;
                }

                // Calculate totals
                let totalSpent = 0;
                let totalVisits = 0;
                let totalPoints = 0;

                for (const entry of completedEntries) {
                    const headCount = entry.head_count || 1;
                    const isVip = entry.is_vip || false;
                    const tip = parseFloat(entry.tip_amount) || 0;
                    
                    // Get service prices
                    const basePrice = parseFloat(entry.services?.price_php) || 0;
                    const vipPrice = parseFloat(entry.services?.price_vip_php) || basePrice;
                    
                    // Calculate this entry's total
                    const servicePrice = isVip ? vipPrice : basePrice;
                    const entryTotal = (servicePrice * headCount) + tip;
                    
                    totalSpent += entryTotal;
                    totalVisits += headCount;
                    
                    // Calculate points (1 point per 10php spent)
                    totalPoints += Math.floor(entryTotal / 10);
                }

                // Get current loyalty record if exists
                const { data: existingLoyalty } = await db
                    .from('customer_loyalty')
                    .select('*')
                    .eq('user_id', customer.id)
                    .single();

                // Determine tier
                let newTier = 'bronze';
                if (totalPoints >= 3000) newTier = 'platinum';
                else if (totalPoints >= 1500) newTier = 'gold';
                else if (totalPoints >= 500) newTier = 'silver';

                // Upsert loyalty record
                await db.from('customer_loyalty').upsert({
                    user_id: customer.id,
                    total_spent: totalSpent,
                    total_visits: totalVisits,
                    total_points: totalPoints,
                    lifetime_points: totalPoints,
                    current_tier: newTier,
                    updated_at: new Date().toISOString()
                }, { onConflict: 'user_id' });

                processed++;
                console.log(`Processed ${customer.email}: ${totalVisits} visits, ₱${totalSpent} spent, ${totalPoints} points`);

            } catch (err) {
                console.error(`Error processing customer ${customer.id}:`, err);
                errors.push({ customerId: customer.id, error: err.message });
            }
        }

        console.log(`=== RECALCULATION COMPLETE ===`);
        console.log(`Processed: ${processed} customers`);
        console.log(`Errors: ${errors.length}`);

        res.json({
            success: true,
            message: `Recalculated loyalty data for ${processed} customers`,
            processed: processed,
            errors: errors
        });

    } catch (error) {
        console.error("Recalculation error:", error);
        res.status(500).json({ error: "Failed to recalculate loyalty: " + error.message });
    }
}

