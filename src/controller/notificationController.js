const { createNotificationHelpers } = require('../utils/notifications');
const { supabase } = require('../database/supabase');
const  setupVapid  = require('../config/vapid');
const webPush = setupVapid()
const axios = require('axios');

const { sendPushNotification } = createNotificationHelpers({ supabase, webPush });

/**
 * TEST ENDPOINT: Manually trigger a push notification
 * Usage: POST /api/test/push-manual { "userId": "user-uuid-here", "message": "Hello World" }
 */
exports.push_manual = async (req, res) => {
    const { userId, message } = req.body;
    
    if (!userId) return res.status(400).json({ error: 'User ID is required' });

    try {
        await sendPushNotification(userId, {
            title: "Test Notification",
            body: message || "This is a test from Postman/Console!",
            url: "/"
        });
        res.json({ success: true, message: `Sent to ${userId}` });
    } catch (error) {
        console.error("Test Push Error:", error);
        res.status(500).json({ error: error.message });
    }
};
/**
 * ENDPOINT: Subscribe to Push Notifications
 * Saves the browser's subscription object to the user's profile or a separate table.
 */
exports.subscribe = async (req, res) => {
    const { subscription, userId } = req.body;

    if (!subscription || !userId) return res.status(400).json({ error: 'Missing fields' });

    try {
        // Save subscription to DB. 
        // NOTE: You need a 'push_subscription' column (jsonb) in your 'profiles' table!
        const { error } = await supabase
            .from('profiles')
            .update({ push_subscription: subscription })
            .eq('id', userId);

        if (error) throw error;

        res.status(201).json({ message: 'Subscribed to push notifications!' });
    } catch (error) {
        console.error("Subscription error:", error);
        res.status(500).json({ error: 'Failed to save subscription' });
    }
};

/**
 * ENDPOINT: Test Push Notification
 * Call this via Postman: POST /api/test/push { "playerId": "your-uuid-here" }
 */
exports.push = async (req, res) => {
    const { playerId } = req.body;
    if (!playerId) return res.status(400).json({ error: "Player ID required" });

    const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID;
    const ONESIGNAL_REST_API_KEY = process.env.ONESIGNAL_REST_API_KEY;

    try {
        const pushData = {
            app_id: ONESIGNAL_APP_ID,
            include_player_ids: [playerId],
            headings: { "en": "Dash-Q Test" },
            contents: { "en": "This is a test notification from your backend!" }
        };

        const response = await axios.post("https://api.onesignal.com/api/v1/notifications", pushData, {
            headers: {
                "Content-Type": "application/json; charset=utf-8",
                "Authorization": `Basic ${ONESIGNAL_REST_API_KEY}`
            }
        });

        res.json({ message: "Sent!", data: response.data });
    } catch (error) {
        console.error("OneSignal Test Failed:", error.response?.data || error.message);
        res.status(500).json({ error: error.message });
    }
}
