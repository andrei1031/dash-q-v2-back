const http = require('http');
const express = require('express');
const bodyParser = require('body-parser');
const barberConfig = require('./config/barber'); // Renamed to avoid collision with barberRoutes
const { startCronJobs } = require('./cron');
const cors = require('cors');

// --- Configure App and Middleware ---
const app = express();
const corsOptions = {
    origin: ['https://dash-q-sigma.vercel.app', 'http://localhost:3000'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Log sanity check
console.log("🔐 Barber config loaded:", {
    signupCodeSet: !!barberConfig.BARBER_SIGNUP_CODE,
    loginPinSet: !!barberConfig.BARBER_LOGIN_PIN,
});

// --- Start Background Jobs ---
startCronJobs();

// Auth middleware
const { auth } = require('./middleware/auth');

// --- Import All Routes ---
const homeRoutes = require('./routes/homeRoutes');
const queueRoutes = require('./routes/queueRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const authRoutes = require('./routes/authRoutes');
const customerRoutes = require('./routes/customerRoutes');
const appointmentRoutes = require('./routes/appointmentRoutes');
const chatRoutes = require('./routes/chatRoutes');
const serviceRoutes = require('./routes/serviceRoutes');
const barberRoutes = require('./routes/barberRoutes');
const settingsRoutes = require('./routes/settingsRoutes');
const adminRoutes = require('./routes/adminRoutes');
const deviceRoutes = require('./routes/deviceRoutes');
const guestRoutes = require('./routes/guestRoutes');
const eventRoutes = require('./routes/eventRoutes');
const reportsRoutes = require('./routes/reportsRoutes');
const loyaltyRoutes = require('./routes/loyaltyRoutes');

// --- API Endpoints ---

// 1. Public / Basic Routes
app.use('/', homeRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/guest', guestRoutes);
app.use('/api/devices', deviceRoutes);
app.use('/api/missed-event', eventRoutes);

// 2. Settings (Publicly accessible for VIP price)
app.use('/api/settings', settingsRoutes);

// 3. Queue Routes (Mix of Public/Protected within router)
app.use('/api/queue', queueRoutes);

// 4. Barber & Service Information (Publicly accessible)
app.use('/api/barbers', barberRoutes);
app.use('/api/services', serviceRoutes);

// 5. Feedback & Reports
app.use('/api/feedback', customerRoutes);
app.use('/api/reports', reportsRoutes);

// 6. Protected Routes (Require Token)
app.use('/api/customer', auth, customerRoutes);
app.use('/api/appointments', auth, appointmentRoutes);
app.use('/api/chat', auth, chatRoutes);
app.use('/api/loyalty', auth, loyaltyRoutes);
app.use('/api/notifications', auth, notificationRoutes);

// 7. Admin Routes (Protected)
app.use('/api/admin', auth, adminRoutes);

// --- Start the Server ---
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Dash-Q Backend Server is running on port ${PORT}`);
});