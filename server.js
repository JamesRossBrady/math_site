const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
// Stripe - only initialize if API key is provided
let stripe = null;
if (process.env.STRIPE_API_KEY) {
    stripe = require('stripe')(process.env.STRIPE_API_KEY);
}

const JWT_SECRET = process.env.JWT_SECRET || 'math-site-dev-secret-change-me';
const JWT_EXPIRY = '24h';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(helmet({ contentSecurityPolicy: false })); // CSP disabled for inline scripts
app.use(cors());

// Rate limiters
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 20, // 20 attempts per window
    message: { error: 'Too many attempts. Please try again later.' }
});
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: 'Too many requests. Please try again later.' }
});

// Apply rate limiting to auth endpoints
app.use('/api/login', authLimiter);
app.use('/api/signup', authLimiter);
app.use('/api/tutor/login', authLimiter);

// Stripe webhook - must be BEFORE express.json() to get raw body
app.post('/api/stripe/webhook', express.raw({type: 'application/json'}), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error('Webhook signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle successful payment
    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        console.log('Payment completed:', session.id);

        // Get the customer email from the session
        const customerEmail = session.customer_details?.email || session.customer_email;

        if (customerEmail) {
            // Find the user by email and add 1 session
            const userResult = await pool.query(
                'SELECT id FROM users WHERE email = $1',
                [customerEmail]
            );

            if (userResult.rows.length > 0) {
                const userId = userResult.rows[0].id;
                await pool.query(
                    'UPDATE users SET free_sessions = free_sessions + 1 WHERE id = $1',
                    [userId]
                );

                // Notify the student
                io.to('calendar').emit('credits-updated', { userId: userId, freeSessions: userResult.rows[0].free_sessions + 1 });

                console.log('Added 1 session to user:', customerEmail);
            }
        }
    }

    res.json({received: true});
});

app.use(express.json());
app.use(express.static(path.join(__dirname, '.')));

// Auth middleware - extracts and verifies JWT from Authorization header
function authenticateStudent(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.role && decoded.role !== 'student') {
            return res.status(403).json({ error: 'Student access required' });
        }
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
}

function authenticateTutor(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.role !== 'tutor') {
            return res.status(403).json({ error: 'Tutor access required' });
        }
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
}

// Generate a secure, non-guessable peer ID for a session
app.get('/api/sessions/peer-id', (req, res) => {
    const { slot_date, slot_hour } = req.query;
    if (!slot_date || !slot_hour) {
        return res.status(400).json({ error: 'slot_date and slot_hour required' });
    }
    const hash = crypto.createHash('sha256').update(JWT_SECRET + slot_date + '-' + slot_hour).digest('hex').substring(0, 16);
    res.json({ peerId: 'session-' + hash });
});

// Hardcoded tutor password (stored hashed with salt on server)
const TUTOR_SALT = 'math_site_salt_2024';
const TUTOR_PASSWORD_HASH = '74bbb24a35914189f3532865e01f23d2d1259c53b646ab96a350534b32c6d9d7'; // SHA-256(salt + new password)

function verifyPassword(input) {
    const hash = crypto.createHash('sha256').update(TUTOR_SALT + input).digest('hex');
    return hash === TUTOR_PASSWORD_HASH;
}

// Configure database connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'math_site',
    user: process.env.DB_USER || 'jamesrossbrady',
    password: process.env.DB_PASSWORD
});
if (!process.env.DATABASE_URL && !process.env.DB_PASSWORD) {
    console.error('DB_PASSWORD or DATABASE_URL must be set');
    process.exit(1);
}

