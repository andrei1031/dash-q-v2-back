const { supabase } = require("../database/supabase");
const { createQueueHelpers } = require("../utils/queueLogic");

const { enforceQueueLogic } = createQueueHelpers(supabase);

/**
 * ENDPOINT: Join Queue as Guest
 * Allows customers to join the queue without signing up/in.
 * Route: POST /api/guest/join
 */
exports.join_as_guest = async (req, res) => {
    const { name, barberId, serviceId, headCount, referenceImageUrl, guestId, playerId, deviceFingerprint } = req.body;

    // Basic validation
    if (!name || name.trim() === "") {
        return res.status(400).json({ error: "Name is required for guest check-in." });
    }
    if (!barberId || !serviceId) {
        return res.status(400).json({ error: "Barber and Service selection are required." });
    }

    // --- DEVICE BLOCKING CHECK ---
    if (deviceFingerprint) {
        const { data: blockedDevice } = await supabase
            .from('blocked_devices')
            .select('*')
            .eq('device_fingerprint', deviceFingerprint)
            .eq('is_active', true)
            .maybeSingle();
        
        if (blockedDevice) {
            console.warn(`Blocked device attempted to join queue: ${deviceFingerprint}`);
            return res.status(403).json({ 
                error: 'This device has been blocked from the system. Please contact the administrator.' 
            });
        }
    }
    // --- END DEVICE BLOCKING CHECK ---

    try {
        // Check if the provided guestId is already active. If so, treat as new guest (null ID)
        // to allow multiple guest entries without conflict.
        let finalGuestId = guestId || null;

        if (finalGuestId) {
            const { data: active } = await supabase
                .from('queue_entries')
                .select('id')
                .eq('user_id', finalGuestId)
                .in('status', ['Waiting', 'Up Next', 'In Progress'])
                .maybeSingle();
            
            if (active) finalGuestId = null;
        }

        // Insert guest into queue
        // We set user_id to null and is_guest to true
        let { data, error } = await supabase
            .from('queue_entries')
            .insert([
                {
                    customer_name: name,
                    barber_id: parseInt(barberId),
                    service_id: parseInt(serviceId),
                    user_id: finalGuestId, // Use computed ID to prevent conflicts
                    is_guest: true,
                    status: 'Waiting',
                    head_count: headCount || 1,
                    reference_image_url: referenceImageUrl || null,
                    is_vip: false,
                    customer_email: null,
                    customer_phone: null,
                    player_id: playerId || null, // Save OneSignal ID for notifications
                    device_fingerprint: deviceFingerprint || null // Store device fingerprint
                }
            ])
            .select()
            .single();

        if (error) throw error;
        
        // Check if "Up Next" slot is empty and promote immediately (Atomic & Safe)
        const promotedCustomers = await enforceQueueLogic(parseInt(barberId));

        // If our guest was promoted, update the response data
        if (promotedCustomers && promotedCustomers.length > 0) {
            const myPromotion = promotedCustomers.find(p => p.id === data.id);
            if (myPromotion) {
                data = myPromotion;
            }
        }

        res.status(201).json({ success: true, message: "Joined queue as guest.", data: data });

    } catch (error) {
        console.error("Guest join error:", error.message);
        res.status(500).json({ error: "Failed to join queue." });
    }
};