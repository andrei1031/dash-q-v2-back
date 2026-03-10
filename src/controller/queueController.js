const axios = require("axios");
const { supabase } = require("../database/supabase");
const { createNotificationHelpers } = require("../utils/notifications");
const { createQueueHelpers } = require("../utils/queueLogic");
const setupVapid = require("../config/vapid");
const webPush = setupVapid()

const { getNotificationContext, processUpNextNotification } = createNotificationHelpers({ supabase, webPush });
const { enforceQueueLogic } = createQueueHelpers(supabase);

// Customer Confirms Attendance
exports.confirm = async (req, res) => {
    const { queueId } = req.body;

    if (!queueId) return res.status(400).json({ error: 'Queue ID required.' });

    try {
        const { data, error } = await supabase
            .from('queue_entries')
            .update({ is_confirmed: true })
            .eq('id', queueId)
            .select()
            .single();

        if (error) throw error;

        console.log(`[Confirm] Customer for queue ${queueId} is ON THE WAY.`);
        res.json({ message: "Attendance confirmed!", data });
    } catch (error) {
        console.error("Confirmation failed:", error.message);
        res.status(500).json({ error: 'Server error confirming attendance.' });
    }
}

/**
 * ENDPOINT: Update Customer Location (Heartbeat)
 */
exports.location = async (req, res) => {
    const { queueId, distance } = req.body;

    // Silent failure is okay here (we don't want to crash the app if GPS fails)
    if (!queueId || distance === undefined) return res.sendStatus(400);

    try {
        await supabase
            .from('queue_entries')
            .update({ current_distance_meters: Math.round(distance) })
            .eq('id', queueId);

        res.sendStatus(200); // OK
    } catch (error) {
        console.error("Loc update failed:", error.message);
        res.sendStatus(500);
    }
}

/**
 * ENDPOINT 2 (RPC): Add a customer and auto-assign status
 */
