const { supabase } = require("../database/supabase");

/**
 * ENDPOINT: Get all settings
 * Fetches all keys and values from the app_settings table.
 */
exports.get_settings = async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('app_settings')
            .select('key, value');
        
        if (error) throw error;
        
        // Convert array of objects into a single key-value object for easier frontend use
        const settings = {};
        data.forEach(item => {
            settings[item.key] = item.value;
        });
        
        res.json(settings);
    } catch (error) {
        console.error("Get settings error:", error.message);
        // Return empty settings object as fallback to prevent frontend crashes
        res.json({});
    }
};

/**
 * ENDPOINT: Update a setting
 * Inserts a new setting or updates an existing one based on the key.
 */
exports.update_setting = async (req, res) => {
    const { key, value } = req.body;
    
    if (!key) {
        return res.status(400).json({ error: 'Setting key is required.' });
    }
    
    try {
        // Check if the setting key already exists
        const { data: existing, error: fetchError } = await supabase
            .from('app_settings')
            .select('id')
            .eq('key', key)
            .maybeSingle();
        
        if (fetchError) throw fetchError;
        
        if (existing) {
            // Update the existing key
            const { error } = await supabase
                .from('app_settings')
                .update({ value: String(value) })
                .eq('key', key);
            
            if (error) throw error;
        } else {
            // Insert as a new key
            const { error } = await supabase
                .from('app_settings')
                .insert({ key, value: String(value) });
            
            if (error) throw error;
        }
        
        res.json({ message: 'Setting updated successfully.', key, value });
    } catch (error) {
        console.error("Update setting error:", error.message);
        res.status(500).json({ error: error.message });
    }
};

/**
 * ENDPOINT: Get VIP price specifically
 * Specifically used by CustomerView, Admin layouts, and Barber dashboards.
 * Path: GET /api/settings/vip-price
 */
exports.get_vip_price = async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('app_settings')
            .select('value')
            .eq('key', 'vip_price')
            .maybeSingle();
        
        if (error) {
            console.warn("VIP price query error (fallback 100):", error.message);
            return res.json({ vip_price: 100 });
        }
        
        // Convert the string value from DB to an integer, defaulting to 100 if empty
        const vip_price = data ? parseInt(data.value, 10) || 100 : 100;
        console.log(`VIP price served: ${vip_price}`); 
        res.json({ vip_price });
    } catch (error) {
        console.error("Get VIP price error:", error.message);
        res.status(500).json({ error: 'Server error', vip_price: 100 });
    }
};

// Explicitly export all functions to ensure they are available to routes
module.exports = {
    get_settings: exports.get_settings,
    update_setting: exports.update_setting,
    get_vip_price: exports.get_vip_price
};