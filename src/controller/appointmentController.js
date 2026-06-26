const axios = require("axios");
const { supabase, supabaseAdmin } = require("../database/supabase");

// Helper: Convert total minutes into HH:MM:SS
const formatTime = (totalMinutes) => {
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
};

// Helper: Generate "11:00 AM" directly from "2026-04-01T11:00:00"
const getFormattedTime = (naiveString) => {
    if (!naiveString) return "Unknown";
    const timePart = naiveString.split('T')[1];
    if (!timePart) return naiveString;
    let [hours, mins] = timePart.split(':');
    hours = parseInt(hours, 10);
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12; 
    return `${String(hours).padStart(2, '0')}:${mins} ${ampm}`;
};

const notifyN8n = async (action, appointmentData) => {
    try {
        await axios.post(N8N_WEBHOOK_URL, {
            event: action, // 'CANCELED' or 'EDITED'
            appointment: appointmentData,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Failed to trigger n8n automation:', error.message);
    }
};

/**
 * ENDPOINT: "Naive Time" Smart Slots
 * Completely ignores UTC. Calculates directly in literal Philippines time.
 */
exports.slots = async (req, res) => {
    const { barberId, date, serviceId } = req.query;
    if (!barberId || !date || !serviceId) return res.status(400).json({ error: 'Missing parameters' });

    try {
        const { data: service } = await supabase.from('services').select('duration_minutes').eq('id', serviceId).single();
        const duration = service?.duration_minutes || 30;

        // Get current real PH time
        const now = new Date();
        const nowPH = new Date(now.getTime() + (8 * 60 * 60 * 1000));
        const todayStr = `${nowPH.getUTCFullYear()}-${String(nowPH.getUTCMonth()+1).padStart(2,'0')}-${String(nowPH.getUTCDate()).padStart(2,'0')}`;
        const currentPHMinutes = nowPH.getUTCHours() * 60 + nowPH.getUTCMinutes();

        let currentMinutes = 10 * 60 + 30; // 10:30 AM
        const closeMinutes = 19 * 60; // 7:00 PM

        // Query database using literal string matching
        const { data: bookings } = await supabase
            .from('appointments')
            .select('scheduled_time, end_time')
            .eq('barber_id', barberId)
            .in('status', ['confirmed', 'pending'])
            .gte('scheduled_time', `${date}T00:00:00`)
            .lte('scheduled_time', `${date}T23:59:59`);

        let slots = [];

        while (currentMinutes + duration <= closeMinutes) {
            // Block past slots if booking for today
            if (date === todayStr && currentMinutes <= currentPHMinutes) {
                currentMinutes += 30;
                continue;
            }

            const slotStart = currentMinutes;
            const slotEnd = currentMinutes + duration;

            // Check if slot overlaps with existing bookings
            const isTaken = bookings?.some(b => {
                const bTime = b.scheduled_time.split('T')[1]; 
                const bStartMin = parseInt(bTime.split(':')[0]) * 60 + parseInt(bTime.split(':')[1]);
                
                const eTime = b.end_time.split('T')[1]; 
                const bEndMin = parseInt(eTime.split(':')[0]) * 60 + parseInt(eTime.split(':')[1]);
                
                return (slotStart < bEndMin && slotEnd > bStartMin);
            });

            if (!isTaken) {
                // Sends literal string like "2026-04-01T11:00:00"
                slots.push(`${date}T${formatTime(currentMinutes)}`);
            }

            currentMinutes += 30;
        }

        res.json(slots);

    } catch (error) {
        console.error("Slot fetch error:", error);
        res.status(500).json({ error: 'Server error calculating slots' });
    }
};

exports.cancelAppointment = async (req, res) => {
    const { id } = req.params;

    try {
        const { data, error } = await supabase
            .from('appointments')
            .update({ status: 'Canceled' })
            .eq('id', id)
            .select()
            .single();

        if (error) throw error;

        // Trigger n8n automation
        await notifyN8n('CANCELED', data);

        res.status(200).json({ message: 'Appointment canceled successfully', data });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

exports.editAppointment = async (req, res) => {
    const { id } = req.params;
    const { date, time, service_id } = req.body;

    try {
        const { data, error } = await supabase
            .from('appointments')
            .update({ 
                date, 
                time, 
                service_id, 
                status: 'Rescheduled', // Optional: Flag to show it was edited
                updated_at: new Date().toISOString() 
            })
            .eq('id', id)
            .select()
            .single();

        if (error) throw error;

        // Trigger n8n automation
        await notifyN8n('EDITED', data);

        res.status(200).json({ message: 'Appointment updated successfully', data });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

/**
 * ENDPOINT: Book an Appointment (NAIVE TIME)
 */
exports.book = async (req, res) => {
    const { customer_name, customer_email, user_id, barber_id, service_id, scheduled_time } = req.body;
    
    // Clean whatever the frontend sends down to a literal "YYYY-MM-DDTHH:MM:SS"
    let cleanTime = scheduled_time.split('.')[0].split('+')[0]; 
    if (cleanTime.endsWith('Z')) cleanTime = cleanTime.slice(0, -1);

    try {
        const { data: service } = await supabase.from('services').select('duration_minutes').eq('id', service_id).single();
        const duration = service?.duration_minutes || 30;

        const datePart = cleanTime.split('T')[0];
        const timePart = cleanTime.split('T')[1];
        
        const startMins = parseInt(timePart.split(':')[0]) * 60 + parseInt(timePart.split(':')[1]);
        const endMins = startMins + duration;
        
        // The exact literal time it will end
        const end_time = `${datePart}T${formatTime(endMins)}`;

        // Strict String comparison for conflicts
        const { data: conflict } = await supabase
            .from('appointments')
            .select('id')
            .eq('barber_id', barber_id)
            .in('status', ['confirmed', 'pending'])
            .lt('scheduled_time', end_time)
            .gt('end_time', cleanTime)
            .maybeSingle();

        if (conflict) {
            return res.status(409).json({ error: 'Slot is pending approval or taken. Please choose another.' });
        }

        // Insert exactly the literal strings into Supabase
        const { data, error } = await supabase.from('appointments').insert({
            customer_name,
            customer_email,
            user_id,
            barber_id,
            service_id,
            scheduled_time: cleanTime, // Supabase will save EXACTLY 11:00:00
            end_time: end_time,        // Supabase will save EXACTLY 11:30:00
            status: 'pending',
            is_converted_to_queue: false
        }).select().single();

        if (error) throw error;
        
        // Send Notification
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
                        message: `You have a new appointment with ${customer_name} on ${getFormattedTime(cleanTime)}.`
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
        
        const fixedData = data?.map(appt => ({
            ...appt,
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
        const nowPH = new Date(now.getTime() + (8 * 60 * 60 * 1000));
        const todayStr = `${nowPH.getUTCFullYear()}-${String(nowPH.getUTCMonth()+1).padStart(2,'0')}-${String(nowPH.getUTCDate()).padStart(2,'0')}T00:00:00`;

        const { data, error } = await supabase
            .from('appointments')
            .select(`id, scheduled_time, customer_name, customer_email, status, is_converted_to_queue, barber_profiles(full_name), services(name, duration_minutes)`)
            .in('status', ['confirmed', 'pending']) 
            .gte('scheduled_time', todayStr) 
            .order('scheduled_time', { ascending: true });

        if (error) throw error;
        
        const fixedData = data?.map(appt => ({
            ...appt,
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
        const nowPH = new Date(now.getTime() + (8 * 60 * 60 * 1000));
        const todayStr = `${nowPH.getUTCFullYear()}-${String(nowPH.getUTCMonth()+1).padStart(2,'0')}-${String(nowPH.getUTCDate()).padStart(2,'0')}T00:00:00`;

        const { data, error } = await supabase
            .from('appointments')
            .select(`id, scheduled_time, customer_name, customer_email, status, is_converted_to_queue, services(name, duration_minutes)`)
            .eq('barber_id', barberId)
            .in('status', ['confirmed', 'pending']) 
            .gte('scheduled_time', todayStr) 
            .order('scheduled_time', { ascending: true }); 

        if (error) throw error;
        
        const fixedData = data?.map(appt => ({
            ...appt,
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
    const now = new Date();
    const nowPH = new Date(now.getTime() + (8 * 60 * 60 * 1000));
    const lookBackPH = new Date(nowPH.getTime() - 24 * 60 * 60 * 1000);
    const lbY = lookBackPH.getUTCFullYear();
    const lbM = String(lookBackPH.getUTCMonth()+1).padStart(2,'0');
    const lbD = String(lookBackPH.getUTCDate()).padStart(2,'0');
    const lookBackStr = `${lbY}-${lbM}-${lbD}T00:00:00`;

    try {
        const { data: missed, error } = await supabase.from('appointments')
            .select('*').in('status', ['confirmed']).eq('is_converted_to_queue', false).gte('scheduled_time', lookBackStr);
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
exports.cancelAppointment = async (req, res) => {
    const { id } = req.params;

    try {
        const { data, error } = await supabase
            .from('appointments')
            .update({ status: 'cancelled' }) // Ensure this matches your DB status (cancelled/Canceled)
            .eq('id', id)
            .select()
            .single();

        if (error) throw error;

        // Optional: Trigger n8n webhook here if configured
        if (process.env.N8N_WEBHOOK_URL) {
            axios.post(process.env.N8N_WEBHOOK_URL, {
                event: 'CANCELED',
                appointment: data,
                timestamp: new Date().toISOString()
            }).catch(e => console.error("n8n error:", e.message));
        }

        res.status(200).json({ message: 'Appointment canceled successfully', data });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

/**
 * ENDPOINT: Edit/Reschedule Appointment
 */
exports.editAppointment = async (req, res) => {
    const { id } = req.params;
    const { scheduled_time, service_id } = req.body;

    try {
        // Need to calculate new end_time
        const { data: service } = await supabase.from('services').select('duration_minutes').eq('id', service_id).single();
        const duration = service?.duration_minutes || 30;

        let cleanTime = scheduled_time.split('.')[0].split('+')[0]; 
        if (cleanTime.endsWith('Z')) cleanTime = cleanTime.slice(0, -1);

        const datePart = cleanTime.split('T')[0];
        const timePart = cleanTime.split('T')[1];
        
        const startMins = parseInt(timePart.split(':')[0]) * 60 + parseInt(timePart.split(':')[1]);
        const endMins = startMins + duration;
        
        const end_time = `${datePart}T${formatTime(endMins)}`;

        const { data, error } = await supabase
            .from('appointments')
            .update({ 
                scheduled_time: cleanTime, 
                end_time: end_time,
                service_id, 
                status: 'pending' // Revert to pending for barber to approve
            })
            .eq('id', id)
            .select()
            .single();

        if (error) throw error;

        // Optional: Trigger n8n webhook here
        if (process.env.N8N_WEBHOOK_URL) {
            axios.post(process.env.N8N_WEBHOOK_URL, {
                event: 'RESCHEDULED',
                appointment: data,
                timestamp: new Date().toISOString()
            }).catch(e => console.error("n8n error:", e.message));
        }

        res.status(200).json({ message: 'Appointment updated successfully', data });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};