exports.queue = async (req, res) => {
    const {
        customer_name, customer_phone, barber_id, reference_image_url,
        customer_email, service_id, player_id, user_id,
        is_vip,
        head_count = 1,
    } = req.body;

    console.log(`[RPC Join] POST /api/queue - Customer: ${customer_name}, VIP: ${is_vip}`);

    const barberIdInt = parseInt(barber_id);
    const serviceIdInt = parseInt(service_id);

    if (!customer_name || isNaN(barberIdInt) || isNaN(serviceIdInt)) {
        return res.status(400).json({ error: 'Name, Barber ID, and Service ID are required.' });
    }

    // --- 1. BLOCKING CHECK: Active Booking ---
    if (user_id) {
        const { data: activeEntry, error: checkError } = await supabase
            .from('queue_entries')
            .select('id, status')
            .eq('user_id', user_id)
            .in('status', ['Waiting', 'Up Next', 'In Progress'])
            .maybeSingle();

        if (checkError) return res.status(500).json({ error: 'Server error checking queue status.' });
        if (activeEntry) return res.status(409).json({ error: 'You already have an active booking.', details: activeEntry });
    }

    try {
        // --- 2. JOIN QUEUE (Initially 'Waiting') ---
        const { data, error } = await supabase.rpc('join_queue_auto_assign', {
            p_customer_name: customer_name,
            p_barber_id: barberIdInt,
            p_service_id: serviceIdInt,
            p_customer_phone: customer_phone || null,
            p_customer_email: customer_email || null,
            p_reference_image_url: reference_image_url || null,
            p_player_id: player_id || null,
            p_user_id: user_id || null,
            p_ai_haircut_image_url: null,
            p_share_ai_image: false,
            p_is_vip: !!is_vip
        });

        if (error) return res.status(409).json({ error: error.message });

        let newQueueEntry = Array.isArray(data) ? data[0] : data;
        if (!newQueueEntry) throw new Error('Database function did not return a new entry.');

        // ============================================================
        // 🔴 PRIORITY LOGIC START
        // Hierarchy: Appointment > VIP > Regular (FCFS)
        // ============================================================
        
        // A. Check for "Blocking" Appointments (e.g., within next 45 mins)
        const now = new Date();
        const appointmentBuffer = new Date(now.getTime() + 45 * 60 * 1000); // 45 Minute lookahead

        const { data: upcomingAppt } = await supabase
            .from('appointments')
            .select('id, scheduled_time')
            .eq('barber_id', barberIdInt)
            .eq('status', 'confirmed')
            .eq('is_converted_to_queue', false)
            .gt('scheduled_time', now.toISOString())
            .lt('scheduled_time', appointmentBuffer.toISOString())
            .maybeSingle();

        // Get current "Up Next" person (if any)
        const { data: currentUpNext } = await supabase
            .from('queue_entries')
            .select('id, is_vip, customer_name, status')
            .eq('barber_id', barberIdInt)
            .eq('status', 'Up Next')
            .maybeSingle();

        // --- SCENARIO 1: APPOINTMENT EXISTS ---
        if (upcomingAppt) {
            console.log(`[Priority] Upcoming Appointment found at ${upcomingAppt.scheduled_time}. Blocking Up Next slot.`);
            
            // If someone is currently Up Next (VIP or Regular), DEMOTE them to save the spot for the Appointment
            if (currentUpNext) {
                console.log(`[Priority] Demoting ${currentUpNext.customer_name} (VIP: ${currentUpNext.is_vip}) to make room for Appointment.`);
                await supabase
                    .from('queue_entries')
                    .update({ status: 'Waiting', notified_up_next: false })
                    .eq('id', currentUpNext.id);
            }
            
            // New user stays Waiting (do nothing).
        } 
        
        // --- SCENARIO 2: NO APPOINTMENT (Standard VIP Logic) ---
        else {
            if (!currentUpNext) {
                // SLOT EMPTY: Anyone takes it
                console.log(`[Priority] Slot empty. Promoting #${newQueueEntry.id} to Up Next.`);
                const { data: updated } = await supabase.from('queue_entries').update({ status: 'Up Next' }).eq('id', newQueueEntry.id).select().single();
                if (updated) newQueueEntry = updated;
            } 
            else {
                // SLOT FULL: Check for VIP Bump
                // Rule: New VIP bumps Old Regular. 
                // Rule: New VIP does NOT bump Old VIP (FCFS).
                // Rule: New Regular does NOT bump anyone.

                if (!!is_vip && !currentUpNext.is_vip) {
                    console.log(`[Priority] VIP BUMP! New VIP #${newQueueEntry.id} bumps Regular #${currentUpNext.id}`);
                    
                    // 1. Demote Regular
                    await supabase.from('queue_entries').update({ status: 'Waiting', notified_up_next: false }).eq('id', currentUpNext.id);
                    
                    // 2. Promote New VIP
                    const { data: updated } = await supabase.from('queue_entries').update({ status: 'Up Next' }).eq('id', newQueueEntry.id).select().single();
                    if (updated) newQueueEntry = updated;
                } 
                else if (!!is_vip && currentUpNext.is_vip) {
                     console.log(`[Priority] VIP Conflict. Slot held by VIP #${currentUpNext.id}. New VIP #${newQueueEntry.id} waits (FCFS).`);
                }
            }
        }
        // ============================================================
        // 🔴 PRIORITY LOGIC END
        // ============================================================


        // --- 3. HANDLE HEAD COUNT ---
        if (newQueueEntry && head_count > 1) {
            await supabase.from('queue_entries').update({ head_count: parseInt(head_count) }).eq('id', newQueueEntry.id);
            newQueueEntry.head_count = parseInt(head_count);
        }

        // --- 4. SEND NOTIFICATIONS (Only if they successfully got the Up Next spot) ---
        if (newQueueEntry.status === 'Up Next') {
            console.log(`[RPC Join] Triggering notifications for ${newQueueEntry.customer_name}...`);
            await supabase.from('queue_entries').update({ notified_up_next: true }).eq('id', newQueueEntry.id);

            const context = await getNotificationContext(newQueueEntry);

            // Trigger Email (n8n)
            if (newQueueEntry.customer_email && process.env.N8N_WEBHOOK_URL && context) {
                axios.post(process.env.N8N_WEBHOOK_URL, {
                    type: 'up_next',
                    email: newQueueEntry.customer_email,
                    name: newQueueEntry.customer_name,
                    barberName: context.barberName,
                    serviceName: context.serviceName,
                    duration: context.duration
                }).catch(err => console.error(err.message));
            }

            // Trigger Push (OneSignal)
            if (newQueueEntry.player_id && process.env.ONESIGNAL_APP_ID && process.env.ONESIGNAL_REST_API_KEY) {
                const pushContent = context ?
                    `Hi ${newQueueEntry.customer_name}, you're Up Next for ${context.serviceName} with ${context.barberName}.` :
                    `Hi ${newQueueEntry.customer_name}, you're Up Next!`;
                
                axios.post("https://api.onesignal.com/api/v1/notifications", {
                    app_id: process.env.ONESIGNAL_APP_ID,
                    include_player_ids: [newQueueEntry.player_id],
                    headings: { "en": "You're next!" },
                    contents: { "en": pushContent }
                }, { headers: { "Authorization": `Basic ${process.env.ONESIGNAL_REST_API_KEY}`, "Content-Type": "application/json" } })
                .catch(err => console.error(err.message));
            }
        }

        res.status(201).json(newQueueEntry);

    } catch (error) {
        console.error('Error in POST /api/queue:', error.message);
        res.status(500).json({ error: `Failed to add to queue: ${error.message}` });
    }
}

