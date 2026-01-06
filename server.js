// --- Import our "tools" ---
require('dotenv').config();

// --- DEFINE CONSTANTS IMMEDIATELY AFTER DOTENV LOAD ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const BARBER_SIGNUP_CODE = process.env.BARBER_SIGNUP_CODE; // New
const BARBER_LOGIN_PIN = process.env.BARBER_LOGIN_PIN;     // New

// --- VALIDATION CHECK ---
const missingVars = [];
if (!SUPABASE_URL) missingVars.push('SUPABASE_URL');
if (!SUPABASE_SERVICE_KEY) missingVars.push('SUPABASE_SERVICE_KEY');
if (!SUPABASE_ANON_KEY) missingVars.push('SUPABASE_ANON_KEY');
if (!BARBER_SIGNUP_CODE) missingVars.push('BARBER_SIGNUP_CODE');
if (!BARBER_LOGIN_PIN) missingVars.push('BARBER_LOGIN_PIN');

if (missingVars.length > 0) {
    console.error(`FATAL ERROR: Missing required environment variables: ${missingVars.join(', ')}`);
    process.exit(1); // Stop the server if secrets are missing
}

// --- Now load other modules ---
const http = require('http');
const express = require('express')
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const fetch = require('node-fetch');
const Filter = require('bad-words');
const tagalogBadWords = [
    'gago',
    'putangina',
    'bobo',
    'tangina',
    'ina mo',
    'tanga',
    'kupal',
    // ADD MORE TAGALOG WORDS HERE
];
const filter = new Filter();
filter.addWords(...tagalogBadWords);
const cron = require('node-cron');


// --- Configure our "tools" ---
const app = express();
const corsOptions = {
    origin: ['https://dash-q-sigma.vercel.app', 'http://localhost:3000'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
};
app.use(cors(corsOptions));
app.use(express.json());

const server = http.createServer(app);


// --- Supabase Clients ---
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
});

/**
 * ENFORCE QUEUE LOGIC (VIP SWAP & AUTO-FILL)
 * Place this function near your other helper functions (e.g., processUpNextNotification).
 * This ensures that if a VIP joins, they immediately bump a regular user from "Up Next".
 */
async function enforceQueueLogic(barberId) {
    console.log(`[QueueLogic] Enforcing rules for Barber ${barberId}...`);

    try {
        // 1. Fetch Current "Up Next" (if any)
        const { data: upNextEntry } = await supabase
            .from('queue_entries')
            .select('*')
            .eq('barber_id', barberId)
            .eq('status', 'Up Next')
            .maybeSingle();

        // 2. Fetch Top "Waiting" Candidate
        // Sort by VIP (true first), then Time (oldest first)
        const { data: waitingList } = await supabase
            .from('queue_entries')
            .select('*')
            .eq('barber_id', barberId)
            .eq('queue.status', 'waiting')
            .order('is_vip', { ascending: false }) // VIPs first
            .order('created_at', { ascending: true }) // Then First-Come-First-Serve
            .limit(1);

        const topCandidate = waitingList?.length > 0 ? waitingList[0] : null;

        // --- SCENARIO A: Up Next is Empty ---
        // Simply fill the slot with the top candidate
        if (!upNextEntry && topCandidate) {
            console.log(`[QueueLogic] Up Next is empty. Promoting #${topCandidate.id} (${topCandidate.is_vip ? 'VIP' : 'Reg'}).`);

            const { data: newUpNext } = await supabase
                .from('queue_entries')
                .update({ status: 'Up Next' })
                .eq('id', topCandidate.id)
                .select()
                .single();

            return [newUpNext];
        }

        // --- SCENARIO B: VIP Bump (The Fix) ---
        // If Up Next is REGULAR, and Top Waiting is VIP... SWAP THEM.
        if (upNextEntry && !upNextEntry.is_vip && topCandidate && topCandidate.is_vip) {
            console.log(`[QueueLogic] VIP #${topCandidate.id} is bumping Regular #${upNextEntry.id}!`);

            // 1. Demote current Up Next back to Waiting
            await supabase
                .from('queue_entries')
                .update({ status: 'Waiting' })
                .eq('id', upNextEntry.id);

            // 2. Promote VIP to Up Next
            const { data: newUpNext } = await supabase
                .from('queue_entries')
                .update({ status: 'Up Next' })
                .eq('id', topCandidate.id)
                .select()
                .single();

            return [newUpNext];
        }

        // --- SCENARIO C: No changes needed ---
        return upNextEntry ? [upNextEntry] : [];

    } catch (error) {
        console.error("[QueueLogic] Error enforcing rules:", error.message);
        return [];
    }
}

/**
 * ROBUST EMAIL SENDER
 * Handles sending the email and marking the database flag to prevent duplicates.
 */
async function processUpNextNotification(entry) {
    try {
        // 1. Get Context (Barber Name, Service Name)
        const context = await getNotificationContext(entry);
        if (!context) {
            console.error(`[Email Job] Could not fetch context for Queue #${entry.id}`);
            return;
        }

        // 2. Send to n8n (if email exists)
        if (entry.customer_email && process.env.N8N_WEBHOOK_URL) {
            console.log(`[Email Job] Sending email to ${entry.customer_email} for Queue #${entry.id}`);

            await axios.post(process.env.N8N_WEBHOOK_URL, {
                email: entry.customer_email,
                name: entry.customer_name,
                barberName: context.barberName,
                serviceName: context.serviceName,
                duration: context.duration
            });

            // 3. CRITICAL: Mark as notified in DB so we don't send again
            await supabase
                .from('queue_entries')
                .update({ notified_up_next: true })
                .eq('id', entry.id);

            console.log(`[Email Job] Success. Flagged Queue #${entry.id} as notified.`);
        } else {
            // If no email, mark as notified anyway so we don't keep checking it
            console.log(`[Email Job] No email for Queue #${entry.id}, skipping and flagging.`);
            await supabase
                .from('queue_entries')
                .update({ notified_up_next: true })
                .eq('id', entry.id);
        }

    } catch (error) {
        console.error(`[Email Job] FAILED for Queue #${entry.id}:`, error.message);
        // We DO NOT mark as true here. The Cron will try again next minute.
    }
}

/**
 * HELPER: Fetches detailed context for an Up Next notification
 */
async function getNotificationContext(queueEntry) {
    if (!queueEntry || !queueEntry.barber_id || !queueEntry.service_id) return null;

    try {
        const [barberResponse, serviceResponse] = await Promise.all([
            supabase.from('barber_profiles').select('full_name').eq('id', queueEntry.barber_id).single(),
            supabase.from('services').select('name, duration_minutes').eq('id', queueEntry.service_id).single()
        ]);

        return {
            barberName: barberResponse.data?.full_name || 'Your Barber',
            serviceName: serviceResponse.data?.name || 'Your Service',
            duration: serviceResponse.data?.duration_minutes || 30
        };
    } catch (error) {
        console.error("Error fetching notification context:", error.message);
        return null; // Return null if fetching context fails
    }
}

// --- API Endpoints ---
/**
 * ENDPOINT: Customer Confirms Attendance
 */
app.put('/api/queue/confirm', async (req, res) => {
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
});

/**
 * ENDPOINT (NEW): Check if email exists (for Forgot Password)
 * This is secure because it uses the admin key and doesn't reveal
 * anything other than "found: true" or "found: false".
 */
