const http = require('http');
const express = require('express');
const compression = require('compression');
const barber = require('./config/barber');
const { startCronJobs } = require('./cron');
const cors = require('cors');

// --- Configure our "tools" ---
const app = express();
const corsOptions = {
    // FIX: Removed duplicate 'https://dash-q-sigma.vercel.app'
    origin: ['https://dash-q-sigma.vercel.app', 'http://localhost:3000'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
};

app.use(compression()); // FIX: Added compression for faster payload delivery
app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // FIX: Removed redundant body-parser

// example: log or sanity check (optional)
console.log("🔐 Barber config loaded:", {
    signupCodeSet: !!barber.BARBER_SIGNUP_CODE,
    loginPinSet: !!barber.BARBER_LOGIN_PIN,
});

// --- CRON: Process Upcoming Appointments (Smart Auto-Chair) ---
startCronJobs();

// Auth middleware
const { auth, adminAuth } = require('./middleware/auth');

// API ENDPOINTS START
// FIX: Removed duplicate route mounts. Standardized to one mount point per route.
const home = require('./routes/homeRoutes');
app.use('/api', home);

const notificationRoutes = require('./routes/notificationRoutes');
app.use('/api/notifications', notificationRoutes);

const authRoutes = require('./routes/authRoutes');
app.use('/api', authRoutes);

const appointmentRoutes = require('./routes/appointmentRoutes');
app.use('/api/appointments', appointmentRoutes);

const chatRoutes = require('./routes/chatRoutes');
app.use('/api/chat', chatRoutes);

const serviceRoutes = require('./routes/serviceRoutes');
app.use('/api', serviceRoutes); // <-- Changed back to /api
app.use('/api/services', serviceRoutes); // Keep this just in case

const barberRoutes = require('./routes/barberRoutes');
app.use('/api', barberRoutes); // <-- Changed back to /api
app.use('/api/barbers', barberRoutes); // Keep this just in case

const settingsRoutes = require('./routes/settingsRoutes');
app.use('/api', settingsRoutes);

const loyaltyRoutes = require('./routes/loyaltyRoutes');
app.use('/api/loyalty', auth, loyaltyRoutes);

const adminRoutes = require('./routes/adminRoutes');
app.use('/api/admin', adminRoutes);

const deviceRoutes = require('./routes/deviceRoutes');
app.use('/api', deviceRoutes);

const guestRoutes = require('./routes/guestRoutes');
app.use('/api/guest', guestRoutes);

const queueRoutes = require('./routes/queueRoutes');
app.use('/api/queue', queueRoutes);

const eventRoutes = require('./routes/eventRoutes');
app.use('/api/missed-event', eventRoutes);

const reportsRoutes = require('./routes/reportsRoutes');
app.use('/api/reports', reportsRoutes);

const customerRoutes = require('./routes/customerRoutes');
app.use('/api', customerRoutes);

// Analytics Route
const analyticsRoutes = require('./routes/analyticsRoutes');
app.use('/api/analytics', analyticsRoutes);

// API ENDPOINTS END

const server = http.createServer(app);

// --- Start the server ---
const PORT = process.env.PORT || 3001;
// FIX: Changed app.listen to server.listen so socket/realtime servers can attach
server.listen(PORT, () => {
    console.log(`Dash-Q Backend Server is running on port ${PORT}`);
});