/**
 * ENDPOINT (NEW): Update the reference image URL
 */
exports.photo = async (req, res) => {
    const { queueId, barberId, referenceImageUrl } = req.body;
    const queueIdInt = parseInt(queueId);
    const barberIdInt = parseInt(barberId);
    console.log(`PUT /api/queue/photo - Updating photo for queue ${queueIdInt} by barber ${barberIdInt}`);

    if (isNaN(queueIdInt) || isNaN(barberIdInt) || !referenceImageUrl) {
        return res.status(400).json({ error: 'Valid Queue ID, Barber ID, and Image URL are required.' });
    }

    try {
        // 1. Check if the entry is still in an updatable state ('Waiting' or 'Up Next')
        const { data: entry, error: fetchError } = await supabase.from('queue_entries')
            .select('status, barber_id')
            .eq('id', queueIdInt)
            .eq('barber_id', barberIdInt)
            .maybeSingle();

        if (fetchError) throw fetchError;
        if (!entry) return res.status(404).json({ error: 'Queue entry not found or invalid barber ID.' });
        if (entry.status !== 'Waiting' && entry.status !== 'Up Next') {
            return res.status(403).json({ error: `Photo can only be updated when status is 'Waiting' or 'Up Next' (Current: ${entry.status}).` });
        }

        // 2. Perform the update
        const { data, error: updateError } = await supabase.from('queue_entries')
            .update({ reference_image_url: referenceImageUrl })
            .eq('id', queueIdInt)
            .select('id, reference_image_url')
            .single();

        if (updateError) throw updateError;

        console.log(`Successfully updated photo URL for queue ${queueIdInt}`);
        res.status(200).json(data);

    } catch (error) {
        console.error('Error updating reference photo:', error.message);
        res.status(500).json({ error: error.message || 'Server error updating photo.' });
    }
}

/**
 * ENDPOINT 3.5 (UPDATED): Get full queue details for Barber Dashboard
 * Includes 'unread_count' for chat notification badges and 'nextAppointment' for Safety Gap.
 */
