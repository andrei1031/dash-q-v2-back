const axios = require("axios");
const { supabase } = require("../database/supabase");
const { createNotificationHelpers } = require("../utils/notifications");
const { createQueueHelpers } = require("../utils/queueLogic");
const setupVapid = require("../config/vapid");
const webPush = setupVapid();

const { getNotificationContext, processUpNextNotification, sendPushNotification } = createNotificationHelpers({ supabase, webPush });
const { enforceQueueLogic } = createQueueHelpers(supabase);

// --- 1. ATTENDANCE CONFIRMATION ---
exports.confirm = async (req, res) => {
    const { queueId } = req.body;
    if (!queueId) return res.status(400).json({ error: 'Queue ID required.' });
    try {
        const { data, error } = await supabase.from('queue_entries').update({ is_confirmed: true }).eq('id', queueId).select().single();
        if (error) throw error;
        res.json({ message: "Attendance confirmed!", data });
    } catch (error) {
        res.status(500).json({ error: 'Server error confirming attendance.' });
    }
}

// --- 2. LOCATION TRACKING (Heartbeat) ---
exports.location = async (req, res) => {
    const { queueId, distance } = req.body;
    if (!queueId || distance === undefined) return res.sendStatus(400);
    try {
        await supabase.from('queue_entries').update({ current_distance_meters: Math.round(distance) }).eq('id', queueId);
        res.sendStatus(200);
    } catch (error) {
        res.sendStatus(500);
    }
}

// --- 3. JOIN QUEUE (With Unified Recovery for Guests/Registered) ---
exports.queue = async (req, res) => {
    const {
        customer_name, customer_phone, barber_id, reference_image_url,
        customer_email, service_id, player_id, user_id, guestId,
        is_vip, head_count = 1, deviceFingerprint
    } = req.body;

    const barberIdInt = parseInt(barber_id);
    const serviceIdInt = parseInt(service_id);

    if (!customer_name || isNaN(barberIdInt) || isNaN(serviceIdInt)) {
        return res.status(400).json({ error: 'Name, Barber ID, and Service ID are required.' });
    }

    // --- RECOVERY CHECK: registered user_id OR guestId ---
    const identifier = user_id || guestId || deviceFingerprint;
    if (identifier) {
        let recoveryQuery = supabase
            .from('queue_entries')
            .select('id, status, barber_id, customer_name, reference_image_url') // ✅ SELECT ALL FOR RECOVERY
            .in('status', ['Waiting', 'Up Next', 'In Progress']);

        if (user_id) {
            recoveryQuery = recoveryQuery.eq('user_id', user_id);
        } else if (guestId) {
            recoveryQuery = recoveryQuery.eq('user_id', guestId); // Guests store ID in user_id field
        } else {
            recoveryQuery = recoveryQuery.eq('device_fingerprint', deviceFingerprint);
        }

        const { data: activeEntry, error: checkError } = await recoveryQuery.maybeSingle();
        if (checkError) return res.status(500).json({ error: 'Server error checking queue status.' });
        if (activeEntry) {
            return res.status(409).json({ error: 'You already have an active booking.', details: activeEntry });
        }
    }

    // --- DUPLICATE NAME CHECK ---
    const { data: duplicateName } = await supabase.from('queue_entries').select('id').eq('customer_name', customer_name).eq('barber_id', barberIdInt).in('status', ['Waiting', 'Up Next', 'In Progress']).limit(1);
    if (duplicateName && duplicateName.length > 0) {
        return res.status(409).json({ error: `Name "${customer_name}" already in queue.` });
    }

    try {
        const { data, error } = await supabase.rpc('join_queue_auto_assign', {
            p_customer_name: customer_name, p_barber_id: barberIdInt, p_service_id: serviceIdInt,
            p_customer_phone: customer_phone || null, p_customer_email: customer_email || null,
            p_reference_image_url: reference_image_url || null, p_player_id: player_id || null,
            p_user_id: identifier || null, p_ai_haircut_image_url: null, p_share_ai_image: false, p_is_vip: !!is_vip
        });

        if (error) return res.status(409).json({ error: error.message });

        let newQueueEntry = Array.isArray(data) ? data[0] : data;
        const now = new Date();
        const apptBuffer = new Date(now.getTime() + 45 * 60 * 1000);

        const { data: upcomingAppt } = await supabase.from('appointments').select('id').eq('barber_id', barberIdInt).eq('status', 'confirmed').eq('is_converted_to_queue', false).gt('scheduled_time', now.toISOString()).lt('scheduled_time', apptBuffer.toISOString()).maybeSingle();
        const { data: currentUpNext } = await supabase.from('queue_entries').select('id, is_vip, status').eq('barber_id', barberIdInt).eq('status', 'Up Next').maybeSingle();

        if (upcomingAppt) {
            if (currentUpNext) await supabase.from('queue_entries').update({ status: 'Waiting', notified_up_next: false }).eq('id', currentUpNext.id);
        } else if (!currentUpNext || (!!is_vip && !currentUpNext.is_vip)) {
            if (currentUpNext) await supabase.from('queue_entries').update({ status: 'Waiting', notified_up_next: false }).eq('id', currentUpNext.id);
            const { data: updated } = await supabase.from('queue_entries').update({ status: 'Up Next' }).eq('id', newQueueEntry.id).select().single();
            if (updated) newQueueEntry = updated;
        }

        if (newQueueEntry && head_count > 1) {
            await supabase.from('queue_entries').update({ head_count: parseInt(head_count) }).eq('id', newQueueEntry.id);
        }

        if (newQueueEntry.status === 'Up Next') {
            processUpNextNotification(newQueueEntry).catch(() => {});
            const context = await getNotificationContext(newQueueEntry);
            if (newQueueEntry.customer_email && process.env.N8N_WEBHOOK_URL && context) {
                axios.post(process.env.N8N_WEBHOOK_URL, { type: 'up_next', email: newQueueEntry.customer_email, name: newQueueEntry.customer_name, barberName: context.barberName, serviceName: context.serviceName, duration: context.duration })
                    .then(() => supabase.from('queue_entries').update({ notified_up_next: true }).eq('id', newQueueEntry.id).then(() => {}))
                    .catch(() => {});
            } else {
                await supabase.from('queue_entries').update({ notified_up_next: true }).eq('id', newQueueEntry.id);
            }
        }
        res.status(201).json(newQueueEntry);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}

// --- 4. PHOTO UPDATE ---
exports.photo = async (req, res) => {
    const { queueId, barberId, referenceImageUrl } = req.body;
    try {
        const { data, error } = await supabase.from('queue_entries').update({ reference_image_url: referenceImageUrl }).eq('id', queueId).eq('barber_id', barberId).select().single();
        if (error) throw error;
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: 'Photo update failed.' });
    }
}