app.post('/api/check-email', async (req, res) => {
    const { email } = req.body;
    if (!email) {
        return res.status(400).json({ error: 'Email is required.' });
    }
    console.log(`POST /api/check-email - Checking: ${email}`);

    try {
        // We use the admin API to securely check for the user
        const checkEmailResponse = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(email)}`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'apikey': SUPABASE_ANON_KEY }
        });

        if (!checkEmailResponse.ok && checkEmailResponse.status !== 404) {
            const body = await checkEmailResponse.text();
            throw new Error(`Email check failed: ${checkEmailResponse.status} ${body}`);
        }

        if (checkEmailResponse.ok) {
            const data = await checkEmailResponse.json();
            // Check if any user in the response *exactly* matches the email
            if (data?.users?.some(u => u.email === email)) {
                console.log(`Email ${email} found.`);
                return res.status(200).json({ found: true });
            }
        }

        // If we're here, either a 404 was returned or no exact match was found
        console.log(`Email ${email} NOT found.`);
        return res.status(200).json({ found: false });

    } catch (error) {
        console.error("Error checking email:", error.message);
        res.status(500).json({ error: 'Server error checking email.' });
    }
});

// POST /api/admin/next-customer
// Body: { barberId: 5 }
app.post('/api/admin/next-customer', async (req, res) => {
    const { barberId } = req.body;

    try {
        // 1. Find the current customer in the chair (status: 'serving') and finish them
        await db.query(
            "UPDATE queue SET status = 'completed' WHERE barber_id = $1 AND status = 'serving'",
            [barberId]
        );

        // 2. Find the next person waiting
        const nextCustomer = await db.query(
            "SELECT * FROM queue WHERE barber_id = $1 AND status = 'waiting' ORDER BY id ASC LIMIT 1",
            [barberId]
        );

        if (nextCustomer.rows.length === 0) {
            return res.json({ message: "Queue is empty for this barber." });
        }

        // 3. Update the next person to 'serving'
        const customer = nextCustomer.rows[0];
        await db.query("UPDATE queue SET status = 'serving' WHERE id = $1", [customer.id]);

        // 4. TRIGGER N8N (Notify the customer)
        // Note: We use the logic you already have, just triggering it manually here
        await axios.post(process.env.N8N_WEBHOOK_URL, {
            type: 'up_next', // Ensure your Switch node handles this!
            email: customer.email,
            name: customer.name,
            barberName: `Admin for Barber ${barberId}` // Or fetch actual name
        });

        res.json({ success: true, message: `Moved ${customer.name} to chair.` });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
    }
});

/**
 * ENDPOINT: Update Customer Location (Heartbeat)
 */
app.put('/api/queue/location', async (req, res) => {
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
});


/**
 * ENDPOINT (NEW): Clear session flag on customer logout
 */
app.put('/api/logout/flag', async (req, res) => {
    const { userId } = req.body;
    console.log(`PUT /api/logout/flag - Clearing session flag for user ${userId}`);
    if (!userId) return res.status(400).json({ error: 'User ID is required.' });

    try {
        // 1. Clear session flag in 'profiles' (Required for login concurrency)
        const { error: profileError } = await supabase.from('profiles')
            .update({ current_session_id: null })
            .eq('id', userId);
        if (profileError) throw profileError;

        // 2. Set barber to INACTIVE and UNAVAILABLE in 'barber_profiles'
        const { error: barberError } = await supabase.from('barber_profiles')
            .update({ is_active: false, is_available: false, current_session_id: null })
            .eq('user_id', userId);

        if (barberError && barberError.code !== 'PGRST116') {
            throw barberError;
        }

        res.status(200).json({ message: 'Flags cleared and availability updated' });
    } catch (error) {
        console.error("Error clearing customer session flag during logout:", error.message);
        res.status(500).json({ error: 'Server error clearing session.' });
    }
});

/**
 * ENDPOINT (NEW): Fetch Customer Loyalty History
 */
app.get('/api/customer/history/:userId', async (req, res) => {
    const { userId } = req.params;
    console.log(`GET /api/customer/history/${userId} - Fetching loyalty history`);

    try {
        // Fetch completed/cancelled entries, joining service name, price, and barber name
        const { data, error } = await supabase.from('queue_entries')
            .select(`
                created_at, 
                status, 
                services(name, price_php), 
                barber_profiles(full_name),
                is_vip
            `)
            .eq('user_id', userId)
            .in('status', ['Done', 'Cancelled'])
            .order('created_at', { ascending: false });

        if (error) throw error;
        res.json(data || []);

    } catch (error) {
        console.error("Error fetching history:", error.message);
        res.status(500).json({ error: 'Failed to retrieve history.' });
    }
});

app.get('/api/admin/conversations', async (req, res) => {
    // This SQL is tricky: It finds the latest message for every unique barber-customer pair
    const sql = `
        SELECT DISTINCT ON (LEAST(sender_id, receiver_id), GREATEST(sender_id, receiver_id))
            id, sender_id, receiver_id, message, timestamp
        FROM messages
        ORDER BY LEAST(sender_id, receiver_id), GREATEST(sender_id, receiver_id), timestamp DESC
    `;
    const result = await db.query(sql);
    res.json(result.rows);
});

app.get('/api/admin/chat-history', async (req, res) => {
    const { barberId, customerId } = req.query;
    
    const result = await db.query(
        "SELECT * FROM messages WHERE (sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1) ORDER BY timestamp ASC",
        [barberId, customerId]
    );
    res.json(result.rows);
});

app.post('/api/admin/reply', async (req, res) => {
    const { barberId, customerId, message } = req.body;

    // We save the message as if it came FROM the barber (sender_id = barberId)
    await db.query(
        "INSERT INTO messages (sender_id, receiver_id, message) VALUES ($1, $2, $3)",
        [barberId, customerId, `[Admin]: ${message}`] // Optional: Add [Admin] tag
    );

    res.json({ success: true });
});

/**
 * ENDPOINT: Timezone-Aware Smart Slots
 * - Forces "Philippines Time" (UTC+8) regardless of server location.
 * - Fixes the "5 PM - 2 AM" bug caused by UTC conversion.
 */
app.get('/api/appointments/slots', async (req, res) => {
    const { barberId, date, serviceId } = req.query;
    if (!barberId || !date || !serviceId) return res.status(400).json({ error: 'Missing parameters' });

    try {
        const { data: service } = await supabase.from('services').select('duration_minutes').eq('id', serviceId).single();
        const duration = service?.duration_minutes || 30;

        // --- UPDATED HOURS HERE ---
        // --- UPDATED HOURS HERE ---
        const PH_OFFSET = "+08:00";
        
        // 1. OPENING TIME: 10:30 AM
        const startIso = `${date}T10:30:00${PH_OFFSET}`; 
        
        // 2. CLOSING TIME: 7:00 PM (19:00)
        // Note: The logic below automatically enforces the 6:30 PM cut-off.
        // If a 30-min service starts at 6:30 PM, it ends at 7:00 PM (Allowed).
        // If it tries to start at 6:40 PM, it ends at 7:10 PM (Blocked).
        const closeIso = `${date}T19:00:00${PH_OFFSET}`; 

        let slotIterator = new Date(startIso);
        const closeTime = new Date(closeIso);
        const now = new Date();

        // Fetch existing appointments...
        const dbStart = new Date(`${date}T00:00:00${PH_OFFSET}`).toISOString();
        const dbEnd = new Date(`${date}T23:59:59${PH_OFFSET}`).toISOString();

        const { data: bookings } = await supabase
            .from('appointments')
            .select('scheduled_time, end_time')
            .eq('barber_id', barberId)
            .eq('status', 'confirmed')
            .gte('scheduled_time', dbStart)
            .lte('scheduled_time', dbEnd);

        let slots = [];

        while (slotIterator < closeTime) {
            const slotStart = new Date(slotIterator);
            const slotEnd = new Date(slotIterator.getTime() + duration * 60000);

            // RULE A: STRICT CLOSING TIME (7:00 PM)
            // If a 30-min cut starts at 6:30 PM, it ends at 7:00 PM (Allowed).
            // If it starts at 6:40 PM, it ends at 7:10 PM (Blocked).
            if (slotEnd > closeTime) {
                break;
            }

            if (slotStart < now) {
                slotIterator.setMinutes(slotIterator.getMinutes() + 30);
                continue;
            }

            const isTaken = bookings.some(b => {
                const bookStart = new Date(b.scheduled_time);
                const bookEnd = new Date(b.end_time);
                return (slotStart < bookEnd && slotEnd > bookStart);
            });

            if (!isTaken) {
                slots.push(slotStart.toISOString());
            }

            slotIterator.setMinutes(slotIterator.getMinutes() + 30);
        }

        res.json(slots);

    } catch (error) {
        console.error("Slot fetch error:", error);
        res.status(500).json({ error: 'Server error calculating slots' });
    }
});

/**
 * ENDPOINT: Book an Appointment
 * - Enforces "Tomorrow Only" rule (blocks booking for today or past dates).
 * - Enforces strict 1-customer-per-slot rule (prevents overlaps).
 */
app.post('/api/appointments/book', async (req, res) => {
    const { customer_name, customer_email, user_id, barber_id, service_id, scheduled_time } = req.body;

    try {
        // --- 1. VALIDATION: Block "Today" and Past Appointments ---
        const appointmentDate = new Date(scheduled_time);
        const now = new Date();

        // Adjust 'now' to Philippines time (UTC+8) to ensure fairness regardless of server location
        const nowPH = new Date(now.getTime() + (8 * 60 * 60 * 1000));

        // Compare dates using YYYY-MM-DD format strings
        const apptDateString = appointmentDate.toISOString().split('T')[0];
        const nowDateString = nowPH.toISOString().split('T')[0];

        // If the appointment is Today or in the Past, reject it
        if (apptDateString <= nowDateString) {
            return res.status(400).json({ error: 'Appointments must be booked at least 1 day in advance.' });
        }
        // -----------------------------------------------------------

        // 2. Calculate End Time based on Service Duration
        const { data: service } = await supabase.from('services').select('duration_minutes').eq('id', service_id).single();
        const duration = service?.duration_minutes || 30;

        const startDate = new Date(scheduled_time);
        const endDate = new Date(startDate.getTime() + duration * 60000);

        // 3. STRICT CONFLICT CHECK (Race Condition Prevention)
        // This ensures Customer B cannot book if Customer A already has this slot.
        // Logic: Is there any confirmed appointment that Starts BEFORE this one Ends AND Ends AFTER this one Starts?
        const { data: conflict } = await supabase
            .from('appointments')
            .select('id')
            .eq('barber_id', barber_id)
            .eq('status', 'confirmed') // Only check confirmed slots
            .lt('scheduled_time', endDate.toISOString()) // Existing start < New end
            .gt('end_time', startDate.toISOString())     // Existing end > New start
            .maybeSingle();

        if (conflict) {
            return res.status(409).json({ error: 'Slot was just taken. Please choose another.' });
        }

        // 4. Insert Appointment
        const { data, error } = await supabase.from('appointments').insert({
            customer_name,
            customer_email,
            user_id,
            barber_id,
            service_id,
            scheduled_time: startDate.toISOString(),
            end_time: endDate.toISOString(),
            status: 'confirmed', // Immediately confirmed
            is_converted_to_queue: false
        }).select().single();

        if (error) throw error;

        console.log(`[Appointment] Booked for ${customer_name} on ${startDate.toISOString()}`);

        try {
            // 1. Get Barber's Email from their User Profile
            const { data: barberUser, error: barberError } = await supabaseAdmin // Use Admin client to access auth/users
                .from('barber_profiles')
                .select('user_id')
                .eq('id', barber_id)
                .single();

            if (barberUser) {
                // Fetch actual email from Auth system (securely)
                const { data: userData } = await supabaseAdmin.auth.admin.getUserById(barberUser.user_id);
                const barberEmail = userData?.user?.email;

                if (barberEmail && process.env.N8N_WEBHOOK_URL) {
                    // 2. Send Alert via n8n
                    await axios.post(process.env.N8N_WEBHOOK_URL, {
                        type: 'barber_alert', // <--- NEW TYPE
                        email: barberEmail, // Send to Barber
                        subject: '📅 New Booking Received!',
                        message: `You have a new appointment with ${customer_name} on ${new Date(startDate).toLocaleString('en-US', { timeZone: 'Asia/Manila' })}.`
                    });
                    console.log(`[Notify] Alert sent to barber at ${barberEmail}`);
                }
            }
        } catch (notifyError) {
            console.error("Failed to notify barber:", notifyError.message);
            // Don't fail the booking just because notification failed
        }

        res.status(201).json({ message: 'Appointment Confirmed!', appointment: data });

    } catch (error) {
        console.error("Booking error:", error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * ENDPOINT: Barber Rejects/Cancels an Appointment
 */
app.put('/api/appointments/reject', async (req, res) => {
    const { appointmentId, reason } = req.body;
    if (!appointmentId) return res.status(400).json({ error: 'Appointment ID required.' });

    try {
        // 1. Mark as Cancelled in DB
        const { data: appt, error } = await supabase
            .from('appointments')
            .update({ status: 'cancelled' }) // Change status to cancelled
            .eq('id', appointmentId)
            .select('customer_email, customer_name, scheduled_time')
            .single();

        if (error) throw error;

        // 2. Send URGENT Notification (via n8n Email or OneSignal)
        if (appt && process.env.N8N_WEBHOOK_URL) {
            console.log(`[Reject] Sending cancellation alert to ${appt.customer_email}`);
            
            // We use the existing n8n webhook but add a "type" flag
            // You might need to update your n8n workflow to handle this "cancellation" type
            await axios.post(process.env.N8N_WEBHOOK_URL, {
                type: 'cancellation', // Flag for n8n to send a different email template
                email: appt.customer_email,
                name: appt.customer_name,
                date: new Date(appt.scheduled_time).toLocaleString('en-US', { timeZone: 'Asia/Manila', weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
                reason: reason || 'Barber is unavailable.'
            }).catch(err => console.error("Notification failed:", err.message));
        }

        res.json({ message: 'Appointment rejected and customer notified.' });

    } catch (error) {
        console.error("Reject error:", error.message);
        res.status(500).json({ error: 'Failed to reject appointment.' });
    }
});

/**
 * ENDPOINT: Send Chat Message (Replaces Socket.IO 'chat message' event)
 * Handles profanity filtering and database insertion.
 */
app.post('/api/chat/send', async (req, res) => {
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
        // 2. Log to Database (Supabase Realtime will pick this up automatically!)
        const { data, error } = await supabase.from('chat_messages').insert({
            queue_entry_id: parseInt(queueId),
            sender_id: senderId,
            message: message,
        }).select().single();

        if (error) throw error;

        res.status(200).json(data);
    } catch (error) {
        console.error("Chat insert error:", error.message);
        res.status(500).json({ error: 'Failed to send message.' });
    }
});


/**
 * ENDPOINT (NEW): Fetch Customer Loyalty History (For Barber/Admin Use)
 * Securely finds the customer's ID and fetches their Done/Cancelled history.
 */
app.get('/api/barber/customer-loyalty/:customerEmail', async (req, res) => {
    const { customerEmail } = req.params;
    console.log(`GET /api/barber/customer-loyalty/${customerEmail} - Loyalty check`);

    if (!customerEmail) {
        return res.status(400).json({ error: 'Customer email is required.' });
    }

    try {
        // Step 1: Find the User ID associated with the email via the Auth Admin API
        const checkEmailResponse = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(customerEmail)}`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'apikey': SUPABASE_ANON_KEY }
        });

        if (!checkEmailResponse.ok) {
            // Treat 404 (Not Found) as a non-registered customer
            if (checkEmailResponse.status === 404) {
                return res.status(200).json({ count: 0, history: [] });
            }
            const body = await checkEmailResponse.text();
            throw new Error(`Auth lookup failed: ${checkEmailResponse.status} ${body}`);
        }

        const data = await checkEmailResponse.json();
        const targetUser = data?.users?.find(u => u.email === customerEmail);

        if (!targetUser) {
            // Email is valid but user might be unconfirmed or not found
            return res.status(200).json({ count: 0, history: [] });
        }

        const customerUserId = targetUser.id;

        // Step 2: Fetch completed/cancelled entries using the found user_id
        const { data: historyData, error: historyError } = await supabase.from('queue_entries')
            .select(`
                created_at, 
                status, 
                services(name, price_php), 
                barber_profiles(full_name),
                is_vip
            `)
            .eq('user_id', customerUserId)
            .in('status', ['Done', 'Cancelled'])
            .order('created_at', { ascending: false });

        if (historyError) throw historyError;

        const doneCount = historyData
            .filter(h => h.status === 'Done')
            .reduce((sum, entry) => sum + (entry.head_count || 1), 0);

        // Step 3: Return the count and history
        res.json({ count: doneCount, history: historyData || [] });

    } catch (error) {
        console.error("Error fetching customer loyalty history for barber:", error.message);
        res.status(500).json({ error: 'Server error retrieving customer history.' });
    }
});