exports.details = async (req, res) => {
    const { barberId } = req.params;
    const barberIdInt = parseInt(barberId);

    if (isNaN(barberIdInt)) return res.status(400).json({ error: "Invalid Barber ID" });

    try {
        // 0. Fetch Barber's UUID (Required to filter out their own messages from unread count)
        const { data: bProfile } = await supabase
            .from('barber_profiles')
            .select('user_id')
            .eq('id', barberIdInt)
            .maybeSingle();

        const barberUserId = bProfile?.user_id;

        // --- HELPER: Fetch unread counts for a list of entries ---
        const fetchUnreadCounts = async (entries) => {
            if (!entries || entries.length === 0) return entries;
            
            const entryIds = entries.map(e => e.id);
            
            // Query: Get messages in these queues that are NOT read
            let query = supabase
                .from('chat_messages')
                .select('queue_entry_id, sender_id')
                .in('queue_entry_id', entryIds)
                .is('read_at', null);
            
            // Critical: Exclude messages sent by the barber themselves
            if (barberUserId) {
                query = query.neq('sender_id', barberUserId);
            }

            const { data: unreadMsgs, error } = await query;

            if (error) {
                console.error("Error counting unread messages:", error);
                return entries; // Return entries without counts if error occurs
            }

            // Map counts back to entries
            return entries.map(e => {
                const count = unreadMsgs.filter(m => m.queue_entry_id === e.id).length;
                return { ...e, unread_count: count };
            });
        };

        // 1. Fetch WAITING list
        const { data: waitingData, error: waitingError } = await supabase.from('queue_entries')
            .select(`*, services(name, price_php), profiles(id), is_vip`)
            .eq('barber_id', barberIdInt).eq('status', 'Waiting')
            .order('is_vip', { ascending: false }).order('created_at', { ascending: true });

        if (waitingError) throw waitingError;

        // 2. Fetch IN PROGRESS
        const { data: inProgressData, error: inProgressError } = await supabase.from('queue_entries')
            .select(`*, services(name, price_php), profiles(id), is_vip`)
            .eq('barber_id', barberIdInt).eq('status', 'In Progress')
            .limit(1).maybeSingle();

        if (inProgressError) throw inProgressError;

        // 3. Fetch UP NEXT
        const { data: upNextListData, error: upNextError } = await supabase.from('queue_entries')
            .select(`*, services(name, price_php), profiles(id), is_vip`)
            .eq('barber_id', barberIdInt).eq('status', 'Up Next')
            .limit(1);
        
        if (upNextError) throw upNextError;

        const finalUpNext = (upNextListData && upNextListData.length > 0) ? upNextListData[0] : null;

        // 4. Fetch Next Immediate Appointment (Safety Gap Warning)
        const now = new Date().toISOString();
        const { data: nextAppt, error: apptError } = await supabase
            .from('appointments')
            .select('id, scheduled_time, customer_name, services(name, duration_minutes)')
            .eq('barber_id', barberIdInt)
            .eq('status', 'confirmed')
            .eq('is_converted_to_queue', false)
            .gt('scheduled_time', now)
            .order('scheduled_time', { ascending: true })
            .limit(1)
            .maybeSingle();

        if (apptError) throw apptError;

        // 5. Apply Unread Counts to all lists
        const waitingWithCounts = await fetchUnreadCounts(waitingData || []);
        
        let inProgressWithCount = null;
        if (inProgressData) {
            const res = await fetchUnreadCounts([inProgressData]);
            inProgressWithCount = res[0];
        }

        let upNextWithCount = null;
        if (finalUpNext) {
            const res = await fetchUnreadCounts([finalUpNext]);
            upNextWithCount = res[0];
        }

        // 6. Return compiled response
        res.json({ 
            waiting: waitingWithCounts, 
            inProgress: inProgressWithCount, 
            upNext: upNextWithCount,
            nextAppointment: nextAppt 
        });

    } catch (error) {
        console.error('Error fetching detailed queue:', error.message);
        res.status(500).json({ error: 'Failed to fetch detailed queue' });
    }
}

/**
 * ENDPOINT 4 (v5 - RPC - ATOMIC): Call next customer
 * This is now much simpler and safer. It only does two things:
 * 1. Calls the RPC to move the target customer to "In Progress".
 * 2. Calls the NEW atomic RPC to promote the next waiting customer.
 */