// --- 5. BARBER DASHBOARD DETAILS ---
exports.details = async (req, res) => {
    const { barberId } = req.params;
    const bId = parseInt(barberId);
    try {
        const { data: bProfile } = await supabase.from('barber_profiles').select('user_id').eq('id', bId).single();
        const fetchUnread = async (list) => {
            if (!list || list.length === 0) return list;
            const ids = list.map(e => e.id);
            const { data: msgs } = await supabase.from('chat_messages').select('queue_entry_id').in('queue_entry_id', ids).is('read_at', null).neq('sender_id', bProfile?.user_id);
            return list.map(e => ({ ...e, unread_count: msgs?.filter(m => m.queue_entry_id === e.id).length || 0 }));
        };
        const { data: wait } = await supabase.from('queue_entries').select(`*, services(name, price_php), profiles(id)`).eq('barber_id', bId).eq('status', 'Waiting').order('is_vip', { ascending: false }).order('created_at', { ascending: true });
        const { data: prog } = await supabase.from('queue_entries').select(`*, services(name, price_php), profiles(id)`).eq('barber_id', bId).eq('status', 'In Progress').maybeSingle();
        const { data: next } = await supabase.from('queue_entries').select(`*, services(name, price_php), profiles(id)`).eq('barber_id', bId).eq('status', 'Up Next').maybeSingle();
        const now = new Date().toISOString();
        const { data: appt } = await supabase.from('appointments').select('id, scheduled_time, customer_name, services(name, duration_minutes)').eq('barber_id', bId).eq('status', 'confirmed').gt('scheduled_time', now).order('scheduled_time', { ascending: true }).limit(1).maybeSingle();
        
        res.json({ waiting: await fetchUnread(wait || []), inProgress: prog ? (await fetchUnread([prog]))[0] : null, upNext: next ? (await fetchUnread([next]))[0] : null, nextAppointment: appt });
    } catch (error) {
        res.status(500).json({ error: 'Details fetch failed.' });
    }
}

// --- 6. CALL NEXT ---
exports.next = async (req, res) => {
    const { queue_id, barber_id } = req.body;
    try {
        const { data: rpcData, error } = await supabase.rpc('call_next_customer', { p_barber_id: barber_id, p_queue_id: queue_id });
        if (error) return res.status(409).json({ error: error.message });
        const promoted = await enforceQueueLogic(barber_id);
        const newUpNext = Array.isArray(promoted) ? promoted[0] : null;
        if (newUpNext) {
            processUpNextNotification(newUpNext).catch(() => {});
            const ctx = await getNotificationContext(newUpNext);
            if (newUpNext.customer_email && process.env.N8N_WEBHOOK_URL && ctx) {
                axios.post(process.env.N8N_WEBHOOK_URL, { email: newUpNext.customer_email, name: newUpNext.customer_name, barberName: ctx.barberName, serviceName: ctx.serviceName, duration: ctx.duration }).catch(() => {});
            }
        }
        res.json(rpcData);
    } catch (error) {
        res.status(500).json({ error: 'Call next failed.' });
    }
}

