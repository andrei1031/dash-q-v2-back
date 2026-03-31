const { supabase } = require("../database/supabase");

/**
 * ENDPOINT: Get all settings
 */
exports.get_settings = async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('app_settings')
            .select('key, value');
        
        if (error) throw error;
        
        // Convert array to key-value object
        const settings = {};
        data.forEach(item => {
            settings[item.key] = item.value;
        });
        
        res.json(settings);
    } catch (error) {
        console.error("Get settings error:", error.message);
        // Return empty settings if table doesn't exist
        res.json({});
    }
};

/**
 * ENDPOINT: Update a setting
 */
exports.update_setting = async (req, res) => {
    const { key, value } = req.body;
    
    if (!key) {
        return res.status(400).json({ error: 'Setting key is required.' });
    }
    
    try {
        // Try to update first
        const { data: existing, error: fetchError } = await supabase
            .from('app_settings')
            .select('id')
            .eq('key', key)
            .maybeSingle();
        
        if (fetchError) throw fetchError;
        
        if (existing) {
            // Update existing
            const { error } = await supabase
                .from('app_settings')
                .update({ value: String(value) })
                .eq('key', key);
            
            if (error) throw error;
        } else {
            // Insert new
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