exports.next = async (req, res) => {
    const { queue_id, barber_id } = req.body;
    const barberIdInt = parseInt(barber_id);
    const queueIdInt = parseInt(queue_id);
    console.log(`[RPC v5] /api/queue/next - Barber ${barberIdInt} calling ${queueIdInt}`);

    if (isNaN(queueIdInt) || isNaN(barberIdInt)) {
        return res.status(400).json({ error: 'Valid Queue ID and Barber ID are required.' });
    }

    try {
        // --- STEP 1: Call the RPC to move customer to "In Progress" ---
        const { data: rpcData, error: rpcError } = await supabase.rpc('call_next_customer', {
            p_barber_id: barberIdInt,
            p_queue_id: queueIdInt
        });

        if (rpcError) {
            console.error('[RPC v5] Database function (call_next_customer) error:', rpcError.message);
            return res.status(409).json({ error: rpcError.message });
        }

        const inProgressCustomer = Array.isArray(rpcData) ? rpcData[0] : rpcData;
        console.log('[RPC v5] Successfully set "In Progress":', inProgressCustomer?.id);

        // --- STEP 2 (THE FIX): Call the new atomic function to fill the slot ---
        const promotedCustomers = await enforceQueueLogic(barberIdInt);
        const newUpNextCustomer = Array.isArray(promotedCustomers) ? promotedCustomers[0] : null;

        // --- STEP 3: Send notifications for the *correct* 'Up Next' customer ---
        if (newUpNextCustomer) {
            console.log(`[Instant] Triggering instant email for Queue #${newUpNextCustomer.id}`);
            processUpNextNotification(newUpNextCustomer).catch(err => {
                console.error("[Instant] Failed instant send (Cron will handle it):", err.message);
            });


            const context = await getNotificationContext(newUpNextCustomer);

            if (newUpNextCustomer.customer_email && process.env.N8N_WEBHOOK_URL && context) {
                // MODIFIED PAYLOAD: Added full_name, serviceName, and duration
                axios.post(process.env.N8N_WEBHOOK_URL, {
                    email: newUpNextCustomer.customer_email,
                    name: newUpNextCustomer.customer_name,
                    barberName: context.barberName,
                    serviceName: context.serviceName,
                    duration: context.duration
                })
                    .catch(webhookError => { console.error("[RPC v5] Error triggering n8n webhook:", webhookError.message); });
            }

            if (newUpNextCustomer.player_id && process.env.ONESIGNAL_APP_ID && process.env.ONESIGNAL_REST_API_KEY) {
                // MODIFIED PUSH MESSAGE: Enhanced content
                const pushHeaders = { "Content-Type": "application/json; charset=utf-8", "Authorization": `Basic ${process.env.ONESIGNAL_REST_API_KEY}` };

                const pushContent = context ?
                    `Hi ${newUpNextCustomer.customer_name}, you're Up Next for the ${context.serviceName} cut with ${context.barberName}. Please head over!` :
                    `Hi ${newUpNextCustomer.customer_name}, it's your turn. Please head over!`;

                const pushData = {
                    app_id: process.env.ONESIGNAL_APP_ID,
                    include_player_ids: [newUpNextCustomer.player_id],
                    headings: { "en": "You're next!" },
                    contents: { "en": pushContent }
                };
                axios.post("https://api.onesignal.com/api/v1/notifications", pushData, { headers: pushHeaders })
                    .catch(pushError => { console.error("[RPC v5] Error sending OneSignal Push:", pushError.response?.data || pushError.message); });
            }
        } else {
            console.log("[RPC v5] auto_fill_up_next_v2 found no one to promote (or slot was full).");
        }

        res.json(inProgressCustomer || { message: "Update successful" });
    } catch (error) {
        console.error("[RPC v5] Overall endpoint error:", error);
        res.status(500).json({ error: "Server error calling next customer." });
    }
}

/**
 * ENDPOINT 4.5 (RPC): Mark queue entry as Cancelled/No-Show
 */
exports.cancel = async (req, res) => {
    const { queue_id, barber_id } = req.body;
    const barberIdInt = parseInt(barber_id);
    const queueIdInt = parseInt(queue_id);
    console.log(`[RPC Cancel] PUT /api/queue/cancel - Barber ${barberIdInt} cancelling ${queueIdInt}`);
    if (isNaN(queueIdInt) || isNaN(barberIdInt)) {
        return res.status(400).json({ error: 'Valid Queue ID and Barber ID are required.' });
    }
    try {
        const { data: nextCustomerData, error } = await supabase.rpc('mark_queue_entry_cancelled', { p_barber_id: barberIdInt, p_queue_id: queueIdInt });
        if (error) { console.error('[RPC Cancel] Database function error:', error.message); return res.status(400).json({ error: error.message }); }
        console.log('[RPC Cancel] Successfully cancelled entry. Next customer data (if any):', nextCustomerData);

        const newUpNextCustomer = Array.isArray(nextCustomerData) ? nextCustomerData[0] : null;
        if (newUpNextCustomer) {
            console.log(`[RPC Cancel] Triggering notifications for new Up Next: ${newUpNextCustomer.id}`);
            if (newUpNextCustomer.customer_email && process.env.N8N_WEBHOOK_URL) {
                axios.post(process.env.N8N_WEBHOOK_URL, { email: newUpNextCustomer.customer_email, name: newUpNextCustomer.customer_name })
                    .catch(err => console.error("[RPC Cancel] Error n8n webhook:", err.message));
            }
            if (newUpNextCustomer.player_id && process.env.ONESIGNAL_APP_ID) {
                axios.post("https://api.onesignal.com/api/v1/notifications", {
                    app_id: process.env.ONESIGNAL_APP_ID,
                    include_player_ids: [newUpNextCustomer.player_id],
                    headings: { "en": "You're next!" },
                    contents: { "en": `Hi ${newUpNextCustomer.customer_name}, it's your turn. Please head over!` },
                }, { headers: { "Authorization": `Basic ${process.env.ONESIGNAL_REST_API_KEY}` } })
                    .catch(err => console.error("[RPC Cancel] Error OneSignal push:", err.message));
            }
        }

        res.json({ message: `Queue entry #${queueIdInt} cancelled.` });
    } catch (error) {
        console.error("[RPC Cancel] Overall endpoint error:", error);
        res.status(500).json({ error: "Server error cancelling queue entry." });
    }
}

