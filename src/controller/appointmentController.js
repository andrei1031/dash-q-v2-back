const axios = require("axios");
const { supabase, supabaseAdmin } = require("../database/supabase");

// THE ULTIMATE TIMEZONE FIX: 
// Rebuilds the string so it literally contains the local PH time, 
// fixing views that use .substring() or .slice() instead of new Date()
const formatToPHT = (dbDateString) => {
    if (!dbDateString) return dbDateString;
    try {
        let safeString = dbDateString;
        // Ensure it's treated as UTC if Supabase stripped the marker
        if (!safeString.includes('Z') && !safeString.includes('+')) {
            safeString += 'Z';
        }
        
        const date = new Date(safeString);
        if (isNaN(date.getTime())) return dbDateString; // fallback
        
        // Shift by 8 hours
        const phTime = new Date(date.getTime() + (8 * 60 * 60 * 1000));
        
        // Rebuild string manually
        const year = phTime.getUTCFullYear();
        const month = String(phTime.getUTCMonth() + 1).padStart(2, '0');
        const day = String(phTime.getUTCDate()).padStart(2, '0');
        const hours = String(phTime.getUTCHours()).padStart(2, '0');
        const minutes = String(phTime.getUTCMinutes()).padStart(2, '0');
        const seconds = String(phTime.getUTCSeconds()).padStart(2, '0');
        
        // Output: "2026-04-01T10:30:00+08:00"
        return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}+08:00`;
    } catch(e) {
        return dbDateString;
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

        const PH_OFFSET = "+08:00";
        const startIso = `${date}T10:30:00${PH_OFFSET}`; 
        const closeIso = `${date}T19:00:00${PH_OFFSET}`; 

        let slotIterator = new Date(startIso);
        const closeTime = new Date(closeIso);
        
        const now = new Date();
        const nowPH = new Date(now.getTime() + (8 * 60 * 60 * 1000));

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

            if (slotEnd > closeTime) break;

            if (slotStart < nowPH) {
                slotIterator.setMinutes(slotIterator.getMinutes() + 30);
                continue;
            }

            const isTaken = bookings.some(b => {
                const bookStart = new Date(b.scheduled_time);
                const bookEnd = new Date(b.end_time);
                return (slotStart < bookEnd && slotEnd > bookStart);
            });

            if (!isTaken) {
                const utcTime = slotIterator.getTime();
                const phTime = new Date(utcTime + (8 * 60 * 60 * 1000));
                
                const year = phTime.getUTCFullYear();
                const month = String(phTime.getUTCMonth() + 1).padStart(2, '0');
                const day = String(phTime.getUTCDate()).padStart(2, '0');
                const hours = String(phTime.getUTCHours()).padStart(2, '0');
                const minutes = String(phTime.getUTCMinutes()).padStart(2, '0');
                const seconds = String(phTime.getUTCSeconds()).padStart(2, '0');
                
                slots.push(`${year}-${month}-${day}T${hours}:${minutes}:${seconds}+08:00`);
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
        const extractDateParts = (isoString) => {
            const match = isoString.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
            if (!match) return null;
            return {
                year: parseInt(match[1]), month: parseInt(match[2]), day: parseInt(match[3]),
                hours: parseInt(match[4]), minutes: parseInt(match[5])
            };
        };

        const timeParts = extractDateParts(scheduled_time);
        if (!timeParts) return res.status(400).json({ error: 'Invalid time format' });

        const now = new Date();
        const nowPH = new Date(now.getTime() + (8 * 60 * 60 * 1000));
        const appointmentPH = new Date(timeParts.year, timeParts.month - 1, timeParts.day, timeParts.hours, timeParts.minutes);

        if (appointmentPH.getTime() <= nowPH.getTime()) {
            return res.status(400).json({ error: 'Appointments must be booked at least 1 day in advance.' });
        }

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

        const scheduledTimePH = scheduled_time;
        
        const extractTimeParts = (isoString) => {
            const match = isoString.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
            if (!match) return null;
            return { year: parseInt(match[1]), month: parseInt(match[2]), day: parseInt(match[3]), hours: parseInt(match[4]), minutes: parseInt(match[5]), seconds: parseInt(match[6]) };
        };
        
        const startTimeParts = extractTimeParts(scheduled_time);
        let totalMinutes = startTimeParts.hours * 60 + startTimeParts.minutes + duration;
        let endHours = Math.floor(totalMinutes / 60);
        let endMinutes = totalMinutes % 60;
        
        const formatTime = (h, m, s) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}+08:00`;
        const endTimePH = `${startTimeParts.year}-${String(startTimeParts.month).padStart(2, '0')}-${String(startTimeParts.day).padStart(2, '0')}T${formatTime(endHours, endMinutes, startTimeParts.seconds)}`;

        const { data, error } = await supabase.from('appointments').insert({
            customer_name, customer_email, user_id, barber_id, service_id,
            scheduled_time: scheduledTimePH, end_time: endTimePH,
            status: 'pending', is_converted_to_queue: false
        }).select().single();

        if (error) throw error;

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
        const { data: appt, error } = await supabase
            .from('appointments')
            .update({ status: 'cancelled' }) 
            .eq('id', appointmentId)
            .select('customer_email, customer_name, scheduled_time')
            .single();

        if (error) throw error;
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
        const { data: appt, error } = await supabase
            .from('appointments')
            .update({ status: 'confirmed' })
            .eq('id', appointmentId)
            .select('customer_email, customer_name, scheduled_time')
            .single();

        if (error) throw error;
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
            .select(`id, scheduled_time, status, is_converted_to_queue, barber_profiles(full_name), services(name, price_php, duration_minutes)`)
            .eq('user_id', userId)
            .order('scheduled_time', { ascending: false });

        if (error) throw error;
        
        // Apply String Reconstruction Fix
        const fixedData = data?.map(appt => ({
            ...appt,
            scheduled_time: formatToPHT(appt.scheduled_time)
        }));

        res.json(fixedData || []);
    } catch (error) {
        console.error("Fetch appointments error:", error.message);
        res.status(500).json({ error: 'Failed to fetch appointments.' });
    }
}

/**
 * FEATURE: Admin Get All Upcoming Appointments
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
        
        // Apply String Reconstruction Fix
        const fixedData = data?.map(appt => ({
            ...appt,
            scheduled_time: formatToPHT(appt.scheduled_time)
        }));

        res.json(fixedData || []);
    } catch (error) {
        console.error("Admin Appointments Error:", error.message);
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
        
        // Apply String Reconstruction Fix
        const fixedData = data?.map(appt => ({
            ...appt,
            scheduled_time: formatToPHT(appt.scheduled_time)
        }));

        res.json(fixedData || []);
    } catch (error) {
        console.error("Fetch barber appointments error:", error.message);
        res.status(500).json({ error: 'Failed to fetch appointments.' });
    }
}

exports.process_appointments = async (req, res) => {
    const now = new Date();
    const lookBack = new Date(now.getTime() - 24 * 60 * 60 * 1000); 

    try {
        const { data: missed, error } = await supabase
            .from('appointments')
            .select('*')
            .in('status', ['confirmed'])
            .eq('is_converted_to_queue', false)
            .gte('scheduled_time', lookBack.toISOString());

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

    } catch (e) {
        res.json({ error: e.message });
    }
}