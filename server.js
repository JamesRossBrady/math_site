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

// Book a session (create pending request)
app.post('/api/sessions/book', async (req, res) => {
    try {
        const { slot_date, slot_hour, subject, textbook, chapter, struggling, userId } = req.body;
        console.log('Book attempt:', { slot_date, slot_hour, userId });

        // Parse slot_date and slot_hour properly
        const parsedDate = String(slot_date);
        const parsedHour = parseInt(slot_hour);
        const parsedUserId = parseInt(userId);

        // Check user for free_sessions OR payment method
        const userResult = await pool.query(
            'SELECT stripe_customer_id, free_sessions FROM users WHERE id = $1',
            [parsedUserId]
        );

        if (userResult.rows.length === 0) {
            return res.status(400).json({ error: 'User not found' });
        }

        const user = userResult.rows[0];

        // Count user's pending/confirmed sessions
        const sessionCount = await pool.query(
            "SELECT COUNT(*) FROM sessions WHERE student_id = $1 AND status IN ('pending', 'confirmed')",
            [parsedUserId]
        );
        const activeSessions = parseInt(sessionCount.rows[0].count);

        const hasFreeCredit = user.free_sessions > activeSessions;
        const hasPayment = !!user.stripe_customer_id;

        if (!hasFreeCredit && !hasPayment) {
            return res.status(400).json({ error: 'No sessions left. Add payment method.' });
        }

        console.log('Update query:', { parsedDate, parsedHour });

        const result = await pool.query(
            `UPDATE sessions
             SET status = 'pending', student_id = $7, subject = $3, textbook = $4, chapter = $5, struggling = $6, updated_at = CURRENT_TIMESTAMP
             WHERE slot_date = $1 AND slot_hour = $2 AND status = 'available'
             RETURNING id, slot_date, slot_hour, status`,
            [parsedDate, parsedHour, subject, textbook, chapter, struggling, parsedUserId]
        );

        if (result.rows.length === 0) {
            return res.status(400).json({ error: 'Slot not available' });
        }

        // Notify all calendars
        io.to('calendar').emit('session-updated', result.rows[0]);

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
            `SELECT s.student_id, s.paid FROM sessions s WHERE s.slot_date = $1 AND s.slot_hour = $2 AND s.status = 'pending'`,
            [slot_date, slot_hour]
        );

        if (sessionResult.rows.length === 0) {
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

        // Check if student already used a free session (paid=true means they had credit)
        if (alreadyPaid) {
            // Already used free session, no charge
        } else if (user.free_sessions > 0) {
            // Use free session credit
            await pool.query(
                'UPDATE users SET free_sessions = free_sessions - 1 WHERE id = $1',
                [student_id]
            );
        } else if (user.stripe_customer_id && stripe && process.env.ENABLE_CHARGES === 'true') {
            // Charge $0.50 (50 cents = 50 in Stripe format)
            try {
                // Create customer if not exists
                let customerId = user.stripe_customer_id;
                if (!user.stripe_customer_id.startsWith('cus_')) {
                    const customer = await stripe.customers.create({
                        email: user.email,
                        payment_method: user.stripe_customer_id
                    });
                    customerId = customer.id;
                    // Update with customer ID
                    await pool.query(
                        'UPDATE users SET stripe_customer_id = $1 WHERE id = $2',
                        [customerId, student_id]
                    );
                }

                await stripe.paymentIntents.create({
                    amount: 50,
                    currency: 'usd',
                    customer: customerId,
                    off_session: true,
                    confirm: true,
                    description: 'Math tutoring session'
                });
                charged = true;
            } catch (chargeErr) {
                console.error('Charge failed:', chargeErr.message);
                // Allow anyway if charge fails, tutor can handle manually
            }
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

        const result = await pool.query(
            `UPDATE sessions
             SET status = 'available', student_id = NULL, subject = NULL, textbook = NULL, chapter = NULL, struggling = NULL, updated_at = CURRENT_TIMESTAMP
             WHERE slot_date = $1 AND slot_hour = $2 AND status IN ('pending', 'confirmed')
             RETURNING id, slot_date, slot_hour, status`,
            [slot_date, slot_hour]
        );

        if (result.rows.length === 0) {
            return res.status(400).json({ error: 'Session not found' });
        }

        const cancelledSession = result.rows[0];

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

        // Get user email
        const userResult = await pool.query('SELECT email FROM users WHERE id = $1', [userId]);
        if (userResult.rows.length === 0) {
            return res.status(400).json({ error: 'User not found' });
        }

        let stripeCustomerId = paymentMethodId;

        // If Stripe is available, create a Customer
        if (stripe) {
            try {
                const customer = await stripe.customers.create({
                    email: userResult.rows[0].email,
                    payment_method: paymentMethodId
                });
                stripeCustomerId = customer.id;
                console.log('Created Stripe customer:', customer.id);
            } catch (err) {
                console.error('Error creating customer:', err.message);
                // Continue with just storing the payment method
            }
        }

        await pool.query(
            'UPDATE users SET stripe_customer_id = $1 WHERE id = $2',
            [stripeCustomerId, userId]
        );

        res.json({ success: true });
    } catch (err) {
        console.error('Payment method error:', err);
        res.status(500).json({ error: 'Database error' });
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

// Debug: list session dates
app.get('/api/debug/dates', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT DISTINCT slot_date FROM sessions ORDER BY slot_date LIMIT 10'
        );
        res.json(result.rows);
    } catch (err) {
        res.json({ error: err.message });
    }
});

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