/**
 * ENDPOINT (NEW): Get Service Menu (Active Only)
 */
app.get('/api/services', async (req, res) => {
    console.log('GET /api/services - Fetching service menu');
    try {
        // FIX: Only select services where is_active is TRUE
        const { data, error } = await supabase
            .from('services')
            .select('*')
            .eq('is_active', true)
            .order('duration_minutes', { ascending: true });

        if (error) throw error;
        res.json(data || []);
    } catch (error) {
        console.error('Error fetching services:', error.message);
        res.status(500).json({ error: 'Failed to retrieve service menu.' });
    }
});



/**
 * ENDPOINT 1 (UPDATED): Get available barbers with STAR RATINGS
 */
app.get('/api/barbers', async (req, res) => {
    console.log('GET /api/barbers - Request received for available barbers (with ratings)');

    // We use the RPC function we just created in SQL
    const { data, error } = await supabase.rpc('get_available_barbers_with_ratings');

    if (error) {
        console.error('Error fetching available barbers:', error.message);
        return res.status(500).json({ error: error.message });
    }

    console.log('Successfully fetched available barbers:', data);
    res.json(data || []);
});

/**
 * ENDPOINT 1.5: Get barber profile by user_id
 */
app.get('/api/barber/profile/:userId', async (req, res) => {
    const { userId } = req.params;
    console.log(`GET /api/barber/profile/${userId} - Fetching profile`);
    if (!userId || userId === 'undefined' || userId === 'null') return res.status(400).json({ error: 'Valid User ID is required.' });
    try {
        const { data, error } = await supabase.from('barber_profiles').select('id, user_id, full_name, is_available').eq('user_id', userId).single();
        if (error) { if (error.code === 'PGRST116') return res.status(404).json({ error: 'Barber profile not found.' }); throw error; }
        if (!data) return res.status(404).json({ error: 'Barber profile not found.' });
        console.log('Successfully fetched barber profile:', data); res.json(data);
    } catch (catchError) { console.error("Catch block error fetching profile:", catchError); res.status(500).json({ error: 'Server error fetching profile.' }); }
});

/**
 * ENDPOINT 1.7: Set barber availability
 */
app.put('/api/barber/availability', async (req, res) => {
    const { barberId, isAvailable, userId } = req.body; const barberIdInt = parseInt(barberId);
    console.log(`PUT /api/barber/availability - Setting barber ${barberIdInt} avail: ${isAvailable} by user ${userId}`);
    if (isNaN(barberIdInt) || isAvailable === undefined || !userId) return res.status(400).json({ error: 'Valid IDs and status required.' });
    try {
        const { data: ownerCheck, error: ownerError } = await supabase.from('barber_profiles').select('user_id').eq('id', barberIdInt).single();
        if (ownerError || !ownerCheck || ownerCheck.user_id !== userId) {
            console.warn(`Authorization failed: User ${userId} attempted action on profile.`);
            return res.status(403).json({ error: 'You are not authorized to perform this action.' });
        }
        const { data, error } = await supabase.from('barber_profiles').update({ is_available: isAvailable }).eq('id', barberIdInt).select('id, is_available').single();
        if (error) throw error;
        if (isAvailable === false) {
            console.log(`Clearing session flag for user ${userId}`);
            const { error: clearFlagError } = await supabase.from('profiles').update({ current_session_id: null }).eq('id', userId);
            if (clearFlagError) { console.error("Failed to clear concurrency flag on logout:", clearFlagError); }
        }
        console.log('Updated availability:', data); res.json(data);
    } catch (catchError) { console.error("Catch block error updating avail:", catchError); res.status(500).json({ error: 'Server error updating availability.' }); }
});

/**
 * ENDPOINT (NEW): Set barber earnings visibility
 */
