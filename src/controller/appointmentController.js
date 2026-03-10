const axios = require("axios");
const { supabase, supabaseAdmin } = require("../database/supabase");

/**
 * ENDPOINT: Timezone-Aware Smart Slots
 * - Forces "Philippines Time" (UTC+8) regardless of server location.
 * - Fixes the "5 PM - 2 AM" bug caused by UTC conversion.
 */
exports.slots = async (req, res) => {

    const { barberId, date, serviceId } = req.query;
    if (!barberId || !date || !serviceId) return res.status(400).json({ error: 'Missing parameters' });

    try {
        const { data: service } = await supabase.from('services').select('duration_minutes').eq('id', serviceId).single();
        const duration = service?.duration_minutes || 30;

        // --- FIXED: Use Philippines timezone properly ---
        const PH_OFFSET = "+08:00";
        
        // 1. OPENING TIME: 10:30 AM Philippines
        const startIso = `${date}T10:30:00${PH_OFFSET}`; 
        
        // 2. CLOSING TIME: 7:00 PM (19:00) Philippines
        const closeIso = `${date}T19:00:00${PH_OFFSET}`; 

        // Parse dates as Philippines time
        let slotIterator = new Date(startIso);
        const closeTime = new Date(closeIso);
        
        // Get current time in Philippines timezone for comparison
        const now = new Date();
        const nowPH = new Date(now.getTime() + (8 * 60 * 60 * 1000));

        // Fetch existing appointments stored in PH time
        // Query using the date string directly without conversion
        const dbStart = `${date}T00:00:00${PH_OFFSET}`;
        const dbEnd = `${date}T23:59:59${PH_OFFSET}`;

        const { data: bookings } = await supabase
            .from('appointments')
            .select('scheduled_time, end_time')
            .eq('barber_id', barberId)
            .in('status', ['confirmed', 'pending'])
            .gte('scheduled_time', dbStart)
            .lte('scheduled_time', dbEnd);

        let slots = [];

        while (slotIterator < closeTime) {
            const slotStart = new Date(slotIterator);
            const slotEnd = new Date(slotIterator.getTime() + duration * 60000);

            // RULE A: STRICT CLOSING TIME (7:00 PM)
            if (slotEnd > closeTime) {
                break;
            }

            // FIX: Compare against PH time, not server local time
            if (slotStart < nowPH) {
                slotIterator.setMinutes(slotIterator.getMinutes() + 30);
                continue;
            }

            const isTaken = bookings.some(b => {
                // Parse existing bookings as PH time
                const bookStart = new Date(b.scheduled_time);
                const bookEnd = new Date(b.end_time);
                return (slotStart < bookEnd && slotEnd > bookStart);
            });

            if (!isTaken) {
                // Push as Philippines time (+08:00)
                const year = slotStart.getFullYear();
                const month = String(slotStart.getMonth() + 1).padStart(2, '0');
                const day = String(slotStart.getDate()).padStart(2, '0');
                const hours = String(slotStart.getHours()).padStart(2, '0');
                const minutes = String(slotStart.getMinutes()).padStart(2, '0');
                const seconds = String(slotStart.getSeconds()).padStart(2, '0');
                const phTimeString = `${year}-${month}-${day}T${hours}:${minutes}:${seconds}+08:00`;
                slots.push(phTimeString);
            }

            slotIterator.setMinutes(slotIterator.getMinutes() + 30);
        }

        res.json(slots);

    } catch (error) {
        console.error("Slot fetch error:", error);
        res.status(500).json({ error: 'Server error calculating slots' });
    }
};

/**
 * ENDPOINT: Book an Appointment
 * - Enforces "Tomorrow Only" rule (blocks booking for today or past dates).
 * - Enforces strict 1-customer-per-slot rule (prevents overlaps).
 * - FIXED: Stores time in Philippines timezone (+08:00) to prevent UTC conversion issues
 */
