const { createNotificationHelpers } = require('../utils/notifications');
const { supabase } = require("../database/supabase");
const setupVapid = require('../config/vapid');
const filter = require('../utils/profanity');
const { isAdmin } = require('../utils/admin');

// Initialize webPush via your VAPID config
const webPush = setupVapid();

// Initialize the push notification helper
const { sendPushNotification } = createNotificationHelpers({ supabase, webPush });

/**
 * ENDPOINT: Send Chat Message & Trigger Push Notification
 * Handles profanity filtering, DB insertion, and Push Alerts.
 */
exports.send = async (req, res) => {
    const { senderId, queueId, message } = req.body;

    if (!senderId || !queueId || !message) {
        return res.status(400).json({ error: 'Missing required fields.' });
    }

    // 1. Filter Profanity
    if (filter.isProfane(message)) {
        console.log(`[Chat] Profane message from ${senderId} BLOCKED.`);
        return res.status(400).json({ error: 'Message contains inappropriate language.' });
    }

    try {
        // 2. Log to Database
        const { data, error } = await supabase.from('chat_messages').insert({
            queue_entry_id: parseInt(queueId),
            sender_id: senderId,
            message: message,
        }).select().single();

        if (error) throw error;

        // 3. TRIGGER PUSH NOTIFICATION
        // A. Fetch Queue Entry to get Customer ID and Barber ID
        const { data: entry } = await supabase
            .from('queue_entries')
            .select('user_id, barber_id')
            .eq('id', queueId)
            .single();

        if (entry) {
            let recipientId = null;

            // B. Determine Recipient
            if (senderId === entry.user_id) {
                // Sender is Customer -> Notify Barber
                // Look up the Barber's User ID from their Barber Profile ID
                const { data: barber } = await supabase
                    .from('barber_profiles')
                    .select('user_id')
                    .eq('id', entry.barber_id)
                    .single();
                
                recipientId = barber?.user_id;
            } else {
                // Sender is Barber (or Admin) -> Notify Customer
                recipientId = entry.user_id;
            }

            // C. Send Notification if Recipient Found
            if (recipientId) {
                const title = "New Message";
                // Truncate long messages for the notification body
                const body = message.length > 40 ? message.substring(0, 40) + '...' : message;
                
                // FIX: Added 'await' to ensure the push process completes
                await sendPushNotification(recipientId, { 
                    title: title, 
                    body: body, 
                    url: '/' // Clicking opens the app
                });
            }
        }

        res.status(200).json(data);

    } catch (error) {
        console.error("Chat send error:", error.message);
        res.status(500).json({ error: 'Failed to send message.' });
    }
};

/**
 * ENDPOINT: Mark messages as READ
 */
exports.read = async (req, res) => {
    const { queueId, readerId } = req.body; // readerId is the person opening the chat

    if (!queueId || !readerId) return res.status(400).json({ error: "Missing fields" });

    try {
        // Mark all messages in this queue NOT sent by the reader as read
        const { error } = await supabase
            .from('chat_messages')
            .update({ read_at: new Date().toISOString() })
            .eq('queue_entry_id', queueId)
            .neq('sender_id', readerId) // Don't mark my own messages as read by me
            .is('read_at', null);

        if (error) throw error;
        res.json({ success: true });
    } catch (error) {
        console.error("Error marking read:", error);
        res.status(500).json({ error: error.message });
    }
};

/**
 * FEATURE: Admin "Omni-Chat" - Get Active Chats
 * Returns list of active queue entries that have chat history, 
 * including unread message counts for the Admin.
 */
exports.admin_active_chats = async (req, res) => {
    try {
        // 1. Get all active queue entries
        const { data: entries, error } = await supabase
            .from('queue_entries')
            .select(`
                id, 
                customer_name, 
                status, 
                barber_id,
                user_id,
                barber_profiles(full_name)
            `)
            .in('status', ['Waiting', 'Up Next', 'In Progress'])
            .order('updated_at', { ascending: false });

        if (error) {
            console.error("Error fetching queue entries:", error);
            return res.status(500).json({ error: error.message });
        }

        if (!entries || entries.length === 0) {
            return res.json([]);
        }

        const activeChats = [];
        
        for (const entry of entries) {
            // Count TOTAL messages to see if chat exists
            const { count: totalCount, error: countError } = await supabase
                .from('chat_messages')
                .select('*', { count: 'exact', head: true })
                .eq('queue_entry_id', entry.id);

            if (countError) continue;

            if (totalCount > 0) {
                // Count UNREAD messages sent BY THE CUSTOMER for the Admin to see
                const { count: unreadCount } = await supabase
                    .from('chat_messages')
                    .select('*', { count: 'exact', head: true })
                    .eq('queue_entry_id', entry.id)
                    .eq('sender_id', entry.user_id) 
                    .is('read_at', null);

                activeChats.push({ 
                    ...entry, 
                    message_count: totalCount, 
                    unread_count: unreadCount || 0 
                });
            }
        }

        res.json(activeChats);

    } catch (error) {
        console.error("Admin Chats Error:", error);
        res.status(500).json({ error: error.message, activeChats: [] });
    }
};

/**
 * FEATURE: Admin "Omni-Chat" - Send Reply
 * Admin sends a message into a specific queue entry chat.
 */
exports.admin_chats_reply = async (req, res) => {
    const { adminId, queueId, message } = req.body;

    // 1. SECURITY: Verify the user is actually an Admin
    if (!await isAdmin(adminId)) {
        return res.status(403).json({ error: 'Unauthorized: Admin access required.' });
    }

    try {
        const adminMessage = `[ADMIN]: ${message}`;

        // 2. DATABASE: Insert the message
        const { data, error } = await supabase.from('chat_messages').insert({
            queue_entry_id: parseInt(queueId),
            sender_id: adminId, 
            message: adminMessage,
        }).select().single();

        if (error) throw error;
        
        // 3. NOTIFICATION: Fetch customer ID and trigger Push
        const { data: entry } = await supabase
            .from('queue_entries')
            .select('user_id')
            .eq('id', queueId)
            .single();

        if (entry && entry.user_id) {
            // FIX: Added 'await' for reliability
            await sendPushNotification(entry.user_id, { 
                title: "Support Message", 
                body: message, 
                url: '/' 
            });
        }

        res.json(data);

    } catch (error) {
        console.error("Admin Reply Error:", error.message);
        res.status(500).json({ error: error.message });
    }
};