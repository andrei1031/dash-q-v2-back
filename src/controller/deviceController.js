const { supabase } = require("../database/supabase");

/**
 * ENDPOINT: Block a device
 * Body: { adminUserId, deviceFingerprint, reason }
 */
exports.block_device = async (req, res) => {
    const { adminUserId, deviceFingerprint, reason } = req.body;

    if (!adminUserId || !deviceFingerprint) {
        return res.status(400).json({ error: 'Admin ID and device fingerprint are required.' });
    }

    if (!reason || reason.trim() === "") {
        return res.status(400).json({ error: 'Reason for blocking is required.' });
    }

    try {
        // Check if device is already blocked
        const { data: existing } = await supabase
            .from('blocked_devices')
            .select('*')
            .eq('device_fingerprint', deviceFingerprint)
            .maybeSingle();

        if (existing) {
            // Update existing record
            const { error: updateError } = await supabase
                .from('blocked_devices')
                .update({ 
                    is_active: true, 
                    reason: reason,
                    blocked_by: adminUserId,
                    blocked_at: new Date().toISOString()
                })
                .eq('device_fingerprint', deviceFingerprint);

            if (updateError) throw updateError;
            return res.json({ message: 'Device blocked successfully.' });
        }

        // Insert new blocked device
        const { error: insertError } = await supabase
            .from('blocked_devices')
            .insert({
                device_fingerprint: deviceFingerprint,
                reason: reason,
                blocked_by: adminUserId,
                is_active: true,
                blocked_at: new Date().toISOString()
            });

        if (insertError) throw insertError;
        res.json({ message: 'Device blocked successfully.' });

    } catch (error) {
        console.error("Block device error:", error.message);
        res.status(500).json({ error: 'Failed to block device.' });
    }
};

/**
 * ENDPOINT: Unblock a device
 * Body: { adminUserId, deviceFingerprint }
 */
exports.unblock_device = async (req, res) => {
    const { adminUserId, deviceFingerprint } = req.body;

    if (!adminUserId || !deviceFingerprint) {
        return res.status(400).json({ error: 'Admin ID and device fingerprint are required.' });
    }

    try {
        const { error } = await supabase
            .from('blocked_devices')
            .update({ is_active: false })
            .eq('device_fingerprint', deviceFingerprint);

        if (error) throw error;
        res.json({ message: 'Device unblocked successfully.' });

    } catch (error) {
        console.error("Unblock device error:", error.message);
        res.status(500).json({ error: 'Failed to unblock device.' });
    }
};

/**
 * ENDPOINT: Get all blocked devices
 */
exports.get_blocked_devices = async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('blocked_devices')
            .select('*')
            .order('blocked_at', { ascending: false });

        if (error) throw error;
        res.json(data || []);
    } catch (error) {
        console.error("Get blocked devices error:", error.message);
        res.status(500).json({ error: 'Failed to fetch blocked devices.' });
    }
};

/**
 * ENDPOINT: Check if device is blocked (for client-side check)
 * Query: ?deviceFingerprint=xxx
 */
exports.check_device_status = async (req, res) => {
    const { deviceFingerprint } = req.query;

    if (!deviceFingerprint) {
        return res.status(400).json({ error: 'Device fingerprint required.' });
    }

    try {
        const { data, error } = await supabase
            .from('blocked_devices')
            .select('*')
            .eq('device_fingerprint', deviceFingerprint)
            .eq('is_active', true)
            .maybeSingle();

        if (error) throw error;
        
        if (data) {
            return res.json({ isBlocked: true, reason: data.reason });
        }
        
        res.json({ isBlocked: false });

    } catch (error) {
        console.error("Check device status error:", error.message);
        res.status(500).json({ error: 'Failed to check device status.' });
    }
};

