const webPush = require('web-push');

webPush.setVapidDetails(
    'mailto:your-email@example.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
);

exports.sendPushNotification = async (subscription, payload) => {
    try {
        await webPush.sendNotification(subscription, JSON.stringify(payload));
        return { success: true };
    } catch (err) {
        console.error("Error sending push:", err);
        return { success: false, error: err };
    }
};

const createNotificationHelpers = ({ supabase, webPush }) => {

    const getNotificationContext = async (queueEntry) => {
        if (!queueEntry?.barber_id || !queueEntry?.service_id) return null;

        try {
        const [barberResponse, serviceResponse] = await Promise.all([
            supabase
            .from('barber_profiles')
            .select('full_name')
            .eq('id', queueEntry.barber_id)
            .single(),
            supabase
            .from('services')
            .select('name, duration_minutes')
            .eq('id', queueEntry.service_id)
            .single(),
        ]);

        return {
            barberName: barberResponse.data?.full_name || 'Your Barber',
            serviceName: serviceResponse.data?.name || 'Your Service',
            duration: serviceResponse.data?.duration_minutes || 30,
        };
        } catch (error) {
        console.error('Error fetching notification context:', error?.message || error);
        return null;
        }
    }

    const sendPushNotification = async (userId, payload) => {
        try {
        const { data: user, error } = await supabase
            .from('profiles')
            .select('push_subscription')
            .eq('id', userId)
            .single();

        if (error) throw error;

        if (!user?.push_subscription) {
            console.log(`[Push] User ${userId} has no subscription.`);
            return { ok: false, reason: 'no_subscription' };
        }

        await webPush.sendNotification(
            user.push_subscription,
            JSON.stringify(payload)
        );

        console.log(`[Push] Sent to user ${userId}`);
        return { ok: true };
        } catch (error) {
        console.error(`[Push] Failed to send to ${userId}:`, error?.message || error);

        // optional: cleanup if subscription is invalid (410)
        // if (error?.statusCode === 410) { ...remove subscription... }

        return { ok: false, reason: 'send_failed' };
        }
    }

    const processUpNextNotification = async (entry) => {
        try {
        const context = await getNotificationContext(entry);
        const barberName = context?.barberName || 'Your Barber';
        const serviceName = context?.serviceName || 'Service';

        console.log(`[Notify] Processing 'Up Next' for Queue #${entry.id} (User ${entry.user_id})`);

        if (entry.user_id) {
            await sendPushNotification(entry.user_id, {
            title: "You're Up Next! ✂️",
            body: `Get ready! ${barberName} is ready for your ${serviceName}. Please head to the shop now.`,
            url: '/',
            });
        }

        const { error } = await supabase
            .from('queue_entries')
            .update({ notified_up_next: true })
            .eq('id', entry.id);

        if (error) throw error;

        console.log(`[Notify] Success. Flagged Queue #${entry.id} as notified.`);
        } catch (error) {
        console.error(`[Notify] FAILED for Queue #${entry?.id}:`, error?.message || error);
        }
    }

    return { getNotificationContext, sendPushNotification, processUpNextNotification };
}

module.exports = {
    createNotificationHelpers
}