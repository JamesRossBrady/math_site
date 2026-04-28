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
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

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
        // Check if sessions table is empty
        const result = await client.query('SELECT COUNT(*) FROM sessions');
        if (parseInt(result.rows[0].count) === 0) {
            // Create sessions for next 28 days (4 weeks), 8am-6pm
            const sessions = [];
            const today = new Date();

            for (let d = 0; d < 28; d++) {
                const date = new Date(today);
                date.setDate(date.getDate() + d);
                const dateStr = date.toISOString().split('T')[0];

                for (let h = 8; h <= 18; h++) {
                    sessions.push({
                        slot_date: dateStr,
                        slot_hour: h,
                        status: 'available'
                    });
                }
            }

            // Insert in batches
            for (const session of sessions) {
                await client.query(
                    'INSERT INTO sessions (slot_date, slot_hour, status) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
                    [session.slot_date, session.slot_hour, session.status]
                );
            }
            console.log('Initialized sessions database');
        }
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
            `SELECT id, TO_CHAR(slot_date, 'YYYY-MM-DD') as slot_date, slot_hour, status, subject, textbook, chapter, struggling, created_at, updated_at
             FROM sessions
             WHERE slot_date >= $1 AND slot_date <= $2
             ORDER BY slot_date, slot_hour`,
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
        const { slot_date, slot_hour, subject, textbook, chapter: struggling, userId } = req.body;

        // Check if user has payment method
        const userResult = await pool.query(
            'SELECT stripe_customer_id FROM users WHERE id = $1',
            [userId]
        );

        if (userResult.rows.length === 0 || !userResult.rows[0].stripe_customer_id) {
            return res.status(400).json({ error: 'Add payment method in account settings before booking' });
        }

        const result = await pool.query(
            `UPDATE sessions
             SET status = 'pending', student_id = $7, subject = $3, textbook = $4, chapter = $5, struggling = $6, updated_at = CURRENT_TIMESTAMP
             WHERE slot_date = $1 AND slot_hour = $2 AND status = 'available'
             RETURNING id, slot_date, slot_hour, status`,
            [slot_date, slot_hour, subject, textbook, chapter, struggling, userId]
        );

        if (result.rows.length === 0) {
            return res.status(400).json({ error: 'Slot not available' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// Confirm a session (and charge student)
app.post('/api/sessions/confirm', async (req, res) => {
    try {
        const { slot_date, slot_hour } = req.body;

        // First get the session to find student_id
        const sessionResult = await pool.query(
            `SELECT s.student_id, s.price, u.stripe_customer_id
             FROM sessions s
             JOIN users u ON s.student_id = u.id
             WHERE s.slot_date = $1 AND s.slot_hour = $2 AND s.status = 'pending'`,
            [slot_date, slot_hour]
        );

        if (sessionResult.rows.length === 0) {
            return res.status(400).json({ error: 'Session not found or not pending' });
        }

        const { student_id, price, stripe_customer_id } = sessionResult.rows[0];

        // Charge if student has payment method
        let paymentFailed = false;
        if (stripe && stripe_customer_id && price) {
            try {
                await stripe.paymentIntents.create({
                    amount: price,
                    currency: 'usd',
                    customer: stripe_customer_id,
                    confirm: true,
                    automatic_payment_methods: { enabled: true }
                });
            } catch (stripeErr) {
                console.error('Payment failed:', stripeErr);
                paymentFailed = true;
            }
        }

        if (paymentFailed) {
            // Reject the session if payment fails
            await pool.query(
                `UPDATE sessions SET status = 'available', student_id = NULL, subject = NULL, textbook = NULL, chapter = NULL, struggling = NULL, updated_at = CURRENT_TIMESTAMP WHERE slot_date = $1 AND slot_hour = $2`,
                [slot_date, slot_hour]
            );
            return res.status(400).json({ error: 'Payment failed. Student needs to update payment method.' });
        }

        // Mark as confirmed
        const result = await pool.query(
            `UPDATE sessions
             SET status = 'confirmed', paid = TRUE, updated_at = CURRENT_TIMESTAMP
             WHERE slot_date = $1 AND slot_hour = $2 AND status = 'pending'
             RETURNING id, slot_date, slot_hour, status`,
            [slot_date, slot_hour]
        );

        res.json(result.rows[0]);
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

        res.json(result.rows[0]);
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
            'SELECT id, username, email, created_at FROM users ORDER BY created_at DESC'
        );
        res.json(result.rows);
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
            'SELECT id, username, email, stripe_customer_id, created_at FROM users WHERE id = $1',
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

        // Get existing customer or create new one
        const userResult = await pool.query(
            'SELECT stripe_customer_id FROM users WHERE id = $1',
            [userId]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        let stripeCustomerId = userResult.rows[0].stripe_customer_id;

        // If no customer exists, create one
        if (!stripeCustomerId && stripe) {
            const user = userResult.rows[0];
            const customer = await stripe.customers.create({
                email: user.email,
                payment_method: paymentMethodId,
                invoice_settings: {
                    default_payment_method: paymentMethodId
                }
            });
            stripeCustomerId = customer.id;
        }

        // Update user with payment method
        await pool.query(
            'UPDATE users SET stripe_customer_id = $1 WHERE id = $2',
            [stripeCustomerId, userId]
        );

        res.json({ success: true });
    } catch (err) {
        console.error(err);
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
        const { username, email, password, paymentMethodId } = req.body;

        // Check if username or email already exists
        const existing = await pool.query(
            'SELECT id FROM users WHERE username = $1 OR email = $2',
            [username, email]
        );

        if (existing.rows.length > 0) {
            return res.status(400).json({ error: 'Username or email already exists' });
        }

        // Create Stripe customer with payment method
        let stripeCustomerId = null;
        if (stripe && paymentMethodId) {
            try {
                const customer = await stripe.customers.create({
                    email: email,
                    payment_method: paymentMethodId,
                    invoice_settings: {
                        default_payment_method: paymentMethodId
                    }
                });
                stripeCustomerId = customer.id;
            } catch (stripeErr) {
                console.error('Stripe error:', stripeErr);
                return res.status(400).json({ error: 'Payment processing failed. Please check your card.' });
            }
        }

        // Hash password and insert
        const hash = crypto.createHash('sha256').update(password).digest('hex');
        const result = await pool.query(
            'INSERT INTO users (username, email, password_hash, stripe_customer_id) VALUES ($1, $2, $3, $4) RETURNING id, username, email',
            [username, email, hash, stripeCustomerId]
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

const PORT = process.env.PORT || 3000;

// Socket.IO for whiteboard sync
let whiteboardState = {
    lines: [],
    texts: []
};

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Send current whiteboard state to new user
    socket.emit('whiteboard-state', whiteboardState);

    // Handle drawing line
    socket.on('draw-line', (data) => {
        whiteboardState.lines.push(data);
        socket.broadcast.emit('draw-line', data);
    });

    // Handle text add
    socket.on('add-text', (data) => {
        whiteboardState.texts.push(data);
        socket.broadcast.emit('add-text', data);
    });

    // Handle clear
    socket.on('clear-whiteboard', () => {
        whiteboardState = { lines: [], texts: [] };
        io.emit('clear-whiteboard');
    });

    // Handle undo (remove last line)
    socket.on('undo', () => {
        if (whiteboardState.lines.length > 0) {
            const removedLine = whiteboardState.lines.pop();
            io.emit('undo', removedLine);
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