// Initialize database tables
async function initDB() {
    if (!pool) {
        console.log('No database configured, skipping DB init');
        return;
    }
    const client = await pool.connect();
    try {
        // Create users table
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(255) UNIQUE NOT NULL,
                email VARCHAR(255) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                stripe_customer_id VARCHAR(255),
                free_sessions INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Add free_sessions column if missing
        try {
            await client.query(`ALTER TABLE users ADD COLUMN free_sessions INTEGER DEFAULT 0`);
        } catch (e) { /* ignore */ }

        // Create sessions table
        await client.query(`
            CREATE TABLE IF NOT EXISTS sessions (
                id SERIAL PRIMARY KEY,
                student_id INTEGER,
                slot_date DATE NOT NULL,
                slot_hour INTEGER NOT NULL CHECK (slot_hour >= 8 AND slot_hour <= 18),
                status VARCHAR(20) DEFAULT 'available',
                price INTEGER DEFAULT 5000,
                subject VARCHAR(100),
                textbook VARCHAR(255),
                chapter VARCHAR(255),
                struggling TEXT,
                paid BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(slot_date, slot_hour)
            )
        `);

        console.log('Database tables initialized');
    } catch (err) {
        console.error('Error initializing database:', err);
    } finally {
        client.release();
    }
}

// Initialize database with test sessions
async function initSessions() {
    if (!pool) {
        console.log('No database, skipping session init');
        return;
    }
    const client = await pool.connect();
    try {
        // Ensure sessions exist for next 28 days from April 30, 2026
        const startDate = new Date('2026-04-30');

        for (let d = 0; d < 28; d++) {
            const date = new Date(startDate);
            date.setDate(date.getDate() + d);
            const dateStr = date.toISOString().split('T')[0];

            for (let h = 8; h <= 18; h++) {
                await client.query(
                    'INSERT INTO sessions (slot_date, slot_hour, status) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
                    [dateStr, h, 'available']
                );
            }
        }
        console.log('Sessions ensured from 2026-04-30');
    } catch (err) {
        console.error('Error initializing sessions:', err);
    } finally {
        client.release();
    }
}

// Get sessions for a date range
app.get('/api/sessions', async (req, res) => {
    try {
        const { start_date, end_date } = req.query;
        const result = await pool.query(
            `SELECT s.id, s.student_id, TO_CHAR(s.slot_date, 'YYYY-MM-DD') as slot_date, s.slot_hour, s.status, s.subject, s.textbook, s.chapter, s.struggling, s.created_at, s.updated_at, u.username as student_name
             FROM sessions s
             LEFT JOIN users u ON s.student_id = u.id
             WHERE s.slot_date >= $1 AND s.slot_date <= $2
             ORDER BY s.slot_date, s.slot_hour`,
            [start_date, end_date]
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// Book a session (student uses their available session)
app.post('/api/sessions/book', authenticateStudent, async (req, res) => {
    const { slot_date, slot_hour, subject, textbook, chapter, struggling } = req.body;
    const parsedDate = String(slot_date);
    const parsedHour = parseInt(slot_hour);
    const parsedUserId = req.user.id;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Lock the user row to prevent concurrent bookings
        const userResult = await client.query(
            'SELECT free_sessions FROM users WHERE id = $1 FOR UPDATE',
            [parsedUserId]
        );

        if (userResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'User not found' });
        }

        if (userResult.rows[0].free_sessions < 1) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'No sessions left. Buy more in settings.' });
        }

        // Book directly as confirmed
        const result = await client.query(
            `UPDATE sessions
             SET status = 'confirmed', student_id = $7, subject = $3, textbook = $4, chapter = $5, struggling = $6, paid = TRUE, updated_at = CURRENT_TIMESTAMP
             WHERE slot_date = $1 AND slot_hour = $2 AND status = 'available'
             RETURNING id, slot_date, slot_hour, status`,
            [parsedDate, parsedHour, subject, textbook, chapter, struggling, parsedUserId]
        );

        if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Slot not available' });
        }

        // Deduct one session atomically within the transaction
        const updatedUser = await client.query(
            'UPDATE users SET free_sessions = free_sessions - 1 WHERE id = $1 RETURNING free_sessions',
            [parsedUserId]
        );

        await client.query('COMMIT');

        io.to('calendar').emit('session-updated', result.rows[0]);
        io.to('calendar').emit('credits-updated', { userId: parsedUserId, freeSessions: updatedUser.rows[0].free_sessions });

        res.json(result.rows[0]);
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    } finally {
        client.release();
    }
});

