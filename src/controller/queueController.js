const axios = require("axios");
const { supabase } = require("../database/supabase");
const { createNotificationHelpers } = require("../utils/notifications");
const { createQueueHelpers } = require("../utils/queueLogic");
const setupVapid = require("../config/vapid");
const webPush = setupVapid();

const { getNotificationContext, processUpNextNotification, sendPushNotification } = createNotificationHelpers({ supabase, webPush });
const { enforceQueueLogic } = createQueueHelpers(supabase);

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

exports.location = async (req, res) => {
    const { queueId, distance } = req.body;

    if (!queueId || distance === undefined) return res.sendStatus(400);

    try {
        await supabase
            .from('queue_entries')
            .update({ current_distance_meters: Math.round(distance) })
            .eq('id', queueId);

        res.sendStatus(200);
    } catch (error) {
        console.error("Loc update failed:", error.message);
        res.sendStatus(500);
    }
}

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

    const { data: duplicateName, error: dupError } = await supabase
        .from('queue_entries')
        .select('id')
        .eq('customer_name', customer_name)
        .eq('barber_id', barberIdInt)
        .in('status', ['Waiting', 'Up Next', 'In Progress'])
        .limit(1);

    if (dupError) {
        console.error('Duplicate name check error:', dupError);
    } else if (duplicateName && duplicateName.length > 0) {
        return res.status(409).json({ 
            error: `Name "${customer_name}" already in ${barberIdInt}'s active queue. Please use a different name.` 
        });
    }

    try {
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

        const now = new Date();
        const appointmentBuffer = new Date(now.getTime() + 45 * 60 * 1000);

        const { data: upcomingAppt } = await supabase
            .from('appointments')
            .select('id, scheduled_time')
            .eq('barber_id', barberIdInt)
            .eq('status', 'confirmed')
            .eq('is_converted_to_queue', false)
            .gt('scheduled_time', now.toISOString())
            .lt('scheduled_time', appointmentBuffer.toISOString())
            .maybeSingle();

        const { data: currentUpNext } = await supabase
            .from('queue_entries')
            .select('id, is_vip, customer_name, status')
            .eq('barber_id', barberIdInt)
            .eq('status', 'Up Next')
            .maybeSingle();

        if (upcomingAppt) {
            console.log(`[Priority] Upcoming Appointment found. Blocking Up Next slot.`);
            if (currentUpNext) {
                await supabase
                    .from('queue_entries')
                    .update({ status: 'Waiting', notified_up_next: false })
                    .eq('id', currentUpNext.id);
            }
        } 
        else {
            if (!currentUpNext) {
                const { data: updated } = await supabase.from('queue_entries').update({ status: 'Up Next' }).eq('id', newQueueEntry.id).select().single();
                if (updated) newQueueEntry = updated;
            } 
            else {
                if (!!is_vip && !currentUpNext.is_vip) {
                    await supabase.from('queue_entries').update({ status: 'Waiting', notified_up_next: false }).eq('id', currentUpNext.id);
                    const { data: updated } = await supabase.from('queue_entries').update({ status: 'Up Next' }).eq('id', newQueueEntry.id).select().single();
                    if (updated) newQueueEntry = updated;
                }
            }
        }

        if (newQueueEntry && head_count > 1) {
            await supabase.from('queue_entries').update({ head_count: parseInt(head_count) }).eq('id', newQueueEntry.id);
            newQueueEntry.head_count = parseInt(head_count);
        }

        if (newQueueEntry.status === 'Up Next') {
            console.log(`[RPC Join] Triggering double notifications for ${newQueueEntry.customer_name}...`);
            
            processUpNextNotification(newQueueEntry).catch(err => console.error("Web Push failed:", err.message));

            const context = await getNotificationContext(newQueueEntry);
            if (newQueueEntry.customer_email && process.env.N8N_WEBHOOK_URL && context) {
                axios.post(process.env.N8N_WEBHOOK_URL, {
                    type: 'up_next',
                    email: newQueueEntry.customer_email,
                    name: newQueueEntry.customer_name,
                    barberName: context.barberName,
                    serviceName: context.serviceName,
                    duration: context.duration
                })
                .then(async () => {
                    await supabase.from('queue_entries').update({ notified_up_next: true }).eq('id', newQueueEntry.id);
                })
                .catch(err => console.error("Email Webhook failed:", err.message));
            } else {
                 await supabase.from('queue_entries').update({ notified_up_next: true }).eq('id', newQueueEntry.id);
            }
        }

        res.status(201).json(newQueueEntry);

    } catch (error) {
        console.error('Error in POST /api/queue:', error.message);
        res.status(500).json({ error: `Failed to add to queue: ${error.message}` });
    }
}

