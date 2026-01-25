const webPush = require('web-push');

function setupVapid() {
    const {
        VAPID_PUBLIC_KEY,
        VAPID_PRIVATE_KEY,
        VAPID_EMAIL
    } = process.env;

    if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY && VAPID_EMAIL) {
        try {
            webPush.setVapidDetails(
                VAPID_EMAIL,
                VAPID_PUBLIC_KEY,
                VAPID_PRIVATE_KEY
            );
            console.log('✅ VAPID Web Push configured.');
        } catch (err) {
            console.error('⚠️ VAPID Config Error:', err.message);
        }
    } else {
        console.warn('⚠️ VAPID keys or Email missing. Push notifications disabled.');
    }

    return webPush;
}

module.exports = setupVapid;