/**
 * ENDPOINT 5: Mark a cut as "Done" and log the profit (MODIFIED for VIP)
 */
exports.complete = async (req, res) => {
    const { queue_id, barber_id, tip_amount, vip_charge } = req.body;
    const barberIdInt = parseInt(barber_id);
    const queueIdInt = parseInt(queue_id);
    const tipInt = parseInt(tip_amount) || 0;
    const vipChargeInt = parseInt(vip_charge) || 0;

    if (isNaN(queueIdInt) || isNaN(barberIdInt) || tipInt < 0 || vipChargeInt < 0) {
        return res.status(400).json({ error: 'Queue ID, Barber ID, and valid Tip/VIP amounts required.' });
    }

    try {
        const { data: queueEntry, error: fetchError } = await supabase.from('queue_entries').select('service_id, head_count, services(price_php)').eq('id', queueIdInt).maybeSingle();
        if (fetchError || !queueEntry || !queueEntry.services || queueEntry.services.price_php == null) {
            console.error("Failed to fetch service price for completion:", fetchError, queueEntry);
            return res.status(500).json({ error: 'Failed to find service price for completion.' });
        }
        const servicePrice = parseFloat(queueEntry.services.price_php);
        const headCount = queueEntry.head_count || 1;

        // --- CRITICAL CHANGE: Add the VIP charge to the total profit ---
        const baseTotal = servicePrice * headCount;
        const totalProfit = baseTotal + tipInt + vipChargeInt;

        // 1. UPDATE QUEUE ENTRY: Mark as Done AND save the tip amount
        const { error: updateError } = await supabase
            .from('queue_entries')
            .update({ 
                status: 'Done', 
                tip_amount: tipInt // <--- CRITICAL: SAVES TIP TO HISTORY
            })
            .eq('id', queueIdInt)
            .eq('status', 'In Progress');

        if (updateError) { 
            console.error('Error updating queue status:', updateError.message); 
            return res.status(500).json({ error: updateError.message }); 
        }

        // Log the service with the total profit (Base + Tip + VIP)
        const { data, error: insertError } = await supabase.from('services_completed').insert([{ barber_id: barberIdInt, price: totalProfit, head_count: headCount }]).select();
        if (insertError) { console.error('Error logging service:', insertError.message); return res.status(500).json({ error: insertError.message }); }

        // ============================================================
        // 🎁 LOYALTY POINTS: Award points after service completion
        // ============================================================
        try {
            // Get user_id from the queue entry to award points
            const { data: queueEntryWithUser } = await supabase
                .from('queue_entries')
                .select('user_id')
                .eq('id', queueIdInt)
                .single();

            if (queueEntryWithUser?.user_id) {
                // Call loyalty points API (fire and forget - don't wait)
                const axios = require('axios');
                
                // Get additional data needed for accurate loyalty calculation
                const { data: queueEntryDetails } = await supabase
                    .from('queue_entries')
                    .select('head_count, is_vip')
                    .eq('id', queueIdInt)
                    .single();
                
                const headCount = queueEntryDetails?.head_count || 1;
                const isVip = queueEntryDetails?.is_vip || false;
                const vipCharge = isVip ? vipChargeInt : 0;
                
                axios.post(`${process.env.API_URL || 'http://localhost:3001/api'}/loyalty/earn`, {
                    userId: queueEntryWithUser.user_id,
                    queueEntryId: queueIdInt,
                    servicePrice: servicePrice, // base price per person
                    serviceId: queueEntry?.service_id,
                    headCount: headCount,
                    vipCharge: vipCharge,
                    tipAmount: tipInt
                }).catch(err => console.error('Failed to award loyalty points:', err.message));
            }
        } catch (pointsError) {
            // Don't fail the transaction if points award fails
            console.error('Loyalty points award error (non-blocking):', pointsError.message);
        }
        // ============================================================

        console.log(`[Complete] Successfully logged service for ${queueIdInt}. Checking to auto-fill Up Next...`);
        const promotedCustomers = await enforceQueueLogic(barberIdInt);
        const newUpNextCustomer = Array.isArray(promotedCustomers) ? promotedCustomers[0] : null;
        if (newUpNextCustomer) {
            console.log(`[Auto-fill] Promoted customer ${newUpNextCustomer.id} to Up Next. Triggering notifications.`);
            if (newUpNextCustomer.customer_email && process.env.N8N_WEBHOOK_URL) {
                console.log(`[Auto-fill] Firing n8n email webhook for ${newUpNextCustomer.customer_name}`);
                axios.post(process.env.N8N_WEBHOOK_URL, { email: newUpNextCustomer.customer_email, name: newUpNextCustomer.customer_name })
                    .catch(webhookError => { console.error("[Auto-fill] Error triggering n8n webhook:", webhookError.message); });
            }
            if (newUpNextCustomer.player_id && process.env.ONESIGNAL_APP_ID && process.env.ONESIGNAL_REST_API_KEY) {
                console.log(`[Auto-fill] Sending OneSignal Push to ${newUpNextCustomer.player_id}`);
                const pushHeaders = { "Content-Type": "application/json; charset=utf-8", "Authorization": `Basic ${process.env.ONESIGNAL_REST_API_KEY}` };
                const pushData = { app_id: process.env.ONESIGNAL_APP_ID, include_player_ids: [newUpNextCustomer.player_id], headings: { "en": "You're next!" }, contents: { "en": `Hi ${newUpNextCustomer.customer_name}, it's your turn. Please head over!` } };
                axios.post("https://api.onesignal.com/api/v1/notifications", pushData, { headers: pushHeaders })
                    .catch(pushError => { console.error("[Auto-fill] Error sending OneSignal Push:", pushError.response?.data || pushError.message); });
            }
        }

        console.log('Successfully logged service:', data);
        res.status(200).json(data[0]);
    } catch (error) {
        console.error("Error in /api/queue/complete:", error.message);
        res.status(500).json({ error: "Server error completing cut." });
    }
}