exports.photo = async (req, res) => {
    const { queueId, barberId, referenceImageUrl } = req.body;
    const queueIdInt = parseInt(queueId);
    const barberIdInt = parseInt(barberId);

    if (isNaN(queueIdInt) || isNaN(barberIdInt) || !referenceImageUrl) {
        return res.status(400).json({ error: 'Valid Queue ID, Barber ID, and Image URL are required.' });
    }

    try {
        const { data: entry, error: fetchError } = await supabase.from('queue_entries')
            .select('status, barber_id')
            .eq('id', queueIdInt)
            .eq('barber_id', barberIdInt)
            .maybeSingle();

        if (fetchError) throw fetchError;
        if (!entry) return res.status(404).json({ error: 'Queue entry not found or invalid barber ID.' });
        if (entry.status !== 'Waiting' && entry.status !== 'Up Next') {
            return res.status(403).json({ error: `Photo status forbidden.` });
        }

        const { data, error: updateError } = await supabase.from('queue_entries')
            .update({ reference_image_url: referenceImageUrl })
            .eq('id', queueIdInt)
            .select('id, reference_image_url')
            .single();

        if (updateError) throw updateError;
        res.status(200).json(data);
    } catch (error) {
        console.error('Error updating photo:', error.message);
        res.status(500).json({ error: 'Server error updating photo.' });
    }
}

exports.details = async (req, res) => {
    const { barberId } = req.params;
    const barberIdInt = parseInt(barberId);

    if (isNaN(barberIdInt)) return res.status(400).json({ error: "Invalid Barber ID" });

    try {
        const { data: bProfile } = await supabase
            .from('barber_profiles')
            .select('user_id')
            .eq('id', barberIdInt)
            .maybeSingle();

        const barberUserId = bProfile?.user_id;

        const fetchUnreadCounts = async (entries) => {
            if (!entries || entries.length === 0) return entries;
            const entryIds = entries.map(e => e.id);
            let query = supabase.from('chat_messages').select('queue_entry_id, sender_id').in('queue_entry_id', entryIds).is('read_at', null);
            if (barberUserId) query = query.neq('sender_id', barberUserId);

            const { data: unreadMsgs, error } = await query;
            if (error) return entries;

            return entries.map(e => {
                const count = unreadMsgs.filter(m => m.queue_entry_id === e.id).length;
                return { ...e, unread_count: count };
            });
        };

        const { data: waitingData } = await supabase.from('queue_entries').select(`*, services(name, price_php), profiles(id), is_vip`).eq('barber_id', barberIdInt).eq('status', 'Waiting').order('is_vip', { ascending: false }).order('created_at', { ascending: true });
        const { data: inProgressData } = await supabase.from('queue_entries').select(`*, services(name, price_php), profiles(id), is_vip`).eq('barber_id', barberIdInt).eq('status', 'In Progress').limit(1).maybeSingle();
        const { data: upNextListData } = await supabase.from('queue_entries').select(`*, services(name, price_php), profiles(id), is_vip`).eq('barber_id', barberIdInt).eq('status', 'Up Next').limit(1);
        
        const finalUpNext = (upNextListData && upNextListData.length > 0) ? upNextListData[0] : null;

        const now = new Date().toISOString();
        const { data: nextAppt } = await supabase.from('appointments').select('id, scheduled_time, customer_name, services(name, duration_minutes)').eq('barber_id', barberIdInt).eq('status', 'confirmed').eq('is_converted_to_queue', false).gt('scheduled_time', now).order('scheduled_time', { ascending: true }).limit(1).maybeSingle();

        const waitingWithCounts = await fetchUnreadCounts(waitingData || []);
        let inProgressWithCount = inProgressData ? (await fetchUnreadCounts([inProgressData]))[0] : null;
        let upNextWithCount = finalUpNext ? (await fetchUnreadCounts([finalUpNext]))[0] : null;

        res.json({ waiting: waitingWithCounts, inProgress: inProgressWithCount, upNext: upNextWithCount, nextAppointment: nextAppt });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch detailed queue' });
    }
}