app.put('/api/barber/settings/earnings', async (req, res) => {
    const { barberId, showEarnings, userId } = req.body;
    const barberIdInt = parseInt(barberId);
    if (isNaN(barberIdInt) || showEarnings === undefined || !userId) {
        return res.status(400).json({ error: 'Valid barber ID, user ID, and visibility status are required.' });
    }
    try {
        const { data: ownerCheck, error: ownerError } = await supabase.from('barber_profiles').select('user_id').eq('id', barberIdInt).single();
        if (ownerError || !ownerCheck || ownerCheck.user_id !== userId) {
            return res.status(403).json({ error: 'You are not authorized to change these settings.' });
        }
        const { data, error } = await supabase.from('barber_profiles').update({ show_earnings_analytics: showEarnings }).eq('id', barberIdInt).select('id, show_earnings_analytics').single();
        if (error) {
            console.warn("Could not update earnings visibility (column might be missing):", error.message);
        }
        console.log('Updated earnings visibility setting:', data);
        res.json(data || { id: barberIdInt, show_earnings_analytics: showEarnings });
    } catch (catchError) {
        console.error("Catch block error updating earnings visibility:", catchError);
        res.status(500).json({ error: 'Server error updating settings.' });
    }
});

/**
 * ENDPOINT (FIXED): Handle Signup
 */
app.post('/api/signup/username', async (req, res) => {
    const { email, password, username, fullName, role = 'customer', barberCode } = req.body;
    console.log(`POST /api/signup/username - Signup attempt: user=${username}, email=${email}, role=${role}`);
    if (!email || !password || !username || !fullName) return res.status(400).json({ error: 'All fields required.' });
    if (password.length < 6) return res.status(400).json({ error: 'Password min 6 characters.' });
    if (username.length < 3) return res.status(400).json({ error: 'Username min 3 characters.' });
    if (!/^[a-zA-Z0-Z0-9_]+$/.test(username)) return res.status(400).json({ error: 'Username format invalid.' });

    const CORRECT_BARBER_CODE = process.env.BARBER_SIGNUP_CODE;
    const isBarber = role === 'barber';
    if (isBarber && (!barberCode || barberCode !== CORRECT_BARBER_CODE)) return res.status(403).json({ error: 'Invalid Barber Code provided.' });

    let newUser = null;
    try {
        const { data: existingProfile, error: profileCheckError } = await supabase.from('profiles').select('id').ilike('username', username).maybeSingle();
        if (profileCheckError) throw profileCheckError;
        if (existingProfile) return res.status(409).json({ error: 'Username already taken.' });

        console.log(`Checking email uniqueness via API: ${email}`);
        const checkEmailResponse = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(email)}`, { method: 'GET', headers: { 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'apikey': SUPABASE_ANON_KEY } });
        if (!checkEmailResponse.ok && checkEmailResponse.status !== 404) { const body = await checkEmailResponse.text(); throw new Error(`Email check failed: ${checkEmailResponse.status} ${body}`); }
        if (checkEmailResponse.ok) { const data = await checkEmailResponse.json(); if (data?.users?.some(u => u.email === email)) return res.status(409).json({ error: 'Email already registered.' }); }
        console.log(`Email ${email} available.`);

        console.log(`Creating user via API: ${email}`);
        const createUserResponse = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { full_name: fullName } })
        });
        if (!createUserResponse.ok) { const body = await createUserResponse.json(); throw new Error(body.msg || body.message || 'Failed to create user.'); }
        newUser = await createUserResponse.json();
        if (!newUser || !newUser.id) throw new Error("API User creation failed: No ID returned.");
        console.log('User created via API:', newUser.id);

        console.log(`Inserting profile for user ${newUser.id}`);
        // FIX: Explicitly save the role ('barber' or 'customer') to the profiles table
        const { data: profileData, error: profileInsertError } = await supabase
            .from('profiles')
            .insert({
                id: newUser.id,
                username: username,
                full_name: fullName,
                role: role // <--- THIS WAS MISSING
            })
            .select()
            .single();
        if (profileInsertError) throw profileInsertError;
        console.log('Profile created:', profileData);

        if (isBarber) {
            console.log(`Attempting to insert BARBER profile for user ${newUser.id}`);
            const { data: barberProfileData, error: barberProfileError } = await supabase.from('barber_profiles').insert({ user_id: newUser.id, full_name: fullName, is_active: true, is_available: false }).select().single();
            if (barberProfileError) throw barberProfileError;
            console.log('Barber profile created:', barberProfileData);
        }

        console.log("Signup process completed successfully.");
        const successMessage = 'Account created! You can now log in.';
        res.status(201).json({ message: successMessage });

    } catch (error) {
        console.error('Username signup failed:', error.message);
        if (newUser && newUser.id) {
            console.warn(`Signup failed. Rolling back Auth user ${newUser.id}...`);
            try {
                const deleteResponse = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${newUser.id}`, {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'apikey': SUPABASE_ANON_KEY }
                });
                if (!deleteResponse.ok) { const body = await deleteResponse.text(); console.error(`CRITICAL: Rollback failed ${deleteResponse.status}:`, body); }
                else { console.log(`Rolled back Auth user ${newUser.id}`); }
            } catch (rollbackError) { console.error(`CRITICAL: Exception during rollback:`, rollbackError); }
        }

        const isUsernameConflict = error.message.includes('profiles_username_key') || error.message.includes('profiles_username_idx');
        const isEmailConflict = error.message.includes('already registered');
        const clientMessage = isUsernameConflict ? 'Username taken.' : isEmailConflict ? 'Email registered.' : error.message;
        const statusCode = (isUsernameConflict || isEmailConflict) ? 409 : 500;
        res.status(statusCode).json({ error: clientMessage });
    }
});


/**
 * ENDPOINT (UPDATED): Handle Login with BAN CHECK
 */
app.post('/api/login/username', async (req, res) => {
    const { username, password, role, pin } = req.body;
    console.log(`POST /api/login/username - Login attempt: user=${username}, role=${role}`);
    if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });
    const selectedRole = role || 'customer';
    if (selectedRole === 'barber') {
        const CORRECT_BARBER_PIN = process.env.BARBER_LOGIN_PIN;
        if (!pin) return res.status(400).json({ error: 'Barber PIN required.' });
        if (pin !== CORRECT_BARBER_PIN) { console.log(`Incorrect PIN for barber: ${username}`); return res.status(401).json({ error: 'Incorrect username, password, or PIN.' }); }
    }
    try {
        // --- MODIFIED SECTION START ---
        // 1. Fetch ID AND is_banned status
        const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('id, is_banned, role') // <--- Added is_banned here
            .ilike('username', username)
            .maybeSingle();

        if (profileError) throw profileError;

        if (!profile) {
            console.log(`Username "${username}" not found.`);
            return res.status(401).json({ error: 'Incorrect username or password.' });
        }

        // 2. CHECK IF BANNED
        if (profile.is_banned) {
            console.warn(`Banned user ${username} attempted login.`);
            return res.status(403).json({ error: 'Your account has been suspended due to policy violations. Contact admin.' });
        }
        // --- MODIFIED SECTION END ---

        const userId = profile.id;

        const userResponse = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, { method: 'GET', headers: { 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'apikey': SUPABASE_ANON_KEY } });
        if (!userResponse.ok) { const body = await userResponse.text(); throw new Error(`Could not retrieve user details: ${userResponse.status} ${body}`); }
        const userData = await userResponse.json();
        if (!userData?.email) throw new Error('User email not found.');
        const userEmail = userData.email;

        const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({ email: userEmail, password: password });
        if (signInError) {
            if (signInError.message.includes('Invalid login credentials')) return res.status(401).json({ error: 'Incorrect username or password.' });
            if (signInError.message.includes('Email not confirmed')) return res.status(401).json({ error: 'Please verify your email address.' });
            throw signInError;
        }
        const loggedInUser = signInData.user;

        if (selectedRole === 'barber') {
            console.log(`Verifying if user ${loggedInUser.id} is a barber...`);
            const { data: barberProfile, error: barberCheckError } = await supabase.from('barber_profiles').select('id, current_session_id').eq('user_id', loggedInUser.id).maybeSingle();
            if (barberCheckError) { console.error("Error checking barber_profiles table:", barberCheckError); throw new Error("Server error during role check."); }
            if (!barberProfile) { console.warn(`User ${username} (${loggedInUser.id}) passed PIN but has no barber profile.`); return res.status(403).json({ error: 'Incorrect username, password, or PIN.' }); }
            if (barberProfile.current_session_id) { console.warn(`User ${username} attempted second login. Blocking!`); return res.status(409).json({ error: 'This barber account is already signed in on another device.' }); }

            // --- FIX: Update is_active to TRUE on successful login ---
            const { error: updateAvailabilityError } = await supabase.from('barber_profiles')
                .update({ is_active: true })
                .eq('user_id', loggedInUser.id);
            if (updateAvailabilityError) { console.error("Failed to set is_active flag:", updateAvailabilityError); }
            // --- END FIX ---

            const { error: updateError } = await supabase.from('profiles').update({ current_session_id: loggedInUser.id }).eq('id', loggedInUser.id);
            if (updateError) { console.error("Failed to set session ID flag:", updateError); return res.status(500).json({ error: 'Login failed setting active status.' }); }
            console.log(`User ${username} confirmed as a barber.`);
        } else if (selectedRole === 'customer') {
            // --- 1. BLOCK ADMINS ---
            if (profile.role === 'admin') {
                return res.status(403).json({ error: 'Admins must log in via the Admin Portal.' });
            }

            // --- 2. BLOCK BARBERS (Existing Logic) ---
            const { data: barberProfile } = await supabase.from('barber_profiles').select('id').eq('user_id', loggedInUser.id).maybeSingle();
            if (barberProfile) { 
                return res.status(403).json({ error: 'You must log in using the "Barber" role.' }); 
            }
            
            console.log(`User ${username} confirmed as a customer.`);

            // <--- ADD THIS BLOCK --->
        } else if (selectedRole === 'admin') {
            // 1. Fetch the user's profile to check the DB role
            const { data: adminProfile, error: adminCheckError } = await supabase
                .from('profiles')
                .select('role')
                .eq('id', loggedInUser.id)
                .single();

            if (adminCheckError || adminProfile?.role !== 'admin') {
                console.warn(`User ${username} attempted ADMIN login but is '${adminProfile?.role || 'unknown'}'.`);
                return res.status(403).json({ error: 'Access Denied: You do not have Administrator privileges.' });
            }
            console.log(`User ${username} confirmed as ADMIN.`);
        }
        console.log(`Login successful for user: ${username}, ID: ${loggedInUser.id} as role: ${selectedRole}`);
        res.json({ user: loggedInUser });
    } catch (error) {
        console.error('Username login failed:', error);
        res.status(500).json({ error: 'Login failed due to a server error.' });
    }
});