// Confirm a session (no payment - tutor waives or student pays later)
app.post('/api/sessions/confirm', authenticateTutor, async (req, res) => {
    try {
        const { slot_date, slot_hour } = req.body;

        // First get the session and student
        const sessionResult = await pool.query(
            `SELECT s.student_id, s.paid, s.status FROM sessions s WHERE s.slot_date = $1 AND s.slot_hour = $2 AND s.status = 'pending'`,
            [slot_date, slot_hour]
        );

        if (sessionResult.rows.length === 0) {
            // Check what status it actually has
            const checkResult = await pool.query(
                'SELECT status FROM sessions WHERE slot_date = $1 AND slot_hour = $2',
                [slot_date, slot_hour]
            );
            console.log('Session status:', checkResult.rows[0]?.status);
            return res.status(400).json({ error: 'Session not found or not pending' });
        }

        const student_id = sessionResult.rows[0].student_id;
        const alreadyPaid = sessionResult.rows[0].paid;

        // Get student info
        const userResult = await pool.query(
            'SELECT stripe_customer_id, free_sessions FROM users WHERE id = $1',
            [student_id]
        );

        if (userResult.rows.length === 0) {
            return res.status(400).json({ error: 'Student not found' });
        }

        const user = userResult.rows[0];
        let charged = false;

        console.log('Confirm check - free_sessions:', user.free_sessions, 'has_payment:', !!user.stripe_customer_id, 'stripe_configured:', !!stripe);

        // Check if student already used a free session (paid=true means they had credit)
        if (alreadyPaid) {
            // Already paid
        } else if (user.free_sessions > 0) {
            await pool.query(
                'UPDATE users SET free_sessions = free_sessions - 1 WHERE id = $1',
                [student_id]
            );
        } else if (user.stripe_customer_id && stripe && process.env.ENABLE_CHARGES === 'true') {
            // Charge the customer's default payment method
            try {
                const intent = await stripe.paymentIntents.create({
                    amount: 2500,
                    currency: 'usd',
                    customer: user.stripe_customer_id,
                    off_session: true,
                    confirm: true,
                    description: 'Math session'
                });
                console.log('Stripe intent:', intent.id, 'status:', intent.status);
                charged = true;
            } catch(e) {
                console.error('Stripe charge failed:', e.message);
                await pool.query('UPDATE users SET free_sessions = free_sessions + 1 WHERE id = $1', [student_id]);
            }
        }
        // If no credits and no payment method, just confirm without charging
        // (tutor manually confirmed)

        // Mark as confirmed
        const result = await pool.query(
            `UPDATE sessions
             SET status = 'confirmed', paid = TRUE, updated_at = CURRENT_TIMESTAMP
             WHERE slot_date = $1 AND slot_hour = $2 AND status = 'pending'
             RETURNING id, slot_date, slot_hour, status`,
            [slot_date, slot_hour]
        );

        // Notify all calendars
        io.to('calendar').emit('session-updated', result.rows[0]);

        res.json({ ...result.rows[0], charged });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// Reject a session
app.post('/api/sessions/reject', authenticateTutor, async (req, res) => {
    try {
        const { slot_date, slot_hour } = req.body;

        const result = await pool.query(
            `UPDATE sessions
             SET status = 'available', subject = NULL, textbook = NULL, chapter = NULL, struggling = NULL, updated_at = CURRENT_TIMESTAMP
             WHERE slot_date = $1 AND slot_hour = $2 AND status = 'pending'
             RETURNING id, slot_date, slot_hour, status`,
            [slot_date, slot_hour]
        );

        if (result.rows.length === 0) {
            return res.status(400).json({ error: 'Session not found or not pending' });
        }

        // Notify all calendars
        io.to('calendar').emit('session-updated', result.rows[0]);

        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// Cancel a session (tutor cancels confirmed or pending)
app.post('/api/sessions/cancel', authenticateTutor, async (req, res) => {
    try {
        const { slot_date, slot_hour } = req.body;

        // First get the student_id before canceling
        const sessionCheck = await pool.query(
            'SELECT student_id, status FROM sessions WHERE slot_date = $1 AND slot_hour = $2 AND status IN (\'pending\', \'confirmed\')',
            [slot_date, slot_hour]
        );

        let studentId = null;
        if (sessionCheck.rows.length > 0) {
            studentId = sessionCheck.rows[0].student_id;
        }

        const result = await pool.query(
            `UPDATE sessions
             SET status = 'available', student_id = NULL, subject = NULL, textbook = NULL, chapter = NULL, struggling = NULL, paid = FALSE, updated_at = CURRENT_TIMESTAMP
             WHERE slot_date = $1 AND slot_hour = $2 AND status IN ('pending', 'confirmed')
             RETURNING id, slot_date, slot_hour, status`,
            [slot_date, slot_hour]
        );

        if (result.rows.length === 0) {
            return res.status(400).json({ error: 'Session not found' });
        }

        const cancelledSession = result.rows[0];

        // If a student had booked it, give them back their session
        if (studentId) {
            await pool.query(
                'UPDATE users SET free_sessions = free_sessions + 1 WHERE id = $1',
                [studentId]
            );
            const updatedUser = await pool.query('SELECT free_sessions FROM users WHERE id = $1', [studentId]);
            io.to('calendar').emit('credits-updated', { userId: studentId, freeSessions: updatedUser.rows[0].free_sessions });
        }

        // Notify all calendars to refresh
        io.to('calendar').emit('session-updated', cancelledSession);

        res.json(cancelledSession);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// Mark a session as unavailable (tutor has plans)
app.post('/api/sessions/unavailable', authenticateTutor, async (req, res) => {
    try {
        const { slot_date, slot_hour } = req.body;

        const result = await pool.query(
            `UPDATE sessions
             SET status = 'unavailable', updated_at = CURRENT_TIMESTAMP
             WHERE slot_date = $1 AND slot_hour = $2 AND status = 'available'
             RETURNING id, slot_date, slot_hour, status`,
            [slot_date, slot_hour]
        );

        if (result.rows.length === 0) {
            return res.status(400).json({ error: 'Slot not available to mark unavailable' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// Mark a session as available again
app.post('/api/sessions/available', authenticateTutor, async (req, res) => {
    try {
        const { slot_date, slot_hour } = req.body;

        const result = await pool.query(
            `UPDATE sessions
             SET status = 'available', updated_at = CURRENT_TIMESTAMP
             WHERE slot_date = $1 AND slot_hour = $2 AND status = 'unavailable'
             RETURNING id, slot_date, slot_hour, status`,
            [slot_date, slot_hour]
        );

        if (result.rows.length === 0) {
            return res.status(400).json({ error: 'Slot not found or not unavailable' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// Get session details
app.get('/api/sessions/details', async (req, res) => {
    try {
        const { slot_date, slot_hour } = req.query;

        const result = await pool.query(
            `SELECT id, slot_date, slot_hour, status, subject, textbook, chapter, struggling, created_at, updated_at
             FROM sessions
             WHERE slot_date = $1 AND slot_hour = $2`,
            [slot_date, slot_hour]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Session not found' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// Get all users (for tutor dashboard)
app.get('/api/users', authenticateTutor, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, username, email, free_sessions, created_at FROM users ORDER BY created_at DESC'
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// Delete a user and their sessions
app.delete('/api/users/:id', authenticateTutor, async (req, res) => {
    const client = await pool.connect();
    try {
        const { id } = req.params;
        console.log('Deleting user:', id);
        await client.query('BEGIN');
        await client.query('DELETE FROM sessions WHERE student_id = $1', [id]);
        console.log('Deleted sessions for user:', id);
        await client.query('DELETE FROM users WHERE id = $1', [id]);
        console.log('Deleted user:', id);
        await client.query('COMMIT');

        // Notify all calendars about user deletion
        console.log('Emitting user-deleted for user:', id);
        io.to('calendar').emit('user-deleted', { userId: id });

        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Delete user error:', err);
        res.status(500).json({ error: 'Database error' });
    } finally {
        client.release();
    }
});

// Update free sessions for a user (tutor can set for any user, student can only add to themselves)
app.post('/api/user/free-sessions', async (req, res) => {
    // Authenticate as either tutor or student
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    let decoded;
    try {
        decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
    } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }

    console.log('free-sessions API called:', req.body);
    try {
        const { userId, amount } = req.body;

        // Determine the target user ID based on role
        let targetUserId;
        if (decoded.role === 'tutor') {
            targetUserId = parseInt(userId);
        } else {
            // Student can only add to themselves
            targetUserId = decoded.id;
        }

        console.log('Adding', amount, 'sessions to user', targetUserId);
        if (!targetUserId || amount === undefined) {
            console.log('Missing userId or amount');
            return res.status(400).json({ error: 'userId and amount required' });
        }
        const result = await pool.query(
            'UPDATE users SET free_sessions = free_sessions + $1 WHERE id = $2 RETURNING id, username, free_sessions',
            [amount, targetUserId]
        );
        if (result.rows.length === 0) {
            console.log('User not found:', userId);
            return res.status(404).json({ error: 'User not found' });
        }

        console.log('Updated user sessions:', result.rows[0].free_sessions);

        // Notify the student their credits were updated
        io.to('calendar').emit('credits-updated', { userId: targetUserId, freeSessions: result.rows[0].free_sessions });

        res.json(result.rows[0]);
    } catch (err) {
        console.error('Error in free-sessions:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

// Get user by ID
app.get('/api/user/:id', authenticateStudent, async (req, res) => {
    try {
        const { id } = req.params;
        // Students can only view their own data
        if (parseInt(id) !== req.user.id) {
            return res.status(403).json({ error: 'Access denied' });
        }
        const result = await pool.query(
            'SELECT id, username, email, free_sessions, created_at, CASE WHEN stripe_customer_id IS NOT NULL THEN true ELSE false END as has_payment_method FROM users WHERE id = $1',
            [id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// Update user payment method
app.post('/api/user/payment-method', authenticateStudent, async (req, res) => {
    try {
        const { paymentMethodId } = req.body;

        if (!stripe) {
            return res.status(500).json({ error: 'Stripe not configured' });
        }

        // Get user's current data
        const userResult = await pool.query(
            'SELECT id, email, stripe_customer_id FROM users WHERE id = $1',
            [req.user.id]
        );
        const user = userResult.rows[0];

        // Use existing Customer or create one
        let customerId = user.stripe_customer_id;
        if (!customerId || !customerId.startsWith('cus_')) {
            const customer = await stripe.customers.create({ email: user.email });
            customerId = customer.id;
        }

        // Attach payment method to the Customer
        await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId });

        // Set as default payment method
        await stripe.customers.update(customerId, {
            invoice_settings: { default_payment_method: paymentMethodId }
        });

        // Store Customer ID
        await pool.query(
            'UPDATE users SET stripe_customer_id = $1 WHERE id = $2',
            [customerId, req.user.id]
        );

        console.log('Payment method saved for user:', req.user.id);
        res.json({ success: true });
    } catch (err) {
        console.error('Payment method error:', err);
        res.status(500).json({ error: 'Failed to save payment method' });
    }
});

// Verify Stripe checkout session (credits granted by webhook, not here)
app.post('/api/stripe/verify-session', authenticateStudent, async (req, res) => {
    try {
        const { sessionId } = req.body;

        if (!stripe) {
            return res.status(500).json({ error: 'Stripe not configured' });
        }

        if (!sessionId) {
            return res.status(400).json({ error: 'Session ID required' });
        }

        // Retrieve the checkout session from Stripe
        const session = await stripe.checkout.sessions.retrieve(sessionId);

        if (session.payment_status === 'paid') {
            res.json({ success: true, status: 'paid' });
        } else if (session.payment_status === 'unpaid') {
            res.json({ success: false, status: 'unpaid', error: 'Payment not yet completed' });
        } else {
            res.json({ success: false, status: session.payment_status });
        }
    } catch (err) {
        console.error('Verify session error:', err);
        res.status(500).json({ error: 'Failed to verify payment' });
    }
});

// Create a SetupIntent (saves card without charging)
app.post('/api/stripe/create-setup', async (req, res) => {
    try {
        if (!stripe) {
            return res.status(500).json({ error: 'Stripe not configured' });
        }

        const setupIntent = await stripe.setupIntents.create({
            usage: 'off_session',
        });

        res.json({ clientSecret: setupIntent.client_secret });
    } catch (err) {
        console.error('Create setup error:', err);
        res.status(500).json({ error: 'Failed to create setup' });
    }
});

// Tutor login API
app.post('/api/tutor/login', (req, res) => {
    const { password } = req.body;
    if (verifyPassword(password)) {
        const token = jwt.sign({ role: 'tutor' }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
        res.json({ success: true, token });
    } else {
        res.status(401).json({ error: 'Invalid password' });
    }
});

// User signup
app.post('/api/signup', async (req, res) => {
    try {
        const { username, email, password } = req.body;

        // Validate input
        if (!username || !email || !password) {
            return res.status(400).json({ error: 'All fields are required' });
        }
        if (typeof username !== 'string' || username.trim().length < 2 || username.length > 50) {
            return res.status(400).json({ error: 'Username must be 2-50 characters' });
        }
        if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ error: 'Invalid email address' });
        }
        if (typeof password !== 'string' || password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }

        // Check if username or email already exists
        const existing = await pool.query(
            'SELECT id FROM users WHERE username = $1 OR email = $2',
            [username, email]
        );

        if (existing.rows.length > 0) {
            return res.status(400).json({ error: 'Username or email already exists' });
        }

        // Hash password with bcrypt
        const hash = await bcrypt.hash(password, 10);
        const result = await pool.query(
            'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, username, email',
            [username, email, hash]
        );

        const user = result.rows[0];
        const token = jwt.sign({ id: user.id, username: user.username, email: user.email, role: 'student' }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
        res.json({ success: true, token, user: { id: user.id, username: user.username, email: user.email } });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// User login
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        // Find user by username or email
        const result = await pool.query(
            'SELECT id, username, email, password_hash FROM users WHERE username = $1 OR email = $1',
            [username]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid username or password' });
        }

        const user = result.rows[0];

        // Try bcrypt first, fall back to SHA-256 for legacy users
        let valid = await bcrypt.compare(password, user.password_hash).catch(() => false);
        if (!valid) {
            // Legacy SHA-256 check
            const shaHash = crypto.createHash('sha256').update(password).digest('hex');
            if (shaHash === user.password_hash) {
                valid = true;
                // Migrate to bcrypt
                const bcryptHash = await bcrypt.hash(password, 10);
                await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [bcryptHash, user.id]);
            }
        }

        if (!valid) {
            return res.status(401).json({ error: 'Invalid username or password' });
        }

        const token = jwt.sign({ id: user.id, username: user.username, email: user.email, role: 'student' }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
        res.json({ success: true, token, user: { id: user.id, username: user.username, email: user.email } });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

//

const PORT = process.env.PORT || 3000;

// Socket.IO for whiteboard sync (per room)
const whiteboardRooms = {}; // { roomId: { lines: [], texts: [] } }

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Join a global room for calendar updates
    socket.on('join-calendar', () => {
        socket.join('calendar');
    });

    // Join a whiteboard room
    socket.on('join-room', (roomId) => {
        socket.join(roomId);
        // Initialize room if needed
        if (!whiteboardRooms[roomId]) {
            whiteboardRooms[roomId] = { lines: [], texts: [] };
        }
        // Send current whiteboard state to new user
        socket.emit('whiteboard-state', whiteboardRooms[roomId]);
    });

    // Handle drawing line
    socket.on('draw', (data) => {
        const roomId = Array.from(socket.rooms).find(r => r !== socket.id);
        if (roomId && whiteboardRooms[roomId]) {
            whiteboardRooms[roomId].lines.push(data);
            socket.to(roomId).emit('draw', data);
        }
    });

    // Handle text add
    socket.on('text', (data) => {
        const roomId = Array.from(socket.rooms).find(r => r !== socket.id);
        if (roomId && whiteboardRooms[roomId]) {
            whiteboardRooms[roomId].texts.push(data);
            socket.to(roomId).emit('text', data);
        }
    });

    // Handle clear
    socket.on('clear', () => {
        const roomId = Array.from(socket.rooms).find(r => r !== socket.id);
        if (roomId && whiteboardRooms[roomId]) {
            whiteboardRooms[roomId] = { lines: [], texts: [] };
            socket.to(roomId).emit('clear');
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
});

    // Listen on all interfaces for external access
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
    initDB();
    initSessions();
});

module.exports = app;