/**
 * ENDPOINT 7 (UPDATED): Get Public Queue View (With "Ghost Slots")
 * Merges Walk-ins and upcoming Appointments into one chronological list.
 */
exports.public_barber = async (req, res) => {
    const { barberId } = req.params;
    const barberIdInt = parseInt(barberId);
    console.log(`GET /api/queue/public/${barberIdInt} - Fetching public queue with Ghost Slots`);

    if (isNaN(barberIdInt)) { return res.status(400).json({ error: 'Invalid Barber ID.' }); }

    try {
        // 1. Fetch Active Queue (Walk-ins)
        const { data: queueData, error: queueError } = await supabase
            .from('queue_entries')
            .select(`
                id, customer_name, status, created_at, updated_at, 
                services(duration_minutes), reference_image_url, 
                is_vip, head_count, is_confirmed,
                user_id, barber_id
            `)
            .eq('barber_id', barberIdInt)
            .in('status', ['Waiting', 'Up Next', 'In Progress'])
            .order('is_vip', { ascending: false })
            .order('created_at', { ascending: true });

        if (queueError) throw queueError;

        // 2. Fetch Today's Appointments (Ghost Slots)
        // We look for confirmed appointments that haven't been converted to queue entries yet.
        const now = new Date();
        const PH_OFFSET = 8 * 60 * 60 * 1000; // 8 Hours in milliseconds
        const nowPH = new Date(now.getTime() + PH_OFFSET);

        // Set start to 00:00:00 PH time
        const todayStart = new Date(nowPH);
        todayStart.setUTCHours(0,0,0,0);
        
        // Set end to 23:59:59 PH time
        const todayEnd = new Date(nowPH);
        todayEnd.setUTCHours(23,59,59,999);

        // Shift back to UTC ISO strings for the database query
        const startIso = new Date(todayStart.getTime() - PH_OFFSET).toISOString();
        const endIso = new Date(todayEnd.getTime() - PH_OFFSET).toISOString();

        const { data: apptData, error: apptError } = await supabase
            .from('appointments')
            .select('id, scheduled_time, customer_name, status')
            .eq('barber_id', barberIdInt)
            .in('status', ['confirmed', 'pending'])
            .eq('is_converted_to_queue', false)
            .gte('scheduled_time', startIso) // Use shifted ISO
            .lte('scheduled_time', endIso);  // Use shifted ISO

        if (apptError) throw apptError;

        // 3. Transform Appointments into "Ghost Objects"
        const ghostSlots = (apptData || []).map(appt => ({
            id: `appt_${appt.id}`, // String ID to distinguish from integer queue IDs
            customer_name: "Reserved Slot", // Mask name for privacy (optional)
            status: 'Reserved',
            created_at: appt.scheduled_time, // Use schedule time for sorting
            is_vip: false,
            is_ghost: true, // Flag for frontend to render differently
            display_time: new Date(appt.scheduled_time).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})
        }));

        // 4. Merge Logic
        // "In Progress" & "Up Next" always stay at the top.
        const active = queueData.filter(q => q.status !== 'Waiting');
        const waiting = queueData.filter(q => q.status === 'Waiting');
        
        // Combine Waiting Walk-ins + Ghost Slots
        const combinedWaiting = [...waiting, ...ghostSlots].sort((a, b) => {
            // 1. Appointments/Reserved slots ALWAYS win if they are "Ghost" (Future) or "Confirmed" (Active)
            const aScore = (a.is_confirmed || a.status === 'Reserved') ? 2 : (a.is_vip ? 1 : 0);
            const bScore = (b.is_confirmed || b.status === 'Reserved') ? 2 : (b.is_vip ? 1 : 0);

            if (aScore > bScore) return -1;
            if (aScore < bScore) return 1;

            // 2. Tie-breaker: Time
            return new Date(a.created_at) - new Date(b.created_at);
        });

        const finalQueue = [...active, ...combinedWaiting];

        res.json(finalQueue);
    } catch (error) {
        console.error('Error fetching public queue:', error.message);
        res.status(500).json({ error: 'Failed to fetch queue information.' });
    }
}