exports.next = async (req, res) => {
    const { queue_id, barber_id } = req.body;
    const barberIdInt = parseInt(barber_id);
    const queueIdInt = parseInt(queue_id);

    if (isNaN(queueIdInt) || isNaN(barberIdInt)) return res.status(400).json({ error: 'ID required.' });

    try {
        const { data: rpcData, error: rpcError } = await supabase.rpc('call_next_customer', { p_barber_id: barberIdInt, p_queue_id: queueIdInt });
        if (rpcError) return res.status(409).json({ error: rpcError.message });

        const inProgressCustomer = Array.isArray(rpcData) ? rpcData[0] : rpcData;
        const promotedCustomers = await enforceQueueLogic(barberIdInt);
        const newUpNextCustomer = Array.isArray(promotedCustomers) ? promotedCustomers[0] : null;

        if (newUpNextCustomer) {
            console.log(`[Instant] Triggering double notifications for Queue #${newUpNextCustomer.id}`);
            
            processUpNextNotification(newUpNextCustomer).catch(err => console.error("Web Push failed:", err.message));

            const context = await getNotificationContext(newUpNextCustomer);
            if (newUpNextCustomer.customer_email && process.env.N8N_WEBHOOK_URL && context) {
                axios.post(process.env.N8N_WEBHOOK_URL, {
                    email: newUpNextCustomer.customer_email,
                    name: newUpNextCustomer.customer_name,
                    barberName: context.barberName,
                    serviceName: context.serviceName,
                    duration: context.duration
                }).catch(err => console.error("Email Webhook failed:", err.message));
            }
        }
        res.json(inProgressCustomer || { message: "Update successful" });
    } catch (error) {
        res.status(500).json({ error: "Server error calling next." });
    }
}

exports.cancel = async (req, res) => {
    const { queue_id, barber_id } = req.body;
    const barberIdInt = parseInt(barber_id);
    const queueIdInt = parseInt(queue_id);

    if (isNaN(queueIdInt) || isNaN(barberIdInt)) return res.status(400).json({ error: 'IDs required.' });

    try {
        const { data: nextCustomerData, error } = await supabase.rpc('mark_queue_entry_cancelled', { p_barber_id: barberIdInt, p_queue_id: queueIdInt });
        if (error) return res.status(400).json({ error: error.message });

        const newUpNextCustomer = Array.isArray(nextCustomerData) ? nextCustomerData[0] : null;
        if (newUpNextCustomer) {
            processUpNextNotification(newUpNextCustomer).catch(err => console.error("Web Push failed:", err.message));

            if (newUpNextCustomer.customer_email && process.env.N8N_WEBHOOK_URL) {
                axios.post(process.env.N8N_WEBHOOK_URL, { email: newUpNextCustomer.customer_email, name: newUpNextCustomer.customer_name })
                    .catch(err => console.error("Email Webhook failed:", err.message));
            }
        }
        res.json({ message: `Cancelled #${queueIdInt}.` });
    } catch (error) {
        res.status(500).json({ error: "Server error cancelling." });
    }
}

exports.complete = async (req, res) => {
    const { queue_id, barber_id, tip_amount, vip_charge } = req.body;
    const barberIdInt = parseInt(barber_id);
    const queueIdInt = parseInt(queue_id);
    const tipInt = parseInt(tip_amount) || 0;
    const vipChargeInt = parseInt(vip_charge) || 0;

    if (isNaN(queueIdInt) || isNaN(barberIdInt)) return res.status(400).json({ error: 'IDs required.' });

    try {
        const { data: queueEntry } = await supabase.from('queue_entries').select('service_id, head_count, services(price_php)').eq('id', queueIdInt).maybeSingle();
        const servicePrice = parseFloat(queueEntry.services.price_php);
        const headCount = queueEntry.head_count || 1;
        const totalProfit = (servicePrice * headCount) + tipInt + vipChargeInt;

        await supabase.from('queue_entries').update({ status: 'Done', tip_amount: tipInt, vip_charge: vipChargeInt }).eq('id', queueIdInt).eq('status', 'In Progress');
        const { data } = await supabase.from('services_completed').insert([{ barber_id: barberIdInt, price: totalProfit, head_count: headCount }]).select();

        try {
            const { data: qeUser } = await supabase.from('queue_entries').select('user_id, head_count, is_vip').eq('id', queueIdInt).single();
            if (qeUser?.user_id) {
                const loyaltyController = require('./loyaltyController');
                const mockReq = { body: { userId: qeUser.user_id, queueEntryId: queueIdInt, servicePrice, serviceId: queueEntry?.service_id, headCount: qeUser.head_count, vipCharge: qeUser.is_vip ? vipChargeInt : 0, tipAmount: tipInt } };
                const mockRes = { json: () => {}, status: () => ({ json: () => {} }) };
                loyaltyController.earnPointsOnService(mockReq, mockRes);
            }
        } catch (e) {}

        const promotedCustomers = await enforceQueueLogic(barberIdInt);
        const newUpNextCustomer = Array.isArray(promotedCustomers) ? promotedCustomers[0] : null;
        if (newUpNextCustomer) {
            processUpNextNotification(newUpNextCustomer).catch(err => console.error("Web Push failed:", err.message));
            if (newUpNextCustomer.customer_email && process.env.N8N_WEBHOOK_URL) {
                axios.post(process.env.N8N_WEBHOOK_URL, { email: newUpNextCustomer.customer_email, name: newUpNextCustomer.customer_name })
                    .catch(err => console.error("Email Webhook failed:", err.message));
            }
        }
        res.status(200).json(data[0]);
    } catch (error) {
        res.status(500).json({ error: "Server error completing." });
    }
}

