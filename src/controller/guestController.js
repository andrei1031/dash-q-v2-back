const { supabase } = require("../database/supabase");

/**
 * ENDPOINT: Join Queue as Guest
 * Allows customers to join the queue without signing up/in.
 * Route: POST /api/guest/join
 */
exports.join_as_guest = async (req, res) => {
    const { name, barberId, serviceId, headCount, referenceImageUrl } = req.body;

    // Basic validation
    if (!name || name.trim() === "") {
        return res.status(400).json({ error: "Name is required for guest check-in." });
    }
    if (!barberId || !serviceId) {
        return res.status(400).json({ error: "Barber and Service selection are required." });
    }

    try {
        // Insert guest into queue
        // We set user_id to null and is_guest to true
        let { data, error } = await supabase
            .from('queue_entries')
            .insert([
                {
                    customer_name: name,
                    barber_id: parseInt(barberId),
                    service_id: parseInt(serviceId),
                    user_id: null, // Guest has no user account
                    is_guest: true,
                    status: 'Waiting',
                    head_count: headCount || 1,
                    reference_image_url: referenceImageUrl || null,
                    is_vip: false,
                    customer_email: null,
                    customer_phone: null
                }
            ])
            .select()
            .single();

        if (error) throw error;
        
        // Check if "Up Next" slot is empty and promote immediately
        const { data: upNextData } = await supabase
            .from('queue_entries')
            .select('id')
            .eq('barber_id', parseInt(barberId))
            .eq('status', 'Up Next')
            .maybeSingle();

        if (!upNextData) {
            const { data: updatedEntry, error: updateError } = await supabase
                .from('queue_entries')
                .update({ status: 'Up Next' })
                .eq('id', data.id)
                .select()
                .single();
            
            if (!updateError && updatedEntry) {
                data = updatedEntry;
            }
        }

        res.status(201).json({ success: true, message: "Joined queue as guest.", data: data });

    } catch (error) {
        console.error("Guest join error:", error.message);
        res.status(500).json({ error: "Failed to join queue." });
    }
};