const { supabase } = require("../database/supabase");

/**
 * ENDPOINT: Submit a Report (Barber <-> Customer)
 * UPDATED: Now accepts proofImageUrl
 */
exports.submit_reports = async (req, res) => {
    const { reporterId, reportedId, role, reason, description, proofImageUrl } = req.body;

    if (!reporterId || !reportedId || !reason) {
        return res.status(400).json({ error: 'Missing required fields.' });
    }

    try {
        const { data, error } = await supabase.from('reports').insert({
            reporter_id: reporterId,
            reported_id: reportedId,
            role_reporter: role,
            reason: reason,
            description: description,
            proof_image_url: proofImageUrl || null // <--- Save the image URL
        });

        if (error) throw error;
        res.status(201).json({ message: 'Report submitted. Admin will review.' });
    } catch (error) {
        console.error("Report error:", error);
        res.status(500).json({ error: 'Failed to submit report.' });
    }
}

/**
 * ENDPOINT: Admin Get All Reports
 */
exports.get_all_reports = async (req, res) => {
    try {
        // Fetch reports with names for both sides
        const { data, error } = await supabase
            .from('reports')
            .select(`
                *,
                reporter:profiles!reporter_id(full_name, role),
                reported:profiles!reported_id(full_name, role, is_banned)
            `)
            .order('created_at', { ascending: false });

        if (error) throw error;
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}

/**
 * ENDPOINT: Admin Action (Ban/Unban User & Resolve Report)
 */
exports.admin_reports_resolve = async (req, res) => {
    const { reportId, targetUserId, action, adminNotes } = req.body;
    // action can be: 'ban', 'dismiss', 'warning'

    try {
        // 1. If Action is BAN, update profile
        if (action === 'ban') {
            await supabase.from('profiles').update({ is_banned: true }).eq('id', targetUserId);
            // Also force logout logic (optional, clears session)
            await supabase.from('barber_profiles').update({ is_active: false }).eq('user_id', targetUserId);
        } else if (action === 'unban') {
            await supabase.from('profiles').update({ is_banned: false }).eq('id', targetUserId);
        }

        // 2. Update Report Status
        const { error } = await supabase.from('reports')
            .update({
                status: action === 'dismiss' ? 'Dismissed' : 'Resolved',
                admin_notes: `Action: ${action.toUpperCase()}. ${adminNotes || ''}`
            })
            .eq('id', reportId);

        if (error) throw error;
        res.json({ message: `User ${action}ned and report resolved.` });
    } catch (error) {
        console.error("Resolve error:", error);
        res.status(500).json({ error: 'Failed to take action.' });
    }
}

/**
 * ENDPOINT: Get User's Submitted Reports (For Barber & Customer)
 */
exports.get_user_submitted_reports = async (req, res) => {  
    const { userId } = req.params;
    if (!userId) return res.status(400).json({ error: 'User ID required.' });

    try {
        const { data, error } = await supabase
            .from('reports')
            .select(`
                id,
                created_at,
                reason,
                description,
                status,
                admin_notes,
                reported:profiles!reported_id(full_name)
            `)
            .eq('reporter_id', userId)
            .order('created_at', { ascending: false });

        if (error) throw error;
        res.json(data || []);
    } catch (error) {
        console.error("Error fetching user reports:", error.message);
        res.status(500).json({ error: 'Failed to load reports.' });
    }
}

// In src/controller/reportsController.js

// In src/controller/reportsController.js
exports.unban_user = async (req, res) => {
    const { userId } = req.params;

    try {
        const { data, error } = await supabase
            .from('profiles')
            .update({ 
                is_banned: false // ONLY flipping this switch
            })
            .eq('id', userId)
            .select();

        if (error) throw error;
        
        res.status(200).json({ message: "User is no longer banned." });
    } catch (err) {
        // This will help you see if Supabase still thinks 'is_active' is missing
        res.status(500).json({ error: err.message });
    }
};