/**
 * ENDPOINT 2 (RPC): Add a customer and auto-assign status (FIXED FOR VIP)
 */
app.post('/api/queue', async (req, res) => {
    const {
        customer_name, customer_phone, barber_id, reference_image_url,
        customer_email, service_id, player_id, user_id,
        is_vip,
        head_count = 1,
    } = req.body;

    console.log(`[RPC Join] POST /api/queue - Customer: ${customer_name}, User: ${user_id}, VIP: ${is_vip}`);

    const barberIdInt = parseInt(barber_id);
    const serviceIdInt = parseInt(service_id);

    if (!customer_name || isNaN(barberIdInt) || isNaN(serviceIdInt)) {
        return res.status(400).json({ error: 'Name, Barber ID, and Service ID are required.' });
    }

    // --- 1. BLOCKING CHECK: Prevent user from joining if they have an active booking ---
    if (user_id) {
        const { data: activeEntry, error: checkError } = await supabase
            .from('queue_entries')
            .select('id, status, barber_id')
            .eq('user_id', user_id)
            .in('status', ['Waiting', 'Up Next', 'In Progress'])
            .maybeSingle();

        if (checkError) {
            console.error('Error checking active status:', checkError);
            return res.status(500).json({ error: 'Server error checking queue status.' });
        }

        if (activeEntry) {
            console.warn(`User ${user_id} blocked from joining: Already in queue (Entry #${activeEntry.id})`);
            return res.status(409).json({
                error: 'You already have an active booking.',
                details: activeEntry
            });
        }
    }

    try {
        // --- 2. JOIN QUEUE (Initially puts user in 'Waiting') ---
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

        if (error) {
            console.error('[RPC Join] Database function error:', error.message);
            return res.status(409).json({ error: error.message });
        }

        let newQueueEntry = Array.isArray(data) ? data[0] : data;
        if (!newQueueEntry) { throw new Error('Database function did not return a new entry.'); }

        // ============================================================
        // 🟢 CRITICAL FIX: FORCE VIP PROMOTION CHECK IMMEDIATELY
        // ============================================================
        console.log(`[RPC Join] Triggering VIP enforcement for Barber ${barberIdInt}...`);

        // This executes the JS logic to SWAP a Regular "Up Next" with a VIP "Waiting"
        const promotedCustomers = await enforceQueueLogic(barberIdInt);

        // If the user we just added got promoted in the logic above, update our local variable
        // so the frontend receives the correct 'Up Next' status immediately.
        const promotedEntry = promotedCustomers.find(c => c && c.id === newQueueEntry.id);

        if (promotedEntry) {
            console.log(`[RPC Join] User #${newQueueEntry.id} was immediately promoted to ${promotedEntry.status}`);
            newQueueEntry = promotedEntry;
        }
        // ============================================================
        // 🔴 END FIX
        // ============================================================

        // --- 3. HANDLE HEAD COUNT (For groups) ---
        if (newQueueEntry && head_count > 1) {
            await supabase
                .from('queue_entries')
                .update({ head_count: parseInt(head_count) })
                .eq('id', newQueueEntry.id);

            newQueueEntry.head_count = parseInt(head_count);
        }

        console.log(`[RPC Join] Successfully added customer ${newQueueEntry.id} with final status: ${newQueueEntry.status}`);

        // --- 4. SEND NOTIFICATIONS (If status is Up Next) ---
        if (newQueueEntry.status === 'Up Next') {
            console.log(`[RPC Join] Customer ${newQueueEntry.id} is "Up Next". Triggering notifications...`);

            // Mark as notified immediately to avoid duplicates from cron
            await supabase.from('queue_entries').update({ notified_up_next: true }).eq('id', newQueueEntry.id);

            const context = await getNotificationContext(newQueueEntry);

            // Email Notification
            if (newQueueEntry.customer_email && process.env.N8N_WEBHOOK_URL && context) {
                console.log(`[RPC Join] Firing n8n email webhook for ${newQueueEntry.customer_name}`);
                axios.post(process.env.N8N_WEBHOOK_URL, {
                    type: 'up_next',
                    email: newQueueEntry.customer_email,
                    name: newQueueEntry.customer_name,
                    barberName: context.barberName,
                    serviceName: context.serviceName,
                    duration: context.duration
                }).catch(webhookError => { console.error("[RPC Join] Error triggering n8n webhook:", webhookError.message); });
            }

            // Push Notification
            if (newQueueEntry.player_id && process.env.ONESIGNAL_APP_ID && process.env.ONESIGNAL_REST_API_KEY) {
                console.log(`[RPC Join] Sending OneSignal Push to ${newQueueEntry.player_id}`);
                const pushHeaders = { "Content-Type": "application/json; charset=utf-8", "Authorization": `Basic ${process.env.ONESIGNAL_REST_API_KEY}` };

                const pushContent = context ?
                    `Hi ${newQueueEntry.customer_name}, you're Up Next for the ${context.serviceName} cut with ${context.barberName}. Please head over!` :
                    `Hi ${newQueueEntry.customer_name}, it's your turn. Please head over!`;

                const pushData = {
                    app_id: process.env.ONESIGNAL_APP_ID,
                    include_player_ids: [newQueueEntry.player_id],
                    headings: { "en": "You're next!" },
                    contents: { "en": pushContent }
                };
                axios.post("https://api.onesignal.com/api/v1/notifications", pushData, { headers: pushHeaders })
                    .catch(pushError => { console.error("[RPC Join] Error sending OneSignal Push:", pushError.response?.data || pushError.message); });
            }
        }

        res.status(201).json(newQueueEntry);

    } catch (error) {
        console.error('Error in POST /api/queue:', error.message);
        res.status(500).json({ error: `Failed to add to queue: ${error.message}` });
    }
});

/**
 * ENDPOINT: Test Push Notification
 * Call this via Postman: POST /api/test/push { "playerId": "your-uuid-here" }
 */
app.post('/api/test/push', async (req, res) => {
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
});

/**
 * ENDPOINT (NEW): Update the reference image URL
 */
app.put('/api/queue/photo', async (req, res) => {
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
});

/**
 * ENDPOINT 3.5 (UPDATED): Get full queue details for Barber Dashboard
 * Now includes 'nextAppointment' for the Safety Gap Warning.
 */
app.get('/api/queue/details/:barberId', async (req, res) => {
    const { barberId } = req.params;
    const barberIdInt = parseInt(barberId);

    if (isNaN(barberIdInt)) return res.status(400).json({ error: "Invalid Barber ID" });

    try {
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

        // 4. (NEW) Fetch Next Immediate Appointment
        // We need this to warn the barber if they try to call a walk-in close to an appointment time.
        const now = new Date().toISOString();
        const { data: nextAppt, error: apptError } = await supabase
            .from('appointments')
            .select('id, scheduled_time, customer_name, services(name, duration_minutes)')
            .eq('barber_id', barberIdInt)
            .eq('status', 'confirmed')
            .eq('is_converted_to_queue', false) // Only get ones that aren't already in the queue
            .gt('scheduled_time', now)          // Only future appointments
            .order('scheduled_time', { ascending: true }) // Get the soonest one
            .limit(1)
            .maybeSingle();

        if (apptError) throw apptError;

        // 5. Return compiled data
        res.json({ 
            waiting: waitingData || [], 
            inProgress: inProgressData, 
            upNext: finalUpNext,
            nextAppointment: nextAppt // <--- Critical for Safety Gap Warning
        });

    } catch (error) {
        console.error('Error fetching detailed queue:', error.message);
        res.status(500).json({ error: 'Failed to fetch detailed queue' });
    }
});

/**
 * ENDPOINT 4 (v5 - RPC - ATOMIC): Call next customer
 * This is now much simpler and safer. It only does two things:
 * 1. Calls the RPC to move the target customer to "In Progress".
 * 2. Calls the NEW atomic RPC to promote the next waiting customer.
 */
app.put('/api/queue/next', async (req, res) => {
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
});

/**
 * ENDPOINT 4.5 (RPC): Mark queue entry as Cancelled/No-Show
 */
app.put('/api/queue/cancel', async (req, res) => {
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
});

/**
 * ENDPOINT 5: Mark a cut as "Done" and log the profit (MODIFIED for VIP)
 */
