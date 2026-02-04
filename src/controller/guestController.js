const { supabase } = require("../database/supabase");

/**
 * ENDPOINT: Join Queue as Guest
 * Allows customers to join the queue without signing up/in.
 * Route: POST /api/guest/join
 */
exports.join_as_guest = async (req, res) => {
    const { name, barberId, serviceId } = req.body;

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
        const { data, error } = await supabase
            .from('queue')
            .insert([
                {
                    customer_name: name,
                    barber_id: parseInt(barberId),
                    service_id: parseInt(serviceId),
                    user_id: null, // Guest has no user account
                    is_guest: true,
                    status: 'waiting'
                }
            ])
            .select()
            .single();

        if (error) throw error;

        res.status(201).json({ success: true, message: "Joined queue as guest.", data });

    } catch (error) {
        console.error("Guest join error:", error.message);
        res.status(500).json({ error: "Failed to join queue." });
    }
};