/**
 * ENDPOINT 8 (SECURE): Remove a customer AND auto-promote next
 * (FIXED: Handles Ambiguity & Enforces VIP Logic)
 */
exports.remove = async (req, res) => {
    const { queueId } = req.params;
    const { userId } = req.body || {}; 
    const queueIdInt = parseInt(queueId);

    console.log(`DELETE /api/queue/${queueIdInt} - Request from user ${userId}`);

    if (isNaN(queueIdInt)) return res.status(400).json({ error: 'Invalid Queue ID.' });
    if (!userId) return res.status(401).json({ error: 'Authorization failed.' });

    try {
        // 1. Verify Ownership
        const { data: queueEntry, error: fetchError } = await supabase
            .from('queue_entries')
            .select('user_id, barber_id')
            .eq('id', queueIdInt)
            .in('status', ['Waiting', 'Up Next'])
            .maybeSingle();

        if (fetchError) throw fetchError;
        if (!queueEntry) return res.status(404).json({ message: 'Entry not found or already in progress.' });

        if (queueEntry.user_id !== userId) {
            return res.status(403).json({ error: 'Unauthorized.' });
        }

        // 2. Delete the Entry
        const { error: deleteError } = await supabase
            .from('queue_entries')
            .delete()
            .eq('id', queueIdInt);

        if (deleteError) throw deleteError;

        console.log(`[DELETE] Deleted entry ${queueIdInt}. Enforcing queue logic...`);

        // 3. TRIGGER AUTOMATION (Fill the gap / Promote VIP)
        // This replaces the old "auto_fill" code that had the "ambiguous" error
        const promotedCustomers = await enforceQueueLogic(queueEntry.barber_id);
        const newUpNextCustomer = Array.isArray(promotedCustomers) ? promotedCustomers[0] : null;

        // 4. Send Notifications if someone moved up
        if (newUpNextCustomer) {
            console.log(`[DELETE] Auto-promoted ${newUpNextCustomer.customer_name} to Up Next.`);
            processUpNextNotification(newUpNextCustomer); // Use the helper function
        }

        res.status(200).json({ message: 'Successfully left queue.' });

    } catch (error) {
        console.error('Error removing from queue:', error.message);
        res.status(500).json({ error: 'Failed to remove from queue.' });
    }
}