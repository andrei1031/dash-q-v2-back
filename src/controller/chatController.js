const { createNotificationHelpers } = require('../utils/notifications');
const { supabase } = require("../database/supabase");
const  setupVapid  = require('../config/vapid');
const filter = require('../utils/profanity')
const { isAdmin } = require('../utils/admin');
const webPush = setupVapid()

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
        // We need to figure out who the "other person" is.
        // If Sender == Customer, Notify Barber.
        // If Sender == Barber, Notify Customer.
        
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
                // We need to look up the Barber's *User ID* from their Profile ID
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
                
                // Helper function call (Must be defined in server.js)
                // If you haven't defined it, check Step 4 of the VAPID plan.
                sendPushNotification(recipientId, { 
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
 * FEATURE 2: Admin "Omni-Chat" - Get Active Chats
 * Returns list of active queue entries that have chat history, 
 * including unread message counts for the Admin.
 */
exports.admin_active_chats = async (req, res) => {
    try {
        // 1. Get all active queue entries (Waiting, Up Next, In Progress)
        // We need the user_id to identify which messages are from the customer
        const { data: entries, error } = await supabase
            .from('queue_entries')
            .select(`
                id, 
                customer_name, 
                status, 
                barber_id,
                user_id,
                barber_profiles(full_name),
                profiles(id, role)
            `)
            .in('status', ['Waiting', 'Up Next', 'In Progress'])
            .order('updated_at', { ascending: false });

        if (error) {
            console.error("Error fetching queue entries:", error);
            return res.status(500).json({ error: error.message });
        }

        // If no entries, return empty array
        if (!entries || entries.length === 0) {
            return res.json([]);
        }

        // 2. Filter & Count: Only return entries with messages
        const activeChats = [];
        
        for (const entry of entries) {
            // A. Count TOTAL messages (to see if chat exists)
            const { count: totalCount, error: countError } = await supabase
                .from('chat_messages')
                .select('*', { count: 'exact', head: true })
                .eq('queue_entry_id', entry.id);

            if (countError) {
                console.error(`Error counting messages for queue ${entry.id}`, countError);
                continue;
            }

            // If there are messages, we process this entry
            if (totalCount > 0) {
                // B. Count UNREAD messages for Admin
                // Logic: Count messages sent by the CUSTOMER (entry.user_id) that are NOT read.
                // This ignores messages sent by the Barber or other Admins.
                const { count: unreadCount } = await supabase
                    .from('chat_messages')
                    .select('*', { count: 'exact', head: true })
                    .eq('queue_entry_id', entry.id)
                    .eq('sender_id', entry.user_id) // Only count messages FROM the customer
                    .is('read_at', null);           // That are not read

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
}

/**
 * FEATURE 2: Admin "Omni-Chat" - Send Reply
 * Admin sends a message into a specific queue entry chat.
 * Triggers Push Notification to the Customer.
 */
exports.admin_chats_reply = async (req, res) => {
    const { adminId, queueId, message } = req.body;

    // 1. SECURITY: Verify the user is actually an Admin
    if (!await isAdmin(adminId)) {
        return res.status(403).json({ error: 'Unauthorized: Admin access required.' });
    }

    try {
        // Tagging the message helps the Customer know it's support/admin
        const adminMessage = `[ADMIN]: ${message}`;

        // 2. DATABASE: Insert the message
        const { data, error } = await supabase.from('chat_messages').insert({
            queue_entry_id: parseInt(queueId),
            sender_id: adminId, 
            message: adminMessage,
        }).select().single();

        if (error) throw error;
        
        // 3. NOTIFICATION: Manually trigger Push Notification to Customer
        // (The database insert updates the UI, but this wakes up the phone)
        
        // Fetch the queue entry to find the Customer's User ID
        const { data: entry } = await supabase
            .from('queue_entries')
            .select('user_id')
            .eq('id', queueId)
            .single();

        if (entry && entry.user_id) {
            // Send Push (Ensure sendPushNotification helper is defined in server.js)
            sendPushNotification(entry.user_id, { 
                title: "Support Message", 
                body: message, // Don't include [ADMIN] prefix in push to keep it clean
                url: '/' 
            });
        }

        res.json(data);

    } catch (error) {
        console.error("Admin Reply Error:", error.message);
        res.status(500).json({ error: error.message });
    }
}