app.post('/api/queue/complete', async (req, res) => {
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

        const { error: updateError } = await supabase.from('queue_entries').update({ status: 'Done' }).eq('id', queueIdInt).eq('status', 'In Progress');
        if (updateError) { console.error('Error updating queue status to Done:', updateError.message); return res.status(500).json({ error: updateError.message }); }

        // Log the service with the total profit (Base + Tip + VIP)
        const { data, error: insertError } = await supabase.from('services_completed').insert([{ barber_id: barberIdInt, price: totalProfit, head_count: headCount }]).select();
        if (insertError) { console.error('Error logging service:', insertError.message); return res.status(500).json({ error: insertError.message }); }

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
});

// ======================================================================
// ===                OPTIMIZATION 1: ANALYTICS ENDPOINT              ===
// ======================================================================

/**
 * ENDPOINT 6: Get analytics for a barber (Updated with Global Carbon)
 */
app.get('/api/analytics/:barberId', async (req, res) => {
    const { barberId } = req.params;
    const barberIdInt = parseInt(barberId);

    try {
        // 1. Get visibility setting
        let showEarningsAnalytics = true;
        const { data: profileData } = await supabase.from('barber_profiles').select('show_earnings_analytics').eq('id', barberIdInt).maybeSingle();
        if (profileData) showEarningsAnalytics = profileData.show_earnings_analytics;

        // 2. Call the Barber Analytics RPC
        const { data: analyticsData, error: rpcError } = await supabase.rpc('get_barber_analytics', { p_barber_id: barberIdInt });
        if (rpcError) throw rpcError;

        // --- 3. NEW: Call the Global Carbon RPC ---
        const { data: carbonData, error: carbonError } = await supabase.rpc('get_global_carbon_stats');
        if (carbonError) console.error("Carbon Fetch Error:", carbonError);

        const globalCarbonTotal = carbonData?.total_carbon || 0;
        const isTodayActive = carbonData?.today_active || false;
        // ------------------------------------------

        // 4. Combine data
        const finalResponse = {
            ...analyticsData,
            showEarningsAnalytics: showEarningsAnalytics,

            // Add the global carbon stats here
            carbonSavedTotal: globalCarbonTotal,
            carbonSavedToday: isTodayActive ? 5 : 0 // If today has a cut, show 5, else 0
        };

        res.json(finalResponse);

    } catch (error) {
        console.error('Error fetching analytics:', error.message);
        res.status(500).json({ error: 'Failed to fetch analytics data.' });
    }
});

/**
 * ENDPOINT 7 (UPDATED): Get Public Queue View (With "Ghost Slots")
 * Merges Walk-ins and upcoming Appointments into one chronological list.
 */
app.get('/api/queue/public/:barberId', async (req, res) => {
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
                is_vip, head_count
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
            .eq('status', 'confirmed')
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
            // Priority Rule: VIP Walk-ins first, then everything else by time
            if (a.is_vip && !b.is_vip) return -1;
            if (!a.is_vip && b.is_vip) return 1;
            return new Date(a.created_at) - new Date(b.created_at);
        });

        const finalQueue = [...active, ...combinedWaiting];

        res.json(finalQueue);
    } catch (error) {
        console.error('Error fetching public queue:', error.message);
        res.status(500).json({ error: 'Failed to fetch queue information.' });
    }
});

/**
 * ENDPOINT 8 (SECURE): Remove a customer AND auto-promote next
 * (FIXED: Now checks if the user is authorized to delete)
 */
app.delete('/api/queue/:queueId', async (req, res) => {
    const { queueId } = req.params;
    const { userId } = req.body || {}; // <-- This is the fix
    const queueIdInt = parseInt(queueId);

    console.log(`DELETE /api/queue/${queueIdInt} - Request from user ${userId}`);

    if (isNaN(queueIdInt)) { return res.status(400).json({ error: 'Invalid Queue ID.' }); }
    if (!userId) { return res.status(401).json({ error: 'Authorization failed (missing user ID).' }); }

    try {
        // --- 1. First, find the queue entry and check its owner ---
        const { data: queueEntry, error: fetchError } = await supabase
            .from('queue_entries')
            .select('user_id')
            .eq('id', queueIdInt)
            .in('status', ['Waiting', 'Up Next']) // Can only delete if waiting
            .maybeSingle();

        if (fetchError) throw fetchError;
        if (!queueEntry) { return res.status(404).json({ message: 'Entry not found or already in progress.' }); }

        // --- 2. This is the security check ---
        if (queueEntry.user_id !== userId) {
            console.warn(`[SECURITY] User ${userId} tried to delete queue entry ${queueIdInt} owned by ${queueEntry.user_id}. DENIED.`);
            return res.status(403).json({ error: 'You are not authorized to remove this entry.' });
        }

        // --- 3. If authorized, proceed with deletion ---
        console.log(`[DELETE] User ${userId} authorized. Deleting entry ${queueIdInt}...`);
        const { data: deletedEntry, error: deleteError } = await supabase
            .from('queue_entries')
            .delete()
            .eq('id', queueIdInt)
            .select('barber_id, status')
            .single();

        if (deleteError) {
            if (deleteError.code === 'PGRST116') { return res.status(200).json({ message: 'Entry not found or already removed.' }); }
            throw deleteError;
        }
        if (!deletedEntry) { return res.status(200).json({ message: 'Entry not found or already removed.' }); }
        console.log(`[DELETE] Successfully deleted entry ${queueIdInt} for barber ${deletedEntry.barber_id}.`);
        console.log(`[DELETE] Checking to auto-fill Up Next for barber ${deletedEntry.barber_id}...`);
        const { data: promotedCustomers, error: promoteError } = await supabase.rpc('auto_fill_up_next_v2', {
            p_barber_id: deletedEntry.barber_id
        });
        if (promoteError) { console.error(`[DELETE] Error auto-filling Up Next:`, promoteError.message); }

        const newUpNextCustomer = Array.isArray(promotedCustomers) ? promotedCustomers[0] : null;
        if (newUpNextCustomer) {
            console.log(`[DELETE] Promoted ${newUpNextCustomer.id}. Triggering notifications.`);
            if (newUpNextCustomer.customer_email && process.env.N8N_WEBHOOK_URL) {
                axios.post(process.env.N8N_WEBHOOK_URL, { email: newUpNextCustomer.customer_email, name: newUpNextCustomer.customer_name })
                    .catch(err => console.error("[DELETE] Error n8n webhook:", err.message));
            }
            if (newUpNextCustomer.player_id && process.env.ONESIGNAL_APP_ID) {
                axios.post("https://api.onesignal.com/api/v1/notifications", {
                    app_id: process.env.ONESIGNAL_APP_ID,
                    include_player_ids: [newUpNextCustomer.player_id],
                    headings: { "en": "You're next!" },
                    contents: { "en": `Hi ${newUpNextCustomer.customer_name}, it's your turn. Please head over!` },
                }, { headers: { "Authorization": `Basic ${process.env.ONESIGNAL_REST_API_KEY}` } })
                    .catch(err => console.error("[DELETE] Error OneSignal push:", err.message));
            }
        }

        res.status(200).json({ message: 'Successfully left queue.' });
    } catch (error) {
        console.error('Error removing from queue:', error.message);
        res.status(500).json({ error: 'Failed to remove from queue.' });
    }
});

/**
 * ENDPOINT: Get Customer's Appointments
 */
app.get('/api/appointments/my/:userId', async (req, res) => {
    const { userId } = req.params;
    if (!userId) return res.status(400).json({ error: 'User ID required' });

    try {
        const { data, error } = await supabase
            .from('appointments')
            .select(`
                id, 
                scheduled_time, 
                status, 
                is_converted_to_queue,
                barber_profiles(full_name),
                services(name, price_php, duration_minutes)
            `)
            .eq('user_id', userId)
            .order('scheduled_time', { ascending: false }); // Show upcoming first

        if (error) throw error;
        res.json(data || []);
    } catch (error) {
        console.error("Fetch appointments error:", error.message);
        res.status(500).json({ error: 'Failed to fetch appointments.' });
    }
});

/**
 * ENDPOINT 9 (MODIFIED): Analyze and save customer feedback
 * Now accepts a star rating (1-5) and comment.
 */
app.post('/api/feedback', async (req, res) => {
    // Destructure the numeric 'rating' field sent from the client
    const { barber_id, customer_name, comments, rating } = req.body;

    // 1. Validation: Ensure the rating is a valid integer between 1 and 5
    const customerRating = parseInt(rating);
    if (isNaN(customerRating) || customerRating < 1 || customerRating > 5) {
        return res.status(400).json({ error: 'A valid star rating (1-5) is required.' });
    }
    if (!comments || comments.trim().length === 0) {
        return res.status(400).json({ error: 'Feedback comments cannot be empty.' });
    }

    try {
        const scoreToSave = customerRating; // scoreToSave will be 2 (or 3, 4, etc.)

        // 2. CRITICAL WRITE: Insert the correct numeric rating into the 'score' column
        const { error } = await supabase.from('feedback').insert({
            barber_id: parseInt(barber_id),
            customer_name: customer_name,
            comments: comments,
            score: scoreToSave, // <--- This must write the numeric value (2)
        });

        if (error) {
            // If this error block is executed, the issue is database schema/RLS.
            console.error(`[CRITICAL DB ERROR] Supabase insert failed: ${error.code} - ${error.message}`);
            // Throwing the error will allow you to see the database reason in the server logs.
            throw new Error(`Database Error: ${error.message}`);
        }

        console.log(`[Feedback] Successfully saved rating ${scoreToSave} for barber ${barber_id}.`);
        res.status(201).json({ message: 'Feedback saved!', score: scoreToSave });

    } catch (error) {
        console.error('[Feedback] Error saving feedback (General Catch):', error.message);
        res.status(500).json({ error: 'Server error saving feedback. Final code fix applied. Please check Supabase schema/policies.' });
    }
});

