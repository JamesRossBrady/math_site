const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
// Stripe - only initialize if API key is provided
let stripe = null;
if (process.env.STRIPE_API_KEY) {
    stripe = require('stripe')(process.env.STRIPE_API_KEY);
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '.')));

// Hardcoded tutor password (stored hashed with salt on server)
const TUTOR_SALT = 'math_site_salt_2024';
const TUTOR_PASSWORD_HASH = '703e110ea4de4bba15675565beb04f172abc91d2a885b38257dec10cfe5f8d33'; // SHA-256(salt + 'aladan64SOFT12v?')

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
    password: process.env.DB_PASSWORD || 'password'
});

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
app.post('/api/sessions/book', async (req, res) => {
    try {
        const { slot_date, slot_hour, subject, textbook, chapter, struggling, userId } = req.body;

        const parsedDate = String(slot_date);
        const parsedHour = parseInt(slot_hour);
        const parsedUserId = parseInt(userId);

        // Check user has at least 1 available session
        const userResult = await pool.query(
            'SELECT free_sessions FROM users WHERE id = $1',
            [parsedUserId]
        );

        if (userResult.rows.length === 0) {
            return res.status(400).json({ error: 'User not found' });
        }

        const user = userResult.rows[0];

        if (user.free_sessions < 1) {
            return res.status(400).json({ error: 'No sessions left. Buy more in settings.' });
        }

        // Book directly as confirmed (no tutor confirmation needed)
        const result = await pool.query(
            `UPDATE sessions
             SET status = 'confirmed', student_id = $7, subject = $3, textbook = $4, chapter = $5, struggling = $6, paid = TRUE, updated_at = CURRENT_TIMESTAMP
             WHERE slot_date = $1 AND slot_hour = $2 AND status = 'available'
             RETURNING id, slot_date, slot_hour, status`,
            [parsedDate, parsedHour, subject, textbook, chapter, struggling, parsedUserId]
        );

        if (result.rows.length === 0) {
            return res.status(400).json({ error: 'Slot not available' });
        }

        // Deduct one session from user's available sessions
        await pool.query(
            'UPDATE users SET free_sessions = free_sessions - 1 WHERE id = $1',
            [parsedUserId]
        );

        // Get updated free_sessions
        const updatedUser = await pool.query(
            'SELECT free_sessions FROM users WHERE id = $1',
            [parsedUserId]
        );

        // Notify all calendars
        io.to('calendar').emit('session-updated', result.rows[0]);

        // Notify the student their credits were updated
        io.to('calendar').emit('credits-updated', { userId: parsedUserId, freeSessions: updatedUser.rows[0].free_sessions });

        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// Confirm a session (no payment - tutor waives or student pays later)
app.post('/api/sessions/confirm', async (req, res) => {
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

        console.log('Confirm check - free_sessions:', user.free_sessions, 'stripe_customer_id:', user.stripe_customer_id, 'stripe:', !!stripe, 'ENABLE_CHARGES:', process.env.ENABLE_CHARGES);

        // Check if student already used a free session (paid=true means they had credit)
        if (alreadyPaid) {
            // Already paid
        } else if (user.free_sessions > 0) {
            await pool.query(
                'UPDATE users SET free_sessions = free_sessions - 1 WHERE id = $1',
                [student_id]
            );
        } else if (user.stripe_customer_id && stripe && process.env.ENABLE_CHARGES === 'true') {
            // Try Stripe charge
            try {
                const intent = await stripe.paymentIntents.create({
                    amount: 50,
                    currency: 'usd',
                    payment_method: user.stripe_customer_id,
                    description: 'Math session'
                });
                console.log('Stripe intent:', intent.id, 'status:', intent.status);
                charged = true;
            } catch(e) {
                console.error('Stripe:', e.message);
                await pool.query('UPDATE users SET free_sessions = free_sessions + 1 WHERE id = $1', [student_id]);
            }
        } else {
            await pool.query('UPDATE users SET free_sessions = free_sessions + 1 WHERE id = $1', [student_id]);
        }

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
app.post('/api/sessions/reject', async (req, res) => {
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
app.post('/api/sessions/cancel', async (req, res) => {
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
app.post('/api/sessions/unavailable', async (req, res) => {
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
app.post('/api/sessions/available', async (req, res) => {
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
app.get('/api/users', async (req, res) => {
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
app.delete('/api/users/:id', async (req, res) => {
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
        res.status(500).json({ error: 'Database error: ' + err.message });
    } finally {
        client.release();
    }
});

// Update free sessions for a user
app.post('/api/user/free-sessions', async (req, res) => {
    try {
        const { userId, amount } = req.body;
        if (!userId || amount === undefined) {
            return res.status(400).json({ error: 'userId and amount required' });
        }
        const result = await pool.query(
            'UPDATE users SET free_sessions = free_sessions + $1 WHERE id = $2 RETURNING id, username, free_sessions',
            [amount, userId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Notify the student their credits were updated
        io.to('calendar').emit('credits-updated', { userId: parseInt(userId), freeSessions: result.rows[0].free_sessions });

        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// Get user by ID
app.get('/api/user/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(
            'SELECT id, username, email, stripe_customer_id, free_sessions, created_at FROM users WHERE id = $1',
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
app.post('/api/user/payment-method', async (req, res) => {
    try {
        const { userId, paymentMethodId } = req.body;
        console.log('Saving payment for user:', userId, 'pm:', paymentMethodId);

        // Just save the payment method directly
        await pool.query(
            'UPDATE users SET stripe_customer_id = $1 WHERE id = $2',
            [paymentMethodId, userId]
        );

        res.json({ success: true });
    } catch (err) {
        console.error('Payment method error:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

// Verify Stripe checkout session and get payment method
app.post('/api/stripe/verify-session', async (req, res) => {
    try {
        const { sessionId } = req.body;

        if (!stripe) {
            return res.status(500).json({ error: 'Stripe not configured' });
        }

        // Retrieve the checkout session
        const session = await stripe.checkout.sessions.retrieve(sessionId);

        if (session.payment_status === 'paid') {
            // Get the payment method
            const paymentIntent = await stripe.paymentIntents.retrieve(session.payment_intent);
            const paymentMethodId = paymentIntent.payment_method;

            res.json({ success: true, paymentMethodId });
        } else {
            res.status(400).json({ error: 'Payment not completed' });
        }
    } catch (err) {
        console.error('Verify session error:', err);
        res.status(500).json({ error: 'Invalid session' });
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
        res.json({ success: true });
    } else {
        res.status(401).json({ error: 'Invalid password' });
    }
});

// User signup
app.post('/api/signup', async (req, res) => {
    try {
        const { username, email, password } = req.body;

        // Check if username or email already exists
        const existing = await pool.query(
            'SELECT id FROM users WHERE username = $1 OR email = $2',
            [username, email]
        );

        if (existing.rows.length > 0) {
            return res.status(400).json({ error: 'Username or email already exists' });
        }

        // Hash password and insert (no payment method required at signup)
        const hash = crypto.createHash('sha256').update(password).digest('hex');
        const result = await pool.query(
            'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, username, email',
            [username, email, hash]
        );

        res.json({ success: true, user: result.rows[0] });
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
        const hash = crypto.createHash('sha256').update(password).digest('hex');

        if (hash !== user.password_hash) {
            return res.status(401).json({ error: 'Invalid username or password' });
        }

        res.json({ success: true, user: { id: user.id, username: user.username, email: user.email } });
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