exports.public_barber = async (req, res) => {
    const { barberId } = req.params;
    const barberIdInt = parseInt(barberId);
    if (isNaN(barberIdInt)) return res.status(400).json({ error: 'Invalid ID.' });

    try {
        const { data: queueData } = await supabase.from('queue_entries').select(`id, customer_name, status, created_at, updated_at, services(duration_minutes), reference_image_url, is_vip, head_count, is_confirmed, user_id, barber_id`).eq('barber_id', barberIdInt).in('status', ['Waiting', 'Up Next', 'In Progress']).order('is_vip', { ascending: false }).order('created_at', { ascending: true });

        const now = new Date();
        const PH_OFFSET = 8 * 60 * 60 * 1000;
        const nowPH = new Date(now.getTime() + PH_OFFSET);
        const todayStart = new Date(nowPH); todayStart.setUTCHours(0,0,0,0);
        const todayEnd = new Date(nowPH); todayEnd.setUTCHours(23,59,59,999);
        const startIso = new Date(todayStart.getTime() - PH_OFFSET).toISOString();
        const endIso = new Date(todayEnd.getTime() - PH_OFFSET).toISOString();

        const { data: apptData } = await supabase.from('appointments').select('id, scheduled_time, customer_name, status').eq('barber_id', barberIdInt).in('status', ['confirmed', 'pending']).eq('is_converted_to_queue', false).gte('scheduled_time', startIso).lte('scheduled_time', endIso);

        const ghostSlots = (apptData || []).map(appt => ({
            id: `appt_${appt.id}`,
            customer_name: "Reserved Slot",
            status: 'Reserved',
            created_at: appt.scheduled_time,
            is_vip: false,
            is_ghost: true,
            display_time: new Date(appt.scheduled_time).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})
        }));

        const active = queueData.filter(q => q.status !== 'Waiting');
        const waiting = queueData.filter(q => q.status === 'Waiting');
        const combinedWaiting = [...waiting, ...ghostSlots].sort((a, b) => {
            const aScore = (a.is_confirmed || a.status === 'Reserved') ? 2 : (a.is_vip ? 1 : 0);
            const bScore = (b.is_confirmed || b.status === 'Reserved') ? 2 : (b.is_vip ? 1 : 0);
            if (aScore !== bScore) return bScore - aScore;
            return new Date(a.created_at) - new Date(b.created_at);
        });

        res.json([...active, ...combinedWaiting]);
    } catch (error) {
        res.status(500).json({ error: 'Failed info.' });
    }
}

exports.remove = async (req, res) => {
    const { queueId } = req.params;
    const { userId } = req.body || {}; 
    const queueIdInt = parseInt(queueId);

    if (isNaN(queueIdInt) || !userId) return res.status(400).json({ error: 'Auth failed.' });

    try {
        const { data: queueEntry } = await supabase.from('queue_entries').select('user_id, barber_id').eq('id', queueIdInt).in('status', ['Waiting', 'Up Next']).maybeSingle();
        if (!queueEntry || queueEntry.user_id !== userId) return res.status(403).json({ error: 'Unauthorized.' });

        await supabase.from('queue_entries').delete().eq('id', queueIdInt);
        const promotedCustomers = await enforceQueueLogic(queueEntry.barber_id);
        const newUpNextCustomer = Array.isArray(promotedCustomers) ? promotedCustomers[0] : null;

        if (newUpNextCustomer) {
            processUpNextNotification(newUpNextCustomer).catch(err => console.error("Web Push failed:", err.message));
        }
        res.status(200).json({ message: 'Left queue.' });
    } catch (error) {
        res.status(500).json({ error: 'Failed remove.' });
    }
}