// --- 7. CANCEL / NO-SHOW ---
exports.cancel = async (req, res) => {
    const { queue_id, barber_id } = req.body;
    try {
        const { data, error } = await supabase.rpc('mark_queue_entry_cancelled', { p_barber_id: barber_id, p_queue_id: queue_id });
        if (error) throw error;
        const newNext = Array.isArray(data) ? data[0] : null;
        if (newNext) {
            processUpNextNotification(newNext).catch(() => {});
            if (newNext.customer_email && process.env.N8N_WEBHOOK_URL) axios.post(process.env.N8N_WEBHOOK_URL, { email: newNext.customer_email, name: newNext.customer_name }).catch(() => {});
        }
        res.json({ message: "Cancelled." });
    } catch (error) {
        res.status(500).json({ error: 'Cancel failed.' });
    }
}

// --- 8. COMPLETE HAIRCUT ---
exports.complete = async (req, res) => {
    const { queue_id, barber_id, tip_amount, vip_charge } = req.body;
    try {
        const { data: qe } = await supabase.from('queue_entries').select('service_id, head_count, services(price_php), user_id, is_vip').eq('id', queue_id).single();
        const total = (parseFloat(qe.services.price_php) * qe.head_count) + (parseInt(tip_amount) || 0) + (parseInt(vip_charge) || 0);
        await supabase.from('queue_entries').update({ status: 'Done', tip_amount, vip_charge }).eq('id', queue_id);
        await supabase.from('services_completed').insert([{ barber_id, price: total, head_count: qe.head_count }]);
        
        // Loyalty
        if (qe.user_id) {
            const loyalty = require('./loyaltyController');
            loyalty.earnPointsOnService({ body: { userId: qe.user_id, queueEntryId: queue_id, servicePrice: qe.services.price_php, headCount: qe.head_count, vipCharge: qe.is_vip ? vip_charge : 0, tipAmount: tip_amount } }, { json: () => {}, status: () => ({ json: () => {} }) });
        }

        const promoted = await enforceQueueLogic(barber_id);
        const newUpNext = Array.isArray(promoted) ? promoted[0] : null;
        if (newUpNext) {
            processUpNextNotification(newUpNext).catch(() => {});
            if (newUpNext.customer_email && process.env.N8N_WEBHOOK_URL) axios.post(process.env.N8N_WEBHOOK_URL, { email: newUpNext.customer_email, name: newUpNext.customer_name }).catch(() => {});
        }
        res.json({ message: "Done." });
    } catch (error) {
        res.status(500).json({ error: 'Complete failed.' });
    }
}

// --- 9. PUBLIC BARBER VIEW ---
exports.public_barber = async (req, res) => {
    const { barberId } = req.params;
    try {
        const { data: q } = await supabase.from('queue_entries').select(`id, customer_name, status, created_at, is_vip, head_count, is_confirmed`).eq('barber_id', barberId).in('status', ['Waiting', 'Up Next', 'In Progress']).order('is_vip', { ascending: false }).order('created_at', { ascending: true });
        const { data: a } = await supabase.from('appointments').select('id, scheduled_time, customer_name').eq('barber_id', barberId).eq('status', 'confirmed').eq('is_converted_to_queue', false);
        const ghosts = (a || []).map(appt => ({ id: `appt_${appt.id}`, customer_name: "Reserved", status: 'Reserved', created_at: appt.scheduled_time, is_ghost: true }));
        const active = q.filter(x => x.status !== 'Waiting');
        const waiting = q.filter(x => x.status === 'Waiting');
        const sortedWaiting = [...waiting, ...ghosts].sort((n1, n2) => (n1.is_confirmed ? -1 : 1) - (n2.is_confirmed ? -1 : 1) || new Date(n1.created_at) - new Date(n2.created_at));
        res.json([...active, ...sortedWaiting]);
    } catch (error) {
        res.status(500).json({ error: 'Public view failed.' });
    }
}

// --- 10. LEAVE QUEUE (Self-Remove) ---
exports.remove = async (req, res) => {
    const { queueId } = req.params;
    const { userId } = req.body; // guestId or user_id
    try {
        // Find entry and check ownership
        const { data: entry } = await supabase.from('queue_entries').select('user_id, barber_id').eq('id', queueId).single();
        if (!entry || entry.user_id !== userId) return res.status(403).json({ error: 'Unauthorized.' });

        await supabase.from('queue_entries').delete().eq('id', queueId);
        
        // Promote next person automatically
        const promoted = await enforceQueueLogic(entry.barber_id);
        const newUpNext = Array.isArray(promoted) ? promoted[0] : null;
        if (newUpNext) processUpNextNotification(newUpNext).catch(() => {});

        res.json({ message: "Left queue." });
    } catch (error) {
        res.status(500).json({ error: 'Remove failed.' });
    }
}