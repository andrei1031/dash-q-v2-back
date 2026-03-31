
const http = require('http');
const express = require('express')
const bodyParser = require('body-parser');
const barber = require('./config/barber');
const { startCronJobs } = require('./cron');
const cors = require('cors');


// --- Configure our "tools" ---
const app = express();
const corsOptions = {
    origin: ['https://dash-q-sigma.vercel.app', 'http://localhost:3000', 'https://dash-q-sigma.vercel.app'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));


// example: log or sanity check (optional)
console.log("🔐 Barber config loaded:", {
    signupCodeSet: !!barber.BARBER_SIGNUP_CODE,
    loginPinSet: !!barber.BARBER_LOGIN_PIN,
});

// --- CRON: Process Upcoming Appointments (Smart Auto-Chair) ---

startCronJobs()

// Auth middleware
const { auth, adminAuth } = require('./middleware/auth');

// API ENDPOINTS START
const home = require('./routes/homeRoutes');
app.use('/api', home);

const notificationRoutes = require('./routes/notificationRoutes');
app.use('/api', notificationRoutes);
app.use('/api/test', notificationRoutes);

const authRoutes = require('./routes/authRoutes');
app.use('/api', authRoutes);

const appointmentRoutes = require('./routes/appointmentRoutes');
app.use('/api/appointments', appointmentRoutes);

const chatRoutes = require('./routes/chatRoutes');
app.use('/api/chat', chatRoutes);

const serviceRoutes = require('./routes/serviceRoutes');
app.use('/api', serviceRoutes);
app.use('/api/services', serviceRoutes);

const barberRoutes = require('./routes/barberRoutes');
app.use('/api', barberRoutes);
app.use('/api/barbers', barberRoutes);

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
app.use('/api/queue/public', queueRoutes);

const eventRoutes = require('./routes/eventRoutes');
app.use('/api/missed-event', eventRoutes);

const reportsRoutes = require('./routes/reportsRoutes');
app.use('/api/reports', reportsRoutes);

// 🟢 THE FIX: Mount customerRoutes EXACTLY ONCE at the root!
const customerRoutes = require('./routes/customerRoutes');
app.use('/api', customerRoutes);

// API ENDPOINTS END

const server = http.createServer(app);

// --- API Endpoints ---


[server.js] 


// --- Start the server ---

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Dash-Q Backend Server is running on port ${PORT}`);
});