/**
 * ENDPOINT 10 (MODIFIED): Get feedback for a specific barber
 */
app.get('/api/feedback/:barberId', async (req, res) => {
    const { barberId } = req.params;
    console.log(`[Feedback] Fetching feedback for barber ${barberId}`);

    try {
        // Now selecting 'score' which represents the star rating
        const { data, error } = await supabase
            .from('feedback')
            .select('customer_name, comments, score, created_at')
            .eq('barber_id', barberId)
            .order('created_at', { ascending: false })
            .limit(10);

        if (error) { throw error; }

        res.json(data || []);

    } catch (error) {
        console.error('[Feedback] Error fetching feedback:', error.message);
        res.status(500).json({ error: error.message || 'Server error fetching feedback.' });
    }
});

/**
 * ENDPOINT: Check for missed "Done" or "Cancelled" events
 * FIX: NOW PRESERVES HISTORY. Updates 'client_acknowledged' instead of deleting.
 */
app.get('/api/missed-event/:userId', async (req, res) => {
    const { userId } = req.params;
    if (!userId || userId === 'undefined') return res.status(400).json({ error: 'Valid User ID is required.' });

    try {
        // 1. Find unacknowledged events
        const { data: event, error: fetchError } = await supabase
            .from('queue_entries')
            .select('id, status')
            .eq('user_id', userId)
            .in('status', ['Done', 'Cancelled'])
            .eq('client_acknowledged', false) // Only get ones they haven't seen
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

        if (fetchError) throw fetchError;
        if (!event) return res.status(200).json({ event: null });

        console.log(`[Missed Event] Found '${event.status}' for user ${userId}.`);

        // 2. Mark as acknowledged (DO NOT DELETE)
        await supabase.from('queue_entries')
            .update({ client_acknowledged: true })
            .eq('id', event.id);

        res.status(200).json({ event: event.status });

    } catch (error) {
        console.error('[Missed Event] Error:', error.message);
        res.status(500).json({ error: 'Server error checking event.' });
    }
});

// ==========================================
// ===           ADMIN ENDPOINTS          ===
// ==========================================

/**
 * HELPER: Verify Admin Role
 */
async function isAdmin(userId) {
    if (!userId) return false;
    const { data } = await supabase.from('profiles').select('role').eq('id', userId).single();
    return data?.role === 'admin';
}

/**
 * ENDPOINT: Add a New Service (With Validation)
 */
app.post('/api/admin/services', async (req, res) => {
    const { userId, name, duration_minutes, price_php } = req.body;

    if (!await isAdmin(userId)) return res.status(403).json({ error: 'Unauthorized.' });

    // VALIDATION: Prevent bad data
    if (!name || name.trim() === "") return res.status(400).json({ error: 'Service name is required.' });
    if (duration_minutes < 5) return res.status(400).json({ error: 'Duration must be at least 5 minutes.' });
    if (price_php < 0) return res.status(400).json({ error: 'Price cannot be negative.' });

    try {
        const { data, error } = await supabase.from('services').insert({
            name,
            duration_minutes: parseInt(duration_minutes),
            price_php: parseFloat(price_php),
            is_active: true
        }).select().single();

        if (error) throw error;
        res.json({ message: 'Service added successfully', data });
    } catch (error) {
        console.error("Admin add service error:", error.message);
        res.status(500).json({ error: error.message });
    }
});

/**
 * ENDPOINT: Edit a Service (Fixed for "Cannot coerce" error)
 */
app.put('/api/admin/services/:id', async (req, res) => {
    const { id } = req.params;
    const { userId, name, duration_minutes, price_php } = req.body;

    // Check Admin rights (assuming isAdmin function exists or you skip it for dev)
    // if (!await isAdmin(userId)) return res.status(403).json({ error: 'Unauthorized.' });

    // VALIDATION
    if (!name || name.trim() === "") return res.status(400).json({ error: 'Service name is required.' });
    if (duration_minutes < 5) return res.status(400).json({ error: 'Duration must be at least 5 minutes.' });
    if (price_php < 0) return res.status(400).json({ error: 'Price cannot be negative.' });

    try {
        const { data, error } = await supabase.from('services')
            .update({ name, duration_minutes, price_php })
            .eq('id', id)
            .select(); // <--- REMOVED .single() to prevent crash

        if (error) throw error;

        // Check if anything was actually updated
        if (!data || data.length === 0) {
            return res.status(404).json({ error: 'Service ID not found (it may have been deleted).' });
        }

        res.json({ message: 'Service updated successfully', data: data[0] });
    } catch (error) {
        console.error("Admin edit service error:", error.message);
        res.status(500).json({ error: error.message });
    }
});

/**
 * ENDPOINT: Admin Get All Services (Active AND Archived)
 */