exports.book = async (req, res) => {
    const { customer_name, customer_email, user_id, barber_id, service_id, scheduled_time } = req.body;
    
    try {
        // --- 1. VALIDATION: Block "Today" and Past Appointments ---
        // Parse the incoming time as Philippines time
        const appointmentDate = new Date(scheduled_time);
        const now = new Date();

        // Adjust 'now' to Philippines time (UTC+8) to ensure fairness regardless of server location
        const nowPH = new Date(now.getTime() + (8 * 60 * 60 * 1000));

        // Compare dates using YYYY-MM-DD format strings
        const apptDateString = appointmentDate.toISOString().split('T')[0];
        const nowDateString = nowPH.toISOString().split('T')[0];

        // If the appointment is Today or in the Past, reject it
        if (apptDateString <= nowDateString) {
            return res.status(400).json({ error: 'Appointments must be booked at least 1 day in advance.' });
        }
        // -----------------------------------------------------------

        // 2. Calculate End Time based on Service Duration
        const { data: service } = await supabase.from('services').select('duration_minutes').eq('id', service_id).single();
        const duration = service?.duration_minutes || 30;

        const startDate = new Date(scheduled_time);
        const endDate = new Date(startDate.getTime() + duration * 60000);

        // 3. STRICT CONFLICT CHECK (Race Condition Prevention)
        // This ensures Customer B cannot book if Customer A already has this slot.
        // For conflict check, we need to use the local time (with +08:00) for comparison
        const startDatePH = new Date(startDate.getTime() + (8 * 60 * 60 * 1000));
        const endDatePH = new Date(endDate.getTime() + (8 * 60 * 60 * 1000));

        const { data: conflict } = await supabase
            .from('appointments')
            .select('id')
            .eq('barber_id', barber_id)
            .in('status', ['confirmed', 'pending'])
            .lt('scheduled_time', endDatePH.toISOString())
            .gt('end_time', startDatePH.toISOString())
            .maybeSingle();

        if (conflict) {
            return res.status(409).json({ error: 'Slot is pending approval or taken. Please choose another.' });
        }

        // 4. FIXED: Store the time in Philippines timezone (+08:00) instead of UTC
        // Extract the date/time parts and append +08:00 to preserve Philippines time
        const formatPHDateTime = (date) => {
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            const hours = String(date.getHours()).padStart(2, '0');
            const minutes = String(date.getMinutes()).padStart(2, '0');
            const seconds = String(date.getSeconds()).padStart(2, '0');
            return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}+08:00`;
        };

        const scheduledTimePH = formatPHDateTime(startDate);
        const endTimePH = formatPHDateTime(endDate);

        // 4. Insert Appointment
        const { data, error } = await supabase.from('appointments').insert({
            customer_name,
            customer_email,
            user_id,
            barber_id,
            service_id,
            scheduled_time: scheduledTimePH,
            end_time: endTimePH,
            status: 'pending', // Immediately confirmed
            is_converted_to_queue: false
        }).select().single();

        if (error) throw error;

        console.log(`[Appointment] Booked for ${customer_name} on ${scheduledTimePH}`);

        try {
            // 1. Get Barber's Email from their User Profile
            const { data: barberUser, error: barberError } = await supabaseAdmin // Use Admin client to access auth/users
                .from('barber_profiles')
                .select('user_id')
                .eq('id', barber_id)
                .single();

            if (barberUser) {
                // Fetch actual email from Auth system (securely)
                const { data: userData } = await supabaseAdmin.auth.admin.getUserById(barberUser.user_id);
                const barberEmail = userData?.user?.email;

                if (barberEmail && process.env.N8N_WEBHOOK_URL) {
                    // 2. Send Alert via n8n
                    await axios.post(process.env.N8N_WEBHOOK_URL, {
                        type: 'barber_alert', // <--- NEW TYPE
                        email: barberEmail, // Send to Barber
                        subject: '📅 New Booking Received!',
                        message: `You have a new appointment with ${customer_name} on ${new Date(startDate).toLocaleString('en-US', { timeZone: 'Asia/Manila' })}.`
                    });
                    console.log(`[Notify] Alert sent to barber at ${barberEmail}`);
                }
            }
        } catch (notifyError) {
            console.error("Failed to notify barber:", notifyError.message);
            // Don't fail the booking just because notification failed
        }

        res.status(201).json({ message: 'Appointment Confirmed!', appointment: data });

    } catch (error) {
        console.error("Booking error:", error);
        res.status(500).json({ error: error.message });
    }
};

/**
 * ENDPOINT: Barber Rejects/Cancels an Appointment
 */
exports.reject = async (req, res) => {
    const { appointmentId, reason } = req.body;

        if (!appointmentId) return res.status(400).json({ error: 'Appointment ID required.' });

        try {
            // 1. Mark as Cancelled in DB
            const { data: appt, error } = await supabase
                .from('appointments')
                .update({ status: 'cancelled' }) // Change status to cancelled
                .eq('id', appointmentId)
                .select('customer_email, customer_name, scheduled_time')
                .single();

            if (error) throw error;

            // 2. Send URGENT Notification (via n8n Email or OneSignal)
            if (appt && process.env.N8N_WEBHOOK_URL) {
                console.log(`[Reject] Sending cancellation alert to ${appt.customer_email}`);
                
                // We use the existing n8n webhook but add a "type" flag
                // You might need to update your n8n workflow to handle this "cancellation" type
                await axios.post(process.env.N8N_WEBHOOK_URL, {
                    type: 'cancellation', // Flag for n8n to send a different email template
                    email: appt.customer_email,
                    name: appt.customer_name,
                    date: new Date(appt.scheduled_time).toLocaleString('en-US', { timeZone: 'Asia/Manila', weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
                    reason: reason || 'Barber is unavailable.'
                }).catch(err => console.error("Notification failed:", err.message));
            }

            res.json({ message: 'Appointment rejected and customer notified.' });

        } catch (error) {
            console.error("Reject error:", error.message);
            res.status(500).json({ error: 'Failed to reject appointment.' });
        }
};

/**
 * ENDPOINT: Barber Approves an Appointment
 */
exports.approve = async (req, res) => {
    const { appointmentId } = req.body;
    if (!appointmentId) return res.status(400).json({ error: 'Appointment ID required.' });

    try {
        // 1. Mark as Confirmed
        const { data: appt, error } = await supabase
            .from('appointments')
            .update({ status: 'confirmed' })
            .eq('id', appointmentId)
            .select('customer_email, customer_name, scheduled_time')
            .single();

        if (error) throw error;

        // 2. Notify Customer
        if (appt && process.env.N8N_WEBHOOK_URL) {
            console.log(`[Approve] Notifying ${appt.customer_email}`);
            await axios.post(process.env.N8N_WEBHOOK_URL, {
                type: 'confirmation', // Use a template that says "You are confirmed!"
                email: appt.customer_email,
                name: appt.customer_name,
                date: new Date(appt.scheduled_time).toLocaleString('en-US', { timeZone: 'Asia/Manila' })
            }).catch(err => console.error("Notification failed:", err.message));
        }

        res.json({ message: 'Appointment approved successfully!' });

    } catch (error) {
        console.error("Approve error:", error.message);
        res.status(500).json({ error: 'Failed to approve appointment.' });
    }
};

/**
 * ENDPOINT: Get Customer's Appointments
 */
exports.get_customer_appointments = async (req, res) => {
    const { userId } = req.params;
    if (!userId) return res.status(400).json({ error: 'User ID required' });

    try {
        const { data, error } = await supabase
            .from('appointments')
            .select(`
                id, 
                scheduled_time, 
                status, 
                is_converted_to_queue,
                barber_profiles(full_name),
                services(name, price_php, duration_minutes)
            `)
            .eq('user_id', userId)
            .order('scheduled_time', { ascending: false }); // Show upcoming first

        if (error) throw error;
        res.json(data || []);
    } catch (error) {
        console.error("Fetch appointments error:", error.message);
        res.status(500).json({ error: 'Failed to fetch appointments.' });
    }
}

/**
 * FEATURE: Admin Get All Upcoming Appointments
 * FIXED: Now fetches 'pending' bookings too so Admin can see everything.
 */
exports.get_all_appointments = async (req, res) => {
    try {
        const now = new Date();
        const { data, error } = await supabase
            .from('appointments')
            .select(`
                id, 
                scheduled_time, 
                customer_name,
                customer_email,
                status, 
                is_converted_to_queue,
                barber_profiles(full_name),
                services(name, duration_minutes)
            `)
            // 🔴 OLD: .eq('status', 'confirmed') 
            // 🟢 NEW: Allow Pending too!
            .in('status', ['confirmed', 'pending']) 
            .gte('scheduled_time', now.toISOString()) 
            .order('scheduled_time', { ascending: true });

        if (error) throw error;
        res.json(data || []);
    } catch (error) {
        console.error("Admin Appointments Error:", error.message);
        res.status(500).json({ error: 'Failed to fetch appointments.' });
    }
}

/**
 * ENDPOINT: Get Barber's Upcoming Appointments
 * FIXED: Now fetches 'pending' appointments so the barber can approve them.
 */
exports.get_barber_appointments = async (req, res) => {
    const { barberId } = req.params;
    if (!barberId) return res.status(400).json({ error: 'Barber ID required' });

    try {
        // Fetch confirmed appointments for today and the future
        const now = new Date();
        now.setHours(0,0,0,0); 

        const { data, error } = await supabase
            .from('appointments')
            .select(`
                id, 
                scheduled_time, 
                customer_name,
                customer_email,
                status, 
                is_converted_to_queue,
                services(name, duration_minutes)
            `)
            .eq('barber_id', barberId)
            // 🔴 OLD CODE: .eq('status', 'confirmed') 
            // 🟢 NEW CODE: Fetch BOTH confirmed and pending
            .in('status', ['confirmed', 'pending']) 
            .gte('scheduled_time', now.toISOString()) 
            .order('scheduled_time', { ascending: true }); 

        if (error) throw error;
        res.json(data || []);
    } catch (error) {
        console.error("Fetch barber appointments error:", error.message);
        res.status(500).json({ error: 'Failed to fetch appointments.' });
    }
}

exports.process_appointments = async (req, res) => {
    console.log('[Manual Trigger] Checking for missed appointments...');
    const now = new Date();
    const lookBack = new Date(now.getTime() - 24 * 60 * 60 * 1000); // Look back 24 hours

    try {
        // Find confirmed appointments that haven't been queued yet
        const { data: missed, error } = await supabase
            .from('appointments')
            .select('*')
            .in('status', ['confirmed'])
            .eq('is_converted_to_queue', false)
            .gte('scheduled_time', lookBack.toISOString());

        if (error) throw error;

        const results = [];
        for (const appt of missed) {
            // FORCE INSERT TO QUEUE
            const { data: newEntry } = await supabase.from('queue_entries').insert({
                barber_id: appt.barber_id,
                customer_name: `${appt.customer_name} (Booked)`,
                customer_email: appt.customer_email,
                user_id: appt.user_id,
                service_id: appt.service_id,
                status: 'Up Next', // Force to Up Next since it's late
                is_vip: true,
                is_confirmed: true
            }).select().single();

            if (newEntry) {
                await supabase.from('appointments').update({ is_converted_to_queue: true }).eq('id', appt.id);
                results.push(`Converted ${appt.customer_name}`);
            }
        }

        res.json({ success: true, processed: results });

    } catch (e) {
        res.json({ error: e.message });
    }
}