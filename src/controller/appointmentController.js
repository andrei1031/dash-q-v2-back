const axios = require("axios");
const { supabase, supabaseAdmin } = require("../database/supabase");

// Helper to ensure UTC
const ensureUTC = (dateString) => {
    if (!dateString) return dateString;
    if (!dateString.endsWith('Z') && !dateString.includes('+')) {
        return dateString + 'Z';
    }
    return dateString;
};

// THE FIX: Format the time explicitly on the server
const getFormattedTime = (dateString) => {
    if (!dateString) return "Unknown Time";
    try {
        const utcDate = new Date(ensureUTC(dateString));
        // Force Philippines Time
        return utcDate.toLocaleTimeString('en-US', { 
            timeZone: 'Asia/Manila', 
            hour: '2-digit', 
            minute: '2-digit',
            hour12: true 
        });
    } catch (e) {
        return dateString;
    }
};

/**
 * ENDPOINT: Timezone-Aware Smart Slots
 */
exports.slots = async (req, res) => {
    const { barberId, date, serviceId } = req.query;
    if (!barberId || !date || !serviceId) return res.status(400).json({ error: 'Missing parameters' });

    try {
        const { data: service } = await supabase.from('services').select('duration_minutes').eq('id', serviceId).single();
        const duration = service?.duration_minutes || 30;

        const startIso = `${date}T10:30:00+08:00`; 
        const closeIso = `${date}T19:00:00+08:00`; 

        let slotIterator = new Date(startIso);
        const closeTime = new Date(closeIso);
        
        const nowPH = new Date(new Date().getTime() + (8 * 60 * 60 * 1000));
        
        const dbStart = `${date}T00:00:00+08:00`;
        const dbEnd = `${date}T23:59:59+08:00`;

        const { data: bookings } = await supabase
            .from('appointments')
            .select('scheduled_time, end_time')
            .eq('barber_id', barberId)
            .in('status', ['confirmed', 'pending'])
            .gte('scheduled_time', new Date(dbStart).toISOString())
            .lte('scheduled_time', new Date(dbEnd).toISOString());

        let slots = [];

        while (slotIterator < closeTime) {
            const slotStart = new Date(slotIterator);
            const slotEnd = new Date(slotIterator.getTime() + duration * 60000);

            if (slotEnd > closeTime) break;
            
            if (slotStart < nowPH) {
                slotIterator.setMinutes(slotIterator.getMinutes() + 30);
                continue;
            }

            const isTaken = bookings?.some(b => {
                const bookStart = new Date(ensureUTC(b.scheduled_time));
                const bookEnd = new Date(ensureUTC(b.end_time));
                return (slotStart < bookEnd && slotEnd > bookStart);
            });

            if (!isTaken) {
                slots.push(slotIterator.toISOString()); 
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
 */
exports.book = async (req, res) => {
    const { customer_name, customer_email, user_id, barber_id, service_id, scheduled_time } = req.body;
    
    try {
        const { data: service } = await supabase.from('services').select('duration_minutes').eq('id', service_id).single();
        const duration = service?.duration_minutes || 30;

        const startDate = new Date(scheduled_time);
        const endDate = new Date(startDate.getTime() + duration * 60000);

        const { data: conflict } = await supabase
            .from('appointments')
            .select('id')
            .eq('barber_id', barber_id)
            .in('status', ['confirmed', 'pending'])
            .lt('scheduled_time', endDate.toISOString())
            .gt('end_time', startDate.toISOString())
            .maybeSingle();

        if (conflict) {
            return res.status(409).json({ error: 'Slot is pending approval or taken. Please choose another.' });
        }

        const { data, error } = await supabase.from('appointments').insert({
            customer_name,
            customer_email,
            user_id,
            barber_id,
            service_id,
            scheduled_time: startDate.toISOString(),
            end_time: endDate.toISOString(),
            status: 'pending',
            is_converted_to_queue: false
        }).select().single();

        if (error) throw error;
        
        try {
            const { data: barberUser } = await supabaseAdmin.from('barber_profiles').select('user_id').eq('id', barber_id).single();
            if (barberUser && process.env.N8N_WEBHOOK_URL) {
                const { data: userData } = await supabaseAdmin.auth.admin.getUserById(barberUser.user_id);
                const barberEmail = userData?.user?.email;
                if (barberEmail) {
                    await axios.post(process.env.N8N_WEBHOOK_URL, {
                        type: 'barber_alert',
                        email: barberEmail,
                        subject: '✂️ New Booking Received!',
                        message: `You have a new appointment with ${customer_name} on ${getFormattedTime(startDate.toISOString())}.`
                    });
                }
            }
        } catch (e) { console.error("Notification failed", e.message); }

        res.status(201).json({ message: 'Appointment Confirmed!', appointment: data });

    } catch (error) {
        res.status(500).json({ error: error.message });
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
            .select(`id, scheduled_time, status, is_converted_to_queue, barber_profiles(full_name), services(name, price_php, duration_minutes)`)
            .eq('user_id', userId)
            .order('scheduled_time', { ascending: false });

        if (error) throw error;
        
        // ADD FORMATTED TIME
        const fixedData = data?.map(appt => ({
            ...appt,
            scheduled_time: ensureUTC(appt.scheduled_time),
            formatted_time: getFormattedTime(appt.scheduled_time)
        }));

        res.json(fixedData || []);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch appointments.' });
    }
}

/**
 * ENDPOINT: Admin Get All Upcoming Appointments
 */
exports.get_all_appointments = async (req, res) => {
    try {
        const now = new Date();
        const { data, error } = await supabase
            .from('appointments')
            .select(`id, scheduled_time, customer_name, customer_email, status, is_converted_to_queue, barber_profiles(full_name), services(name, duration_minutes)`)
            .in('status', ['confirmed', 'pending']) 
            .gte('scheduled_time', now.toISOString()) 
            .order('scheduled_time', { ascending: true });

        if (error) throw error;
        
        // ADD FORMATTED TIME
        const fixedData = data?.map(appt => ({
            ...appt,
            scheduled_time: ensureUTC(appt.scheduled_time),
            formatted_time: getFormattedTime(appt.scheduled_time)
        }));

        res.json(fixedData || []);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch appointments.' });
    }
}

/**
 * ENDPOINT: Get Barber's Upcoming Appointments
 */
exports.get_barber_appointments = async (req, res) => {
    const { barberId } = req.params;
    if (!barberId) return res.status(400).json({ error: 'Barber ID required' });

    try {
        const now = new Date();
        now.setHours(0,0,0,0); 

        const { data, error } = await supabase
            .from('appointments')
            .select(`id, scheduled_time, customer_name, customer_email, status, is_converted_to_queue, services(name, duration_minutes)`)
            .eq('barber_id', barberId)
            .in('status', ['confirmed', 'pending']) 
            .gte('scheduled_time', now.toISOString()) 
            .order('scheduled_time', { ascending: true }); 

        if (error) throw error;
        
        // ADD FORMATTED TIME
        const fixedData = data?.map(appt => ({
            ...appt,
            scheduled_time: ensureUTC(appt.scheduled_time),
            formatted_time: getFormattedTime(appt.scheduled_time)
        }));

        res.json(fixedData || []);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch appointments.' });
    }
}

exports.reject = async (req, res) => {
    const { appointmentId, reason } = req.body;
    try {
        const { data, error } = await supabase.from('appointments').update({ status: 'cancelled' }).eq('id', appointmentId).select().single();
        if (error) throw error;
        res.json({ message: 'Appointment rejected.' });
    } catch (error) { res.status(500).json({ error: 'Failed to reject.' }); }
};

exports.approve = async (req, res) => {
    const { appointmentId } = req.body;
    try {
        const { data, error } = await supabase.from('appointments').update({ status: 'confirmed' }).eq('id', appointmentId).select().single();
        if (error) throw error;
        res.json({ message: 'Appointment approved!' });
    } catch (error) { res.status(500).json({ error: 'Failed to approve.' }); }
};

exports.process_appointments = async (req, res) => {
    const lookBack = new Date(new Date().getTime() - 24 * 60 * 60 * 1000); 
    try {
        const { data: missed, error } = await supabase.from('appointments').select('*').in('status', ['confirmed']).eq('is_converted_to_queue', false).gte('scheduled_time', lookBack.toISOString());
        if (error) throw error;

        const results = [];
        for (const appt of missed) {
            const { data: newEntry } = await supabase.from('queue_entries').insert({
                barber_id: appt.barber_id, customer_name: `${appt.customer_name} (Booked)`,
                customer_email: appt.customer_email, user_id: appt.user_id, service_id: appt.service_id,
                status: 'Up Next', is_vip: true, is_confirmed: true
            }).select().single();
            if (newEntry) {
                await supabase.from('appointments').update({ is_converted_to_queue: true }).eq('id', appt.id);
                results.push(`Converted ${appt.customer_name}`);
            }
        }
        res.json({ success: true, processed: results });
    } catch (e) { res.json({ error: e.message }); }
}