app.get('/api/admin/services', async (req, res) => {
    // Note: Real-world apps should verify Admin ID here
    try {
        const { data, error } = await supabase
            .from('services')
            .select('*')
            .order('is_active', { ascending: false }) // Active first
            .order('name', { ascending: true });

        if (error) throw error;
        res.json(data || []);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * ENDPOINT: Admin Restore Service (Undo Delete)
 */
app.put('/api/admin/services/:id/restore', async (req, res) => {
    const { id } = req.params;
    const { userId } = req.body;
    if (!await isAdmin(userId)) return res.status(403).json({ error: 'Unauthorized.' });

    try {
        const { error } = await supabase.rpc('restore_service', { p_service_id: parseInt(id) });
        if (error) throw error;
        res.json({ message: 'Service restored successfully.' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * ENDPOINT: Soft Delete a Service (Archive)
 * Prevents database crashes by hiding the service instead of deleting history.
 */
app.delete('/api/admin/services/:id', async (req, res) => {
    const { id } = req.params;
    const { userId } = req.body;
    console.log(`DELETE /api/admin/services/${id} - Archive request by ${userId}`);

    if (!await isAdmin(userId)) return res.status(403).json({ error: 'Unauthorized.' });

    try {
        // Update is_active to false (Soft Delete)
        const { error } = await supabase
            .from('services')
            .update({ is_active: false })
            .eq('id', id);

        if (error) throw error;
        res.json({ message: 'Service archived successfully.' });
    } catch (error) {
        console.error("Admin delete service error:", error.message);
        res.status(500).json({ error: error.message });
    }
});

/**
 * ENDPOINT: Get All Barbers (For Staff Management)
 */
app.get('/api/admin/barbers', async (req, res) => {
    // We assume the requester is admin, checked via frontend or subsequent action, 
    // but ideally, you pass userId in headers for strict checking. 
    // For now, we rely on the secure RLS policies or simplicity.
    try {
        const { data, error } = await supabase
            .from('barber_profiles')
            .select('*')
            .order('full_name', { ascending: true });

        if (error) throw error;
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * ENDPOINT: Toggle Barber Status (Ban/Unban)
 * UPDATED: Also clears 'is_banned' on the user profile when activating
 */
app.put('/api/admin/barbers/:id/status', async (req, res) => {
    const { id } = req.params;
    const { userId, is_active } = req.body; // userId is the admin's ID

    if (!await isAdmin(userId)) return res.status(403).json({ error: 'Unauthorized.' });

    try {
        // 1. Update Barber Profile (Active/Inactive)
        const { data: barber, error } = await supabase.from('barber_profiles')
            .update({
                is_active: is_active,
                current_session_id: is_active ? undefined : null
            })
            .eq('id', id)
            .select('user_id') // Get the linked user_id to unban the main profile
            .single();

        if (error) throw error;

        // 2. IMPORTANT: If activating, ensure the main User Profile is NOT banned
        if (is_active && barber.user_id) {
            await supabase.from('profiles')
                .update({ is_banned: false })
                .eq('id', barber.user_id);
        }

        res.json({ message: `Barber ${is_active ? 'activated & unbanned' : 'deactivated'}.` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * ENDPOINT: Get Shop-Wide Analytics
 */
app.get('/api/admin/stats', async (req, res) => {
    try {
        // 1. Total Revenue (Sum of services_completed)
        const { data: revenueData, error: revError } = await supabase
            .from('services_completed')
            .select('price, head_count');
        if (revError) throw revError;
        // 2. Calculate Total Revenue (Same as before)
        const totalRevenue = revenueData.reduce((sum, item) => sum + (item.price || 0), 0);

        // 3. FIX: Calculate Total Cuts by summing head_count
        // OLD: const totalCuts = revenueData.length;
        const totalCuts = revenueData.reduce((sum, item) => sum + (item.head_count || 1), 0);

        // 3. Total Active Barbers
        const { count: barberCount, error: barberError } = await supabase.from('barber_profiles')
            .select('*', { count: 'exact', head: true })
            .eq('is_active', true);

        res.json({ totalRevenue, totalCuts, activeBarbers: barberCount || 0 });
    } catch (error) {
        console.error("Admin stats error:", error);
        res.status(500).json({ error: "Failed to load stats" });
    }
});

/**
 * ENDPOINT: Transfer Queue Entry (Admin)
 */
app.put('/api/admin/transfer', async (req, res) => {
    const { userId, queueId, targetBarberId } = req.body;
    console.log(`PUT /api/admin/transfer - Moving Queue #${queueId} to Barber ${targetBarberId}`);

    if (!await isAdmin(userId)) return res.status(403).json({ error: 'Unauthorized.' });

    try {
        // Use the RPC we created
        const { error } = await supabase.rpc('transfer_queue_item', {
            p_queue_id: parseInt(queueId),
            p_target_barber_id: parseInt(targetBarberId)
        });

        if (error) throw error;
        res.json({ message: 'Customer transferred successfully.' });
    } catch (error) {
        console.error("Transfer error:", error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * ENDPOINT: Super Detailed Admin Analytics
 */
app.get('/api/admin/analytics/advanced', async (req, res) => {
    try {
        // IMPORTANT: Must call 'get_detailed_admin_analytics'
        const { data, error } = await supabase.rpc('get_detailed_admin_analytics');

        if (error) throw error;
        res.json(data);
    } catch (error) {
        console.error("Advanced analytics error:", error);
        res.status(500).json({ error: "Failed to load analytics." });
    }
});

/**
 * ENDPOINT: Get All Users (Robust Version)
 */
app.get('/api/admin/users', async (req, res) => {
    try {
        console.log("GET /api/admin/users - Fetching profiles...");

        // FIX: Select ALL columns (*) to avoid errors if specific columns are missing
        // We also remove the .order() temporarily to rule out sorting errors
        const { data, error } = await supabase
            .from('profiles')
            .select('*');

        if (error) {
            console.error("Supabase Error fetching profiles:", error.message);
            throw error;
        }

        console.log(`Found ${data.length} profiles.`);
        res.json(data);
    } catch (error) {
        console.error("Error fetching users:", error.message);
        res.status(500).json({ error: "Failed to load users: " + error.message });
    }
});

/**
 * ENDPOINT: Delete User Account (Safely)
 */
app.delete('/api/admin/users/:targetId', async (req, res) => {
    const { targetId } = req.params;
    const { userId } = req.body;

    if (!await isAdmin(userId)) return res.status(403).json({ error: 'Unauthorized.' });

    try {
        console.log(`Admin ${userId} deleting user ${targetId}`);

        // 1. Try to delete from Auth (Supabase handles most cascades, but not all)
        const { error } = await supabaseAdmin.auth.admin.deleteUser(targetId);
        if (error) throw error;

        // 2. Manually clean up the profile just in case
        await supabase.from('profiles').delete().eq('id', targetId);

        res.json({ message: 'User account deleted.' });
    } catch (error) {
        console.error("Delete user error:", error);
        // Return a helpful error if it fails due to database links
        if (error.message.includes('foreign key constraint')) {
            return res.status(409).json({ error: 'Cannot delete user: They have active records (History/Queue). Ask them to cancel appointments first.' });
        }
        res.status(500).json({ error: "Delete failed: " + error.message });
    }
});



// --- CRON: ROBUST EMAIL SWEEPER (Runs every 1 minute) ---
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
});

// --- NEW 8PM CLEANUP JOB (Your Idea) ---
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
}, { timezone: "Asia/Manila" });

// --- CRON: Process Upcoming Appointments ---
cron.schedule('*/5 * * * *', async () => { // Runs every 5 minutes
    console.log('[Cron] Checking for upcoming appointments...');

    const now = new Date();
    const thirtyMinsFromNow = new Date(now.getTime() + 30 * 60000);

    try {
        // Find confirmed appointments due soon that haven't been queued yet
        const { data: dueAppointments } = await supabase
            .from('appointments')
            .select('*')
            .eq('status', 'confirmed')
            .eq('is_converted_to_queue', false)
            .lte('scheduled_time', thirtyMinsFromNow.toISOString())
            .gte('scheduled_time', now.toISOString());

        if (dueAppointments && dueAppointments.length > 0) {
            for (const appt of dueAppointments) {
                console.log(`[Cron] Moving Appointment #${appt.id} to Live Queue...`);

                // 1. Add to Queue as VIP (Status starts as 'Waiting')
                await supabase.from('queue_entries').insert({
                    barber_id: appt.barber_id,
                    customer_name: `${appt.customer_name} (Appointment)`,
                    customer_email: appt.customer_email,
                    user_id: appt.user_id,
                    service_id: appt.service_id,
                    status: 'Waiting', // Enters waiting list first
                    is_vip: true,      // Marked as VIP to jump to front of line
                    is_confirmed: true
                });

                // 2. Mark appointment as converted so we don't add it twice
                await supabase.from('appointments')
                    .update({ is_converted_to_queue: true })
                    .eq('id', appt.id);

                // --- 3. THE FIX: Trigger Auto-Fill Immediately ---
                // This checks if "Up Next" is empty. Since this new guy is a VIP,
                // he will immediately be promoted to "Up Next" (or "In Progress") if a slot is free.
                console.log(`[Cron] Triggering auto-fill for Barber ${appt.barber_id}...`);
                await supabase.rpc('auto_fill_up_next_v2', { p_barber_id: appt.barber_id });
            }
        }
    } catch (e) {
        console.error("[Cron] Error processing appointments:", e);
    }
});

/**
 * ENDPOINT: Submit a Report (Barber <-> Customer)
 * UPDATED: Now accepts proofImageUrl
 */
app.post('/api/reports', async (req, res) => {
    const { reporterId, reportedId, role, reason, description, proofImageUrl } = req.body;

    if (!reporterId || !reportedId || !reason) {
        return res.status(400).json({ error: 'Missing required fields.' });
    }

    try {
        const { data, error } = await supabase.from('reports').insert({
            reporter_id: reporterId,
            reported_id: reportedId,
            role_reporter: role,
            reason: reason,
            description: description,
            proof_image_url: proofImageUrl || null // <--- Save the image URL
        });

        if (error) throw error;
        res.status(201).json({ message: 'Report submitted. Admin will review.' });
    } catch (error) {
        console.error("Report error:", error);
        res.status(500).json({ error: 'Failed to submit report.' });
    }
});

/**
 * ENDPOINT: Admin Get All Reports
 */
app.get('/api/admin/reports', async (req, res) => {
    try {
        // Fetch reports with names for both sides
        const { data, error } = await supabase
            .from('reports')
            .select(`
                *,
                reporter:profiles!reporter_id(full_name, role),
                reported:profiles!reported_id(full_name, role, is_banned)
            `)
            .order('created_at', { ascending: false });

        if (error) throw error;
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * ENDPOINT: Admin Action (Ban/Unban User & Resolve Report)
 */
app.put('/api/admin/reports/resolve', async (req, res) => {
    const { reportId, targetUserId, action, adminNotes } = req.body;
    // action can be: 'ban', 'dismiss', 'warning'

    try {
        // 1. If Action is BAN, update profile
        if (action === 'ban') {
            await supabase.from('profiles').update({ is_banned: true }).eq('id', targetUserId);
            // Also force logout logic (optional, clears session)
            await supabase.from('barber_profiles').update({ is_active: false }).eq('user_id', targetUserId);
        } else if (action === 'unban') {
            await supabase.from('profiles').update({ is_banned: false }).eq('id', targetUserId);
        }

        // 2. Update Report Status
        const { error } = await supabase.from('reports')
            .update({
                status: action === 'dismiss' ? 'Dismissed' : 'Resolved',
                admin_notes: `Action: ${action.toUpperCase()}. ${adminNotes || ''}`
            })
            .eq('id', reportId);

        if (error) throw error;
        res.json({ message: `User ${action}ned and report resolved.` });
    } catch (error) {
        console.error("Resolve error:", error);
        res.status(500).json({ error: 'Failed to take action.' });
    }
});

/**
 * ENDPOINT: Get User's Submitted Reports (For Barber & Customer)
 */
app.get('/api/reports/my/:userId', async (req, res) => {
    const { userId } = req.params;
    if (!userId) return res.status(400).json({ error: 'User ID required.' });

    try {
        const { data, error } = await supabase
            .from('reports')
            .select(`
                id,
                created_at,
                reason,
                description,
                status,
                admin_notes,
                reported:profiles!reported_id(full_name)
            `)
            .eq('reporter_id', userId)
            .order('created_at', { ascending: false });

        if (error) throw error;
        res.json(data || []);
    } catch (error) {
        console.error("Error fetching user reports:", error.message);
        res.status(500).json({ error: 'Failed to load reports.' });
    }
});

/**
 * ENDPOINT: Get Barber's Upcoming Appointments
 */
app.get('/api/appointments/barber/:barberId', async (req, res) => {
    const { barberId } = req.params;
    if (!barberId) return res.status(400).json({ error: 'Barber ID required' });

    try {
        // Fetch confirmed appointments for today and the future
        const now = new Date();
        // Reset time to start of today to show today's bookings too
        now.setHours(0,0,0,0); 

        const { data, error } = await supabase
            .from('appointments')
            .select(`
                id, 
                scheduled_time, 
                customer_name,
                customer_email,
                status, 
                is_converted_to_queue,
                services(name, duration_minutes)
            `)
            .eq('barber_id', barberId)
            .eq('status', 'confirmed') // Only show confirmed bookings
            .gte('scheduled_time', now.toISOString()) // Today onwards
            .order('scheduled_time', { ascending: true }); // Soonest first

        if (error) throw error;
        res.json(data || []);
    } catch (error) {
        console.error("Fetch barber appointments error:", error.message);
        res.status(500).json({ error: 'Failed to fetch appointments.' });
    }
});


// --- Start the server ---
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Dash-Q Backend Server is running on port ${PORT}`);
});