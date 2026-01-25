const cron = require('node-cron');
const { supabase } = require('../database/supabase');

const startCronJobs = () => {
    console.log('🕒 Starting cron jobs...');

    cron.schedule('* * * * *', async () => {
        console.log('[Cron] Sweeping for unsent "Up Next" emails...');
        try {
            // 1. Find everyone who is 'Up Next' but hasn't been notified
            const { data: pendingNotifications, error } = await supabase
                .from('queue_entries')
                .select('*')
                .eq('status', 'Up Next')
                .eq('notified_up_next', false); // <--- The Magic Flag

            if (error) throw error;

            if (pendingNotifications && pendingNotifications.length > 0) {
                console.log(`[Cron] Found ${pendingNotifications.length} unsent notifications.`);

                // 2. Process them one by one
                for (const entry of pendingNotifications) {
                    await processUpNextNotification(entry);
                }
            }
        } catch (err) {
            console.error('[Cron] Email Sweeper Error:', err.message);
        }
    })

    cron.schedule('0 19 * * *', async () => { // 19:00 = 7:00 PM
        console.log('[Cron 7PM] Shop closing. Cleaning up...');
        try {
            // 1. Set Barbers Offline
            await supabase.from('barber_profiles')
                .update({ is_active: false, is_available: false })
                .neq('is_active', false);

            // 2. Cancel Pending Queue Entries
            const { data: cancelledData } = await supabase
                .from('queue_entries')
                .update({ status: 'Cancelled' })
                .in('status', ['Waiting', 'Up Next'])
                .select();

            console.log(`[Cron 7PM] Cancelled ${cancelledData?.length || 0} pending entries.`);

        } catch (e) {
            console.error('[Cron 7PM] Error during cleanup:', e.message);
        }
    }, { timezone: "Asia/Manila" })

    cron.schedule('*/5 * * * *', async () => { // Runs every 5 minutes
        console.log('[Cron] Checking for upcoming appointments...');

        const now = new Date();
        // Look ahead 30 minutes
        const lookAheadTime = new Date(now.getTime() + 30 * 60000);
        
        // Look BEHIND 24 hours (Safety Net for "Missed" appointments)
        const lookBehindTime = new Date(now.getTime() - 24 * 60 * 60 * 1000); 

        try {
            // 1. Find confirmed appointments due soon (or slightly past due)
            const { data: dueAppointments } = await supabase
                .from('appointments')
                .select('*')
                .in('status', ['confirmed']) 
                .eq('is_converted_to_queue', false)
                .lte('scheduled_time', lookAheadTime.toISOString()) // Starts before 30 mins from now
                .gte('scheduled_time', lookBehindTime.toISOString()); // But not older than yesterday

            if (dueAppointments && dueAppointments.length > 0) {
                for (const appt of dueAppointments) {
                    // ... (Keep the rest of the logic exactly the same) ...
                    console.log(`[Cron] Processing Appointment #${appt.id} for Barber ${appt.barber_id}...`);
                    
                    // ... (Chair Check Logic) ...
                    const { data: activeQueue } = await supabase
                        .from('queue_entries')
                        .select('id, status')
                        .eq('barber_id', appt.barber_id)
                        .in('status', ['In Progress', 'Up Next']);

                    const personInChair = activeQueue.find(q => q.status === 'In Progress');
                    const personUpNext = activeQueue.find(q => q.status === 'Up Next');

                    let initialStatus = 'Waiting';

                    if (!personInChair) {
                        console.log(`---> Chair empty. Auto-seating Appointment #${appt.id}.`);
                        initialStatus = 'In Progress';
                    } else {
                        console.log(`---> Chair taken. CLEARING WAY for Appointment #${appt.id}.`);
                        initialStatus = 'Up Next';

                        // ☢️ NUCLEAR OPTION: Kick ANYONE currently in 'Up Next' back to 'Waiting'
                        // This guarantees the slot is empty for the Appointment.
                        await supabase
                            .from('queue_entries')
                            .update({ status: 'Waiting' })
                            .eq('barber_id', appt.barber_id)
                            .eq('status', 'Up Next'); 
                    }

                    // Insert into Queue
                    const { data: newEntry, error: insertError } = await supabase
                        .from('queue_entries')
                        .insert({
                            barber_id: appt.barber_id,
                            customer_name: `${appt.customer_name} (Booked)`,
                            customer_email: appt.customer_email,
                            user_id: appt.user_id,
                            service_id: appt.service_id,
                            status: initialStatus,
                            is_vip: true,
                            is_confirmed: true
                        }).select().single();

                    if (!insertError) {
                        // Mark as converted
                        await supabase.from('appointments')
                            .update({ is_converted_to_queue: true })
                            .eq('id', appt.id);
                            
                        // Notify
                        if (initialStatus !== 'Waiting') {
                            processUpNextNotification(newEntry);
                        }
                    }
                }
            }
        } catch (e) {
            console.error("[Cron] Error:", e);
        }
    })
}

module.exports = {
    startCronJobs,
};